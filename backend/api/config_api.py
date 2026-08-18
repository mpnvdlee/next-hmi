import asyncio
import logging
from typing import Any

from core.component_validation import (
    DIRECT_BINDING_MESSAGE,
    NESTED_PROP_MESSAGE,
    component_nested_prop_paths,
    component_var_source_paths,
)
from core.exceptions import (
    ConfigConflictError,
    ConfigNotFoundError,
    ConfigValidationError,
)
from core.page_index import (
    collect_dialog_ids,
    collect_dialog_property_keys,
    collect_page_ids,
    is_page_group,
)
from core.storage import (
    BUILD_STATUS_PATH,
    active_alarms_config_path,
    active_config_dir,
    active_custom_widgets_dir,
    active_pages_dir,
    active_project_root,
    active_recipes_config_path,
    active_translations_dir,
    component_files,
    read_csv,
    read_json,
    write_csv,
    write_json,
)
from core.translations import (
    EMPTY_DICTIONARY_MESSAGE,
    build_translation_rows,
    parse_translation_rows,
    translation_payload,
    translation_revision,
    translation_transaction,
)
from core.validation import (
    ValidationReport,
    build_context,
    component_slot_property_gaps,
    component_undeclared_slots,
    is_valid_dict_name,
    is_valid_page_id,
    validate_alarms,
    validate_config_areas,
    validate_dialog,
    validate_global_events,
    validate_historian,
    validate_page,
    validate_recipes,
    validate_shell_areas,
    validate_users,
    validate_widget_node,
)
from fastapi import APIRouter, Query
from mcp_server.diff import make_diff
from services import widget_compiler
from services.websocket_manager import ConfigChangedEvent, websocket_manager

log = logging.getLogger(__name__)


def _log_broadcast_error(task: asyncio.Task[Any]) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        log.warning("config_changed broadcast failed: %s", exc)


router = APIRouter(prefix="/api/config", tags=["config"])

def _config_path():
    return active_config_dir() / "config.json"


def _default_dict_path():
    return active_translations_dir() / "Default.csv"


def _finding_label(node: Any, fallback: str) -> str:
    if isinstance(node, dict):
        # `label` covers the domain documents (a recipe parameter, an alarm),
        # whose entries name themselves that way rather than with `name`.
        name = node.get("name") or node.get("title") or node.get("label")
        if isinstance(name, str) and name:
            return name
        wtype = node.get("type")
        if isinstance(wtype, str) and wtype:
            return wtype
        node_id = node.get("id")
        if isinstance(node_id, str) and node_id:
            return node_id
    return fallback


def _unescape_json_pointer_segment(segment: str) -> str:
    return segment.replace("~1", "/").replace("~0", "~")


# Panels that own properties living outside any widget node still need an owner
# id for the property panel to hang the error badge on. These are the editor's
# reserved tree-node ids (frontend/src/shared/constants/editorSentinels.ts), so
# the same value also works as the diagnostics list's navigation target.
_SHELL_REGION_LABELS = {
    "header": "Header",
    "footer": "Footer",
    "leftSidebar": "Left sidebar",
    "rightSidebar": "Right sidebar",
}
_GLOBAL_EVENTS_OWNER = "__events__"


def _synthetic_owner(
    artifact_kind: str, artifact_id: str | None, segments: list[str]
) -> dict[str, Any] | None:
    """Resolve a finding that belongs to a panel rather than to a widget node —
    shell region settings, per-page shell overrides and global event handlers.

    Returns the owner id, the property-relative field path, the breadcrumb and
    which segment is the property itself, or None when the path isn't one of
    those (leaving the widget walk's own answer in place).
    """
    if len(segments) >= 3 and segments[0] in {"shell", "shellOverride"}:
        region = segments[1]
        if region in _SHELL_REGION_LABELS:
            label = _SHELL_REGION_LABELS[region]
            prop_key = segments[2]
            if segments[0] == "shellOverride":
                # A per-page override is edited in that page's own panel, not in
                # the project-wide Shell area panel, so the page owns it and the
                # region stays in the field path — one page panel shows all four
                # regions and their field names would collide otherwise.
                return _synthetic_row(
                    artifact_id, segments[1:], ["Shell override", label, prop_key], prop_key, 1
                )
            return _synthetic_row(f"__{region}__", segments[2:], [label, prop_key], prop_key, 0)
    if artifact_kind == "globalEvents" and segments:
        return _synthetic_row(_GLOBAL_EVENTS_OWNER, segments, [segments[0]], segments[0], 0)
    return None


def _synthetic_row(
    owner: str | None,
    field_path: list[str],
    parts: list[str],
    prop_key: str,
    prop_index: int,
) -> dict[str, Any]:
    """`prop_index` is where `prop_key` sits inside `field_path`; anything past
    it means the finding targets a sub-slot of the property (an `$if`
    condition, say) rather than its own value."""
    return {
        "widgetId": owner,
        "fieldPath": field_path,
        "parts": parts,
        "propKey": prop_key,
        "nested": len(field_path) > prop_index + 1,
    }


def _resolve_finding(
    draft: Any, path: str, artifact_kind: str = "", artifact_id: str | None = None
) -> dict[str, Any]:
    """Walk `path` against the already-validated `draft` to recover the
    finding's widgetId/propKey, a readable breadcrumb, and whether it targets
    a nested sub-slot of the property (e.g. an `$if` condition) rather than
    the property's own top-level value.

    Path-only + the real tree — deliberately has no id/name knowledge beyond
    what it finds by walking, so it works unchanged across page/dialog/shell/
    globalEvents/component drafts. `artifact_kind`/`artifact_id` only
    disambiguate the panel-owned paths that never reach a widget node
    (see `_synthetic_owner`).
    """
    segments = [
        _unescape_json_pointer_segment(segment)
        for segment in path.split("/")
        if segment != ""
    ]
    current = draft
    widget_id: str | None = None
    # Labels found before the property name and after it are kept apart so the
    # property still reads in path order: `Save > onPress > openDialog`, not
    # `Save > openDialog > onPress`.
    breadcrumb_parts: list[str] = []
    sub_parts: list[str] = []
    prop_key: str | None = None
    prop_key_index: int | None = None
    in_properties = False

    for i, seg in enumerate(segments):
        if in_properties and prop_key is None:
            prop_key = seg
            prop_key_index = i
        if isinstance(current, list):
            if not seg.isdigit():
                break
            idx = int(seg)
            if idx >= len(current):
                break
            current = current[idx]
            if isinstance(current, dict) and isinstance(current.get("id"), str) and "type" in current:
                widget_id = current["id"]
                breadcrumb_parts.append(_finding_label(current, seg))
            elif isinstance(current, dict):
                # Not a widget node — an alarm, a recipe parameter, a user, an
                # action inside a property. It owns nothing the editor can
                # badge, but naming it still beats a breadcrumb of bare list
                # indices.
                target = sub_parts if prop_key is not None else breadcrumb_parts
                target.append(_finding_label(current, seg))
            continue
        if isinstance(current, dict):
            if seg in {"properties", "componentProperties"}:
                in_properties = True
            if seg not in current:
                break
            current = current[seg]
            continue
        break

    nested = prop_key_index is not None and prop_key_index < len(segments) - 1
    field_path = segments[prop_key_index:] if prop_key_index is not None else []
    parts = [*breadcrumb_parts, *([prop_key] if prop_key else []), *sub_parts]

    if prop_key is None and segments and not segments[-1].isdigit():
        # No `properties` map on the way down (a domain document, a page-level
        # field), so the last named segment is the closest thing to a property
        # name this path has.
        parts = [*parts, segments[-1]]

    if widget_id is None:
        synthetic = _synthetic_owner(artifact_kind, artifact_id, segments)
        if synthetic is not None:
            widget_id = synthetic["widgetId"]
            field_path = synthetic["fieldPath"]
            parts = synthetic["parts"]
            prop_key = synthetic["propKey"]
            nested = synthetic["nested"]

    return {
        "widgetId": widget_id,
        "propKey": prop_key,
        # Property-relative structural path used by the property panel to
        # attach a finding to the exact nested property card. For example:
        # ["title", "$if", "condition", "$compare", "left"].
        "fieldPath": field_path,
        "breadcrumb": " › ".join(parts) if parts else "(root)",  # noqa: RUF001 -- intentional breadcrumb separator glyph, shown verbatim in the diagnostics UI
        "nested": nested,
    }


def _diagnostic_rows(
    report: ValidationReport,
    *,
    artifact_kind: str,
    artifact_id: str | None,
    draft: Any,
) -> list[dict[str, Any]]:
    """Blocking findings and advisory warnings alike become diagnostic rows —
    build diagnostics never block a write, so both belong in the same list."""
    rows: list[dict[str, Any]] = []
    for f in (*report.findings, *report.warnings):
        resolved = _resolve_finding(draft, f.path, artifact_kind, artifact_id)
        rows.append({
            "artifactId": artifact_id,
            "artifactKind": artifact_kind,
            "sourcePath": f.path,
            "widgetId": resolved["widgetId"],
            "propKey": resolved["propKey"],
            "fieldPath": resolved["fieldPath"],
            "code": f.code,
            "severity": f.severity,
            "message": f.message,
            "breadcrumb": resolved["breadcrumb"],
            "nested": resolved["nested"],
        })
    return rows


def _project_row(
    *,
    artifact_kind: str,
    artifact_id: str | None,
    message: str,
    breadcrumb: str,
    code: str = "",
    severity: str = "warning",
) -> dict[str, Any]:
    """A project-level diagnostic with no owning widget (translations, custom
    widget build status)."""
    return {
        "artifactId": artifact_id,
        "artifactKind": artifact_kind,
        "sourcePath": "",
        "widgetId": None,
        "propKey": None,
        "fieldPath": [],
        "code": code,
        "severity": severity,
        "message": message,
        "breadcrumb": breadcrumb,
        "nested": False,
    }


def _validate_component_tree(component: Any, ctx: Any) -> ValidationReport:
    """Validate a reusable component's widget tree: the generic catalog checks
    (via `validate_widget_node`) plus component-specific rules — reusable
    components cannot bind directly to variables (must use `$componentProp`)
    and cannot nest another reusable component."""
    report = ValidationReport()
    children = component.get("children") if isinstance(component, dict) else None
    if not isinstance(children, list):
        report.add("/children", "children must be an array")
        return report
    for index, child in enumerate(children):
        report.extend(validate_widget_node(child, ctx, f"/children/{index}"))
        if isinstance(child, dict) and str(child.get("type", "")).startswith("$component:"):
            report.add(
                f"/children/{index}/type",
                "reusable components cannot be nested inside other reusable components",
            )
    for binding_path in component_var_source_paths(component):
        report.warn(
            binding_path,
            DIRECT_BINDING_MESSAGE,
            severity="error",
            code="component-direct-binding",
        )
    for nested_path in component_nested_prop_paths(component):
        report.warn(
            nested_path,
            NESTED_PROP_MESSAGE,
            severity="warning",
            code="componentprop-nested",
        )
    for key in component_slot_property_gaps(component):
        report.warn(
            f"/componentProperties/{key}/type",
            f"no Component Slot names '{key}' — instances get no row for it until one does",
            severity="warning",
            code="slot-property-unmatched",
        )
    for slot_path, key in component_undeclared_slots(component):
        report.warn(
            slot_path,
            f"this slot names no property — declare a 'Widget slot' property "
            f"and pick it, or callers get no row for '{key}'",
            severity="warning",
            code="slot-undeclared",
        )
    return report


def _collect_component_diagnostics(ctx: Any, diagnostics: list[dict[str, Any]]) -> None:
    """Validate saved reusable-component trees without mutating their files."""
    for path, _group in component_files():
        artifact_id = path.stem
        try:
            component = read_json(path)
        except Exception as exc:  # A manually edited file must not break the scan.
            diagnostics.append(_project_row(
                artifact_kind="component", artifact_id=artifact_id,
                message=f"could not read component: {exc}", breadcrumb=f"Component: {artifact_id}",
            ))
            continue
        if not isinstance(component, dict):
            diagnostics.append(_project_row(
                artifact_kind="component", artifact_id=artifact_id,
                message="component definition must be an object", breadcrumb=f"Component: {artifact_id}",
            ))
            continue
        report = _validate_component_tree(component, ctx)
        diagnostics.extend(
            _diagnostic_rows(report, artifact_kind="component", artifact_id=artifact_id, draft=component)
        )


def _collect_translation_diagnostics(diagnostics: list[dict[str, Any]]) -> None:
    """Check every CSV dictionary for malformed headers and rows."""
    for path in sorted(active_translations_dir().glob("*.csv")):
        artifact_id = path.stem
        source_label = f"Translations: {artifact_id}"

        def row(message: str, breadcrumb_suffix: str) -> dict[str, Any]:
            return _project_row(
                artifact_kind="translations", artifact_id=artifact_id,  # noqa: B023 -- row() is only ever called synchronously within this same loop iteration, before artifact_id is reassigned; not deferred, so no late-binding bug
                message=message, breadcrumb=f"{source_label} › {breadcrumb_suffix}",  # noqa: B023, RUF001 -- B023: same as above, for source_label; RUF001: intentional breadcrumb separator glyph, shown verbatim in the diagnostics UI
            )

        try:
            rows = read_csv(path)
        except Exception as exc:
            diagnostics.append(row(f"could not read dictionary: {exc}", "(root)"))
            continue
        if not rows or not rows[0]:
            diagnostics.append(row(EMPTY_DICTIONARY_MESSAGE, "(root)"))
            continue
        header = rows[0]
        seen_codes: set[str] = set()
        for index, code in enumerate(header):
            if not isinstance(code, str) or not code.strip():
                diagnostics.append(row("language code is empty", f"language [{index}]"))
            elif code in seen_codes:
                diagnostics.append(row(f"duplicate language code '{code}'", f"language [{index}]"))
            seen_codes.add(code)
        seen_keys: set[str] = set()
        for index, csv_row in enumerate(rows[1:], start=1):
            key = csv_row[0] if csv_row else ""
            if not key.strip():
                diagnostics.append(row("translation key is empty", f"row [{index}]"))
            elif key in seen_keys:
                diagnostics.append(row(f"duplicate translation key '{key}'", f"row [{index}]"))
            seen_keys.add(key)
            if len(csv_row) > len(header):
                diagnostics.append(row("row has more values than language columns", f"row [{index}]"))


def _collect_widget_build_diagnostics(diagnostics: list[dict[str, Any]]) -> None:
    """Surface custom-widget compiler failures in the common verification UI."""
    try:
        raw_status = read_json(BUILD_STATUS_PATH) if BUILD_STATUS_PATH.exists() else {}
    except Exception:
        return
    status = widget_compiler.decode_build_status(raw_status)
    root = active_custom_widgets_dir()
    current_widget_keys = {
        widget_compiler.widget_key(entry, root)
        for entry in widget_compiler.find_entries(root)
    }
    for key, entry in status.items():
        if (
            key not in current_widget_keys
            or not isinstance(entry, dict)
            or entry.get("ok") is not False
        ):
            continue
        diagnostics.append(_project_row(
            artifact_kind="widget-build", artifact_id=key,
            message=str(entry.get("error") or "custom widget failed to compile"),
            breadcrumb=f"Custom widget: {key}",
        ))


# The config domains that live in their own files rather than in the page tree.
# Each is a (kind, path resolver, validator) triple; the sweep treats them all
# the same, so adding a domain is one row here.
_DOMAIN_VALIDATORS: tuple[tuple[str, Any, Any], ...] = (
    ("alarms", active_alarms_config_path, validate_alarms),
    ("recipes", active_recipes_config_path, validate_recipes),
    ("historian", lambda: active_project_root() / "historian" / "config.json", validate_historian),
    ("users", lambda: active_project_root() / "users.json", validate_users),
)


def _collect_domain_diagnostics(ctx: Any, diagnostics: list[dict[str, Any]]) -> None:
    """Validate alarms/recipes/historian/users — the config domains whose
    ``$var`` bindings and group references nothing else checks, so a variable
    deleted out from under them used to read as "No issues"."""
    for kind, resolve_path, validate in _DOMAIN_VALIDATORS:
        path = resolve_path()
        if not path.exists():
            continue
        try:
            doc = read_json(path)
        except Exception as exc:  # A hand-edited file must not break the sweep.
            diagnostics.append(_project_row(
                artifact_kind=kind, artifact_id=kind,
                message=f"could not read {path.name}: {exc}", breadcrumb=path.name,
            ))
            continue
        report = validate(doc, ctx)
        diagnostics.extend(
            _diagnostic_rows(report, artifact_kind=kind, artifact_id=kind, draft=doc)
        )


# mtime-keyed cache for page-file metadata read during index hydration.
# Each GET /api/config/config otherwise re-reads every page file under a lock.
# Process-local: relies on the single-worker uvicorn run. Multi-worker deployments
# would need a shared invalidation channel (each worker only clears its own cache).
_page_meta_cache: dict[str, tuple[int, dict[str, Any]]] = {}

# Keys persisted on per-page JSON files. Anything outside this set is dropped
# both when reading the existing file and when applying a PUT body, so unknown
# keys can't accumulate on disk across saves.
_PAGE_PERSISTED_FIELDS: frozenset[str] = frozenset({
    "title",
    "icon",
    "description",
    "breadcrumbLabel",
    "hidden",
    "role",
    "order",
    "route",
    "layout",
    "showHeader",
    "showFooter",
    "shellOverride",
    "mainPadding",
    "mainBackground",
    "sections",
})


def _invalidate_runtime_cache() -> None:
    """Drop the websocket manager's cached pages_config after any config/page write."""
    from services.websocket_manager import invalidate_runtime_pages_config_cache
    invalidate_runtime_pages_config_cache()
    _page_meta_cache.clear()


def _read_page_index_metadata(node_id: str) -> dict[str, Any]:
    # Defense-in-depth: refuse to follow ids whose shape can't resolve to a safe filename
    # under PAGES_DIR. PUT validates ids on write, but GET reads whatever is in config.json.
    if not is_valid_page_id(node_id):
        return {}
    page_path = active_pages_dir() / f"{node_id}.json"
    try:
        mtime = page_path.stat().st_mtime_ns
    except FileNotFoundError:
        _page_meta_cache.pop(node_id, None)
        return {}
    cached = _page_meta_cache.get(node_id)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        raw = read_json(page_path)
    except FileNotFoundError:
        _page_meta_cache.pop(node_id, None)
        return {}
    file_data = {k: v for k, v in raw.items() if k != "id"} if isinstance(raw, dict) else {}
    _page_meta_cache[node_id] = (mtime, file_data)
    return file_data

# ── Dictionary helpers ────────────────────────────────────────────────────────


def _dict_path(name: str):
    """Resolve a dictionary name to its CSV path inside TRANSLATIONS_DIR.

    Each dictionary is stored as <name>.csv  (e.g. Default.csv, Motor.csv).
    """
    if not is_valid_dict_name(name):
        raise ConfigValidationError("Invalid dictionary name")
    return active_translations_dir() / f"{name}.csv"


def _list_dictionaries() -> list[dict]:
    """Scan TRANSLATIONS_DIR for CSV files and return a sorted list."""
    result = []
    for p in sorted(active_translations_dir().glob("*.csv")):
        dict_name = p.stem  # filename without extension IS the dictionary name
        result.append({"name": dict_name, "filename": p.name})
    # Ensure Default is always first
    result.sort(key=lambda d: (0 if d["name"] == "Default" else 1, d["name"]))
    return result


# ── Global config (index + areas) ─────────────────────────────────────────────

def _list_field(data: Any, key: str) -> list[Any]:
    if not isinstance(data, dict):
        return []
    value = data.get(key)
    return value if isinstance(value, list) else []


def _clean_index_node(node: dict[str, Any]) -> dict[str, Any]:
    """Groups keep their metadata; pages are structural-only (metadata in page files)."""
    if is_page_group(node):
        return {
            **node,
            "children": [
                _clean_index_node(child)
                for child in node.get("children", [])
                if isinstance(child, dict)
            ],
        }
    return {"id": node["id"], "type": "page"}


def _hydrate_index_tree(nodes: list[Any]) -> list[dict[str, Any]]:
    """Merge per-page file metadata into structural page nodes.

    Group nodes carry their metadata in the index; page nodes pull title, icon,
    sections, etc. from their per-page JSON file.
    """
    result: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        if not isinstance(node_id, str):
            continue

        if is_page_group(node):
            result.append({
                **node,
                "children": _hydrate_index_tree(node.get("children", [])),
            })
            continue

        result.append({
            **_read_page_index_metadata(node_id),
            "id": node_id,
            "type": "page",
        })
    return result


def _empty_config() -> dict[str, Any]:
    return {
        "version": 2,
        "pages": [],
        "header": [],
        "footer": [],
        "leftSidebar": [],
        "rightSidebar": [],
        "shell": {},
        "dialogs": [],
        "globalEvents": {},
        "mcpEnabled": False,
    }


def _load_global_config() -> dict[str, Any]:
    """Load version-2 config.json (page index + global areas)."""
    if not _config_path().exists():
        return _empty_config()
    raw = read_json(_config_path())
    if not isinstance(raw, dict):
        return _empty_config()
    return {
        "version": 2,
        "pages": _hydrate_index_tree(_list_field(raw, "pages")),
        "header": _list_field(raw, "header"),
        "footer": _list_field(raw, "footer"),
        "leftSidebar": _list_field(raw, "leftSidebar"),
        "rightSidebar": _list_field(raw, "rightSidebar"),
        "shell": raw.get("shell", {}) if isinstance(raw.get("shell"), dict) else {},
        "dialogs": _list_field(raw, "dialogs"),
        "globalEvents": raw.get("globalEvents", {}) if isinstance(raw.get("globalEvents"), dict) else {},
        "mcpEnabled": raw.get("mcpEnabled") is True,
    }


# ── Index validation ───────────────────────────────────────────────────────────

def _validate_index_node_identity(node: dict[str, Any], ids: set[str]) -> tuple[str, Any]:
    node_id = node.get("id")
    node_type = node.get("type")

    if not isinstance(node_id, str) or not node_id:
        raise ConfigValidationError("Each page entry requires a string id")
    if node_id in ids:
        raise ConfigValidationError(f"Duplicate page id: {node_id}")
    ids.add(node_id)

    return node_id, node_type


def _validate_index_nodes(nodes: list[Any], ids: set[str]) -> None:
    for node in nodes:
        if not isinstance(node, dict):
            raise ConfigValidationError("Each page entry must be an object")

        node_id, node_type = _validate_index_node_identity(node, ids)

        if is_page_group(node):
            if node_type not in (None, "page-group"):
                raise ConfigValidationError(f"Invalid type for group '{node_id}'")
            children = node.get("children")
            if not isinstance(children, list):
                raise ConfigValidationError(f"Group '{node_id}' requires children")
            for child in children:
                if not isinstance(child, dict):
                    raise ConfigValidationError(f"Group '{node_id}' has invalid child")
            for chrome_key in ("header", "footer"):
                if chrome_key in node and not isinstance(node[chrome_key], list):
                    raise ConfigValidationError(
                        f"Group '{node_id}' field '{chrome_key}' must be an array"
                    )
            _validate_index_nodes(children, ids)
        else:
            if node_type not in (None, "page"):
                raise ConfigValidationError(f"Invalid type for page '{node_id}'")
            if "children" in node or "sections" in node:
                raise ConfigValidationError(
                    f"Page index entry '{node_id}' must not contain page content — "
                    "use PUT /api/config/pages/{id} to save page content",
                )


# ── Config endpoints ───────────────────────────────────────────────────────────

@router.get("/config")
async def get_config() -> Any:
    return _load_global_config()


@router.put("/config")
async def put_config(body: dict) -> Any:
    if "pages" not in body or not isinstance(body["pages"], list):
        raise ConfigValidationError("'pages' array is required")
    _validate_index_nodes(body["pages"], set())

    existing_raw = read_json(_config_path()) if _config_path().exists() else {}
    existing_mcp_enabled = (
        existing_raw.get("mcpEnabled") is True if isinstance(existing_raw, dict) else False
    )
    existing_project_block = (
        existing_raw.get("project") if isinstance(existing_raw, dict) else None
    )

    payload = {
        "version": 2,
        "pages": [_clean_index_node(n) for n in body["pages"] if isinstance(n, dict)],
        "header": _list_field(body, "header"),
        "footer": _list_field(body, "footer"),
        "leftSidebar": _list_field(body, "leftSidebar"),
        "rightSidebar": _list_field(body, "rightSidebar"),
        "shell": body.get("shell", {}) if isinstance(body.get("shell"), dict) else {},
        "dialogs": _list_field(body, "dialogs"),
        "globalEvents": body.get("globalEvents", {}) if isinstance(body.get("globalEvents"), dict) else {},
        # Preserve the admin-managed flag — `PUT /api/config` carries the editable
        # surface (pages/shell/etc.) and should not silently clear it.
        "mcpEnabled": body["mcpEnabled"] is True if "mcpEnabled" in body else existing_mcp_enabled,
    }
    # Preserve the embedded project metadata block — id/name/createdAt must
    # survive every config save (push/pull dedupes on `project.id`).
    if isinstance(existing_project_block, dict):
        payload["project"] = existing_project_block

    # Validate the widget trees this document carries (shell component arrays,
    # dialogs, globalEvents, shell region bindings) before persisting — the
    # per-page endpoint validates page sections, but this surface was previously
    # written unchecked. Resolve cross-references (pages, dialogs) against the
    # incoming body so a page/dialog created in the same save validates.
    ctx = build_context()
    ctx.page_ids = collect_page_ids(payload["pages"])
    ctx.dialog_ids = collect_dialog_ids(payload["dialogs"])
    ctx.dialog_property_keys = collect_dialog_property_keys(payload["dialogs"])
    report = validate_config_areas(payload, ctx)
    if not report.ok:
        raise ConfigValidationError(report.to_message())

    write_json(_config_path(), payload)

    # Remove orphaned page files whose IDs are no longer in the index
    index_ids = ctx.page_ids
    for path in active_pages_dir().glob("*.json"):
        if path.stem.startswith("__"):
            continue
        if path.stem not in index_ids:
            path.unlink(missing_ok=True)

    _invalidate_runtime_cache()
    return payload


# ── Build diagnostics ──────────────────────────────────────────────────────────
# Two endpoints on one path, method-distinguished, both reusing the same walk
# as the write-API's blocking structural guard (which stays untouched — these
# are purely advisory and never block a save).

_VALIDATE_KINDS = frozenset({"page", "dialog", "shell", "globalEvents", "component"})


@router.post("/validate")
async def validate_draft(body: dict) -> Any:
    """Realtime, single-artifact validation of an *unsaved* draft.

    Body: ``{ kind, draft }``. Validates the posted draft directly (so it
    covers edits that haven't been saved yet) — reads disk only for context
    (registry / translations / assets via ``build_context``). Stateless,
    read-only, never persists.
    """
    kind = body.get("kind")
    draft = body.get("draft")
    if kind not in _VALIDATE_KINDS:
        raise ConfigValidationError(f"'kind' must be one of {sorted(_VALIDATE_KINDS)}")
    if not isinstance(draft, dict):
        raise ConfigValidationError("'draft' must be an object")

    ctx = build_context()
    artifact_id = draft.get("id") if isinstance(draft.get("id"), str) else None
    if kind == "page":
        report = validate_page(draft, ctx)
    elif kind == "dialog":
        report = validate_dialog(draft, ctx)
    elif kind == "shell":
        report = validate_shell_areas(draft, ctx)
        artifact_id = "shell"
    elif kind == "globalEvents":
        report = validate_global_events(draft, ctx)
        artifact_id = "globalEvents"
    else:  # component
        report = _validate_component_tree(draft, ctx)

    return {"diagnostics": _diagnostic_rows(report, artifact_kind=kind, artifact_id=artifact_id, draft=draft)}


@router.get("/validate")
async def get_project_diagnostics() -> Any:
    """Whole-project sweep: validate every persisted artifact from disk.

    Covers pages the user hasn't opened this session, reusable components,
    translation dictionaries, and custom-widget build status — the realtime
    endpoint only ever sees the one artifact currently open. Read-only, never
    recompiles or rewrites.
    """
    ctx = build_context()
    diagnostics: list[dict[str, Any]] = []

    raw = read_json(_config_path()) if _config_path().exists() else {}
    if isinstance(raw, dict):
        shell_draft = {
            "header": raw.get("header"),
            "footer": raw.get("footer"),
            "leftSidebar": raw.get("leftSidebar"),
            "rightSidebar": raw.get("rightSidebar"),
            "shell": raw.get("shell"),
        }
        shell_report = validate_shell_areas(shell_draft, ctx)
        diagnostics.extend(
            _diagnostic_rows(shell_report, artifact_kind="shell", artifact_id="shell", draft=shell_draft)
        )

        dialogs = raw.get("dialogs")
        if isinstance(dialogs, list):
            for dialog in dialogs:
                if not isinstance(dialog, dict):
                    continue
                did = dialog.get("id") if isinstance(dialog.get("id"), str) else None
                dialog_report = validate_dialog(dialog, ctx)
                diagnostics.extend(
                    _diagnostic_rows(dialog_report, artifact_kind="dialog", artifact_id=did, draft=dialog)
                )

        global_events = raw.get("globalEvents")
        if isinstance(global_events, dict):
            events_report = validate_global_events(global_events, ctx)
            diagnostics.extend(_diagnostic_rows(
                events_report, artifact_kind="globalEvents", artifact_id="globalEvents", draft=global_events,
            ))

    pages_dir = active_pages_dir()
    if pages_dir.exists():
        for path in sorted(pages_dir.glob("*.json")):
            if path.stem.startswith("__"):
                continue
            try:
                page = read_json(path)
            except FileNotFoundError:
                continue
            if not isinstance(page, dict):
                continue
            page_report = validate_page(page, ctx)
            diagnostics.extend(
                _diagnostic_rows(page_report, artifact_kind="page", artifact_id=path.stem, draft=page)
            )

    _collect_component_diagnostics(ctx, diagnostics)
    _collect_translation_diagnostics(diagnostics)
    _collect_widget_build_diagnostics(diagnostics)
    _collect_domain_diagnostics(ctx, diagnostics)
    return {"diagnostics": diagnostics}


# ── Per-page content endpoints ─────────────────────────────────────────────────

@router.get("/pages/{page_id}")
async def get_page(page_id: str) -> Any:
    if not is_valid_page_id(page_id):
        raise ConfigValidationError("Invalid page id")
    path = active_pages_dir() / f"{page_id}.json"
    if not path.exists():
        return {"id": page_id, "sections": {"content": []}}
    return read_json(path)


@router.put("/pages/{page_id}")
async def put_page(page_id: str, body: dict) -> Any:
    if not is_valid_page_id(page_id):
        raise ConfigValidationError("Invalid page id")
    if "sections" in body:
        sections = body["sections"]
        if not isinstance(sections, dict):
            raise ConfigValidationError("'sections' must be an object")
        for section_id, children in sections.items():
            if not isinstance(section_id, str) or not isinstance(children, list):
                raise ConfigValidationError("'sections' values must be arrays")
            for child in children:
                if isinstance(child, dict) and child.get("type") == "page-group":
                    raise ConfigValidationError(
                        "Pages may not contain page-groups — nest the group inside another page-group instead",
                    )

    path = active_pages_dir() / f"{page_id}.json"
    try:
        existing = read_json(path)
    except FileNotFoundError:
        existing = {}
    if not isinstance(existing, dict):
        existing = {}
    before = existing if existing else None
    merged = {
        **{k: v for k, v in existing.items() if k in _PAGE_PERSISTED_FIELDS},
        **{k: v for k, v in body.items() if k in _PAGE_PERSISTED_FIELDS},
    }
    # Explicit null in the body signals "clear this field" — drop it so
    # toggles like `hidden` can be removed, not just set.
    merged = {k: v for k, v in merged.items() if v is not None}
    payload = {"id": page_id, **merged}
    report = validate_page(payload, build_context())
    if not report.ok:
        raise ConfigValidationError(report.to_message())
    write_json(path, payload)
    _invalidate_runtime_cache()
    event = ConfigChangedEvent(
        artifact_type="page",
        artifact_ids=[page_id],
        source="rest",
        summary=f"PUT /api/config/pages/{page_id}",
        diff=make_diff(before, payload),
    )
    # Fire-and-forget so a slow browser tab doesn't bound REST response time.
    task = asyncio.create_task(websocket_manager.broadcast_config_changed(event))
    task.add_done_callback(_log_broadcast_error)
    return payload


@router.delete("/pages/{page_id}")
async def delete_page(page_id: str) -> Any:
    if not is_valid_page_id(page_id):
        raise ConfigValidationError("Invalid page id")
    path = active_pages_dir() / f"{page_id}.json"
    path.unlink(missing_ok=True)
    _invalidate_runtime_cache()
    return {"ok": True}


# ── Dictionary config ─────────────────────────────────────────────────────────

@router.get("/dictionaries")
async def get_dictionaries() -> Any:
    return _list_dictionaries()


@router.post("/dictionaries")
async def create_dictionary(body: dict) -> Any:
    raw_name = body.get("name", "")
    if not isinstance(raw_name, str):
        raise ConfigValidationError("'name' must be a string")
    name = raw_name.strip()
    if not name:
        raise ConfigValidationError("'name' is required")
    if not is_valid_dict_name(name):
        raise ConfigValidationError("Invalid dictionary name")
    if name == "Default":
        raise ConfigConflictError("'Default' dictionary always exists")
    path = active_translations_dir() / f"{name}.csv"
    with translation_transaction(path):
        if path.exists():
            raise ConfigConflictError("Dictionary already exists")
        if _default_dict_path().exists():
            with translation_transaction(_default_dict_path()):
                default_rows = read_csv(_default_dict_path())
                default_document = parse_translation_rows(default_rows)
                header = [language["code"] for language in default_document["languages"]]
        else:
            header = ["en-EN"]
        write_csv(path, [header])
    return _list_dictionaries()


@router.delete("/dictionaries/{name}")
async def delete_dictionary(name: str) -> Any:
    if name == "Default":
        raise ConfigValidationError("Cannot delete the Default dictionary")
    if not is_valid_dict_name(name):
        raise ConfigValidationError("Invalid dictionary name")
    path = active_translations_dir() / f"{name}.csv"
    with translation_transaction(path):
        if not path.exists():
            raise ConfigNotFoundError("Dictionary not found")
        path.unlink()
    return _list_dictionaries()


# ── Translations config ───────────────────────────────────────────────────────

def _parse_translations_csv(path=None) -> dict:
    """Read a translations CSV file and return structured JSON.

    CSV format:
      Row 0: language codes (e.g. en-EN;nl-NL;de-DE)
      Row 1+: translation rows (first column = key)
    """
    if path is None:
        path = _default_dict_path()
    with translation_transaction(path):
        if not path.exists():
            return {"languages": [], "rows": {}, "revision": "missing"}
        return translation_payload(read_csv(path), path)


@router.get("/translations")
async def get_translations(dict_name: str = Query(default="Default", alias="dict")) -> Any:
    return _parse_translations_csv(_dict_path(dict_name))


@router.post("/translations")
async def add_translation(body: dict, dict_name: str = Query(default="Default", alias="dict")) -> Any:
    path = _dict_path(dict_name)
    raw_key = body.get("key", "")
    if not isinstance(raw_key, str):
        raise ConfigValidationError("'key' must be a string")
    key = raw_key.strip()
    if not key:
        raise ConfigValidationError("'key' is required")

    with translation_transaction(path):
        if not path.exists():
            raise ConfigNotFoundError("Dictionary not found")
        rows = read_csv(path)
        document = parse_translation_rows(rows)
        if key in document["rows"]:
            raise ConfigConflictError("Translation key already exists")
        rows.append([key] + [""] * (len(rows[0]) - 1))
        write_csv(path, rows)
        payload = translation_payload(rows, path)
    return payload


@router.put("/translations")
async def put_translations(body: dict, dict_name: str = Query(default="Default", alias="dict")) -> Any:
    """Full save: languages + rows.

    Body: {
      "languages": [{"code": "en-EN"}, ...],
      "rows": {"key": {"en-EN": "...", "nl-NL": "..."}, ...}
    }
    """
    path = _dict_path(dict_name)
    languages = body.get("languages")
    rows_dict = body.get("rows")
    expected_revision = body.get("revision")
    if not isinstance(languages, list) or not isinstance(rows_dict, dict):
        raise ConfigValidationError("'languages' and 'rows' are required")

    codes: list[str] = []
    for index, language in enumerate(languages):
        if not isinstance(language, dict):
            raise ConfigValidationError(f"languages[{index}] must be an object")
        code = language.get("code")
        if not isinstance(code, str) or not code.strip():
            raise ConfigValidationError(f"languages[{index}].code must be a non-empty string")
        if code in codes:
            raise ConfigValidationError(f"duplicate language code '{code}'")
        codes.append(code)
    if not codes:
        raise ConfigValidationError("at least one language is required")

    with translation_transaction(path):
        actual_revision = translation_revision(path)
        if not isinstance(expected_revision, str):
            raise ConfigConflictError(
                "translation revision is required; reload the dictionary before saving"
            )
        if expected_revision != actual_revision:
            raise ConfigConflictError(
                "translation dictionary changed; reload before saving"
            )
        existing_rows = read_csv(path) if path.exists() else None
        csv_rows = build_translation_rows(codes, rows_dict, existing_rows=existing_rows)
        write_csv(path, csv_rows)
        payload = translation_payload(csv_rows, path)
    return payload


@router.post("/translations/language")
async def add_language(
    body: dict, dict_name: str = Query(default="Default", alias="dict")
) -> Any:
    """Add a new language column to one dictionary. Body: {"code": "fr-FR"}"""
    raw_code = body.get("code", "")
    if not isinstance(raw_code, str):
        raise ConfigValidationError("'code' must be a string")
    code = raw_code.strip()
    if not code:
        raise ConfigValidationError("'code' is required")

    path = _dict_path(dict_name)
    with translation_transaction(path):
        if not path.exists():
            raise ConfigNotFoundError("Dictionary not found")
        existing_rows = read_csv(path)
        document = parse_translation_rows(existing_rows)
        if code in existing_rows[0]:
            raise ConfigConflictError("Language already exists")
        rows = build_translation_rows(
            [*(language["code"] for language in document["languages"]), code],
            document["rows"],
            existing_rows=existing_rows,
        )
        write_csv(path, rows)
        payload = translation_payload(rows, path)
    return payload


@router.delete("/translations/language/{code}")
async def delete_language(
    code: str, dict_name: str = Query(default="Default", alias="dict")
) -> Any:
    """Remove a language column by code from one dictionary."""
    path = _dict_path(dict_name)
    with translation_transaction(path):
        if not path.exists():
            raise ConfigNotFoundError("No translations file")
        rows = read_csv(path)
        parse_translation_rows(rows)
        if code not in rows[0]:
            raise ConfigNotFoundError("Language not found")
        idx = rows[0].index(code)
        if idx == 0:
            raise ConfigValidationError("Cannot remove the primary language")
        for row in rows:
            if idx < len(row):
                row.pop(idx)
        write_csv(path, rows)
        payload = translation_payload(rows, path)
    return payload


@router.delete("/translations/{key:path}")
async def delete_translation(key: str, dict_name: str = Query(default="Default", alias="dict")) -> Any:
    """Remove a single translation row by its key (en-EN value)."""
    path = _dict_path(dict_name)
    with translation_transaction(path):
        if not path.exists():
            raise ConfigNotFoundError("No translations file")
        rows = read_csv(path)
        parse_translation_rows(rows)
        if len(rows) < 2:
            raise ConfigNotFoundError("Translation not found")
        new_rows = rows[:1]
        found = False
        for row in rows[1:]:
            if row and row[0] == key:
                found = True
            else:
                new_rows.append(row)
        if not found:
            raise ConfigNotFoundError("Translation not found")
        write_csv(path, new_rows)
        payload = translation_payload(new_rows, path)
    return payload
