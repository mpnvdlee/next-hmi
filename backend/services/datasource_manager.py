"""
Datasource manager — manages multiple datasource configs, each with its own
variable registry, value cache, and folder-struct maps.

Replaces the single-source VariableManager with a multi-datasource architecture
where each datasource has its own JSON file under the active project's
``datasources/`` directory.
"""

import base64
import contextlib
import hashlib
import logging
import re
import threading
from collections.abc import Callable
from typing import Any, ClassVar

from core.exceptions import DatasourceValidationError
from core.storage import active_datasources_dir, read_json, write_json
from core.value_types import (
    array_index_out_of_bounds,
    is_array_shape,
    is_dynamic_array,
    is_fixed_array,
    to_simple_type,
)
from models.datasource import (
    build_var_key,
    flatten_with_paths,
    is_subscribable,
    parse_var_key,
)

logger = logging.getLogger(__name__)

# Matches the ``[N]`` suffix that identifies indexed array-element folders.
# Compiled once at module level; shared by _build_folder_maps and _sort_key.
_ELEM_INDEX_RE = re.compile(r"\[(\d+)\]$")

# Matches the "idx:field" encoding client_pool._struct_field_routes() uses for
# a direct field of an array-of-struct element (mirrors the "array_elem"
# encoding in DatasourceOpcuaEngine.read_current_values).
_ARRAY_FIELD_RE = re.compile(r"^(\d+):(.+)$")


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
        self._enabled_cache_keys: set[str] = set()  # composite keys valid for snapshot
        self._build_registry()

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
            build_var_key(self.name, path) for path in subscribable_paths
        } | {
            build_var_key(self.name, fp) for fp in self.folder_registry
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
        (`is_array` — see D-ARRAY.1/D-ARRAY.4). Child names still carry the
        [N] index used to order/locate elements; bare "[N]" (OPC-UA style) or
        "Prefix[N]" (static-server style)."""
        return bool(node.get("is_array"))

    @staticmethod
    def is_aggregate_boundary(fentry: dict) -> bool:
        """True when *fentry* (a ``folder_registry`` entry) is an opaque
        traversal/broadcast boundary — currently only array-of-struct folders
        (§10.2). The one flag this checks today (``_is_array``) is set by
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
            entry_dict["_element_paths"] = self._sorted_element_paths(
                folder_path, folder_children
            )
        return entry_dict

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
        self._active_pages: dict[str, set[str]] = {}  # client_id -> set[composite_key]
        self._enqueue_callback: Callable[..., None] | None = None
        self._value_listeners: list[Callable[[str, Any], None]] = []
        # name -> on-disk filename (no extension). Deterministic per name so
        # repeated saves overwrite the same file even when a sanitized-name
        # collision forced a different datasource onto a disambiguated one.
        self._name_to_filename: dict[str, str] = {}

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

    def _snapshot_struct_value_for_broadcast(
        self,
        entry: DatasourceEntry,
        key: str,
        field_name: str,
        value: Any,
        folder_path: str | None = None,
    ) -> tuple[dict[str, Any] | list[Any], str | None, dict[str, Any] | None] | None:
        """Patch a single field into a struct/array-of-struct cache entry in place.

        Returns ``(aggregate_snapshot, elem_key, elem_snapshot)``, or None if
        the field already held this value (no-op — caller should skip
        broadcast). *field_name* encodes where the leaf lives, mirroring the
        encodings client_pool._struct_field_routes()/read_current_values() use:
        - ``"name"``        — direct field of a flat struct (cache is a dict)
        - ``"a/b/name"``    — field of a nested sub-struct (cache is nested dicts)
        - ``"idx:name"``    — direct field of array-of-struct element *idx*
          (cache is a list of dicts)

        For the array-of-struct case, *elem_key*/*elem_snapshot* are also
        populated (when *folder_path* is given and the element folder is
        registered) so the caller can additionally cache/broadcast that one
        element under its own composite key — the per-element addressing
        {path, index} bindings resolve to (§10.5) — alongside the aggregate.
        For every other case they are ``None``.
        """
        with self._lock:
            current = entry.cache.get(key)
            m = _ARRAY_FIELD_RE.match(field_name)
            if m:
                index, leaf = int(m.group(1)), m.group(2)
                if not isinstance(current, list):
                    current = []
                    entry.cache[key] = current
                while len(current) <= index:
                    current.append({})
                elem = current[index]
                if not isinstance(elem, dict):
                    elem = {}
                    current[index] = elem
                parts = leaf.split("/")
                node = elem
                for part in parts[:-1]:
                    nxt = node.get(part)
                    if not isinstance(nxt, dict):
                        nxt = {}
                        node[part] = nxt
                    node = nxt
                leaf_name = parts[-1]
                if node.get(leaf_name) == value:
                    return None
                node[leaf_name] = value
                elem_snapshot = self._snapshot_copy(elem)
                elem_key: str | None = None
                if folder_path is not None:
                    root_fentry = entry.folder_registry.get(folder_path)
                    elem_paths = root_fentry.get("_element_paths", []) if root_fentry else []
                    if 0 <= index < len(elem_paths):
                        elem_key = build_var_key(entry.name, elem_paths[index])
                        entry.cache[elem_key] = elem_snapshot
                # Copy before unlock so queued payload cannot be mutated later.
                return self._snapshot_copy(current), elem_key, elem_snapshot

            if not isinstance(current, dict):
                current = {}
                entry.cache[key] = current
            parts = field_name.split("/")
            node = current
            for part in parts[:-1]:
                nxt = node.get(part)
                if not isinstance(nxt, dict):
                    nxt = {}
                    node[part] = nxt
                node = nxt
            leaf = parts[-1]
            if node.get(leaf) == value:
                return None
            node[leaf] = value
            # Copy before unlock so queued payload cannot be mutated later.
            return self._snapshot_copy(current), None, None

    def _build_folder_fields_snapshot(self, entry: DatasourceEntry, fentry: dict) -> dict[str, Any] | list[dict[str, Any]]:
        """Build a (possibly nested) snapshot of a struct folder's fields.

        For normal struct folders the return value is a dict of
        ``{field_name: value}``.  For array-of-struct folders (``_is_array``)
        it returns a **list** of such dicts, one per element.

        Nested sub-struct fields are resolved recursively with no depth limit
        — the tree is user-authored and finite, so there's no infinite-
        recursion risk (§1.7/§6.2).
        """
        # ── Array-of-struct: return list of element snapshots ─────────────────
        if DatasourceEntry.is_aggregate_boundary(fentry):
            elements: list[dict[str, Any]] = []
            for elem_path in fentry.get("_element_paths", []):
                elem_entry = entry.folder_registry.get(elem_path)
                if elem_entry is not None:
                    snap = self._build_folder_fields_snapshot(entry, elem_entry)
                    elements.append(snap if isinstance(snap, dict) else {})
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

        Shared traversal for _snapshot_copy (passthrough leaf) and _coerce
        (type-coercing leaf) — they differ only in what happens at the leaves.
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
        for key in keys:
            if key in entry.cache:
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

    # Map from lower-cased data_type to a zero-value for that type.
    _STATIC_DEFAULTS: ClassVar[dict[str, Any]] = {
        "bool": False,
        "boolean": False,
        "string": "",
        "int": 0,
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
        "double": 0.0,
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

        value = self._coerce(value)
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
        active_datasources_dir().mkdir(parents=True, exist_ok=True)
        filename = self._assign_filename(name)
        write_json(active_datasources_dir() / f"{filename}.json", config)
        self.apply_config(name, config)

    def apply_config(self, name: str, config: dict[str, Any]) -> DatasourceEntry:
        """Refresh the in-memory entry for *name* from *config* without writing to disk.

        For external writers (e.g. MCP tools) that have already persisted the
        config and just need the runtime registry / cache rebuilt so OPC-UA
        subscription deltas and snapshot keys are consistent.
        """
        entry = DatasourceEntry(config)
        with self._lock:
            old_entry = self.datasources.get(name)
            self.datasources[name] = entry
        if config.get("type") == "static":
            self._load_static_values(entry, old_entry)
        return entry

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

    @staticmethod
    def _coerce_leaf(value: Any) -> Any:
        if value is None or isinstance(value, (bool, int, float, str)):
            return value
        # bytes -> base64 string to keep it compact (common for OPC-UA byte strings)
        if isinstance(value, (bytes, bytearray)):
            return base64.b64encode(value).decode()
        # Anything else: convert to string representation
        return str(value)

    @staticmethod
    def _coerce(value: Any) -> Any:
        """Recursively coerce a value to a JSON-serialisable Python primitive.

        OPC-UA types such as LocalizedText, NodeId, QualifiedName, and Variant
        are not JSON-serialisable by default.  Convert them to their string
        representation so the cache and WS broadcast never contain exotic types.
        """
        return DatasourceManager._walk(value, DatasourceManager._coerce_leaf)

    def update(self, datasource: str, path: str, value: Any, priority: bool = False) -> None:
        """Update cache for a variable and enqueue for WS broadcast."""
        value = self._coerce(value)
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
            self._enqueue_folder_struct(datasource, entry, folder_path, priority)

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
        ``update_struct_field`` — §10.5) so a ``{path, index}`` binding
        resolves per-element regardless of which write path touched it (this
        is the full-rebuild path used by static-datasource struct writes and
        by any OPC-UA leaf ``_node_to_field`` doesn't cover).
        """
        with self._lock:
            fentry = entry.folder_registry.get(folder_path)
        if not fentry or self._enqueue_callback is None:
            return
        key = build_var_key(datasource, folder_path)
        fields_snapshot = self._build_folder_fields_snapshot(entry, fentry)
        if fields_snapshot is not None:
            # Also store in cache so snapshot() picks it up
            with self._lock:
                entry.cache[key] = self._snapshot_copy(fields_snapshot)
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
                        entry.cache[elem_key] = self._snapshot_copy(elem_snapshot)
                    self._emit_cache_update(elem_key, elem_snapshot, priority)

    def update_struct_field(
        self,
        datasource: str,
        path: str,
        field_name: str,
        value: Any,
        leaf_path: str | None = None,
        priority: bool = False,
    ) -> None:
        """Update a single field within a struct variable's cache entry.

        Also caches/broadcasts the leaf's own composite key (when *leaf_path*
        is given) alongside the folder-level aggregate: consumers like the
        datasource variable table read a struct/array-of-struct leaf's live
        value directly under its own key, not just the folder's rollup. For
        an array-of-struct field, the touched element is additionally
        cached/broadcast under its own composite key (e.g. ``ds:Motors/[2]``)
        so a ``{path, index}`` binding on the array resolves per-element
        instead of re-rendering on any element's change (§10.5).
        """
        value = self._coerce(value)
        key = build_var_key(datasource, path)
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
        broadcast = self._snapshot_struct_value_for_broadcast(
            entry, key, field_name, value, folder_path=path,
        )
        if broadcast is None:
            return
        enqueue_val, elem_key, elem_snapshot = broadcast
        self._emit_cache_update(key, enqueue_val, priority)
        if elem_key is not None:
            self._emit_cache_update(elem_key, elem_snapshot, priority)

    def seed_cached_values(self, updates: dict[str, Any]) -> None:
        """Seed cache entries without broadcasting them to all clients."""
        if not updates:
            return
        with self._lock:
            for key, value in updates.items():
                datasource, _path = parse_var_key(key)
                entry = self.datasources.get(datasource)
                if entry is None:
                    continue
                entry.cache[key] = self._snapshot_copy(value)

    def snapshot(self) -> dict[str, Any]:
        """Return all enabled variable values across all datasources."""
        result: dict[str, Any] = {}
        with self._lock:
            for entry in self.datasources.values():
                self._append_snapshot_values(entry, result)
        return result

    def variable_metadata(self) -> dict[str, dict[str, Any]]:
        """Return shape metadata for every enabled variable/folder across all datasources.

        Each entry is keyed by composite key (``datasource:path``) and contains:
        - ``type``: the canonical structured type — array-ness, base/struct-name,
          and struct fields all live inside this single value (never a ``[]``
          string suffix or a ``struct[]`` discriminant):
            - scalar: ``{"kind": "scalar", "base": <simple type>, "array": bool,
              "length"?: <fixed-array length>}``
            - struct: ``{"kind": "struct", "name": <folder name>, "array": bool,
              "fields": [<field names>]}``
        - ``min``/``max``: scalar numeric variables only, when configured
        - ``fieldRanges``: structs only — ``{field_name: {min?, max?}}`` for
          fields that have a configured range

        Disabled variables are excluded.
        """
        result: dict[str, dict[str, Any]] = {}
        with self._lock:
            for entry in self.datasources.values():
                # Scalar / plain-array variables
                for path, var_entry in entry.registry.items():
                    if not is_subscribable(var_entry):
                        continue
                    key = build_var_key(entry.name, path)
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
                    meta: dict[str, Any] = {"type": var_type}
                    if var_entry.get("min") is not None:
                        meta["min"] = var_entry["min"]
                    if var_entry.get("max") is not None:
                        meta["max"] = var_entry["max"]
                    result[key] = meta
                # Struct and array-of-struct folders
                for folder_path, fentry in entry.folder_registry.items():
                    key = build_var_key(entry.name, folder_path)
                    is_array = DatasourceEntry.is_aggregate_boundary(fentry)
                    # Collect field names from direct children + nested structs
                    fields = list(fentry.get("fields", {}).keys())
                    fields += list(fentry.get("_nested_fields", {}).keys())
                    field_ranges = fentry.get("field_ranges", {})
                    # For arrays, use fields from the first element
                    if is_array:
                        elem_paths = fentry.get("_element_paths", [])
                        if elem_paths:
                            first_elem = entry.folder_registry.get(elem_paths[0])
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
        return result

    def get_cached_values(self, keys: set[str]) -> dict[str, Any]:
        """Return cached values for a specific set of composite keys.

        Unlike snapshot(), this does not filter by enabled status - the caller
        has explicitly requested these keys (e.g. priority subscription browse),
        so we return any cached value we have regardless of enabled state.
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

    def set_client_page(self, client_id: str, var_keys: set[str]) -> None:
        """Record which composite keys are on a client's active page."""
        with self._lock:
            self._active_pages[client_id] = set(var_keys)

    def clear_client(self, client_id: str) -> None:
        with self._lock:
            self._active_pages.pop(client_id, None)

    def get_priority_keys(self) -> set[str]:
        """Return union of composite keys across all clients' active pages."""
        with self._lock:
            result: set[str] = set()
            for keys in self._active_pages.values():
                result |= keys
            return result


def _safe_filename(name: str) -> str:
    """Sanitize a datasource name for use as a filename."""
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name)


def validate_static_data_types(variables: list[Any]) -> None:
    """Reject an unrecognized ``data_type`` on any variable in *variables*.

    Only meaningful for ``static`` datasources: their runtime cache defaults
    come from ``DatasourceManager._STATIC_DEFAULTS``, so a type this table
    doesn't recognize (typo, unsupported name) would otherwise silently
    default to ``0`` with no indication the declared type wasn't understood
    (§1.6). Loading a legacy file with an unknown type still warns-and-loads
    via ``_static_default`` — this is the save-time reject.
    """
    for path, entry in flatten_with_paths(variables):
        data_type = str(entry.get("data_type", ""))
        if data_type.lower() not in DatasourceManager._STATIC_DEFAULTS:
            raise DatasourceValidationError(
                f"Unknown data_type {data_type!r} for variable '{path}'"
            )


datasource_manager = DatasourceManager()
