"""
Datasource manager — manages multiple datasource configs, each with its own
variable registry, value cache, and folder-struct maps.

Replaces the single-source VariableManager with a multi-datasource architecture
where each datasource has its own JSON file under the active project's
``datasources/`` directory.
"""

import asyncio
import contextlib
import hashlib
import logging
import re
import threading
from bisect import bisect_left
from collections.abc import Callable, Iterable
from typing import Any, ClassVar

from core.exceptions import DatasourceValidationError
from core.storage import active_datasources_dir, read_json, write_json
from core.value_types import (
    _member,
    _place,
    array_index_out_of_bounds,
    is_array_shape,
    is_dynamic_array,
    is_fixed_array,
    json_ready,
    to_simple_type,
)
from models.datasource import (
    build_var_key,
    flatten_with_paths,
    is_subscribable,
    parse_var_key,
)

logger = logging.getLogger(__name__)

# The ``[N]`` suffix an array-of-struct element folder's name ends in — bare
# ``[3]`` or TwinCAT's ``aSlaves[3]``. It orders the elements and nothing else:
# what makes a folder an element is sitting in an ``is_array`` folder.
_ELEM_INDEX_RE = re.compile(r"\[(\d+)\]$")


class DatasourceEntry:
    """In-memory state for a single datasource."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.name: str = config.get("name", "")
        self.ds_type: str = config.get("type", "")
        # path -> entry dict (flat registry of variables)
        self.registry: dict[str, dict] = {}
        # path -> (folder_path, {field_name: child_path})  for folder structs
        self.folder_registry: dict[str, dict] = {}
        # child_path -> (folder_path, field_name) reverse map
        self._var_to_folder: dict[str, tuple[str, str]] = {}
        # composite_key -> current value
        self.cache: dict[str, Any] = {}
        # Pre-computed sets/dicts that depend only on the config (not on live values)
        # Composite keys valid for snapshot, each mapped to itself so a caller
        # holding many of them can share these strings instead of its own copies.
        self._enabled_cache_keys: dict[str, str] = {}
        self._metadata_index: tuple[dict[str, dict[str, Any]], list[str]] | None = None
        self._metadata_lock = threading.Lock()
        # What a consumer derives from the config alone, by name (the OPC-UA
        # engine's field routes and folder leaves). Kept on the entry, as an
        # edit replaces it: nothing goes stale, and a consumer holds no
        # replaced entry alive through its cache.
        self.derived: dict[str, Any] = {}
        self._build_registry()

    @property
    def metadata_index(self) -> tuple[dict[str, dict[str, Any]], list[str]]:
        """This datasource's full variable metadata and its sorted keys, built
        once per entry — an edit replaces the entry, so nothing invalidates it.
        100k variables take ~80 ms to describe; a page context then costs a
        few bisects into the sorted keys (``DatasourceManager.variable_metadata``).

        Built in a worker thread when the entry is loaded or saved
        (``_with_metadata``, ``_build_metadata_soon``): on the loop, the first
        ``set_context`` after a start or a save stalled 180-530 ms on a large
        PLC. One that comes before the thread is done waits for it rather than
        building a second copy beside it, which contending for the GIL took
        up to twice as long."""
        index = self._metadata_index
        if index is None:
            with self._metadata_lock:
                index = self._metadata_index
                if index is None:
                    index = self._metadata_index = self._build_metadata_index()
        return index

    def _build_metadata_index(self) -> tuple[dict[str, dict[str, Any]], list[str]]:
        result: dict[str, dict[str, Any]] = {}
        # Scalar / plain-array variables
        for path, var_entry in self.registry.items():
            if not is_subscribable(var_entry):
                continue
            key = build_var_key(self.name, path)
            var_is_array = is_array_shape(var_entry)
            var_type: dict[str, Any] = {
                "kind": "scalar",
                "base": to_simple_type(
                    var_entry.get("data_type", ""),
                    as_array_suffix=False,
                ),
                "array": var_is_array,
            }
            if var_is_array and is_fixed_array(var_entry):
                var_type["length"] = var_entry.get("array_length")
            meta: dict[str, Any] = {
                "type": var_type,
                "writable": var_entry.get("writable") is True,
            }
            if var_entry.get("min") is not None:
                meta["min"] = var_entry["min"]
            if var_entry.get("max") is not None:
                meta["max"] = var_entry["max"]
            result[key] = meta
        # Struct and array-of-struct folders
        for folder_path, fentry in self.folder_registry.items():
            key = build_var_key(self.name, folder_path)
            is_array = DatasourceEntry.is_aggregate_boundary(fentry)
            # Collect field names from direct children + nested structs
            fields = list(fentry.get("fields", {}).keys())
            fields += list(fentry.get("_nested_fields", {}).keys())
            field_ranges = fentry.get("field_ranges", {})
            # For arrays, use fields from the first element
            if is_array:
                elem_paths = fentry.get("_element_paths", [])
                if elem_paths:
                    first_elem = self.folder_registry.get(elem_paths[0])
                    if first_elem:
                        fields = list(first_elem.get("fields", {}).keys())
                        fields += list(first_elem.get("_nested_fields", {}).keys())
                        field_ranges = first_elem.get("field_ranges", {})
            struct_meta: dict[str, Any] = {
                "type": {
                    "kind": "struct",
                    "name": fentry.get("display_name") or "struct",
                    "array": is_array,
                    "fields": fields,
                },
            }
            if field_ranges:
                struct_meta["fieldRanges"] = field_ranges
            result[key] = struct_meta
        # A client holding only some elements of an array cannot count them to
        # find which is which, so each element names its own position — from 0,
        # whatever index the PLC starts at, as ``element_keys`` counts.
        for fentry in self.folder_registry.values():
            for elem_path, position in fentry.get("_element_index", {}).items():
                elem_meta = result.get(build_var_key(self.name, elem_path))
                if elem_meta is not None:
                    elem_meta["position"] = position
        return result, sorted(result)

    def _build_registry(self) -> None:
        """Build flat registry and folder maps from the variable tree."""
        variables = self.config.get("variables", [])
        entries = flatten_with_paths(variables)
        self.registry = {path: entry for path, entry in entries}
        self.folder_registry = {}
        self._var_to_folder = {}
        self._build_folder_maps(variables, "")
        self._wire_ancestor_map()
        # Cache composite keys for snapshot() - depends only on config, not live values.
        # Stale vars (present_on_server=False) are excluded so the WS pipeline doesn't
        # push keys we won't subscribe to.
        subscribable_paths = {
            path for path, entry in self.registry.items() if is_subscribable(entry)
        }
        self._enabled_cache_keys = {
            key: key
            for paths in (subscribable_paths, self.folder_registry)
            for key in (build_var_key(self.name, path) for path in paths)
        }
        self._log_invalid_ranges()

    def _log_invalid_ranges(self) -> None:
        """Warn once per variable whose persisted min > max — a contract
        violation left untouched rather than silently corrected; write
        enforcement treats such a range as unenforced until fixed."""
        for path, entry in self.registry.items():
            lo, hi = entry.get("min"), entry.get("max")
            if (
                isinstance(lo, (int, float)) and not isinstance(lo, bool)
                and isinstance(hi, (int, float)) and not isinstance(hi, bool)
                and lo > hi
            ):
                logger.warning(
                    "%s:%s has min=%r > max=%r (invalid range; left untouched — "
                    "write enforcement is unenforced until corrected)",
                    self.name, path, lo, hi,
                )

    def _build_folder_maps(self, nodes: list, prefix: str) -> None:
        """Recursively build folder_registry and _var_to_folder.

        Supports nested structs (folders whose children include sub-struct
        folders) and arrays of structs (folders whose children are all
        ``[N]``-indexed sub-folders that are themselves structs).
        """
        for node in nodes:
            if not isinstance(node, dict) or node.get("kind") != "folder":
                continue
            folder_path = f"{prefix}/{node['name']}" if prefix else node["name"]
            children = node.get("children", [])

            # ── Recurse first so child folders are already in folder_registry ─
            self._build_folder_maps(children, folder_path)

            var_children, folder_children = self._partition_folder_children(children)
            is_array = self._is_array_folder(node)
            fields, field_ranges, child_paths = self._collect_scalar_fields(
                var_children, folder_path
            )
            nested_fields = self._collect_nested_fields(folder_children, folder_path, is_array)

            # Register this folder if it has any fields, nested structs, or is an array
            if not (fields or nested_fields or is_array):
                continue

            entry_dict = self._assemble_folder_entry(
                node, folder_path, fields, field_ranges, child_paths,
                nested_fields, is_array, folder_children,
            )
            self.folder_registry[folder_path] = entry_dict
            for child_path, field_name in child_paths.items():
                self._var_to_folder[child_path] = (folder_path, field_name)

    @staticmethod
    def _partition_folder_children(children: list) -> tuple[list[dict], list[dict]]:
        """Split a folder's children into (variable children, sub-folder children)."""
        var_children = [
            c for c in children if isinstance(c, dict) and c.get("kind") != "folder"
        ]
        folder_children = [
            c for c in children if isinstance(c, dict) and c.get("kind") == "folder"
        ]
        return var_children, folder_children

    @staticmethod
    def _is_array_folder(node: dict) -> bool:
        """True when *node* is explicitly flagged as an array-of-struct folder
        (`is_array`), never inferred from child names alone. Child names still carry the
        [N] index used to order/locate elements; bare "[N]" (OPC-UA style) or
        "Prefix[N]" (static-server style)."""
        return bool(node.get("is_array"))

    @staticmethod
    def is_aggregate_boundary(fentry: dict) -> bool:
        """True when *fentry* (a ``folder_registry`` entry) is an opaque
        traversal/broadcast boundary — currently only array-of-struct folders.
        The one flag this checks today (``_is_array``) is set by
        ``_assemble_folder_entry``; centralised here so the three sites that
        need to stop at a boundary (``_wire_ancestor_map``,
        ``_build_folder_fields_snapshot_rec``, ``variable_metadata``) share one
        predicate instead of three copies of the same hardcoded key lookup —
        a future aggregate construct (dict-of-struct, union, paginated
        collection) only needs to extend this one function."""
        return bool(fentry.get("_is_array"))

    @staticmethod
    def _collect_scalar_fields(
        var_children: list[dict], folder_path: str,
    ) -> tuple[dict[str, str], dict[str, dict[str, float]], dict[str, str]]:
        """Collect a folder's direct variable children as scalar fields.

        Returns (fields: field_name -> node_id, field_ranges: field_name ->
        {min?, max?}, child_paths: child_path -> field_name).
        """
        fields: dict[str, str] = {}
        field_ranges: dict[str, dict[str, float]] = {}
        child_paths: dict[str, str] = {}
        for child in var_children:
            field_name = child.get("display_name", "")
            child_path = f"{folder_path}/{field_name}"
            if field_name:
                node_id = child.get("node_id", "")
                fields[field_name] = node_id
                child_paths[child_path] = field_name
                child_range = {
                    k: child[k] for k in ("min", "max") if child.get(k) is not None
                }
                if child_range:
                    field_ranges[field_name] = child_range
        return fields, field_ranges, child_paths

    def _collect_nested_fields(
        self, folder_children: list[dict], folder_path: str, is_array: bool,
    ) -> dict[str, str]:
        """Collect nested struct children (folders already in folder_registry)."""
        nested_fields: dict[str, str] = {}
        if is_array:
            return nested_fields
        for child in folder_children:
            child_folder_path = f"{folder_path}/{child.get('name', '')}"
            if child_folder_path in self.folder_registry:
                nested_fields[child.get("name", "")] = child_folder_path
        return nested_fields

    @staticmethod
    def _sorted_element_paths(folder_path: str, folder_children: list[dict]) -> list[str]:
        """Collect array-of-struct element folder paths sorted by numeric index.

        Child names may be bare "[N]" or "Prefix[N]" — extract the index from
        the suffix rather than constructing it from scratch.
        """
        def _sort_key(c: dict) -> int:
            m = _ELEM_INDEX_RE.search(c.get("name", ""))
            return int(m.group(1)) if m else 0

        return [
            f"{folder_path}/{c.get('name', '')}"
            for c in sorted(folder_children, key=_sort_key)
        ]

    def _assemble_folder_entry(
        self,
        node: dict,
        folder_path: str,
        fields: dict[str, str],
        field_ranges: dict[str, dict[str, float]],
        child_paths: dict[str, str],
        nested_fields: dict[str, str],
        is_array: bool,
        folder_children: list[dict],
    ) -> dict[str, Any]:
        """Assemble the folder_registry entry dict for a single folder node."""
        entry_dict: dict[str, Any] = {
            "folder_path": folder_path,
            "display_name": node.get("name", ""),
            "node_id": node.get("node_id", ""),
            "fields": fields,
            "field_ranges": field_ranges,
            "_child_paths": child_paths,
            "_child_keys": {cp: build_var_key(self.name, cp) for cp in child_paths},
            "_nested_fields": nested_fields,
        }
        if is_array:
            entry_dict["_is_array"] = True
            entry_dict["_array_length"] = len(folder_children)
            element_paths = self._sorted_element_paths(folder_path, folder_children)
            entry_dict["_element_paths"] = element_paths
            # Reverse map so a leaf can be placed into its element in O(1).
            # Scanning _element_paths instead costs O(array length) string
            # comparisons on every datachange under a wide array.
            entry_dict["_element_index"] = {
                path: idx for idx, path in enumerate(element_paths)
            }
        return entry_dict

    def ancestor_folders(self, leaf_path: str) -> tuple[str, ...]:
        """Every registered folder composite *leaf_path* belongs to, innermost
        first: :meth:`ancestor_field_targets` without the steps, for the
        datachange path that only refreshes them whole."""
        return self._ancestors(leaf_path, with_steps=False)

    def ancestor_field_targets(self, leaf_path: str) -> tuple[tuple[str, tuple[str | int, ...]], ...]:
        """``(folder_path, steps)`` for every registered folder containing
        *leaf_path*, innermost first.

        A leaf lives in as many composites as it has registered folder
        ancestors, and a client may bind any one of them — so a change has to
        be patched into all of them, not just the outermost. *steps* is where
        the leaf sits in that folder's value, as ``_composite_leaf_steps``
        yields it: a ``str`` a dict field, an ``int`` an element's position
        in each array on the way — from ``_element_index``, not from the
        element's name, which differs by server (``[1]``, ``aArr[1]``). A
        leaf directly at an array level is in no element, so in no composite
        from that array outward.

        Recomputed per call rather than memoised per leaf: the walk is one
        dict lookup per path segment, while a memo would hold a tuple for
        every subscribed variable for the life of the datasource — tens of
        thousands of them on exactly the wide browses this path exists to
        make cheap.
        """
        return self._ancestors(leaf_path, with_steps=True)

    def _ancestors(self, leaf_path: str, *, with_steps: bool) -> tuple[Any, ...]:
        targets: list[Any] = []
        steps: tuple[str | int, ...] = ()
        # Walk the prefixes by slicing *leaf_path* rather than rebuilding each
        # one from a `parts[:i]` join: on the deep browses this exists to serve
        # that is O(depth) copies instead of O(depth**2) segments, per
        # datachange — the hottest loop in the product, which is also why the
        # steps are only built for a caller that wants them. *end* closes the
        # segment below the current prefix.
        end = len(leaf_path)
        cut = leaf_path.rfind("/")
        while cut > 0:
            folder_path = leaf_path[:cut]
            fentry = self.folder_registry.get(folder_path)
            if fentry is not None and self.is_aggregate_boundary(fentry):
                idx = fentry.get("_element_index", {}).get(leaf_path[:end])
                if idx is None:
                    break
                if with_steps:
                    steps = (idx, *steps)
            elif with_steps:
                steps = (leaf_path[cut + 1 : end], *steps)
            if fentry is not None:
                targets.append((folder_path, steps) if with_steps else folder_path)
            end = cut
            cut = leaf_path.rfind("/", 0, cut)
        return tuple(targets)

    def _wire_ancestor_map(self) -> None:
        """Rewrite _var_to_folder so every leaf variable points to its effective root ancestor.

        After _build_folder_maps has run, _var_to_folder maps each variable
        to its *immediate* parent folder.  For nested structs we need every
        leaf to map to the outermost ancestor so that a single datachange on a
        deeply nested variable triggers a complete rebuild of the top-level struct.

        Array-of-struct folders (``_is_array``) act as traversal boundaries: a
        leaf inside ``aAlarms/[0]/bRaised`` maps to ``aAlarms``, not to any
        ancestor struct that happens to contain ``aAlarms``.  This ensures the
        broadcast key matches the binding path used by components like AlarmList.
        """
        if not self._var_to_folder:
            return

        # Build child -> parent map in O(n) from data already stored in folder_registry
        folder_parent: dict[str, str] = {}
        for fpath, fentry in self.folder_registry.items():
            for child_fpath in fentry.get("_nested_fields", {}).values():
                folder_parent[child_fpath] = fpath
            for child_fpath in fentry.get("_element_paths", []):
                folder_parent[child_fpath] = fpath

        # No nesting at all — nothing to rewrite
        if not folder_parent:
            return

        # Cache root lookups so repeated calls for the same folder are O(1)
        root_cache: dict[str, str] = {}

        def _find_root(fpath: str) -> str:
            if fpath in root_cache:
                return root_cache[fpath]
            chain: list[str] = []
            current = fpath
            while current in folder_parent:
                # Stop at array-of-struct boundaries: the array folder is the
                # definitive binding target for components like AlarmList.
                # Traversing further up would map leaf changes to an unrelated
                # ancestor key that no component binds to.
                if self.is_aggregate_boundary(self.folder_registry.get(current, {})):
                    break
                chain.append(current)
                current = folder_parent[current]
            # current is the root
            for fp in chain:
                root_cache[fp] = current
            root_cache[fpath] = current
            return current

        # Rewrite every entry so it points to the root ancestor
        new_var_to_folder: dict[str, tuple[str, str]] = {}
        for child_path, (folder_path, field_name) in self._var_to_folder.items():
            root = _find_root(folder_path)
            new_var_to_folder[child_path] = (root, field_name)
        self._var_to_folder = new_var_to_folder

class DatasourceManager:
    """Manages all datasource configurations, registries, and caches.

    Thread-safety:
        All public methods that read or write ``self.datasources``,
        ``self._active_pages``, or any ``DatasourceEntry`` field are
        protected by ``self._lock`` (a ``threading.Lock``).

        Pay-load dicts are *copied* before releasing the lock so that
        callers receive a stable snapshot even if a concurrent write
        modifies the entry afterwards.

        OPC-UA I/O (``asyncua`` calls) is performed *outside* the lock to
        avoid holding it across blocking I/O.  The entry reference is
        captured under the lock, then the I/O proceeds without it.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.datasources: dict[str, DatasourceEntry] = {}  # name -> entry
        # client_id -> composite keys. Held for the life of a connection, so a
        # tuple of the datasource's own key strings (see known_keys): a pointer
        # per key, where a set of the client's strings costs several times that.
        self._active_pages: dict[str, tuple[str, ...]] = {}
        # The union of _active_pages as a count of the pages holding each key,
        # so one client's set_context costs its own keys rather than a fresh
        # union over every connected client.
        self._page_key_counts: dict[str, int] = {}
        # Folder composites the server's own consumers read — an alarm trigger
        # addressing an array element by index. Registered the same way a
        # client's page is, so `_is_key_wanted` is one question with one answer
        # instead of a client-page check plus a hardcoded guess at who else
        # might care.
        self._interest_keys: dict[str, set[str]] = {}  # owner -> set[composite_key]
        # Union of _interest_keys, rebuilt by its (rare) writer.
        self._interest_union: set[str] = set()
        self._enqueue_callback: Callable[..., None] | None = None
        self._value_listeners: list[Callable[[str, Any], None]] = []
        # Read composites changed during this event-loop turn, emitted once at
        # its end: key -> (datasource, entry, folder to rebuild or None, priority).
        self._composites_due: dict[str, tuple[str, DatasourceEntry, str | None, bool]] = {}
        # Ids of the cache containers made since the last emit, the only ones
        # a change may write into in place (see _writable).
        self._unshared_ids: set[int] = set()
        # name -> on-disk filename (no extension). Deterministic per name so
        # repeated saves overwrite the same file even when a sanitized-name
        # collision forced a different datasource onto a disambiguated one.
        self._name_to_filename: dict[str, str] = {}
        self.save_lock = asyncio.Lock()  # see save_async

    def set_enqueue_callback(self, fn: Callable[..., None]) -> None:
        self._enqueue_callback = fn

    def register_value_listener(self, fn: Callable[[str, Any], None]) -> None:
        """Register a callback invoked on every cache update with (key, value)."""
        with self._lock:
            if fn not in self._value_listeners:
                self._value_listeners.append(fn)

    def unregister_value_listener(self, fn: Callable[[str, Any], None]) -> None:
        """Remove a previously-registered listener. No-op if not registered."""
        with self._lock, contextlib.suppress(ValueError):
            self._value_listeners.remove(fn)

    def _get_datasource_entry(self, datasource: str) -> DatasourceEntry | None:
        with self._lock:
            return self.datasources.get(datasource)

    def _cache_set(self, entry: DatasourceEntry, key: str, value: Any) -> None:
        with self._lock:
            entry.cache[key] = value

    def _cache_pop(self, entry: DatasourceEntry, key: str) -> None:
        with self._lock:
            entry.cache.pop(key, None)

    def _emit_cache_update(self, key: str, value: Any, priority: bool = False) -> None:
        if self._enqueue_callback is not None:
            self._enqueue_callback(key, value, priority)
        with self._lock:
            listeners = tuple(self._value_listeners)
        for listener in listeners:
            try:
                listener(key, value)
            except Exception:
                logger.exception("Value listener error for key %s", key)

    def _patch_composite_leaf(
        self,
        entry: DatasourceEntry,
        key: str,
        steps: tuple[str | int, ...],
        value: Any,
        folder_path: str,
        built: bool,
    ) -> tuple[bool, str | None]:
        """Patch one leaf into a folder composite's cache entry in place.

        Returns ``(changed, elem_key)``; ``changed`` is False if the leaf
        already held this value (no-op — caller should skip broadcast),
        unless *built*: the composite was just built whole, from leaf caches
        that already hold it.
        *steps* is where the leaf sits in the composite, as
        ``_composite_leaf_steps`` yields it: a ``str`` a dict field, an
        ``int`` a list element, across any nesting of structs and arrays.

        For an array composite (*steps* starts at an element), *elem_key* is
        also set (when the element folder is registered): the element's own
        composite key — the per-element addressing {path, index} bindings
        resolve to — now caches the aggregate's element itself, and the caller
        broadcasts it. For every other case it is ``None``.

        The element is shared, not copied: a copy per leaf change cost 220 ms
        of event loop on an 8,000-leaf burst. A patch to either key is a patch
        to the one value both hold.

        The patch always happens — ``snapshot()`` serves folder composites
        straight out of the cache, so a composite nobody is watching still has
        to stay correct for the next client that connects. It writes in place
        only into containers made since the last emit, and copies any other
        on the way first (``_writable``): an emit hands the cached value out
        as it is, and what it handed out must not change.
        """
        with self._lock:
            node = entry.cache.get(key)
            for step in steps:
                node = _member(node, step)
            if node != value:
                _place(entry.cache, (key, *steps), value, self._writable)
            elif not built:
                return False, None
            index = steps[0]
            if not isinstance(index, int):
                return True, None
            root_fentry = entry.folder_registry.get(folder_path)
            elem_paths = root_fentry.get("_element_paths", []) if root_fentry else []
            if index >= len(elem_paths):
                return True, None
            elem_key = build_var_key(entry.name, elem_paths[index])
            entry.cache[elem_key] = entry.cache[key][index]
            return True, elem_key

    def _writable(self, node: Any, kind: type) -> Any:
        """*node* if a change may write into it in place, else a one-level
        copy of it (a new *kind* when it is not one) that it may.

        Copy on write. An emit hands the cached composite out as it is rather
        than deep-copying it every loop turn (8,000 leaves for a 250-slave
        EtherCAT array), so a container the cache holds is written in place
        only if it was made since the last emit: its id is in
        ``_unshared_ids``, which every emit clears. Any other is copied first,
        one level, so the untouched elements and sub-structs stay the very
        objects the emit carried, and a turn copies only the list, the touched
        elements and the sub-structs on the way. Caller holds the lock.
        """
        if isinstance(node, kind) and id(node) in self._unshared_ids:
            return node
        node = kind(node) if isinstance(node, kind) else kind()
        self._unshared_ids.add(id(node))
        return node

    def _build_folder_fields_snapshot(self, entry: DatasourceEntry, fentry: dict) -> dict[str, Any] | list[Any]:
        """Build a (possibly nested) snapshot of a struct folder's fields.

        For normal struct folders the return value is a dict of
        ``{field_name: value}``.  For array-of-struct folders (``_is_array``)
        it returns a **list** of such dicts, one per element — or of lists, for
        an element that is itself an array, as the engine's read builds it.

        Nested sub-struct fields are resolved recursively with no depth limit
        — the tree is user-authored and finite, so there's no infinite-
        recursion risk.
        """
        # ── Array-of-struct: return list of element snapshots ─────────────────
        if DatasourceEntry.is_aggregate_boundary(fentry):
            elements: list[Any] = []
            for elem_path in fentry.get("_element_paths", []):
                elem_entry = entry.folder_registry.get(elem_path)
                if elem_entry is not None:
                    elements.append(self._build_folder_fields_snapshot(entry, elem_entry))
                else:
                    elements.append({})
            return elements

        # ── Normal struct: build {field_name: value} dict ─────────────────────
        child_keys = fentry["_child_keys"]
        with self._lock:
            result: dict[str, Any] = {
                field_name: self._snapshot_copy(entry.cache[child_key])
                for child_path, field_name in fentry["_child_paths"].items()
                if (child_key := child_keys[child_path]) in entry.cache
            }

        # Include nested struct fields (resolved recursively)
        nested_fields = fentry.get("_nested_fields", {})
        for field_name, nested_folder_path in nested_fields.items():
            nested_fentry = entry.folder_registry.get(nested_folder_path)
            if nested_fentry is not None:
                result[field_name] = self._build_folder_fields_snapshot(
                    entry, nested_fentry,
                )

        return result

    @staticmethod
    def _walk(value: Any, leaf_fn: Callable[[Any], Any]) -> Any:
        """Recursively rebuild dict/list containers, applying *leaf_fn* to every
        non-container leaf.
        """
        if isinstance(value, dict):
            return {k: DatasourceManager._walk(v, leaf_fn) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [DatasourceManager._walk(v, leaf_fn) for v in value]
        return leaf_fn(value)

    @staticmethod
    def _snapshot_copy(value: Any) -> Any:
        """Return a safe copy for snapshot delivery.

        Scalars (bool, int, float, str, None) are immutable — no copy needed.
        Containers are copied recursively.  This is cheaper than copy.deepcopy
        because it skips the memo dict, type dispatch, and other deepcopy overhead.
        """
        # A scalar returns before the walk: a page-switch seed copies 70k of them.
        if not isinstance(value, (dict, list, tuple)):
            return value
        return DatasourceManager._walk(value, lambda v: v)

    def _append_snapshot_values(self, entry: DatasourceEntry, result: dict[str, Any]) -> None:
        valid_keys = entry._enabled_cache_keys
        for key, value in entry.cache.items():
            if key in valid_keys:
                result[key] = self._snapshot_copy(value)

    def _append_requested_cached_values(
        self,
        entry: DatasourceEntry,
        keys: set[str],
        result: dict[str, Any],
    ) -> None:
        valid_keys = entry._enabled_cache_keys
        for key in keys:
            if key in entry.cache and key in valid_keys:
                result[key] = self._snapshot_copy(entry.cache[key])

    # -- Load / save ---------------------------------------------------------

    def load_all(self) -> None:
        """Load all datasource configs from the active project's ``datasources/``.

        Datasources are keyed by the canonical ``name`` stored *inside* each
        file, not by filename — the filename is just where it happens to live
        on disk (see ``_assign_filename`` for why sanitized names can diverge
        from filenames on collision).
        """
        active_datasources_dir().mkdir(parents=True, exist_ok=True)
        with self._lock:
            self.datasources.clear()
            self._name_to_filename.clear()
        for path in sorted(active_datasources_dir().glob("*.json")):
            try:
                config = read_json(path)
                name = config.get("name", path.stem)
                config["name"] = name
                entry = DatasourceEntry(config)
                with self._lock:
                    self.datasources[name] = entry
                    self._name_to_filename[name] = path.stem
                # Load static variable values into cache
                if config.get("type") == "static":
                    self._load_static_values(entry)
            except Exception:
                logger.exception("Failed to load datasource config %s", path)
        with self._lock:
            entries = list(self.datasources.values())
        _build_metadata_soon(entries)

    # Map from lower-cased data_type to a zero-value for that type, in the
    # cache form a write leaves behind. Parity: opcuaBuiltinTypes.json
    # (staticDefault).
    _STATIC_DEFAULTS: ClassVar[dict[str, Any]] = {
        "bool": False,
        "boolean": False,
        "string": "",
        "int": 0,
        "integer": 0,
        "enumeration": 0,
        "int8": 0,
        "int16": 0,
        "int32": 0,
        "int64": 0,
        "uint": 0,
        "uint8": 0,
        "uint16": 0,
        "uint32": 0,
        "uint64": 0,
        "sbyte": 0,
        "byte": 0,
        "float": 0.0,
        "single": 0.0,
        "double": 0.0,
        "datetime": "1970-01-01T00:00:00.000Z",
        "date": "1970-01-01",
        "time": "00:00:00",
        "duration": 0.0,
        "timespan": 0.0,
    }

    def _static_default(self, var_entry: dict[str, Any]) -> Any:
        """Return a zero-value for *var_entry*, or an array of zeros if it's an array."""
        data_type = str(var_entry.get("data_type", ""))
        if data_type.lower() not in self._STATIC_DEFAULTS:
            logger.warning(
                "Unknown data_type %r for variable %r — defaulting to 0",
                data_type, var_entry.get("display_name", "?"),
            )
        default = self._STATIC_DEFAULTS.get(data_type.lower(), 0)
        if is_fixed_array(var_entry):
            return [default] * var_entry["array_length"]
        if is_dynamic_array(var_entry):
            return []
        return default

    @staticmethod
    def _same_shape(old: dict[str, Any], new: dict[str, Any]) -> bool:
        """True when two variable entries have the same simple type + array-ness."""
        old_type = to_simple_type(str(old.get("data_type", "")), is_array=is_array_shape(old))
        new_type = to_simple_type(str(new.get("data_type", "")), is_array=is_array_shape(new))
        return old_type == new_type

    def _load_static_values(
        self, entry: DatasourceEntry, old_entry: DatasourceEntry | None = None
    ) -> None:
        """For static datasources, initialise the cache with zero-values derived
        from each variable's data type and array length.

        Values are generated from the type definition — not read from the config —
        so they reset to a neutral zero-state on process startup (``old_entry=None``).
        When re-applying a config on a live server (``old_entry`` given — e.g. a
        settings-only save), a variable that still exists with the same shape
        carries forward its previous cached value instead of being zero-reset;
        only genuinely new or shape-changed variables get a fresh default.
        Runtime writes update only the in-memory cache and are never persisted
        to disk.
        """
        old_registry = old_entry.registry if old_entry is not None else {}
        for path, var_entry in entry.registry.items():
            if not is_subscribable(var_entry):
                continue
            key = build_var_key(entry.name, path)
            old_var_entry = old_registry.get(path)
            if old_var_entry is not None and self._same_shape(old_var_entry, var_entry):
                old_key = build_var_key(old_entry.name, path)
                if old_key in old_entry.cache:
                    with self._lock:
                        entry.cache[key] = self._snapshot_copy(old_entry.cache[old_key])
                    continue
            with self._lock:
                entry.cache[key] = self._static_default(var_entry)
        # Build struct / array-of-struct folder snapshots so that snapshot()
        # includes them for components bound to folder-level variables (e.g. AlarmList).
        for folder_path, fentry in entry.folder_registry.items():
            key = build_var_key(entry.name, folder_path)
            snapshot = self._build_folder_fields_snapshot(entry, fentry)
            if snapshot is not None:
                with self._lock:
                    entry.cache[key] = self._snapshot_copy(snapshot)

    def update_static_value(self, name: str, path: str, value: Any) -> None:
        """Update a static datasource variable in memory and broadcast to clients.

        Values are not persisted to disk — they reset to the config defaults on
        restart, matching the behaviour of the OPC-UA test server.

        If *path* ends with ``[N]`` (e.g. ``"MyArray[2]"``) the write targets
        element *N* of the array variable at the base path.
        """
        array_index: int | None = None
        base_path = path
        m = re.search(r"\[(\d+)\]$", path)
        if m:
            array_index = int(m.group(1))
            base_path = path[:m.start()]

        value = json_ready(value)
        with self._lock:
            entry = self.datasources.get(name)
            if entry is None:
                return
            var_entry = entry.registry.get(base_path)
            if var_entry is None:
                return

            if array_index is not None:
                if not is_array_shape(var_entry):
                    logger.debug(
                        "ignored indexed write to non-array %s[%d]", base_path, array_index
                    )
                    return
                if array_index_out_of_bounds(var_entry, array_index):
                    raise DatasourceValidationError(
                        f"Index {array_index} out of bounds for fixed array "
                        f"'{base_path}' (length {var_entry.get('array_length')})"
                    )
                fill = self._STATIC_DEFAULTS.get(
                    str(var_entry.get("data_type", "")).lower(), 0
                )
                key = build_var_key(name, base_path)
                current = entry.cache.get(key)
                if not isinstance(current, list):
                    current = []
                patched = list(current)
                while len(patched) <= array_index:
                    patched.append(fill)
                patched[array_index] = value
                entry.cache[key] = patched
                broadcast_key = key
                broadcast_value = patched
                logger.debug("write %s[%d] = %r", base_path, array_index, value)
            else:
                key = build_var_key(name, base_path)
                entry.cache[key] = value
                broadcast_key = key
                broadcast_value = value
                logger.debug("write %s = %r", base_path, value)

        # Broadcast the scalar update via WS
        self._emit_cache_update(broadcast_key, broadcast_value, priority=True)
        # If the updated variable is a field of a struct/array-of-struct folder,
        # rebuild and broadcast the parent folder snapshot too (e.g. AlarmList).
        if base_path in entry._var_to_folder:
            folder_path, _ = entry._var_to_folder[base_path]
            self._enqueue_folder_struct(name, entry, folder_path, priority=True)
            self._refresh_ancestors(name, entry, base_path, folder_path, True)

    def _assign_filename(self, name: str) -> str:
        """Return the on-disk filename (no extension) for *name*.

        Deterministic per name: a repeat save of the same datasource always
        reuses its existing filename. For a brand-new name, the sanitized
        name is used unless it collides with a *different* datasource's
        filename (e.g. "PLC 1" and "PLC/1" both sanitize to "PLC_1"), in
        which case a short hash of the real name disambiguates it so saving
        one never overwrites the other's file.
        """
        with self._lock:
            existing = self._name_to_filename.get(name)
            if existing is not None:
                return existing
            base = _safe_filename(name)
            used = set(self._name_to_filename.values())
            candidate = base
            if candidate in used:
                candidate = f"{base}_{hashlib.sha1(name.encode('utf-8')).hexdigest()[:8]}"
                n = 1
                while candidate in used:
                    candidate = f"{base}_{hashlib.sha1(name.encode('utf-8')).hexdigest()[:8]}_{n}"
                    n += 1
            self._name_to_filename[name] = candidate
            return candidate

    def save(self, name: str, config: dict[str, Any]) -> None:
        """Save a datasource config to disk and update in-memory state."""
        self._write(name, config)
        self.apply_config(name, config)

    async def save_async(
        self, name: str, config: dict[str, Any] | Callable[[], dict[str, Any]],
    ) -> DatasourceEntry | None:
        """``save`` for a coroutine on the event loop. Returns the entry it replaced.

        The write and the registry and metadata build run in worker threads;
        the swap and a static datasource's cache stay on the loop. That takes
        the file I/O, the replace retries while a virus scanner holds the file,
        and the build (150 ms for a large PLC, leaving a 17 ms loop gap) off
        the loop — not the JSON encoding, whose C encoder holds the GIL: ~100 ms
        for 30 MB.

        Saves wait for each other, and for ``delete_async``: two overlapping
        saves could otherwise apply the older config over the newer file, and a
        delete landing while the threads run would be undone by the swap. A
        read-modify-write passes *config* as a function, called once the lock
        is held, so it builds on whatever the previous save committed. A
        workspace MCP variable edit runs under ``save_lock`` too (see
        ``api.internal_api.run_variable_tool``). The sync ``save()`` (test
        server) and ``apply_config`` callers
        (``datasource_sync.apply_datasource_change``) do not take this lock.
        """
        # Shielded, lock inside: a request cancelled mid-write would otherwise
        # leave the new file on disk and the old entry in memory, and let the
        # next save start while this write is still running.
        return await asyncio.shield(self._save_locked(name, config))

    async def _save_locked(
        self, name: str, config: dict[str, Any] | Callable[[], dict[str, Any]],
    ) -> DatasourceEntry | None:
        async with self.save_lock:
            if callable(config):
                config = config()
            # Side by side: the build only reads *config*, and is applied
            # only once the write committed.
            _, entry = await asyncio.gather(
                asyncio.to_thread(self._write, name, config),
                asyncio.to_thread(_with_metadata, config),
            )
            old_entry = self.get(name)
            self.apply_config(name, config, entry)
            return old_entry

    def _write(self, name: str, config: dict[str, Any]) -> None:
        active_datasources_dir().mkdir(parents=True, exist_ok=True)
        filename = self._assign_filename(name)
        write_json(active_datasources_dir() / f"{filename}.json", config)

    def apply_config(
        self, name: str, config: dict[str, Any], entry: DatasourceEntry | None = None,
    ) -> DatasourceEntry:
        """Refresh the in-memory entry for *name* from *config* without writing to disk.

        For external writers (e.g. MCP tools) that have already persisted the
        config and just need the runtime registry / cache rebuilt so OPC-UA
        subscription deltas and snapshot keys are consistent. *entry* is
        ``DatasourceEntry(config)`` when the caller has built it already.
        """
        if entry is None:
            entry = DatasourceEntry(config)
            _build_metadata_soon([entry])
        with self._lock:
            old_entry = self.datasources.get(name)
            self.datasources[name] = entry
        if config.get("type") == "static":
            self._load_static_values(entry, old_entry)
            # A new or reshaped variable restarts at its default without a
            # change event, so hold its alarms to it the way startup does. A
            # local import, as the alarm manager imports this module.
            from services.alarm_manager import alarm_manager

            alarm_manager.evaluate_cached()
        return entry

    async def delete_async(self, name: str) -> None:
        """``delete`` for a coroutine, after any save in flight (see ``save_async``)."""
        async with self.save_lock:
            self.delete(name)

    def delete(self, name: str) -> None:
        """Remove a datasource from disk and memory."""
        with self._lock:
            filename = self._name_to_filename.pop(name, None) or _safe_filename(name)
        path = active_datasources_dir() / f"{filename}.json"
        if path.exists():
            path.unlink()
        with self._lock:
            self.datasources.pop(name, None)

    def get(self, name: str) -> DatasourceEntry | None:
        """Get a datasource entry by name."""
        with self._lock:
            return self.datasources.get(name)

    def list_all(self) -> list[dict[str, Any]]:
        """Return summary list of all datasources."""
        with self._lock:
            result = []
            for name, entry in self.datasources.items():
                total = len(entry.registry)
                enabled = sum(1 for e in entry.registry.values() if is_subscribable(e))
                result.append(
                    {
                        "name": name,
                        "type": entry.ds_type,
                        "connected": False,  # will be updated by opcua_pool
                        "variable_count": total,
                        "enabled_count": enabled,
                        "error": None,  # set by the API status overlay if any
                    }
                )
            return result

    # -- Variable cache updates ----------------------------------------------

    def update(self, datasource: str, path: str, value: Any, priority: bool = False) -> None:
        """Update cache for a variable and enqueue for WS broadcast.

        A datasource normalizes its own values where they enter (OPC-UA:
        ``opcua.values.normalize_value``); ``json_ready`` here only guarantees
        the cache stays JSON-ready whatever the writer.
        """
        value = json_ready(value)
        key = build_var_key(datasource, path)
        entry = self._get_datasource_entry(datasource)
        if entry is None:
            return
        self._cache_set(entry, key, value)
        self._emit_cache_update(key, value, priority)
        # If this is a child of a folder struct, also broadcast the aggregate
        if path in entry._var_to_folder:
            folder_path, _ = entry._var_to_folder[path]
            logger.debug("update: %s → folder broadcast for %s", path, folder_path)
            # Rebuilt whether or not anything reads the root: when the root is
            # an array of structs, this rebuild is also what feeds its element
            # keys, which `{path, index}` bindings read on their own. A plain
            # struct root nobody reads costs one rebuild per turn, not per leaf.
            self._emit_composite_soon(
                datasource, entry, build_var_key(datasource, folder_path), folder_path, priority,
            )
            self._refresh_ancestors(datasource, entry, path, folder_path, priority)

    def _refresh_ancestors(
        self, datasource: str, entry: DatasourceEntry, path: str, folder_path: str, priority: bool,
    ) -> None:
        """Refresh the composites holding leaf *path* that rebuilding
        *folder_path* does not: that rebuild caches *folder_path* and, for an
        array, each of its elements. `_var_to_folder` stops at the nearest
        array-of-struct boundary, so a struct *containing* that array (a
        widget's `actualPosition` holding `aGuardBoxesWcs`) is not covered."""
        rebuilt = entry.folder_registry.get(folder_path, {}).get("_element_index", {})
        for ancestor in entry.ancestor_folders(path):
            if ancestor != folder_path and ancestor not in rebuilt:
                self._refresh_folder_composite(datasource, entry, ancestor, priority)

    def _enqueue_folder_struct(
        self,
        datasource: str,
        entry: DatasourceEntry,
        folder_path: str,
        priority: bool = False,
    ) -> None:
        """Build field-map from child caches and enqueue for WS broadcast.

        For an array-of-struct folder, also caches/broadcasts each element
        under its own composite key (mirrors the fast path in
        ``update_struct_field``) so a ``{path, index}`` binding
        resolves per-element regardless of which write path touched it (this
        is the full-rebuild path used by static-datasource struct writes and
        by any OPC-UA leaf ``_node_to_field`` doesn't cover).

        Deliberately not gated on ``self._enqueue_callback``: the cache write
        is what ``snapshot()`` and ``set_context`` read, and ``_value_listeners``
        (alarms, historian) consume emits with no WS callback in sight. In a
        served process the callback is installed at import time (``main.py``),
        so the window this would cover does not exist there anyway.
        """
        with self._lock:
            fentry = entry.folder_registry.get(folder_path)
        if not fentry:
            return
        key = build_var_key(datasource, folder_path)
        fields_snapshot = self._build_folder_fields_snapshot(entry, fentry)
        if fields_snapshot is not None:
            # Cached as built and emitted as cached, like _emit_composite, and
            # each element key holds the aggregate's own element, as a patch
            # leaves it.
            with self._lock:
                entry.cache[key] = fields_snapshot
                self._unshared_ids.clear()
            self._emit_cache_update(key, fields_snapshot, priority)
            logger.debug(
                "_enqueue_folder_struct: broadcast key=%s len=%s",
                key,
                len(fields_snapshot) if isinstance(fields_snapshot, (list, dict)) else "?",
            )
            if DatasourceEntry.is_aggregate_boundary(fentry) and isinstance(fields_snapshot, list):
                elem_paths = fentry.get("_element_paths", [])
                for idx, elem_snapshot in enumerate(fields_snapshot):
                    if idx >= len(elem_paths):
                        break
                    elem_key = build_var_key(datasource, elem_paths[idx])
                    with self._lock:
                        entry.cache[elem_key] = elem_snapshot
                    self._emit_cache_update(elem_key, elem_snapshot, priority)

    def update_struct_field(
        self,
        datasource: str,
        path: str,
        steps: tuple[str | int, ...],
        value: Any,
        leaf_path: str | None = None,
        priority: bool = False,
    ) -> None:
        """Patch one leaf into the cached composite of folder *path*, where
        *steps* puts it (the engine's route, ``_struct_field_routes``), and
        into every ancestor composite someone reads or the cache holds.

        Also caches/broadcasts the leaf's own composite key (when *leaf_path*
        is given) alongside the folder-level aggregate: consumers like the
        datasource variable table read a struct/array-of-struct leaf's live
        value directly under its own key, not just the folder's rollup. For
        an array-of-struct field, the touched element is additionally
        cached under its own composite key (e.g. ``ds:Motors/[2]``), and
        broadcast once per loop turn, so a ``{path, index}`` binding on the
        array resolves per-element instead of re-rendering on any element's
        change.
        """
        value = json_ready(value)
        entry = self._get_datasource_entry(datasource)
        if entry is None:
            return
        if leaf_path is not None:
            leaf_key = build_var_key(datasource, leaf_path)
            with self._lock:
                changed = entry.cache.get(leaf_key) != value
                if changed:
                    entry.cache[leaf_key] = value
            if changed:
                self._emit_cache_update(leaf_key, value, priority)

        # The caller's own route is always patched, exactly as before: the
        # OPC-UA node map that produced ``(path, steps)`` is the authority on
        # where this leaf belongs. The extra ancestors are the ones that may
        # be built or skipped wholesale (see ``_patch_folder_composite``).
        shared_elem_key = self._patch_folder_composite(
            datasource, entry, path, steps, value, priority, may_rebuild=False,
        )
        if leaf_path is None:
            return

        # An ancestor neither read nor cached has nothing to patch or build:
        # passed over — most of a PLC leaf's eight or more. So is the element
        # folder the patch above just wrote through, whose key holds that very
        # element.
        def held(folder_path: str) -> bool:
            key = build_var_key(datasource, folder_path)
            if key == shared_elem_key:
                return False
            with self._lock:
                return key in entry.cache or self._wanted_locked(key)

        for folder_path, folder_steps in entry.ancestor_field_targets(leaf_path):
            if (folder_path, folder_steps) != (path, steps) and held(folder_path):
                self._patch_folder_composite(
                    datasource, entry, folder_path, folder_steps, value, priority,
                )

    def _refresh_folder_composite(
        self,
        datasource: str,
        entry: DatasourceEntry,
        folder_path: str,
        priority: bool,
    ) -> None:
        """Rebuild one ancestor composite of a leaf ``update()`` changed —
        one the OPC-UA node map does not route — whole from the child caches.

        Only a composite someone reads is rebuilt. One nobody reads is evicted
        instead: ``snapshot()``/``set_context`` serve cache entries verbatim,
        so a stale copy must not stay behind, and ``set_context`` reads an
        absent composite fresh. Rebuilding it here would cost the whole subtree
        per change — on a root folder of a large PLC (70,000 leaves) that is
        ~35 ms. A read one is rebuilt once per loop turn, not once per leaf.
        """
        key = build_var_key(datasource, folder_path)
        if self._is_key_wanted(key):
            self._emit_composite_soon(datasource, entry, key, folder_path, priority)
            return
        with self._lock:
            entry.cache.pop(key, None)

    def _patch_folder_composite(
        self,
        datasource: str,
        entry: DatasourceEntry,
        folder_path: str,
        steps: tuple[str | int, ...],
        value: Any,
        priority: bool,
        may_rebuild: bool = True,
    ) -> str | None:
        """Patch one ancestor composite's cache and broadcast it if wanted.
        Returns the key of the array element the patch changed, which now
        holds that element itself, or None.

        A composite that is not in the cache yet is never *patched* into
        existence: the result would be a struct holding only the fields that
        happened to tick since boot, and ``snapshot()`` serves cache entries
        verbatim, so the next client to connect would get that fragment.
        Either it is worth having — then it is built whole from the child
        caches — or nothing reads it and it is left absent, which is also what
        keeps a deep browse from holding one full nested copy of the value tree
        per ancestor level. ``set_context`` reads an absent composite fresh.

        *may_rebuild* is False for the caller's own route — the composite the
        node map names — which comes into existence whoever reads it: built
        whole from the child caches the first time, then patched. Not from
        this one field: a route that holds an array has leaves that route to
        that array instead, and patch it only once it is cached, so one that
        reported before it was would be missing from it until it changed —
        a static recipe array for good. Built here rather than through
        ``_enqueue_folder_struct``, which emits it and every element at once:
        it goes out with this turn's composites, if anything reads it, and
        only the touched element's key is set.
        """
        key = build_var_key(datasource, folder_path)
        with self._lock:
            wanted = self._wanted_locked(key)
            cached = key in entry.cache
        built = False
        if not cached:
            if may_rebuild:
                if wanted:
                    self._enqueue_folder_struct(datasource, entry, folder_path, priority)
                return None
            # A route the entry no longer registers (a save replaced it) is
            # patched in as before.
            fentry = entry.folder_registry.get(folder_path)
            if fentry is not None:
                whole = self._build_folder_fields_snapshot(entry, fentry)
                with self._lock:
                    built = entry.cache.setdefault(key, whole) is whole
                    if built:
                        # Made just now and handed out to no one yet: the patch
                        # below writes into it rather than copying it whole again.
                        self._unshared_ids.add(id(whole))
        changed, elem_key = self._patch_composite_leaf(
            entry, key, steps, value, folder_path, built,
        )
        if not changed:
            return None
        if wanted:
            self._emit_composite_soon(datasource, entry, key, None, priority)
        if elem_key is not None:
            self._emit_composite_soon(datasource, entry, elem_key, None, priority)
        return elem_key

    def _emit_composite_soon(
        self,
        datasource: str,
        entry: DatasourceEntry,
        key: str,
        rebuild_path: str | None,
        priority: bool,
    ) -> None:
        """Emit composite *key* — a read folder, an array element, the folder
        ``update()`` rebuilds — once, when this event-loop turn ends, however
        many of its leaves change in the turn: rebuilt from *rebuild_path*
        first when given, else handed out as patched (see ``_writable``).

        Emitted per leaf, a burst copied the whole composite each time: the
        initial values the 8,000 leaves of a just-subscribed EtherCAT slave
        array report at once cost 6 s of event loop that way, and the broadcast
        keeps only the last value per batch anyway. Off the loop (a test, a
        worker thread) there is no turn to wait for, so it is emitted now.

        A patched composite is current in the cache throughout; a rebuilt one
        is written there at turn end, so a cache reader in between gets the
        previous value and the emit then brings the new one. Value listeners
        (alarms, historian) hear either at turn end.
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._emit_composite(datasource, entry, key, rebuild_path, priority)
            return
        with self._lock:
            first = not self._composites_due
            due = self._composites_due.get(key)
            if due is not None:
                # A rebuild covers a patch; either flag keeps it priority.
                rebuild_path = rebuild_path or due[2]
                priority = priority or due[3]
            self._composites_due[key] = (datasource, entry, rebuild_path, priority)
        if first:
            loop.call_soon(self._emit_due_composites)

    def _emit_due_composites(self) -> None:
        with self._lock:
            due, self._composites_due = self._composites_due, {}
        for key, (datasource, entry, rebuild_path, priority) in due.items():
            # The due set is already swapped out: one failing emit must not
            # drop the rest of this turn's composites.
            try:
                self._emit_composite(datasource, entry, key, rebuild_path, priority)
            except Exception:
                logger.exception("Composite emit failed for key %s", key)

    def _emit_composite(
        self,
        datasource: str,
        entry: DatasourceEntry,
        key: str,
        rebuild_path: str | None,
        priority: bool,
    ) -> None:
        if rebuild_path is not None:
            self._enqueue_folder_struct(datasource, entry, rebuild_path, priority)
            return
        with self._lock:
            if key not in entry.cache:
                return
            # Handed out as cached, not copied: from here on a change copies
            # each container it writes into first (_writable), so the queued
            # payload never changes.
            value = entry.cache[key]
            self._unshared_ids.clear()
        self._emit_cache_update(key, value, priority)

    def _is_key_wanted(self, key: str) -> bool:
        """Whether any client page or server-side consumer reads *key*.

        The question the folder-composite gate asks: a leaf sits inside every
        one of its ancestor composites, and on a deeply nested browse
        (``PLC1/gPlc/…/stRobotActualData``) the outermost of those can hold tens
        of thousands of leaves — copying and shipping it on every datachange is
        pure waste when nothing reads it. "Reads it" means some client's active
        page binds the key (``set_client_page``) or one of the server's own
        consumers does (``set_interest_keys``).

        Array-of-struct folders are not special-cased by the callers: their
        elements are cached and emitted under their own composite keys whatever
        the answer here, so ``{path, index}`` bindings and an alarm addressing
        one element keep being fed. A composite nobody reads is patched in
        place or evicted, never left stale, so ``snapshot()`` and
        ``set_context`` stay right for the next client to connect.

        Membership tests against unions kept in step by the writers, rather
        than a scan of every reader's set: this runs once per ancestor per
        datachange, on the path the rest of this file exists to make cheap,
        while ``set_client_page``/``set_interest_keys`` fire on page navigation
        and config edits.
        """
        with self._lock:
            return self._wanted_locked(key)

    def _wanted_locked(self, key: str) -> bool:
        """``_is_key_wanted`` for a caller holding the lock."""
        return key in self._page_key_counts or key in self._interest_union

    def _count_page_keys(self, added: set[str], removed: set[str]) -> bool:
        """Apply one page's change to ``_page_key_counts``. Caller holds the lock.

        Returns whether the union changed: a key no page held is now held, or
        the last page holding one let it go.
        """
        counts = self._page_key_counts
        changed = False
        for key in added:
            held = counts.get(key, 0)
            counts[key] = held + 1
            changed = changed or held == 0
        for key in removed:
            held = counts[key] - 1
            if held:
                counts[key] = held
            else:
                del counts[key]
                changed = True
        return changed

    def seed_cached_values(self, updates: dict[str, Any], *, overwrite: bool = True) -> None:
        """Seed cache entries without broadcasting them to all clients; with
        *overwrite* False, a key the cache already holds keeps its value."""
        if not updates:
            return
        prefix: str | None = None
        entry: DatasourceEntry | None = None
        with self._lock:
            for key, value in updates.items():
                # Parsed once per run of one datasource's keys: per key, the
                # parse cost a page-switch read of 70k leaves 10 ms.
                if prefix is None or not key.startswith(prefix):
                    datasource, _path = parse_var_key(key)
                    prefix, entry = f"{datasource}:", self.datasources.get(datasource)
                if entry is None or (not overwrite and key in entry.cache):
                    continue
                entry.cache[key] = self._snapshot_copy(value)

    def snapshot(self) -> dict[str, Any]:
        """Return all enabled variable values across all datasources."""
        result: dict[str, Any] = {}
        with self._lock:
            for entry in self.datasources.values():
                self._append_snapshot_values(entry, result)
        return result

    def variable_metadata(self, keys: set[str] | None = None) -> dict[str, dict[str, Any]]:
        """Return shape metadata for every enabled variable/folder across all datasources,
        or, with *keys*, for what a client holding those composite keys reads: each
        key, its ancestor folders (the array an element sits in) and its descendants
        (a struct's members, an array's elements). A page context then costs a few
        bisects into a per-datasource cache instead of describing 100k variables.

        Each entry is keyed by composite key (``datasource:path``) and contains:
        - ``type``: the canonical structured type — array-ness, base/struct-name,
          and struct fields all live inside this single value (never a ``[]``
          string suffix or a ``struct[]`` discriminant):
            - scalar: ``{"kind": "scalar", "base": <simple type>, "array": bool,
              "length"?: <fixed-array length>}``
            - struct: ``{"kind": "struct", "name": <folder name>, "array": bool,
              "fields": [<field names>]}``
        - ``min``/``max``: scalar numeric variables only, when configured
        - ``writable``: scalars only — the variable's own ``writable`` flag
          (an OPC-UA node's access level, or the authored flag of a static /
          test-server variable); absent or not ``True`` reads as read-only
        - ``fieldRanges``: structs only — ``{field_name: {min?, max?}}`` for
          fields that have a configured range
        - ``position``: an array-of-struct element folder only — its index in
          the array, from 0 whatever the PLC's lower bound

        Disabled variables are excluded.
        """
        with self._lock:
            entries = list(self.datasources.values())
        result: dict[str, dict[str, Any]] = {}
        if keys is None:
            for entry in entries:
                result.update(entry.metadata_index[0])
            return result
        by_datasource: dict[str, list[str]] = {}
        for key in keys:
            ds_name, _path = parse_var_key(key)
            by_datasource.setdefault(ds_name, []).append(key)
        for entry in entries:
            wanted = by_datasource.get(entry.name)
            if not wanted:
                continue
            meta, sorted_keys = entry.metadata_index
            for key in wanted:
                if key in meta:
                    result[key] = meta[key]
                # Ancestors: the array an element sits in, the struct a leaf is a member of.
                colon = key.find(":")
                cut = key.rfind("/")
                while cut > colon:
                    parent = key[:cut]
                    if parent in meta:
                        result[parent] = meta[parent]
                    cut = key.rfind("/", 0, cut)
                # Descendants: a struct's members, an array's elements and theirs.
                prefix = key + "/"
                i = bisect_left(sorted_keys, prefix)
                while i < len(sorted_keys) and sorted_keys[i].startswith(prefix):
                    result[sorted_keys[i]] = meta[sorted_keys[i]]
                    i += 1
        return result


    def get_cached_values(self, keys: set[str]) -> dict[str, Any]:
        """Return cached values for a specific set of composite keys.

        Filtered like snapshot(): a disabled variable's value is never handed
        out, whoever names its key — `set_context` passes keys straight from
        the client.
        """
        result: dict[str, Any] = {}
        with self._lock:
            for entry in self.datasources.values():
                self._append_requested_cached_values(entry, keys, result)
        return result

    def get_entry(self, datasource: str, path: str) -> dict[str, Any] | None:
        """Look up a variable entry by datasource name and path."""
        entry = self._get_datasource_entry(datasource)
        if entry is None:
            return None
        result = entry.registry.get(path)
        if result is None:
            result = entry.folder_registry.get(path)
        return result

    def evict(self, datasource: str, path: str) -> None:
        """Remove a variable from the live cache."""
        key = build_var_key(datasource, path)
        entry = self._get_datasource_entry(datasource)
        if entry is None:
            return
        self._cache_pop(entry, key)

    # -- Priority subscription management ------------------------------------

    def known_keys(self, keys: Iterable[str]) -> set[str]:
        """The *keys* naming an enabled variable or a folder of a loaded datasource.

        The keys ``snapshot()`` answers, returned as the datasource's own
        strings. ``set_context`` keeps only these: its keys come from any
        client, and one naming nothing it can be given would be held for the
        life of the connection.
        """
        known: set[str] = set()
        with self._lock:
            for key in keys:
                entry = self.datasources.get(parse_var_key(key)[0])
                if entry is not None and (own := entry._enabled_cache_keys.get(key)) is not None:
                    known.add(own)
        return known

    def set_client_page(self, client_id: str, var_keys: set[str]) -> bool:
        """Record which composite keys are on a client's active page.

        Returns whether ``get_priority_keys()`` changed as a result.
        """
        keys = set(var_keys)
        with self._lock:
            previous = set(self._active_pages.pop(client_id, ()))
            if keys:
                self._active_pages[client_id] = tuple(keys)
            return self._count_page_keys(keys - previous, previous - keys)

    def clear_client(self, client_id: str) -> bool:
        """Forget a client's page. Returns whether ``get_priority_keys()`` changed."""
        with self._lock:
            return self._count_page_keys(set(), set(self._active_pages.pop(client_id, ())))

    def set_interest_keys(self, owner: str, var_keys: Iterable[str]) -> None:
        """Record the composite keys a server-side consumer reads.

        Only *folder composites* are gated on this (`_is_key_wanted`); a leaf
        key is emitted to `_value_listeners` whatever anyone's interest, so a
        consumer reading only leaves needs nothing here. What it covers is the
        aggregate an alarm addresses by index — a trigger bound to
        ``DS:Motors`` with ``index: 2`` reads the array folder's composite, and
        without a registration that composite stops being emitted as soon as no
        client page binds it, leaving the alarm evaluating nothing.

        Called by the alarm manager whenever its trigger map is rebuilt. An
        empty set deregisters.
        """
        keys = set(var_keys)
        with self._lock:
            if keys:
                self._interest_keys[owner] = keys
            else:
                self._interest_keys.pop(owner, None)
            self._interest_union = set().union(*self._interest_keys.values())

    def client_page_keys(self, client_id: str) -> set[str]:
        """The composite keys a client's active page promotes."""
        with self._lock:
            return set(self._active_pages.get(client_id, ()))

    def element_keys(self, key: str, positions: Iterable[int] | None = None) -> set[str]:
        """The composite keys of a struct array's elements — all of them, or
        the given positions (an index past the end is skipped). Empty for a
        key that is not an array-of-struct folder."""
        datasource, path = parse_var_key(key)
        entry = self._get_datasource_entry(datasource)
        folder = entry.folder_registry.get(path) if entry is not None else None
        if not folder or not DatasourceEntry.is_aggregate_boundary(folder):
            return set()
        element_paths = folder.get("_element_paths", [])
        chosen = range(len(element_paths)) if positions is None else [i for i in positions if 0 <= i < len(element_paths)]
        return {build_var_key(datasource, element_paths[i]) for i in chosen}

    def get_priority_keys(self) -> set[str]:
        """Return union of composite keys across all clients' active pages."""
        with self._lock:
            return set(self._page_key_counts)


def _with_metadata(config: dict[str, Any]) -> DatasourceEntry:
    """``DatasourceEntry(config)`` with its ``metadata_index`` built: what
    ``save_async`` runs in a worker thread."""
    entry = DatasourceEntry(config)
    _ = entry.metadata_index
    return entry


def _build_metadata_soon(entries: list[DatasourceEntry]) -> None:
    """Build each entry's ``metadata_index`` in a daemon thread, for a caller
    on the loop that built the entries itself. Their registries are never
    mutated (the loop fills only ``derived``, which the thread never reads),
    so the thread only reads; a ``set_context`` that reaches an entry first
    builds it there, or waits for the build already running."""

    def build() -> None:
        for entry in entries:
            try:
                _ = entry.metadata_index
            except Exception:
                logger.exception("Building the variable metadata of %s failed", entry.name)

    threading.Thread(target=build, name="datasource-metadata", daemon=True).start()


def _safe_filename(name: str) -> str:
    """Sanitize a datasource name for use as a filename."""
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name)


def validate_static_data_types(variables: list[Any]) -> None:
    """Reject an unrecognized ``data_type`` on any variable in *variables*.

    Only meaningful for ``static`` datasources: their runtime cache defaults
    come from ``DatasourceManager._STATIC_DEFAULTS``, so a type this table
    doesn't recognize (typo, unsupported name) would otherwise silently
    default to ``0`` with no indication the declared type wasn't understood.
    Loading a legacy file with an unknown type still warns-and-loads
    via ``_static_default`` — this is the save-time reject.
    """
    for path, entry in flatten_with_paths(variables):
        data_type = str(entry.get("data_type", ""))
        if data_type.lower() not in DatasourceManager._STATIC_DEFAULTS:
            raise DatasourceValidationError(
                f"Unknown data_type {data_type!r} for variable '{path}'"
            )


datasource_manager = DatasourceManager()
