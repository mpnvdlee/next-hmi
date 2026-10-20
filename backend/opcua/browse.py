"""
opcua.browse — walk an OPC-UA address space into the tree the import uses.

The walker needs only a connected client and the server's OperationLimits —
none of the engine's subscription state — so it is its own class.
"""

import asyncio
import logging
from typing import Any

from asyncua import Client, ua
from asyncua.common.node import Node
from asyncua.common.ua_utils import get_base_data_type

from .limits import OperationLimits

logger = logging.getLogger(__name__)

# The attributes a browse reads per variable node, in request order. Each one
# is a separate Read operation against MaxNodesPerRead.
_VAR_ATTRS = (
    ua.AttributeIds.DataType,
    ua.AttributeIds.ValueRank,
    ua.AttributeIds.ArrayDimensions,
    ua.AttributeIds.AccessLevel,
)
# (data_type, writable, array_length) for a node whose attributes never arrived.
_UNKNOWN_VAR_ATTRS = ("Unknown", False, -1)

# A struct's members are its HasComponent children. Its HasProperty children
# (EURange, EngineeringUnits, …) describe the tag rather than being tags, so
# the walker keeps them out of the tree.
_HAS_COMPONENT = ua.NodeId(ua.ObjectIds.HasComponent)

_BROWSE_NODE_CLASSES = int(ua.NodeClass.Object) | int(ua.NodeClass.Variable)


def _builtin_data_type_name(ident: int) -> str:
    """Name for a namespace-0 DataType id, as browse reports it.

    Only Structure (i=22) and what does not map anywhere else is "struct":
    "struct" now means "walk this node for members and import it as a
    folder", so a scalar labelled struct stops being bindable.
    """
    if ident == 22:
        return "struct"  # Structure — VariantType(22) would say ExtensionObject
    if ident == 26:
        return "Double"  # Number (abstract)
    if ident == 27:
        return "Int64"  # Integer (abstract)
    if ident == 28:
        return "UInt64"  # UInteger (abstract)
    if ident == 29:
        return "Int32"  # Enumeration — enums travel as Int32 on the wire
    if 1 <= ident <= 25:
        return ua.VariantType(ident).name
    return "struct"


def _is_structure_id(dt_nid: ua.NodeId) -> bool:
    return dt_nid.NamespaceIndex == 0 and dt_nid.Identifier == 22


def _decode_var_attrs(
    results: list[ua.DataValue], index: int
) -> tuple[str, bool, int]:
    """Decode one node's slice of a `_VAR_ATTRS` read into
    (data_type, writable, array_length).

    Each attribute is decoded independently: a server that refuses one of the
    four still yields the others rather than the whole node reading as Unknown.
    """
    write_bit = 1 << int(ua.AccessLevel.CurrentWrite)  # bit 1 = 0x02
    base = index * len(_VAR_ATTRS)
    slice_ = results[base : base + len(_VAR_ATTRS)]
    if len(slice_) != len(_VAR_ATTRS):
        # A compliant server answers every operation; one that truncates must
        # not take the rest of the level down with it.
        return _UNKNOWN_VAR_ATTRS
    dt_dv, vr_dv, ad_dv, al_dv = slice_

    data_type = "Unknown"
    try:
        if dt_dv.StatusCode.is_good() and dt_dv.Value is not None:
            dt_nid: ua.NodeId = dt_dv.Value.Value
            if (
                isinstance(dt_nid, ua.NodeId)
                and dt_nid.NamespaceIndex == 0
                and isinstance(dt_nid.Identifier, int)
            ):
                data_type = _builtin_data_type_name(dt_nid.Identifier)
            else:
                # A server-defined type. Provisional: _read_var_attrs_chunk
                # resolves it to its base, since a PLC enum or a derived
                # scalar is just as likely here as a struct.
                data_type = "struct"
    except Exception:
        pass

    writable = False
    try:
        if al_dv.StatusCode.is_good() and al_dv.Value is not None:
            writable = bool(al_dv.Value.Value & write_bit)
    except Exception:
        pass

    # Determine array_length from ValueRank + ArrayDimensions.
    # ValueRank == 1 means a 1-D array.  array_length encodes:
    #   -1  → scalar (ValueRank != 1)
    #    0  → 1-D array of unknown/dynamic size (no ArrayDimensions)
    #   >0  → 1-D array with known fixed size
    array_length = -1
    try:
        if vr_dv.StatusCode.is_good() and vr_dv.Value is not None:
            value_rank = vr_dv.Value.Value
            if value_rank == 1:
                array_length = 0  # is a 1-D array; size may be unknown
                if ad_dv.StatusCode.is_good() and ad_dv.Value is not None:
                    dims = ad_dv.Value.Value
                    if dims and len(dims) == 1 and dims[0] > 0:
                        array_length = int(dims[0])
    except Exception:
        pass

    return data_type, writable, array_length


class AddressSpaceBrowser:
    """Walks an address space over a connected client, within the server's
    OperationLimits, resolving each variable's type as it goes."""

    def __init__(
        self,
        client: Client,
        limits: OperationLimits | None = None,
        *,
        datasource_name: str = "",
    ) -> None:
        self._client = client
        self._limits = limits or OperationLimits()
        self.datasource_name = datasource_name
        # Server-defined DataType → builtin name, filled during a browse.
        self._data_type_names: dict[str, str] = {}

    async def browse(self, node: Node) -> dict[str, Any]:
        """Walk the address space below *node*."""
        # Types can change with a PLC download between two browses.
        self._data_type_names = {}
        return await self._browse_node(node)

    # ── Batched browse helpers ────────────────────────────────────────────────

    async def _batch_browse_nodes(
        self, nodes: list[Node], chunk_size: int | None = None
    ) -> list[list[ua.ReferenceDescription]]:
        """Browse multiple parent nodes using one Browse request per chunk.

        The OPC-UA Browse service accepts a list of BrowseDescriptions and
        returns one BrowseResult per entry, so a single request suffices for
        all nodes at a given BFS level.  Chunks respect the server's
        MaxNodesPerBrowse, and a chunk the server still refuses is split and
        retried rather than costing the whole level.
        """
        all_refs: list[list[ua.ReferenceDescription]] = [[] for _ in nodes]
        budget = chunk_size or self._limits.browse_nodes_budget()
        for start in range(0, len(nodes), budget):
            chunk = nodes[start : start + budget]
            chunk_refs = await self._browse_chunk(chunk)
            for slot, refs in enumerate(chunk_refs):
                all_refs[start + slot].extend(refs)
        return all_refs

    async def _browse_chunk(
        self, nodes: list[Node]
    ) -> list[list[ua.ReferenceDescription]]:
        """Browse one chunk, halving it when the server refuses the batch.

        Continuation points are followed per slot so no references are lost
        when the server splits results.
        """
        try:
            params = ua.BrowseParameters()
            params.RequestedMaxReferencesPerNode = 0
            params.View.Timestamp = ua.get_win_epoch()
            for n in nodes:
                desc = ua.BrowseDescription()
                desc.NodeId = n.nodeid
                desc.BrowseDirection = ua.BrowseDirection.Forward
                desc.ReferenceTypeId = ua.NodeId(ua.ObjectIds.HierarchicalReferences)
                desc.IncludeSubtypes = True
                # Only what can be a tag or hold one. A Method is neither, yet
                # unmasked it was walked like a folder and its InputArguments
                # and OutputArguments properties offered as bindable rows.
                desc.NodeClassMask = _BROWSE_NODE_CLASSES
                # BrowseResultMask.All returns NodeClass + DisplayName for free
                desc.ResultMask = ua.BrowseResultMask.All
                params.NodesToBrowse.append(desc)
            results = await self._client.uaclient.browse(params)
            all_refs: list[list[ua.ReferenceDescription]] = [[] for _ in nodes]
            for slot, result in enumerate(results):
                all_refs[slot].extend(result.References)
            pending = [
                (i, r.ContinuationPoint)
                for i, r in enumerate(results)
                if r.ContinuationPoint
            ]
            while pending:
                next_params = ua.BrowseNextParameters()
                next_params.ReleaseContinuationPoints = False
                next_params.ContinuationPoints = [cp for _, cp in pending]
                indices = [idx for idx, _ in pending]
                next_results = await self._client.uaclient.browse_next(next_params)
                pending = []
                for idx, result in zip(indices, next_results, strict=False):
                    all_refs[idx].extend(result.References)
                    if result.ContinuationPoint:
                        pending.append((idx, result.ContinuationPoint))
            return all_refs
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if len(nodes) <= 1:
                raise
            logger.debug(
                "Browse of %d nodes failed for %s (%s) — splitting",
                len(nodes), self.datasource_name, exc,
            )
            half = len(nodes) // 2
            return (
                await self._browse_chunk(nodes[:half])
                + await self._browse_chunk(nodes[half:])
            )

    async def _batch_read_var_attrs(
        self, node_ids: list[ua.NodeId], chunk_size: int | None = None
    ) -> list[tuple[str, bool, int]]:
        """Batch-read DataType, ValueRank, ArrayDimensions and AccessLevel for a
        list of variable NodeIds.

        Returns (data_type_name, writable, array_length) per input NodeId.
        array_length is 0 for scalars; for 1-D arrays with a known fixed size it
        contains that size.  Reads are issued as one ReadRequest per chunk — far
        fewer round-trips than reading one node at a time — sized so the four
        attributes per node stay inside the server's MaxNodesPerRead, which
        counts operations (node/attribute pairs), not nodes.

        DataType resolution is done purely from the returned NodeId:
          - ns=0, identifier 1..25  → ua.VariantType(id).name (no extra RPC)
          - ns=0, identifier 29     → "Int32"  (enumeration canonical type)
          - anything else           → "struct"
        """
        if not node_ids:
            return []
        nodes_per_chunk = chunk_size or max(1, self._limits.read_ops_budget() // len(_VAR_ATTRS))
        results_all: list[tuple[str, bool, int]] = []
        for start in range(0, len(node_ids), nodes_per_chunk):
            chunk = node_ids[start : start + nodes_per_chunk]
            results_all.extend(await self._read_var_attrs_chunk(chunk))
        return results_all

    async def _read_var_attrs_chunk(
        self, node_ids: list[ua.NodeId]
    ) -> list[tuple[str, bool, int]]:
        """Read one chunk of variable attributes, halving it on a refusal.

        A server that enforces a stricter limit than it advertises — or none at
        all — still yields real types this way instead of degrading a whole
        browse level to "Unknown".
        """
        try:
            params = ua.ReadParameters()
            params.MaxAge = 0
            params.TimestampsToReturn = ua.TimestampsToReturn.Neither
            for nid in node_ids:
                for attr_id in _VAR_ATTRS:
                    rv = ua.ReadValueId()
                    rv.NodeId = nid
                    rv.AttributeId = attr_id
                    params.NodesToRead.append(rv)
            results = await self._client.uaclient.read(params)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if len(node_ids) <= 1:
                logger.warning(
                    "Attribute read failed for %s (%s): %s",
                    self.datasource_name,
                    node_ids[0].to_string() if node_ids else "?",
                    exc,
                )
                return [_UNKNOWN_VAR_ATTRS] * len(node_ids)
            logger.debug(
                "Attribute read of %d nodes failed for %s (%s) — splitting",
                len(node_ids), self.datasource_name, exc,
            )
            half = len(node_ids) // 2
            return (
                await self._read_var_attrs_chunk(node_ids[:half])
                + await self._read_var_attrs_chunk(node_ids[half:])
            )
        decoded = [_decode_var_attrs(results, i) for i in range(len(node_ids))]
        for i, (data_type, writable, array_length) in enumerate(decoded):
            if data_type != "struct":
                continue
            dt_dv = results[i * len(_VAR_ATTRS)]
            dt_nid = dt_dv.Value.Value if dt_dv.Value is not None else None
            if isinstance(dt_nid, ua.NodeId) and not _is_structure_id(dt_nid):
                decoded[i] = (
                    await self._custom_data_type_name(dt_nid),
                    writable,
                    array_length,
                )
        return decoded

    async def _custom_data_type_name(self, dt_nid: ua.NodeId) -> str:
        """Name a server-defined DataType by the builtin it derives from.

        CODESYS publishes every ENUM, and S7 every UDT, as its own DataType in
        the application namespace, so the namespace alone cannot tell an enum
        (bind it as Int32) from a struct (walk it for members). The HasSubtype
        chain can. The same goes for the standard's own derived types in
        namespace 0 — Duration is a Double, UtcTime a DateTime. Resolved once
        per distinct type per browse — a PLC has tens of types, not thousands,
        and each hop is a Browse.
        """
        key = dt_nid.to_string()
        cached = self._data_type_names.get(key)
        if cached is not None:
            return cached
        try:
            base = await get_base_data_type(Node(self._client.uaclient, dt_nid))
            name = _builtin_data_type_name(base.nodeid.Identifier)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # An unresolvable type stays "struct": the walker then looks for
            # HasComponent members, and a struct import without any falls
            # back to a plain variable, so nothing bindable is lost.
            logger.debug(
                "Could not resolve DataType %s for %s: %s", key, self.datasource_name, exc
            )
            name = "struct"
        self._data_type_names[key] = name
        return name

    async def _browse_node(self, node: Node) -> dict[str, Any]:
        """BFS browse: ~2 round-trips per tree level instead of 5 per node.

        Browse returns NodeClass + DisplayName for each child for free
        (BrowseResultMask.All).  A separate bulk Read fetches DataType and
        AccessLevel only for Variable nodes at each level.

        A struct tag is a Variable that carries its members as HasComponent
        children — that is how both CODESYS and S7-1500 publish one — so a
        Variable is a leaf only until its DataType says otherwise. Structs are
        walked one level deeper per BFS round, which is why the attribute read
        for a level has to happen before the next round is queued.
        """
        # ── Bootstrap: read root's own DisplayName + NodeClass ────────────────
        try:
            params = ua.ReadParameters()
            params.TimestampsToReturn = ua.TimestampsToReturn.Neither
            for attr_id in (ua.AttributeIds.DisplayName, ua.AttributeIds.NodeClass):
                rv = ua.ReadValueId()
                rv.NodeId = node.nodeid
                rv.AttributeId = attr_id
                params.NodesToRead.append(rv)
            root_results = await self._client.uaclient.read(params)
            root_dn = root_results[0].Value.Value.Text if root_results[0].Value else ""
            root_nc = root_results[1].Value.Value if root_results[1].Value else ua.NodeClass.Unspecified
        except Exception:
            root_dn = node.nodeid.to_string()
            root_nc = ua.NodeClass.Unspecified

        root_entry: dict[str, Any] = {
            "node_id": node.nodeid.to_string(),
            "display_name": root_dn or node.nodeid.to_string(),
            "data_type": None,
            "children": [],
        }
        # ── BFS: one Browse + one Read per level ──────────────────────────────
        # Each queue entry carries whether its parent is a struct Variable: the
        # members of a struct hang off it by HasComponent, while HasProperty
        # children (EURange, EngineeringUnits, …) are metadata, not tags, and
        # must not become bindable rows.
        visited: set[str] = {node.nodeid.to_string()}
        queue: list[tuple[Node, dict, bool]] = []

        if root_nc == ua.NodeClass.Variable:
            try:
                attrs = await self._batch_read_var_attrs([node.nodeid])
                dt, wr, al = attrs[0]
                root_entry["data_type"] = dt
                root_entry["writable"] = wr
                if al >= 0:  # 0 = dynamic array, >0 = fixed array, -1 = scalar
                    root_entry["is_array"] = True
                    if al > 0:
                        root_entry["array_length"] = al
            except Exception:
                root_entry["data_type"] = "Unknown"
                root_entry["writable"] = False
            if root_entry["data_type"] != "struct":
                return root_entry
            # A struct browsed as the root still has members to walk.
            queue.append((node, root_entry, True))
        else:
            queue.append((node, root_entry, False))

        while queue:
            parent_nodes = [n for n, _, _ in queue]
            try:
                batch_refs = await self._batch_browse_nodes(parent_nodes)
            except Exception as exc:
                logger.warning(
                    "Batch browse failed for %s: %s — skipping level",
                    self.datasource_name, exc,
                )
                break

            next_queue: list[tuple[Node, dict, bool]] = []
            var_node_ids: list[ua.NodeId] = []
            var_entries: list[dict] = []

            for (_, parent_entry, parent_is_struct), refs in zip(
                queue, batch_refs, strict=False
            ):
                for ref in refs:
                    if parent_is_struct and ref.ReferenceTypeId != _HAS_COMPONENT:
                        continue
                    if ref.NodeClass not in (ua.NodeClass.Object, ua.NodeClass.Variable):
                        # The mask asks the server not to send these; a server
                        # that ignores it must not get them into the tree.
                        continue
                    cid_str = ref.NodeId.to_string()
                    if cid_str in visited:
                        continue
                    visited.add(cid_str)
                    child_entry: dict[str, Any] = {
                        "node_id": cid_str,
                        "display_name": (ref.DisplayName.Text or cid_str),
                        "data_type": None,
                        "children": [],
                    }
                    parent_entry["children"].append(child_entry)
                    if ref.NodeClass == ua.NodeClass.Variable:
                        var_node_ids.append(ref.NodeId)
                        var_entries.append(child_entry)
                    else:
                        next_queue.append(
                            (Node(self._client.uaclient, ref.NodeId), child_entry, False)
                        )

            if var_node_ids:
                try:
                    attrs = await self._batch_read_var_attrs(var_node_ids)
                    for nid, entry, (dt, wr, al) in zip(
                        var_node_ids, var_entries, attrs, strict=False
                    ):
                        entry["data_type"] = dt
                        entry["writable"] = wr
                        if al >= 0:  # 0 = dynamic array, >0 = fixed array, -1 = scalar
                            entry["is_array"] = True
                            if al > 0:
                                entry["array_length"] = al
                        # Only a struct has members, so only a struct is worth
                        # another Browse — a scalar would cost one operation per
                        # tag and return nothing but its own properties.
                        if dt == "struct":
                            next_queue.append(
                                (Node(self._client.uaclient, nid), entry, True)
                            )
                except Exception as exc:
                    logger.warning(
                        "Batch read var attrs failed for %s: %s",
                        self.datasource_name, exc,
                    )
                    # Fill both fields: an entry with a type but no `writable`
                    # reads as "access unknown" in the picker, which hides that
                    # the attribute read is what failed.
                    for entry in var_entries:
                        entry["data_type"], entry["writable"], _ = _UNKNOWN_VAR_ATTRS

            queue = next_queue
        return root_entry
