from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field, replace
from typing import Any

from core.page_index import collect_dialog_ids, collect_dialog_property_keys
from core.page_index import collect_page_ids as _index_collect_page_ids
from core.stdlib_manifest import CatalogVersion, stdlib_catalog
from core.storage import (
    WIDGET_BUILD_DIR,
    active_components_dir,
    active_config_dir,
    active_icons_dir,
    active_images_dir,
    active_pages_dir,
    active_project_root,
    active_translations_dir,
    read_csv,
    read_json,
)
from core.value_types import to_simple_type

from . import vartype
from .ids import is_valid_page_id
from .report import ValidationReport

WIDGET_SCHEMAS_PATH = WIDGET_BUILD_DIR / "widget-schemas.json"

# Property-source keys that may appear at any property value.
PROPERTY_SOURCE_KEYS = frozenset({
    "$static",
    "$var",
    "$loc",
    "$if",
    "$switch",
    "$compare",
    "$random",
    "$user",
    "$userGroups",
    "$device",
    "$time",
    "$urlParam",
    "$pageIsActive",
    "$widgetProp",
    "$componentProp",
    "$languages",
    "$stringExpr",
    "$http",
    "$alarmCount",
    "$page",
    "$viewport",
    "$result",
    "$recipe",
    "$recipeList",
})

# Atomic schema field types that admit type checking on static literals.
# Mirrors the runtime value types in docs/dev/architecture/value-types.md; `icon` and
# `image` are structured ({type,name} / {path}) and validated via their `$static` payloads.
_ATOMIC_TYPE_CHECKS = {
    "string": (str,),
    "integer": (int,),
    "float": (int, float),
    "boolean": (bool,),
    "color": (str,),
    "datetime": (str,),
    "date": (str,),
    "time": (str,),
    "duration": (str, int, float),
}

# Property keys every widget node accepts regardless of its declared schema.
# WidgetRenderer reads them straight off `node.properties` before it consults the
# registry entry, so they are honoured on custom widgets and `$component:`
# instances too — neither of which carries them in its schema. Mirrors
# VISIBILITY_SCHEMA in frontend/src/hmi/registry/widgetRegistry.tsx; parity is
# fixture-tested in test_structure_parity.py.
_UNIVERSAL_PROPERTY_KEYS: frozenset[str] = frozenset({"visible", "interactable"})

_COMPONENT_TYPE_PREFIX = "$component:"


def _component_id(widget_type: str) -> str:
    return widget_type[len(_COMPONENT_TYPE_PREFIX):]


@dataclass
class ValidationContext:
    widget_schemas: dict
    # datasource -> variable path -> VarType (see vartype.py). An empty inner
    # dict for a known datasource means "no typed variables collected yet" —
    # existence/type checks are skipped for it, mirroring the pre-typed
    # behaviour (best-effort, never false-positives a fresh/unstarted pool).
    datasource_registry: dict[str, dict[str, dict]] = field(default_factory=dict)
    # datasource -> declared type ('opcua-client' | 'static' | 'opcua-test-server').
    # A test server is a simulator the product *serves*, never a binding target:
    # bindings must go through an opcua-client pointed at it (see validate_var_ref).
    datasource_types: dict[str, str] = field(default_factory=dict)
    # Group ids declared in users.json — what an alarm's ack_groups, a user's
    # membership and the config-access setting are checked against. Empty means
    # the file wasn't readable, in which case those checks are skipped rather
    # than reporting every group as unknown.
    user_groups: frozenset[str] = field(default_factory=frozenset)
    page_ids: set[str] = field(default_factory=set)
    component_ids: set[str] = field(default_factory=set)
    dialog_ids: set[str] = field(default_factory=set)
    # Component/dialog id -> the property names its interface declares. A missing
    # id means the interface wasn't collected (fresh checkout / deploy runtime) —
    # best-effort, skip rather than false-positive an unknown-property warning.
    component_property_keys: dict[str, frozenset[str]] = field(default_factory=dict)
    # Component id -> the slot names its ComponentSlot widgets declare. A child
    # of an instance carries the slot it fills; a name not in this set means the
    # definition dropped that slot and the child now renders in the first one.
    component_slots: dict[str, frozenset[str]] = field(default_factory=dict)
    dialog_property_keys: dict[str, frozenset[str]] = field(default_factory=dict)
    # Keys of the active (Default) translation dictionary.
    translation_keys: frozenset[str] = field(default_factory=frozenset)
    # Curated built-in icon ids — mirrors frontend/src/shared/config/iconAllowlist.ts.
    builtin_icons: frozenset[str] = field(default_factory=lambda: _BUILTIN_ICON_IDS)
    # Relative asset paths ("icons/<name>" / "images/<name>") under the active project.
    icon_assets: frozenset[str] = field(default_factory=frozenset)
    image_assets: frozenset[str] = field(default_factory=frozenset)
    # declared_property_keys() memo, keyed by widget type — a node walk resolves
    # the same widget type repeatedly (e.g. every Button on a page), and the
    # result only depends on widget_type for the lifetime of this context.
    _declared_keys_cache: dict[str, frozenset[str]] = field(default_factory=dict, repr=False)

    def widget_schema_for(self, widget_type: str) -> dict | None:
        """Field-level schema for ``widget_type``, or None if the type is unknown.

        Does NOT include ``_UNIVERSAL_PROPERTY_KEYS`` — a caller checking whether
        a property *name* is declared (rather than looking up its field schema)
        wants ``declared_property_keys()`` instead.
        """
        if widget_type.startswith(_COMPONENT_TYPE_PREFIX):
            # User-defined component reference. When the component registry is
            # known (non-empty), reject references to components that no longer
            # exist — mirrors the "unknown widget type" check for builtins. An
            # empty registry means it wasn't collected (fresh checkout / deploy
            # runtime), so trust the type rather than block the save.
            component_id = _component_id(widget_type)
            if self.component_ids and component_id not in self.component_ids:
                return None
            return {}
        # Custom widgets take precedence over builtins of the same name, and a
        # name collision across custom-widget groups resolves to the last entry
        # in manifest order — both mirror the frontend loader, which overwrites
        # any registry entry sharing the widget's name and iterates groups in
        # the same (alphabetical) order the manifest is built in.
        custom = self.widget_schemas.get("custom", {})
        # custom keys are "<Group>/<Name>" but widget types in pages are "<Name>".
        matched: dict | None = None
        for key, entry in custom.items():
            if key.split("/")[-1] == widget_type:
                matched = entry.get("schema", {})
        if matched is not None:
            return matched
        builtin = self.widget_schemas.get("builtin", {})
        if widget_type in builtin:
            return builtin[widget_type].get("schema", {})
        return None

    def declared_property_keys(self, widget_type: str, schema: dict) -> frozenset[str] | None:
        """Property names the target's interface declares, or None when no
        interface is known.

        Takes the schema already resolved by ``widget_schema_for`` so a node walk
        doesn't resolve twice. An empty schema is the schema-less pass (feature
        widget, empty manifest) — "interface unknown", not "declares nothing".
        """
        if widget_type.startswith(_COMPONENT_TYPE_PREFIX):
            declared = self.component_property_keys.get(_component_id(widget_type))
            return None if declared is None else declared | _UNIVERSAL_PROPERTY_KEYS
        if not schema:
            return None
        cached = self._declared_keys_cache.get(widget_type)
        if cached is None:
            cached = frozenset(schema) | _UNIVERSAL_PROPERTY_KEYS
            self._declared_keys_cache[widget_type] = cached
        return cached


def _warn_unknown_property(report: ValidationReport, path: str, key: str, target: str) -> None:
    report.warn(path, f"property '{key}' is not defined on {target}", severity="warning", code="prop-unknown")


_EMPTY_MANIFEST: dict = {"version": 2, "builtin": {}, "custom": {}}
_manifest_cache: tuple[tuple[int, CatalogVersion], dict] | None = None


def load_widget_manifest() -> dict:
    """Read the generated v2 manifest. Empty stub if absent, stale, or invalid.

    Returning an empty stub rather than raising keeps the system bootable in
    fresh checkouts where Vite hasn't run; validators degrade to type-existence
    checks only.

    Stdlib widgets are overlaid onto ``builtin`` here rather than baked into
    ``widget-schemas.json`` by the compiler. They ship with the product, so they
    have to be visible even in a runtime home that has never compiled — and
    keeping them out of the file leaves it describing exactly what that compile
    produced.

    Stdlib wins a name clash. The stdlib manifest is built from, and ships with,
    the running bundle; ``widget-schemas.json`` lives in the runtime home and
    survives upgrades, so it can still describe a registry entry for a widget
    that has since moved out to the stdlib. Letting that stale row win would
    shadow the shipped widget with an older schema.

    Cached on both inputs' mtimes — every page-write validation reads this, so
    the stdlib catalog and its version come back from one call rather than
    re-resolving the manifest path and re-stat'ing both halves per lookup.
    """
    global _manifest_cache
    stdlib_version, stdlib_entries = stdlib_catalog()
    try:
        mtime = WIDGET_SCHEMAS_PATH.stat().st_mtime_ns
    except FileNotFoundError:
        mtime = 0
    key = (mtime, stdlib_version)
    if _manifest_cache is not None and _manifest_cache[0] == key:
        return _manifest_cache[1]

    manifest: dict = _EMPTY_MANIFEST
    if mtime:
        try:
            raw = json.loads(WIDGET_SCHEMAS_PATH.read_text(encoding="utf-8"))
        except Exception:
            raw = None
        if isinstance(raw, dict) and raw.get("version") == _EMPTY_MANIFEST["version"]:
            manifest = raw

    builtin = manifest.get("builtin")
    merged = {
        **manifest,
        "builtin": {
            **(builtin if isinstance(builtin, dict) else {}),
            **stdlib_entries,
        },
    }
    _manifest_cache = (key, merged)
    return merged


# config.json is read once and cached by mtime, so a single build_context() — and a
# multi-page save batch, which never rewrites config.json — parses it at most once;
# both page-group ids and dialog ids derive from this one read. Process-local, like
# the manifest/datasource caches above.
_config_cache: tuple[int, dict] | None = None


def _read_config() -> dict:
    """Parsed ``config.json`` as a dict, mtime-cached. ``{}`` when absent/invalid."""
    global _config_cache
    config_path = active_config_dir() / "config.json"
    try:
        config_mtime = config_path.stat().st_mtime_ns
    except FileNotFoundError:
        return {}
    if _config_cache is not None and _config_cache[0] == config_mtime:
        return _config_cache[1]
    try:
        raw = read_json(config_path)
    except Exception:
        return {}
    doc = raw if isinstance(raw, dict) else {}
    _config_cache = (config_mtime, doc)
    return doc


def _page_stems() -> frozenset[str]:
    pages_dir = active_pages_dir()
    if not pages_dir.exists():
        return frozenset()
    return frozenset(
        p.stem for p in pages_dir.glob("*.json") if not p.stem.startswith("__")
    )


def _collect_page_ids() -> set[str]:
    # Page ids = page-file stems union page-group ids from the config index.
    pages = _read_config().get("pages")
    ids: set[str] = set(_page_stems())
    ids |= _index_collect_page_ids(pages if isinstance(pages, list) else [])
    return ids


_ComponentInterfaces = tuple[dict[str, frozenset[str]], dict[str, frozenset[str]]]

_component_interface_cache: tuple[frozenset[tuple[str, int]], _ComponentInterfaces] | None = None

# Slot name a ComponentSlot falls back to when its ``slot`` property is blank.
# Mirrors DEFAULT_SLOT_KEY in frontend/src/hmi/components/ComponentSlot/slotKey.ts.
_DEFAULT_SLOT_KEY = "content"


def _slot_nodes(nodes: Any, path: str = "/children") -> list[tuple[str, str]]:
    """(JSON pointer to its ``slot`` property, slot name) per ``ComponentSlot`` in a tree."""
    found: list[tuple[str, str]] = []
    if not isinstance(nodes, list):
        return found
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            continue
        node_path = f"{path}/{index}"
        if node.get("type") == "ComponentSlot":
            props = node.get("properties")
            raw = props.get("slot") if isinstance(props, dict) else None
            key = raw.strip() if isinstance(raw, str) and raw.strip() else _DEFAULT_SLOT_KEY
            found.append((f"{node_path}/properties/slot", key))
        found.extend(_slot_nodes(node.get("children"), f"{node_path}/children"))
    return found


def _collect_slot_keys(nodes: Any, out: set[str]) -> None:
    """Slot names declared by the ``ComponentSlot`` widgets in a definition's tree."""
    out.update(key for _, key in _slot_nodes(nodes))


def _declared_slot_properties(component: Any) -> set[str]:
    """Keys of the component's ``widgets`` properties — its declared slot names."""
    props = component.get("componentProperties") if isinstance(component, dict) else None
    if not isinstance(props, dict):
        return set()
    return {
        key
        for key, schema in props.items()
        if isinstance(schema, dict) and str(schema.get("type", "")).strip().lower() == "widgets"
    }


def component_slot_property_gaps(component: Any) -> list[str]:
    """Keys of ``widgets`` component properties that no ``ComponentSlot`` names.

    A ``widgets`` property is the declared name of a slot: the instance panel
    renders its row, and the ``ComponentSlot`` carrying the same name renders the
    content. Declared without the widget, it is an interface promising something
    the definition cannot deliver — and the editor drops the row rather than
    offering one whose content would land in another slot.
    """
    placed: set[str] = set()
    _collect_slot_keys(component.get("children") if isinstance(component, dict) else None, placed)
    return [key for key in _declared_slot_properties(component) if key not in placed]


def component_undeclared_slots(component: Any) -> list[tuple[str, str]]:
    """(pointer, slot name) per ``ComponentSlot`` naming no ``widgets`` property.

    A slot name is picked from the component's declared properties, so one that
    matches none of them is a slot no caller can see: the instance gets no panel
    row for it, and anything dropped in it is addressable only from the tree.
    """
    declared = _declared_slot_properties(component)
    nodes = component.get("children") if isinstance(component, dict) else None
    return [(path, key) for path, key in _slot_nodes(nodes) if key not in declared]


def _collect_component_interfaces() -> _ComponentInterfaces:
    """Component id (file stem) -> its declared property names, and -> its slot names.

    Recursive: components live in nested group folders (``components/<group>/<id>.json``),
    so a flat glob would miss most of them. Fingerprint-cached (relative path +
    mtime per file) like ``_collect_asset_names`` — this reads every component
    file, and every debounced ``POST /api/config/validate`` call rebuilds the context.
    """
    global _component_interface_cache
    root = active_components_dir()
    if not root.exists():
        _component_interface_cache = None
        return {}, {}
    files = [
        p for p in root.rglob("*.json")
        if p.is_file() and not p.stem.startswith("__")
    ]
    fingerprint = frozenset(
        (p.relative_to(root).as_posix(), p.stat().st_mtime_ns) for p in files
    )
    if _component_interface_cache is not None and _component_interface_cache[0] == fingerprint:
        return _component_interface_cache[1]
    keys: dict[str, frozenset[str]] = {}
    slots: dict[str, frozenset[str]] = {}
    for path in files:
        try:
            doc = read_json(path)
        except Exception:
            # A hand-edited component must not break an advisory sweep; the
            # component API reports its own parse errors.
            continue
        if not isinstance(doc, dict):
            continue
        declared = doc.get("componentProperties")
        keys[path.stem] = frozenset(declared) if isinstance(declared, dict) else frozenset()
        found: set[str] = set()
        _collect_slot_keys(doc.get("children"), found)
        slots[path.stem] = frozenset(found)
    _component_interface_cache = (fingerprint, (keys, slots))
    return keys, slots


def _collect_dialog_ids() -> set[str]:
    dialogs = _read_config().get("dialogs")
    return collect_dialog_ids(dialogs if isinstance(dialogs, list) else [])


def _collect_dialog_property_keys() -> dict[str, frozenset[str]]:
    dialogs = _read_config().get("dialogs")
    return collect_dialog_property_keys(dialogs if isinstance(dialogs, list) else [])


_ds_scan_cache: tuple[
    frozenset[tuple[str, int]], dict[str, dict[str, dict]], dict[str, str]
] | None = None

# variable_metadata() walks every subscribable variable across all datasources
# under datasource_manager's lock — real cost on a live plant with many tags.
# The realtime POST /api/config/validate endpoint calls build_context() (and
# thus this) once per debounced keystroke, so a short TTL collapses a burst of
# rapid edits into one recompute instead of re-walking the pool per keystroke.
_LIVE_REGISTRY_TTL_S = 0.25
_live_registry_cache: tuple[float, dict[str, dict[str, dict]]] | None = None


def _collect_datasource_registry() -> dict[str, dict[str, dict]]:
    """Best-effort: query the running datasource_manager for typed variables.

    ``variable_metadata()`` already emits VarType-shaped dicts (kind/base/
    array/length or kind/name/array/fields) — the exact JSON shape
    ``vartype.accepts`` expects — so its output is used as-is, no extra
    conversion step. Falls back to scanning the project's
    ``datasources/*.json`` declarations for a typed (if less precise) registry
    so the validator still catches var-unknown/var-type before any pool
    starts. The fallback scan is mtime-keyed cached — startup sweeps and
    pre-pool validations would otherwise re-walk M datasource files per page.
    """
    global _live_registry_cache
    now = time.monotonic()
    if _live_registry_cache is not None and now - _live_registry_cache[0] < _LIVE_REGISTRY_TTL_S:
        return _live_registry_cache[1]
    registry: dict[str, dict[str, dict]] = {}
    try:
        from models.datasource import parse_var_key
        from services.datasource_manager import datasource_manager

        for name in datasource_manager.datasources:
            registry[name] = {}
        for key, meta in datasource_manager.variable_metadata().items():
            ds_name, var_path = parse_var_key(key)
            var_type = meta.get("type") if isinstance(meta, dict) else None
            if isinstance(var_type, dict):
                registry.setdefault(ds_name, {})[var_path] = var_type
    except Exception:
        registry = {}
    if registry:
        _live_registry_cache = (now, registry)
        return registry
    return _scan_datasources_from_disk()[0]


def _walk_variable_tree(nodes: Any, prefix: str, out: dict[str, dict]) -> None:
    """Recursively derive typed VarTypes from a datasource JSON's declared
    ``variables`` tree (folders/variables, as authored — not the runtime
    pool's resolved registry). Best-effort mirror of DatasourceEntry's own
    folder/array-of-struct detection, precise enough for pre-pool validation."""
    if not isinstance(nodes, list):
        return
    for node in nodes:
        if not isinstance(node, dict):
            continue
        kind = node.get("kind")
        name = node.get("display_name") if kind == "variable" else node.get("name")
        if not isinstance(name, str) or not name:
            continue
        path = f"{prefix}/{name}" if prefix else name
        if kind == "folder":
            children = node.get("children")
            if not isinstance(children, list):
                continue
            is_array = bool(node.get("is_array"))
            field_names = [
                child.get("display_name")
                for child in children
                if isinstance(child, dict)
                and child.get("kind") == "variable"
                and isinstance(child.get("display_name"), str)
            ]
            if field_names or is_array:
                out[path] = vartype.node_var_type({
                    "data_type": "struct",
                    "is_array": is_array,
                    "array_length": node.get("array_length"),
                    "fields": field_names,
                })
            _walk_variable_tree(children, path, out)
        elif kind == "variable":
            raw_type = node.get("data_type")
            simple = to_simple_type(raw_type, as_array_suffix=False) if isinstance(raw_type, str) else "String"
            out[path] = vartype.node_var_type({
                "data_type": simple,
                "is_array": bool(node.get("is_array")),
                "array_length": node.get("array_length"),
            })


def _scan_datasources_from_disk() -> tuple[dict[str, dict[str, dict]], dict[str, str]]:
    """(variable registry, declared datasource type) per datasource, from the
    project's ``datasources/*.json`` — one mtime-keyed scan feeds both."""
    global _ds_scan_cache
    from core.storage import active_datasources_dir

    datasources_dir = active_datasources_dir()
    if not datasources_dir.exists():
        _ds_scan_cache = None
        return {}, {}
    files = sorted(datasources_dir.glob("*.json"))
    fingerprint = frozenset(
        (str(p), p.stat().st_mtime_ns) for p in files
    )
    if _ds_scan_cache is not None and _ds_scan_cache[0] == fingerprint:
        return _ds_scan_cache[1], _ds_scan_cache[2]
    registry: dict[str, dict[str, dict]] = {}
    ds_types: dict[str, str] = {}
    for path in files:
        try:
            doc = read_json(path)
        except Exception:
            continue
        name = doc.get("name") if isinstance(doc, dict) else None
        if not isinstance(name, str):
            name = path.stem
        types: dict[str, dict] = {}
        variables = doc.get("variables") if isinstance(doc, dict) else None
        _walk_variable_tree(variables, "", types)
        registry[name] = types
        ds_type = doc.get("type") if isinstance(doc, dict) else None
        if isinstance(ds_type, str):
            ds_types[name] = ds_type
    _ds_scan_cache = (fingerprint, registry, ds_types)
    return registry, ds_types


def _collect_datasource_types() -> dict[str, str]:
    """Declared type per datasource — live pool first, disk declarations as the
    fallback (same best-effort shape as ``_collect_datasource_registry``)."""
    try:
        from services.datasource_manager import datasource_manager

        live = {
            name: entry.ds_type
            for name, entry in datasource_manager.datasources.items()
            if isinstance(entry.ds_type, str) and entry.ds_type
        }
    except Exception:
        live = {}
    if live:
        return live
    return _scan_datasources_from_disk()[1]


# Curated built-in icon ids — mirrors frontend/src/shared/config/iconAllowlist.ts
# BUILTIN_ICON_IDS. Kept in sync by hand (like the vartype BASES list); a
# shared fixture (frontend/src/shared/types/__fixtures__/builtinIconIds.json)
# drives a parity test on each side — see test_structure_parity.py and
# iconAllowlist.test.ts — so drift fails CI instead of silently diverging.
_BUILTIN_ICON_IDS: frozenset[str] = frozenset({
    "house", "gauge", "cpu", "thermometer", "drop", "wave-sine", "lightning",
    "warning", "warning-circle", "x-circle", "check-circle", "info", "play",
    "pause", "stop", "cursor-click", "arrow-clockwise", "arrows-clockwise",
    "arrows-left-right", "arrows-in-line-horizontal", "arrows-out-line-horizontal",
    "sliders-horizontal", "gear-six", "wrench", "toolbox", "database", "plug",
    "broadcast", "chart-line", "chart-bar", "trend-up", "trend-down", "activity",
    "clock", "clock-counter-clockwise", "calendar", "user", "users", "eye",
    "eye-slash", "lock", "shield-check", "bell", "list", "squares-four", "stack",
    "browsers", "sidebar-simple", "frame-corners", "path", "text-t", "translate",
    "puzzle-piece", "star", "file-text", "folder", "image-square",
    "columns", "cube",
    "fan", "engine", "pipe", "flask", "funnel", "factory", "package", "barcode",
    "qr-code", "scales", "ruler", "wind", "snowflake", "fire", "siren", "lightbulb",
    "circuitry", "timer", "hourglass", "speedometer", "plus", "minus", "check", "x",
    "pencil-simple", "trash", "floppy-disk", "download-simple", "upload-simple",
    "export", "copy", "magnifying-glass", "printer", "arrow-counter-clockwise",
    "caret-up", "caret-down", "caret-left", "caret-right", "arrow-up", "arrow-down",
    "arrow-left", "arrow-right", "dots-three", "sign-out", "power", "question",
    "prohibit", "hand-palm", "target", "crosshair", "map-pin", "wifi-high",
    "wifi-slash", "cloud", "hard-drives", "terminal", "bug", "battery-full", "table",
    "rows", "tree-structure", "flow-arrow", "graph", "chart-pie", "chart-donut",
    "chart-scatter", "clipboard-text", "note", "tag", "envelope", "seal-check",
})


_translation_keys_cache: tuple[int, frozenset[str]] | None = None


def _collect_translation_keys() -> frozenset[str]:
    """Keys of the active (Default) translation dictionary. mtime-cached like
    ``_read_config`` — every debounced ``POST /api/config/validate`` call
    otherwise re-parses the CSV."""
    global _translation_keys_cache
    path = active_translations_dir() / "Default.csv"
    try:
        mtime = path.stat().st_mtime_ns
    except FileNotFoundError:
        _translation_keys_cache = None
        return frozenset()
    if _translation_keys_cache is not None and _translation_keys_cache[0] == mtime:
        return _translation_keys_cache[1]
    try:
        rows = read_csv(path)
    except Exception:
        return frozenset()
    keys = frozenset(row[0] for row in rows[1:] if row and row[0])
    _translation_keys_cache = (mtime, keys)
    return keys


_asset_names_cache: dict[str, tuple[frozenset[tuple[str, int]], frozenset[str]]] = {}


def _collect_asset_names(asset_dir) -> frozenset[str]:
    """Relative asset paths under ``asset_dir``, fingerprint-cached (name +
    mtime per file) like ``_scan_datasources_from_disk`` — this runs on every
    debounced ``POST /api/config/validate`` call otherwise."""
    if not asset_dir.exists():
        _asset_names_cache.pop(str(asset_dir), None)
        return frozenset()
    files = list(asset_dir.iterdir())
    fingerprint = frozenset((p.name, p.stat().st_mtime_ns) for p in files if p.is_file())
    cache_key = str(asset_dir)
    cached = _asset_names_cache.get(cache_key)
    if cached is not None and cached[0] == fingerprint:
        return cached[1]
    names = frozenset(f"{asset_dir.name}/{name}" for name, _ in fingerprint)
    _asset_names_cache[cache_key] = (fingerprint, names)
    return names


def _collect_user_groups() -> frozenset[str]:
    """Group ids from users.json. Unreadable/absent yields an empty set, which
    the consumers treat as "unknown" and skip rather than flagging every
    reference as broken."""
    path = active_project_root() / "users.json"
    if not path.exists():
        return frozenset()
    try:
        doc = read_json(path)
    except Exception:
        return frozenset()
    groups = doc.get("groups") if isinstance(doc, dict) else None
    if not isinstance(groups, list):
        return frozenset()
    return frozenset(
        g["id"] for g in groups if isinstance(g, dict) and isinstance(g.get("id"), str) and g["id"]
    )


def build_context() -> ValidationContext:
    """Snapshot the world for the duration of a single validation pass."""
    component_property_keys, component_slots = _collect_component_interfaces()
    return ValidationContext(
        widget_schemas=load_widget_manifest(),
        datasource_registry=_collect_datasource_registry(),
        datasource_types=_collect_datasource_types(),
        page_ids=_collect_page_ids(),
        component_ids=set(component_property_keys),
        component_property_keys=component_property_keys,
        component_slots=component_slots,
        dialog_ids=_collect_dialog_ids(),
        dialog_property_keys=_collect_dialog_property_keys(),
        translation_keys=_collect_translation_keys(),
        user_groups=_collect_user_groups(),
        icon_assets=_collect_asset_names(active_icons_dir()),
        image_assets=_collect_asset_names(active_images_dir()),
    )


def _has_property_source(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if not value:
        return False
    keys = [k for k in value if k.startswith("$")]
    return len(keys) == 1 and keys[0] in PROPERTY_SOURCE_KEYS


def _property_source_key(value: dict) -> str:
    for k in value:
        if k.startswith("$") and k in PROPERTY_SOURCE_KEYS:
            return k
    return ""


# Editor-kind schema tokens — never a binding-filter type, so they're excluded
# from the accept-type list a $var/$componentProp value is checked against.
# Mirrors frontend/src/shared/utils/valueTypes.ts EDITOR_KINDS — parity is
# enforced by test_structure_parity.py / valueTypes.test.ts against the shared
# frontend/src/shared/types/__fixtures__/editorKinds.json fixture.
_EDITOR_KINDS: frozenset[str] = frozenset({
    "color", "icon", "image", "option-list", "actions", "groups",
    "image-indicators", "child-positions", "menu-items", "page-group", "slot",
    "widgets", "_action",
})


def _accept_types_for_schema(schema_field: dict | None) -> list[dict]:
    """A schema field's binding-filter tokens (its `type`, minus editor kinds),
    parsed into AcceptType specs. Empty = no type constraint (skip the check)."""
    if not isinstance(schema_field, dict):
        return []
    field_type = schema_field.get("type")
    if field_type is None:
        return []
    tokens = field_type if isinstance(field_type, list) else [field_type]
    return [
        vartype.parse_type_token(token)
        for token in tokens
        if isinstance(token, str) and token not in _EDITOR_KINDS
    ]


def _report_test_server_target(
    ds_name: str, ctx: ValidationContext, path: str, report: ValidationReport
) -> bool:
    """Mark a binding whose datasource is an OPC-UA test server. The test server
    is a simulator this product *hosts*; it is never a read/write target. The
    binding picker hides those datasources, so anything still pointing at one is
    a leftover from before the datasource changed type (or a hand-edited file)."""
    if ctx.datasource_types.get(ds_name) != "opcua-test-server":
        return False
    report.warn(
        path,
        f"datasource '{ds_name}' is an OPC-UA test server — bind through an "
        f"OPC-UA client datasource pointed at it instead",
        severity="error",
        code="var-test-server",
    )
    return True


def validate_var_ref(
    ref: Any,
    ctx: ValidationContext,
    path: str,
    report: ValidationReport,
    schema_field: dict | None = None,
) -> None:
    # Only structural corruption (non-object payload) is a hard error. Empty
    # datasource/path and unknown datasource/variable are non-blocking build
    # diagnostics — the editor produces empty bindings transiently when a user
    # adds a variable property before picking a datasource, and the
    # datasource registry can grow at runtime (late OPC-UA pools, plugin
    # startup, project imports). The frontend resolver returns null
    # gracefully for unresolved bindings.
    if not isinstance(ref, dict):
        report.add(path, "$var payload must be an object")
        return
    composite = ref.get("path")
    if not isinstance(composite, str) or not composite:
        report.warn(path, "$var.path is empty (incomplete binding)", severity="warning", code="var-empty")
        return
    if ":" not in composite:
        report.warn(path, "$var.path must be 'datasource:location'", severity="warning", code="var-empty")
        return
    ds_name, _, var_path = composite.partition(":")
    if not ds_name:
        report.warn(path, "$var.datasource is empty (incomplete binding)", severity="warning", code="var-empty")
        return
    if not var_path:
        report.warn(path, "$var.path is empty (incomplete binding)", severity="warning", code="var-empty")
        return
    if ds_name not in ctx.datasource_registry:
        report.warn(path, f"unknown datasource '{ds_name}'", severity="error", code="var-unknown")
        return
    if _report_test_server_target(ds_name, ctx, path, report):
        return
    paths = ctx.datasource_registry[ds_name]
    resolved_key = var_path
    if paths and var_path not in paths:
        base = var_path.split("[")[0]
        if base not in paths:
            report.warn(path, f"unknown variable '{ds_name}:{var_path}'", severity="error", code="var-unknown")
            return
        resolved_key = base
    var_type = paths.get(resolved_key) if paths else None
    if var_type is None:
        return  # registry not (yet) populated for this path — best-effort, skip type check
    accept = _accept_types_for_schema(schema_field)
    if not accept:
        return
    required_fields = schema_field.get("requiredFields") if isinstance(schema_field, dict) else None
    element = vartype.element_of(var_type) if ref.get("index") is not None else var_type
    if not any(vartype.accepts(a, element, required_fields) for a in accept):
        report.warn(
            path,
            f"variable '{ds_name}:{var_path}' type is incompatible with this field",
            severity="error",
            code="var-type",
        )


def _validate_write_target(
    action: dict, ctx: ValidationContext, path: str, report: ValidationReport
) -> None:
    """`writeDataVariable`'s target is a flat datasource/path pair, not a `$var`
    payload, so it never reaches validate_var_ref — check it here against the
    same registry. Diagnostics anchor on `<action>/datasource`, which the
    property panel maps back to the action's Variable row."""
    ds_name = action.get("datasource")
    var_path = action.get("path")
    target_path = f"{path}/datasource"
    if not isinstance(ds_name, str) or not ds_name or not isinstance(var_path, str) or not var_path:
        report.warn(
            target_path,
            "write target is incomplete (no variable bound)",
            severity="warning",
            code="var-empty",
        )
        return
    if ds_name not in ctx.datasource_registry:
        report.warn(
            target_path, f"unknown datasource '{ds_name}'", severity="error", code="var-unknown"
        )
        return
    if _report_test_server_target(ds_name, ctx, target_path, report):
        return
    paths = ctx.datasource_registry[ds_name]
    if paths and var_path not in paths and var_path.split("[")[0] not in paths:
        report.warn(
            target_path,
            f"unknown variable '{ds_name}:{var_path}'",
            severity="error",
            code="var-unknown",
        )


def _validate_action(action: Any, ctx: ValidationContext, path: str, report: ValidationReport) -> None:
    if not isinstance(action, dict):
        return
    kind = action.get("type") or action.get("action")
    if kind == "writeDataVariable":
        _validate_write_target(action, ctx, path, report)
    target = action.get("target") or action.get("pageId")
    if kind in {"openPage", "openPageOverlay", "navigateTo"} and isinstance(target, str):  # noqa: SIM102 -- no autofix offered, left as-is per the mechanical-only policy for this family
        if target not in ctx.page_ids:
            report.add(path, f"action target page '{target}' does not exist")
    # closeDialog's dialogId is optional (empty = close the topmost dialog); only
    # validate it when the action actually names a dialog.
    dialog_id = action.get("dialogId")
    if kind in {"openDialog", "closeDialog"} and isinstance(dialog_id, str) and dialog_id:  # noqa: SIM102 -- no autofix offered, left as-is per the mechanical-only policy for this family
        if dialog_id not in ctx.dialog_ids:
            report.add(path, f"action target dialog '{dialog_id}' does not exist")
    if kind == "openDialog" and isinstance(dialog_id, str) and dialog_id:
        declared = ctx.dialog_property_keys.get(dialog_id)
        args = action.get("componentProperties")
        if declared is not None and isinstance(args, dict):
            target = f"dialog '{dialog_id}'"
            for key in args:
                if key not in declared:
                    _warn_unknown_property(report, f"{path}/componentProperties/{key}", key, target)
    # Async actions nest follow-up lists (onSuccess/onFailed/onSettled) and
    # showAlert nests its button handlers; their targets deserve the same checks
    # as a top-level action.
    for slot in ("onSuccess", "onFailed", "onSettled", "onOk", "onCancel"):
        nested = action.get(slot)
        if isinstance(nested, list):
            validate_action_targets(nested, ctx, f"{path}/{slot}", report)


def validate_action_targets(actions: Any, ctx: ValidationContext, path: str, report: ValidationReport) -> None:
    if actions is None:
        return
    if isinstance(actions, dict):
        # Trigger-keyed map: { onClick: [actions], onChange: [...] }
        for trigger, action_list in actions.items():
            if not isinstance(action_list, list):
                continue
            for i, action in enumerate(action_list):
                _validate_action(action, ctx, f"{path}/{trigger}/{i}", report)
    elif isinstance(actions, list):
        for i, action in enumerate(actions):
            _validate_action(action, ctx, f"{path}/{i}", report)


_WILDCARD_RE = re.compile(r"\{([^{}]*)\}")


def _is_unset(value: Any) -> bool:
    """A source-capable slot is 'unset' when undefined, or when it's an
    empty-path $var placeholder the editor produces before a binding is
    picked. Used to decide required-slot warnings vs. optional-slot silence —
    see the noise-control rule in the Build Diagnostics catalog."""
    if value is None:
        return True
    if isinstance(value, dict) and set(value.keys()) == {"$var"}:
        payload = value.get("$var")
        p = payload.get("path") if isinstance(payload, dict) else None
        return not p
    return False


def _validate_wildcards(
    templates: list[str],
    payload: dict,
    source_key: str,
    ctx: ValidationContext,
    path: str,
    report: ValidationReport,
) -> None:
    """Check every `{n}` placeholder across `templates` against the source's
    `wildcards` bag. Shared by `$stringExpr` (one template) and `$http` (url,
    body and header values), which use the same placeholder syntax."""
    wildcards = payload.get("wildcards") if isinstance(payload.get("wildcards"), dict) else {}
    referenced: set[str] = set()
    for template in templates:
        for match in _WILDCARD_RE.finditer(template):
            referenced |= set(re.findall(r"\d+", match.group(1)))
    code_prefix = source_key.lstrip("$").lower()
    for n in sorted(referenced, key=int):
        wildcard_value = wildcards.get(n)
        wildcard_path = f"{path}/{source_key}/wildcards/{n}"
        if _is_unset(wildcard_value):
            report.warn(
                wildcard_path, f"placeholder {{{n}}} is unbound",
                severity="warning", code=f"{code_prefix}-wildcard-empty",
            )
        else:
            _validate_property_value(wildcard_value, None, ctx, wildcard_path, report)


def _validate_slot(
    value: Any,
    schema_field: dict | None,
    ctx: ValidationContext,
    path: str,
    report: ValidationReport,
    *,
    code: str | None = None,
    message: str = "",
) -> None:
    """A composite sub-slot of a property source (e.g. `$if.condition`,
    `$if.true`). Unset -> a slot-specific warning when `code` is given (a
    required slot the source can't function without), else silent (an
    optional slot that's fine left empty). Set -> validated normally."""
    if _is_unset(value):
        if code is not None:
            report.warn(path, message, severity="warning", code=code)
        return
    _validate_property_value(value, schema_field, ctx, path, report)


def _validate_property_value(
    value: Any,
    schema_field: dict | None,
    ctx: ValidationContext,
    path: str,
    report: ValidationReport,
) -> None:
    # Mirrors frontend primaryType(): the first token drives the editor/literal
    # type; the full token list (see _accept_types_for_schema) is only used for
    # the $var binding-filter check below.
    field_type = schema_field.get("type") if isinstance(schema_field, dict) else None
    if isinstance(field_type, list):
        field_type = field_type[0] if field_type else None
    field_type = field_type.lower() if isinstance(field_type, str) else None

    if not _has_property_source(value):
        # Static literal — type-check against schema.
        expected = _ATOMIC_TYPE_CHECKS.get(field_type) if field_type is not None else None
        if expected is None:
            return
        if field_type in ("integer", "float") and isinstance(value, bool):
            # bool is a subclass of int; reject it for numeric fields
            report.add(path, f"expected {field_type}, got boolean")
            return
        if field_type == "duration" and isinstance(value, bool):
            report.add(path, "expected duration, got boolean")
            return
        if not isinstance(value, expected) and value is not None:
            report.add(path, f"expected {field_type}, got {type(value).__name__}")
        return
    # Sourced value — recurse into its payload.
    if not isinstance(value, dict):
        return
    source_key = _property_source_key(value)
    payload = value.get(source_key)
    if source_key == "$var":
        validate_var_ref(payload, ctx, path, report, schema_field)
    elif source_key == "$static":
        if field_type == "icon" and isinstance(payload, dict):
            icon_type = payload.get("type")
            if icon_type == "builtin":
                name = payload.get("name")
                if not isinstance(name, str) or name not in ctx.builtin_icons:
                    report.warn(path, f"unknown built-in icon '{name}'", severity="error", code="icon-unknown")
            elif icon_type == "custom":
                icon_path = payload.get("path")
                if not isinstance(icon_path, str) or icon_path not in ctx.icon_assets:
                    report.warn(path, f"unknown icon asset '{icon_path}'", severity="error", code="icon-unknown")
        elif field_type == "image" and isinstance(payload, dict):
            image_path = payload.get("path")
            if not isinstance(image_path, str) or image_path not in ctx.image_assets:
                report.warn(path, f"unknown image asset '{image_path}'", severity="error", code="image-unknown")
    elif source_key == "$loc":
        # Runtime resolver (frontend/src/hmi/utils/propertySourceEval.ts:evaluateLoc) only
        # accepts a string payload; any other shape silently resolves to null at render.
        if not isinstance(payload, str):
            report.add(path, "$loc payload must be a string translation key")
        elif payload == "":
            report.warn(path, "translation key is empty", severity="warning", code="loc-empty")
        elif ctx.translation_keys and payload not in ctx.translation_keys:
            report.warn(path, f"unknown translation key '{payload}'", severity="error", code="loc-unknown")
    elif source_key == "$if" and isinstance(payload, dict):
        _validate_slot(
            payload.get("condition"), None, ctx, f"{path}/$if/condition", report,
            code="if-condition-empty", message="condition is unset",
        )
        _validate_slot(payload.get("true"), schema_field, ctx, f"{path}/$if/true", report)
        _validate_slot(payload.get("false"), schema_field, ctx, f"{path}/$if/false", report)
    elif source_key == "$switch" and isinstance(payload, dict):
        _validate_slot(
            payload.get("value"), None, ctx, f"{path}/$switch/value", report,
            code="switch-value-empty", message="discriminant value is unset",
        )
        cases = payload.get("cases", [])
        if isinstance(cases, list):
            if len(cases) == 0:
                report.warn(f"{path}/$switch/cases", "no cases defined", severity="warning", code="switch-no-cases")
            for i, case in enumerate(cases):
                if not isinstance(case, dict):
                    continue
                when = case.get("when")
                then = case.get("then")
                if _is_unset(when) and _is_unset(then):
                    report.warn(
                        f"{path}/$switch/{i}", "case is empty", severity="warning", code="switch-case-empty",
                    )
                    continue
                _validate_slot(when, None, ctx, f"{path}/$switch/{i}/when", report)
                _validate_slot(then, schema_field, ctx, f"{path}/$switch/{i}/then", report)
        _validate_slot(payload.get("default"), schema_field, ctx, f"{path}/$switch/default", report)
    elif source_key == "$compare" and isinstance(payload, dict):
        _validate_slot(
            payload.get("left"), None, ctx, f"{path}/$compare/left", report,
            code="compare-operand-empty", message="left operand is unset",
        )
        _validate_slot(
            payload.get("right"), None, ctx, f"{path}/$compare/right", report,
            code="compare-operand-empty", message="right operand is unset",
        )
    elif source_key == "$stringExpr" and isinstance(payload, dict):
        template = payload.get("template")
        if not isinstance(template, str) or template == "":
            report.warn(
                f"{path}/$stringExpr/template", "template is empty",
                severity="warning", code="stringexpr-empty",
            )
        else:
            _validate_wildcards([template], payload, "$stringExpr", ctx, path, report)
    elif source_key == "$http" and isinstance(payload, dict):
        url = payload.get("url")
        if not isinstance(url, str) or url.strip() == "":
            report.warn(
                f"{path}/$http/url", "url is empty",
                severity="warning", code="http-url-empty",
            )
        else:
            # url / body / header values share $stringExpr's placeholder syntax,
            # so every template on the request is scanned against one wildcard bag.
            templates = [url]
            body = payload.get("body")
            if isinstance(body, str):
                templates.append(body)
            headers = payload.get("headers")
            if isinstance(headers, list):
                for header in headers:
                    if isinstance(header, dict) and isinstance(header.get("value"), str):
                        templates.append(header["value"])
            _validate_wildcards(templates, payload, "$http", ctx, path, report)
    elif source_key == "$urlParam" and isinstance(payload, dict):
        name = payload.get("name")
        if not isinstance(name, str) or name == "":
            report.warn(
                f"{path}/$urlParam/name", "name is empty",
                severity="warning", code="urlparam-empty",
            )
    elif source_key == "$widgetProp" and isinstance(payload, dict):
        component_id = payload.get("componentId")
        property_name = payload.get("property")
        if not component_id or not property_name:
            report.warn(
                path, "component/property is empty",
                severity="warning", code="widgetprop-empty",
            )
    elif source_key == "$componentProp":
        if not isinstance(payload, str) or payload == "":
            report.warn(
                path, "property name is empty",
                severity="warning", code="componentprop-empty",
            )
    elif source_key == "$recipe" and isinstance(payload, dict):  # noqa: SIM102 -- no autofix offered, left as-is per the mechanical-only policy for this family
        if not payload.get("type"):
            report.warn(
                f"{path}/$recipe/type", "recipe type is empty",
                severity="warning", code="recipe-type-empty",
            )


def validate_widget_node(
    node: Any,
    ctx: ValidationContext,
    path: str = "",
    report: ValidationReport | None = None,
) -> ValidationReport:
    if report is None:
        report = ValidationReport()
    if not isinstance(node, dict):
        report.add(path, "widget node must be an object")
        return report
    wtype = node.get("type")
    if not isinstance(wtype, str) or not wtype:
        report.add(path, "widget node missing 'type'")
        return report
    schema = ctx.widget_schema_for(wtype)
    if schema is None:
        report.add(path, f"unknown widget type '{wtype}'")
        return report
    properties = node.get("properties")
    if properties is not None:
        if not isinstance(properties, dict):
            report.add(f"{path}/properties", "must be an object")
        else:
            declared = ctx.declared_property_keys(wtype, schema)
            target = (
                f"component '{_component_id(wtype)}'"
                if wtype.startswith(_COMPONENT_TYPE_PREFIX)
                else f"widget '{wtype}'"
            )
            for key, value in properties.items():
                if declared is not None and key not in declared:
                    _warn_unknown_property(report, f"{path}/properties/{key}", key, target)
                field_schema = schema.get(key) if isinstance(schema, dict) else None
                _validate_property_value(value, field_schema, ctx, f"{path}/properties/{key}", report)
                if key == "actions" or (isinstance(field_schema, dict) and field_schema.get("type") == "actions"):
                    validate_action_targets(value, ctx, f"{path}/properties/{key}", report)
    # Walk children
    for child_field in ("children",):
        children = node.get(child_field)
        if isinstance(children, list):
            _validate_instance_slots(wtype, children, ctx, f"{path}/{child_field}", report)
            for i, child in enumerate(children):
                validate_widget_node(child, ctx, f"{path}/{child_field}/{i}", report)
    return report


def _validate_instance_slots(
    wtype: str,
    children: list,
    ctx: ValidationContext,
    path: str,
    report: ValidationReport,
) -> None:
    """Check that a component instance's children fill slots its definition has.

    Warnings, not errors: a child naming a dropped slot still renders (it falls
    into the definition's first one), so trimming a definition must not take the
    pages using it down with it.
    """
    if not wtype.startswith(_COMPONENT_TYPE_PREFIX):
        return
    declared = ctx.component_slots.get(_component_id(wtype))
    # Registry not collected (fresh checkout / deploy runtime) — skip rather
    # than flag every instance.
    if declared is None or not children:
        return
    if not declared:
        report.warn(
            path,
            "component declares no slots — these widgets are not rendered",
            severity="warning",
            code="slot-unknown",
        )
        return
    for i, child in enumerate(children):
        if not isinstance(child, dict):
            continue
        slot = child.get("slot")
        if slot is None:
            continue
        if not isinstance(slot, str) or not slot:
            report.warn(
                f"{path}/{i}/slot", "slot name is empty",
                severity="warning", code="slot-empty",
            )
        elif slot not in declared:
            report.warn(
                f"{path}/{i}/slot",
                f"component has no slot '{slot}' — this widget renders in the first slot",
                severity="warning", code="slot-unknown",
            )


# Shell-region fields carrying a bindable ($var-capable) value, mapped to the
# schema their static literal is checked against. Mirrors the SHELL_*_SCHEMA
# constants in frontend/src/config/components/editor/PropertiesPanel/index.tsx.
_SHELL_BINDABLE_FIELDS: dict[str, dict[str, str]] = {
    "enabled": {"type": "boolean"},
    "expanded": {"type": "boolean"},
    "overlay": {"type": "boolean"},
    "fullHeight": {"type": "boolean"},
    "expandedSize": {"type": "string"},
    "collapsedSize": {"type": "string"},
    "background": {"type": "color"},
}
# Design-time initial state — deliberately NOT bindable (it is the fallback the
# runtime uses until `expanded` resolves), so only its literal is checked.
_SHELL_DEFAULT_STATES = ("expanded", "collapsed", "hidden")
_SHELL_REGIONS = ("header", "footer", "leftSidebar", "rightSidebar")


def _walk_widget_array(
    widgets: Any, ctx: ValidationContext, base_path: str, report: ValidationReport
) -> None:
    """Validate each node of a widget-node array at ``base_path/<index>``."""
    if not isinstance(widgets, list):
        return
    for i, node in enumerate(widgets):
        validate_widget_node(node, ctx, f"{base_path}/{i}", report)


# Public name for the property-value checker, so the sibling domain validators
# (validation/domains.py) can reuse the exact same source/type/binding rules the
# widget walk applies.
validate_property_value = _validate_property_value


def validate_shell_regions(
    shell_like: Any, ctx: ValidationContext, base_path: str, report: ValidationReport
) -> None:
    """Validate the bindable fields on a ShellConfig / per-page shellOverride."""
    if not isinstance(shell_like, dict):
        return
    for region in _SHELL_REGIONS:
        region_cfg = shell_like.get(region)
        if not isinstance(region_cfg, dict):
            continue
        for field_name, field_schema in _SHELL_BINDABLE_FIELDS.items():
            if field_name in region_cfg:
                _validate_property_value(
                    region_cfg[field_name],
                    field_schema,
                    ctx,
                    f"{base_path}/{region}/{field_name}",
                    report,
                )
        default_state = region_cfg.get("defaultState")
        if default_state is not None and default_state not in _SHELL_DEFAULT_STATES:
            report.warn(
                f"{base_path}/{region}/defaultState",
                f"unknown default state '{default_state}' — expected one of "
                f"{', '.join(_SHELL_DEFAULT_STATES)}",
                severity="error",
                code="shell-default-state-unknown",
            )


def validate_page(page: Any, ctx: ValidationContext) -> ValidationReport:
    """Top-level walker for a page document.

    Pages have a ``sections`` map (``{ "content": [...], "footer": [...] }``)
    whose values are widget-node arrays, plus an optional ``shellOverride`` whose
    region configs carry bindable ($var) fields.
    """
    report = ValidationReport()
    if not isinstance(page, dict):
        report.add("", "page must be an object")
        return report
    pid = page.get("id")
    if pid is not None and not is_valid_page_id(pid):
        report.add("/id", "invalid page id")
    validate_shell_regions(page.get("shellOverride"), ctx, "/shellOverride", report)
    sections = page.get("sections")
    if sections is None:
        return report
    if not isinstance(sections, dict):
        report.add("/sections", "must be an object")
        return report
    for section_id, children in sections.items():
        if not isinstance(children, list):
            report.add(f"/sections/{section_id}", "must be an array")
            continue
        for i, child in enumerate(children):
            validate_widget_node(child, ctx, f"/sections/{section_id}/{i}", report)
    return report


def validate_shell_areas(config: Any, ctx: ValidationContext) -> ValidationReport:
    """Validate the shell component arrays (header/footer/sidebars) and the
    project-wide shell region bindings. Paths are relative to `config` itself
    (``/header/0/...``, ``/shell/...``) — usable both as part of a full config
    document and as the standalone draft for ``POST /api/config/validate``
    with ``kind: 'shell'``."""
    report = ValidationReport()
    if not isinstance(config, dict):
        return report
    for area in _SHELL_REGIONS:
        _walk_widget_array(config.get(area), ctx, f"/{area}", report)
    validate_shell_regions(config.get("shell"), ctx, "/shell", report)
    return report


def validate_dialog(dialog: Any, ctx: ValidationContext) -> ValidationReport:
    """Validate a single dialog's widget tree. Paths are relative to `dialog`
    itself (``/widgets/0/...``)."""
    report = ValidationReport()
    if not isinstance(dialog, dict):
        return report
    _walk_widget_array(dialog.get("widgets"), ctx, "/widgets", report)
    return report


def validate_global_events(events: Any, ctx: ValidationContext) -> ValidationReport:
    """Validate the action targets in a ``globalEvents`` map. Paths are
    relative to `events` itself (``/onLoad/0``)."""
    report = ValidationReport()
    if isinstance(events, dict):
        for event_name, actions in events.items():
            validate_action_targets(actions, ctx, f"/{event_name}", report)
    return report


def _reparented(report: ValidationReport, prefix: str) -> ValidationReport:
    """Copy `report` with `prefix` prepended to every finding/warning path —
    lets a validator written against its own artifact root (`/widgets/0/...`)
    be reused at the path it lives under in a larger document (`/dialogs/x/...`)."""
    out = ValidationReport()
    out.findings = [replace(f, path=f"{prefix}{f.path}") for f in report.findings]
    out.warnings = [replace(w, path=f"{prefix}{w.path}") for w in report.warnings]
    return out


def validate_config_areas(config: Any, ctx: ValidationContext) -> ValidationReport:
    """Validate the widget trees carried on the global config document.

    Mirrors :func:`validate_page` for the non-page surfaces persisted by
    ``PUT /api/config/config``: the shell component arrays (header/footer/
    sidebars), each dialog's widget tree, the project-wide shell region bindings,
    and the action targets in ``globalEvents``. Findings block the write;
    warnings ride along in the success response. Reuses :func:`validate_dialog`
    and :func:`validate_global_events` — the same walkers the realtime
    ``POST /api/config/validate`` endpoint uses per-artifact — reparented onto
    this document's paths.
    """
    report = ValidationReport()
    if not isinstance(config, dict):
        return report
    report.extend(validate_shell_areas(config, ctx))
    dialogs = config.get("dialogs")
    if isinstance(dialogs, list):
        for dialog in dialogs:
            if not isinstance(dialog, dict):
                continue
            did = dialog.get("id")
            label = did if isinstance(did, str) and did else "?"
            report.extend(_reparented(validate_dialog(dialog, ctx), f"/dialogs/{label}"))
    report.extend(_reparented(validate_global_events(config.get("globalEvents"), ctx), "/globalEvents"))
    return report
