"""
opcua.limits — the server's OperationLimits and the batch sizes they allow.

Read once per connection by the engine and shared with everything that batches
requests: the browse walker, bulk reads and monitored-item creation.
"""

import logging
from collections.abc import Iterator, Sequence
from dataclasses import dataclass

from asyncua import Client, ua
from asyncua.ua.ua_binary import get_string_encoding, nodeid_to_binary

logger = logging.getLogger(__name__)

# Batch sizes used when a server advertises no OperationLimits (0 or absent
# means "no limit" per OPC-UA Part 5 § 6.3.2). A server that *does* enforce a
# limit rejects an oversized request with a BadTooManyOperations *service*
# fault, which fails every operation in the request rather than the ones past
# the limit — so `read_operation_limits` reads the real values on connect
# and every batched service call clamps itself to them.
DEFAULT_MAX_READ_OPS = 1000
DEFAULT_MAX_BROWSE_NODES = 100
DEFAULT_MAX_MONITORED_ITEMS_PER_CALL = 500

# A ReadValueId past its NodeId: AttributeId (UInt32), IndexRange (null
# String) and DataEncoding (QualifiedName: UInt16 + null String).
_READ_VALUE_ID_FIXED_BYTES = 4 + 4 + 2 + 4
# A MonitoredItemCreateRequest past its NodeId: the ReadValueId tail above,
# MonitoringMode, and MonitoringParameters (handle, interval, filter, queue
# size, discard flag). Rounded up to cover a DataChangeFilter.
_MONITORED_ITEM_FIXED_BYTES = 64
# Per-chunk bytes a secured channel spends outside the body: message,
# security and sequence headers, signature and padding.
_CHUNK_OVERHEAD_BYTES = 128
# Of the server's request limit, the share a Read body may fill; the rest
# is the request header and authentication token.
_REQUEST_BODY_SHARE = 0.9
# A NodeId's binary size before a String/ByteString identifier's bytes: the
# encoding byte, the namespace (none in TwoByte, one byte in FourByte), and
# the identifier, or a String/ByteString's Int32 length prefix (-1 for null).
_NODE_ID_FIXED_BYTES = {
    ua.NodeIdType.TwoByte: 1 + 1,
    ua.NodeIdType.FourByte: 1 + 1 + 2,
    ua.NodeIdType.Numeric: 1 + 2 + 4,
    ua.NodeIdType.String: 1 + 2 + 4,
    ua.NodeIdType.Guid: 1 + 2 + 16,
    ua.NodeIdType.ByteString: 1 + 2 + 4,
}


def _encoded_node_id_bytes(nid: ua.NodeId) -> int:
    """len(nodeid_to_binary(nid)), without encoding it: encoding just to
    measure took 64 ms for a 72k-variable page."""
    # An `nsu=`/`srv=` id parses to an ExpandedNodeId that also encodes its
    # namespace URI and server index; rare enough to just encode.
    if isinstance(nid, ua.ExpandedNodeId) and (nid.NamespaceUri or nid.ServerIndex):
        return len(nodeid_to_binary(nid))
    size = _NODE_ID_FIXED_BYTES[nid.NodeIdType]
    ident = nid.Identifier
    if isinstance(ident, str):
        size += len(ident.encode(get_string_encoding(), "surrogateescape"))
    elif isinstance(ident, bytes):
        size += len(ident)
    return size


@dataclass(frozen=True)
class OperationLimits:
    """A server's OperationLimits. None means "not read yet or not advertised"
    — the DEFAULT_MAX_* batch sizes then apply."""

    max_read_ops: int | None = None
    max_browse_nodes: int | None = None
    max_monitored_items_per_call: int | None = None
    max_browse_continuation_points: int | None = None
    # The largest request the server accepts, in bytes, from the transport
    # handshake. None: unknown or unlimited.
    max_request_bytes: int | None = None

    def read_ops_budget(self) -> int:
        """Operations allowed in one Read request."""
        return self.max_read_ops or DEFAULT_MAX_READ_OPS

    def read_chunks(
        self, node_ids: Sequence[ua.NodeId], attrs_per_node: int = 1
    ) -> Iterator[slice]:
        """Slices of *node_ids* that each fit one Read request.

        A chunk holds at most `read_ops_budget()` operations and, when the
        server's message size is known, at most what fits in it. Long string
        NodeIds make the size the tighter limit: TwinCAT advertises
        MaxNodesPerRead = 65535 but accepts 4 MiB requests, about 44,000 of
        its ReadValueIds. A larger Read gets BadTcpMessageTooLarge and the
        connection closed, failing every chunk after it as well.
        """
        return self._request_chunks(
            node_ids,
            max(1, self.read_ops_budget() // attrs_per_node),
            attrs_per_node * _READ_VALUE_ID_FIXED_BYTES,
            attrs_per_node,
        )

    def monitored_item_chunks(self, node_ids: Sequence[ua.NodeId]) -> Iterator[slice]:
        """Slices of *node_ids* that each fit one CreateMonitoredItems request:
        `monitored_items_budget()` items, within the server's message size (see
        read_chunks — TwinCAT advertises 65535 items per call here too)."""
        return self._request_chunks(
            node_ids, self.monitored_items_budget(), _MONITORED_ITEM_FIXED_BYTES, 1
        )

    def _request_chunks(
        self,
        node_ids: Sequence[ua.NodeId],
        max_nodes: int,
        fixed_bytes_per_node: int,
        node_id_copies: int,
    ) -> Iterator[slice]:
        """Split *node_ids* at *max_nodes*, and at the server's request size
        when known; each node costs its encoded NodeId *node_id_copies* times
        plus *fixed_bytes_per_node*."""
        max_bytes = (
            int(self.max_request_bytes * _REQUEST_BODY_SHARE) if self.max_request_bytes else None
        )
        start = size = 0
        for i, nid in enumerate(node_ids):
            node_bytes = 0
            if max_bytes is not None:
                node_bytes = node_id_copies * _encoded_node_id_bytes(nid) + fixed_bytes_per_node
            if i > start and (
                i - start >= max_nodes or (max_bytes is not None and size + node_bytes > max_bytes)
            ):
                yield slice(start, i)
                start, size = i, 0
            size += node_bytes
        if start < len(node_ids):
            yield slice(start, len(node_ids))

    def browse_nodes_budget(self) -> int:
        """BrowseDescriptions to send in one Browse request.

        Also capped by MaxBrowseContinuationPoints: every node in a request
        may need a continuation point for references past the first answer,
        and a server out of them refuses the node outright (an S7-1500 keeps
        five per session).
        """
        budget = self.max_browse_nodes or DEFAULT_MAX_BROWSE_NODES
        if self.max_browse_continuation_points:
            budget = min(budget, self.max_browse_continuation_points)
        return budget

    def monitored_items_budget(self) -> int:
        """Items allowed in one CreateMonitoredItems/DeleteMonitoredItems call."""
        return self.max_monitored_items_per_call or DEFAULT_MAX_MONITORED_ITEMS_PER_CALL


def negotiated_request_bytes(client: Client) -> int | None:
    """The largest request the server accepts, from its Acknowledge.

    The server's MaxMessageSize, or MaxChunkCount chunks of its receive
    buffer when that is smaller; None when neither is set (0 means no limit).
    asyncua keeps the Acknowledge only on its private connection object, so
    a missing attribute means unknown rather than an error.
    """
    try:
        transport = client.uaclient.protocol._connection._limits
        message_size = int(transport.max_message_size)
        chunk_count = int(transport.max_chunk_count)
        # asyncua files the Acknowledge's Receive/SendBufferSize under each
        # other's names; the smaller one is a safe chunk size either way.
        chunk_size = min(int(transport.max_send_buffer), int(transport.max_recv_buffer))
    except (AttributeError, TypeError, ValueError):
        return None
    bounds = [message_size] if message_size > 0 else []
    if chunk_count > 0 and chunk_size > _CHUNK_OVERHEAD_BYTES:
        bounds.append(chunk_count * (chunk_size - _CHUNK_OVERHEAD_BYTES))
    return min(bounds) if bounds else None


async def read_operation_limits(client: Client, datasource_name: str = "") -> OperationLimits:
    """Read the server's OperationLimits so batched requests stay legal.

    Servers reject an oversized Read/Browse/CreateMonitoredItems with a
    BadTooManyOperations *service* fault: the whole request fails, not just
    the operations past the limit. CODESYS advertises MaxNodesPerRead = 100,
    and the browse attribute read asks for four attributes per variable, so
    without this a level of 26 variables was enough to lose every type on
    that level.
    """
    max_request_bytes = negotiated_request_bytes(client)
    limit_ids = (
        ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead,
        ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerBrowse,
        ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxMonitoredItemsPerCall,
        ua.ObjectIds.Server_ServerCapabilities_MaxBrowseContinuationPoints,
    )
    try:
        params = ua.ReadParameters()
        params.MaxAge = 0
        params.TimestampsToReturn = ua.TimestampsToReturn.Neither
        for ident in limit_ids:
            rv = ua.ReadValueId()
            rv.NodeId = ua.NodeId(ident)
            rv.AttributeId = ua.AttributeIds.Value
            params.NodesToRead.append(rv)
        results = await client.uaclient.read(params)
    except Exception as exc:
        # An optional part of the address space: a server may omit it
        # entirely. The defaults then apply, as they did before.
        logger.debug(
            "Could not read OperationLimits for %s: %s", datasource_name, exc
        )
        return OperationLimits(max_request_bytes=max_request_bytes)
    limits: list[int | None] = []
    for dv in results:
        value: int | None = None
        try:
            if dv.StatusCode.is_good() and dv.Value is not None:
                raw = dv.Value.Value
                # 0 means "no limit"; keep None so the defaults apply.
                if isinstance(raw, int) and raw > 0:
                    value = raw
        except Exception:
            value = None
        limits.append(value)
    (
        max_read_ops,
        max_browse_nodes,
        max_monitored_items_per_call,
        max_browse_continuation_points,
    ) = limits
    logger.info(
        "OPC-UA operation limits for %s: MaxNodesPerRead=%s MaxNodesPerBrowse=%s "
        "MaxMonitoredItemsPerCall=%s MaxBrowseContinuationPoints=%s MaxRequestBytes=%s",
        datasource_name,
        max_read_ops or "unlimited",
        max_browse_nodes or "unlimited",
        max_monitored_items_per_call or "unlimited",
        max_browse_continuation_points or "unlimited",
        max_request_bytes or "unlimited",
    )
    return OperationLimits(
        max_read_ops,
        max_browse_nodes,
        max_monitored_items_per_call,
        max_browse_continuation_points,
        max_request_bytes,
    )
