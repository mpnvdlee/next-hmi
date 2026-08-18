from __future__ import annotations

import copy
import fnmatch
from typing import Any

from core.exceptions import (
    ConfigConflictError,
    ConfigNotFoundError,
    ConfigValidationError,
)
from core.storage import active_datasources_dir, read_json, write_json
from core.validation import is_valid_datasource_name, validate_variable_write_fields
from core.value_types import representative_opcua_type, to_simple_type
from services.datasource_manager import datasource_manager
from services.datasource_sync import apply_datasource_change, enabled_paths

from .. import idempotency, locks
from ..confirm import applied_response, dry_run_response
from ..pagination import paginated_payload
from ..server import expose_read_tool, get_agent_label, register_tool
from ..write_helpers import emit_change
from ._common import merge_patch


def _ds_path(datasource: str):
    if not is_valid_datasource_name(datasource):
        raise ConfigValidationError(f"Invalid datasource name: {datasource!r}")
    return active_datasources_dir() / f"{datasource}.json"


def _node_name(node: Any) -> str | None:
    """Return the addressable name of a tree node — folder ``name`` or variable ``display_name``."""
    if not isinstance(node, dict):
        return None
    if node.get("kind") == "folder":
        name = node.get("name")
    else:
        name = node.get("display_name")
    return name if isinstance(name, str) else None


def _split_path(path: str) -> list[str]:
    return [seg for seg in path.split("/") if seg]


def _walk_path(
    nodes: list, segments: list[str]
) -> tuple[dict | None, list | None]:
    """Walk by name segments; returns ``(node, parent_list)`` or ``(None, None)``."""
    if not segments:
        return None, None
    head, *rest = segments
    for entry in nodes:
        if _node_name(entry) != head:
            continue
        if not rest:
            return entry, nodes
        if entry.get("kind") != "folder":
            return None, None
        children = entry.get("children")
        if not isinstance(children, list):
            return None, None
        return _walk_path(children, rest)
    return None, None


def _folder_children(variables: list, parent_path: str | None) -> list | None:
    """Return the children-list of the folder at ``parent_path``.

    ``parent_path`` of ``None`` or empty string addresses the datasource root.
    Returns ``None`` when the parent does not exist or is not a folder.
    """
    if not parent_path:
        return variables
    node, _ = _walk_path(variables, _split_path(parent_path))
    if node is None or node.get("kind") != "folder":
        return None
    children = node.get("children")
    if not isinstance(children, list):
        node["children"] = []
        children = node["children"]
    return children


async def _sync_runtime(
    datasource: str, after: dict[str, Any], old_enabled: set[str],
) -> None:
    """Apply a variable write to this process's live OPC-UA pipeline.

    Skipped under a ``use_project`` scope: there the tool runs in the manager,
    which holds no live pipeline. The running child re-applies the delta when it
    handles the reload hook (see ``api/internal_api`` + ``emit_change``).
    """
    from core.storage import current_scoped_project_id

    if current_scoped_project_id() is not None:
        return
    await apply_datasource_change(datasource, after, old_enabled)


def _walk_for_list(
    nodes: list,
    prefix: str,
    ds_name: str,
    items: list[tuple[str, str, dict]],
) -> None:
    """Walk a datasource variable tree, emitting one summary per variable leaf."""
    for entry in nodes:
        if not isinstance(entry, dict):
            continue
        kind = entry.get("kind")
        if kind == "folder":
            name = entry.get("name")
            if not isinstance(name, str):
                continue
            children = entry.get("children")
            if isinstance(children, list):
                _walk_for_list(
                    children, f"{prefix}/{name}" if prefix else name, ds_name, items
                )
            continue
        display_name = entry.get("display_name")
        if not isinstance(display_name, str):
            continue
        var_path = f"{prefix}/{display_name}" if prefix else display_name
        full_id = f"{ds_name}/{var_path}"
        summary = {
            "datasource": ds_name,
            "path": var_path,
            "data_type": to_simple_type(
                entry.get("data_type"), is_array=bool(entry.get("is_array"))
            ),
            "enabled": entry.get("enabled", True),
        }
        items.append((full_id, full_id, summary))


def _list_items() -> list[tuple[str, str, dict]]:
    items: list[tuple[str, str, dict]] = []
    if not active_datasources_dir().exists():
        return items
    for ds_path in sorted(active_datasources_dir().glob("*.json")):
        try:
            doc = read_json(ds_path)
        except Exception:
            continue
        name = doc.get("name", ds_path.stem) if isinstance(doc, dict) else ds_path.stem
        variables = doc.get("variables", []) if isinstance(doc, dict) else []
        if isinstance(variables, list):
            _walk_for_list(variables, "", name, items)
    return items


def _matches(
    summary: dict,
    datasource: str | None,
    path_pattern: str | None,
    data_type: str | None,
    enabled: bool | None,
) -> bool:
    if datasource is not None and summary["datasource"] != datasource:
        return False
    if path_pattern is not None and not fnmatch.fnmatchcase(summary["path"], path_pattern):
        return False
    if data_type is not None:
        # Accept either a simple-type or real-OPC-UA filter; compare on simple types.
        want = to_simple_type(data_type)
        have = str(summary["data_type"] or "")
        if have != want and have.removesuffix("[]") != want:
            return False
    return not (enabled is not None and summary["enabled"] != enabled)


def _list_payload(
    datasource: str | None = None,
    path_pattern: str | None = None,
    data_type: str | None = None,
    enabled: bool | None = None,
    cursor: str | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    if datasource is not None and not is_valid_datasource_name(datasource):
        raise ConfigValidationError(f"Invalid datasource name: {datasource!r}")
    items = _list_items()
    if any(p is not None for p in (datasource, path_pattern, data_type, enabled)):
        items = [
            (k, i, s) for (k, i, s) in items
            if _matches(s, datasource, path_pattern, data_type, enabled)
        ]
    return paginated_payload(items, cursor=cursor, limit=limit)


variables_list = expose_read_tool(
    _list_payload,
    name="variables_list",
    description=(
        "List variables across datasources. **Always pass at least one filter** "
        "(``datasource``, ``path_pattern``, ``data_type``, or ``enabled``) — "
        "unfiltered listings can exceed hundreds of items and waste context. "
        "Filters combine with AND: ``datasource`` exact match (e.g. ``\"PLC\"``); "
        "``path_pattern`` fnmatch-style glob against the variable path — "
        "``*`` matches any character including ``/`` so ``\"Motor/*\"`` "
        "matches every descendant of ``Motor`` (use ``\"*Speed*\"`` for "
        "substring, ``\"Motor/Sub/Temp\"`` for exact); "
        "``data_type`` simple-type match (e.g. ``\"float\"``, ``\"boolean\"``, ``\"integer\"``); "
        "``enabled`` true/false. Returns ``{ items, next_cursor? }`` where each "
        "item is ``{ datasource, path, data_type, enabled }``. Use "
        "``datasources_get`` for the full variable tree (with nested children) on "
        "a specific datasource."
    ),
)


@register_tool()
async def variables_add(
    datasource: str,
    name: str,
    data_type: str,
    parent_path: str | None = None,
    settings: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Add a variable under ``parent_path`` (root if omitted).

    ``name`` becomes the variable's ``display_name``. ``data_type`` is a simple
    type (``boolean``, ``integer``, ``float``, ``string``, ``datetime``); it is
    persisted as its representative OPC-UA type (e.g. ``integer`` → ``Int32``,
    ``float`` → ``Double``). ``settings`` may override defaults — recognised keys
    are ``writable`` (bool), ``value`` (any), ``node_id`` (str, for OPC-UA),
    ``is_array`` (bool) with optional ``array_length`` (positive int; omitted
    means dynamic/unknown length — ``array_length`` must not be set without
    ``is_array``), ``enabled`` (bool, default ``true``), ``min``/``max``
    (numeric, for a configured range on a numeric variable), and ``fields``.
    Any other data must go under ``extensions`` (an object) — unrecognised
    top-level keys are rejected, and ``kind``/``display_name``/``data_type``
    (this call already sets them) and ``present_on_server`` (server-derived)
    cannot be set via ``settings``.

    The variable is written in the same shape the UI editor produces:
    ``{ kind: "variable", display_name, data_type, enabled, writable, ... }``.
    """
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    if not isinstance(name, str) or not name or "/" in name:
        raise ConfigValidationError("Variable name must be non-empty and not contain '/'")
    if not isinstance(data_type, str) or not data_type:
        raise ConfigValidationError("data_type is required")
    if settings:
        validate_variable_write_fields(settings, context="variables_add settings")
    ds_path = _ds_path(datasource)
    if not ds_path.exists():
        raise ConfigNotFoundError(f"Datasource '{datasource}' not found")
    async with locks.acquire(("variables", datasource)):
        before = read_json(ds_path)
        after = copy.deepcopy(before)
        variables = after.setdefault("variables", [])
        siblings = _folder_children(variables, parent_path)
        if siblings is None:
            raise ConfigNotFoundError(
                f"Parent folder '{parent_path}' not found in '{datasource}'"
            )
        if any(_node_name(c) == name for c in siblings):
            full_path = f"{parent_path}/{name}" if parent_path else name
            raise ConfigConflictError(
                f"Variable '{datasource}:{full_path}' already exists"
            )
        ds_type = after.get("type", "")
        new_entry: dict[str, Any] = {
            "kind": "variable",
            "display_name": name,
            "data_type": representative_opcua_type(to_simple_type(data_type)),
            "enabled": True,
            "writable": ds_type == "static",
        }
        if settings:
            new_entry.update(settings)
        siblings.append(new_entry)
        old_enabled = enabled_paths(datasource_manager.get(datasource))
        write_json(ds_path, after)
        await _sync_runtime(datasource, after, old_enabled)
        full_path = f"{parent_path}/{name}" if parent_path else name
        response = applied_response(
            f"Added variable '{datasource}:{full_path}'", before, after
        )
        response["path"] = full_path
    await emit_change(
        artifact_type="variables",
        artifact_ids=[f"{datasource}/{full_path}"],
        summary=response["summary"],
        diff=response["diff"]
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response


@register_tool()
async def variables_delete(
    datasource: str,
    path: str,
    confirm: bool = False,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Delete a variable by tree ``path``. Two-step: dry-run unless ``confirm=true``."""
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    segments = _split_path(path)
    if not segments:
        raise ConfigValidationError("path is required")
    ds_path = _ds_path(datasource)
    if not ds_path.exists():
        raise ConfigNotFoundError(f"Datasource '{datasource}' not found")
    if not confirm:
        preview_before = read_json(ds_path)
        entry, _ = _walk_path(preview_before.get("variables", []), segments)
        if entry is None:
            raise ConfigNotFoundError(f"Variable '{datasource}:{path}' not found")
        preview = copy.deepcopy(preview_before)
        target, parent = _walk_path(preview.get("variables", []), segments)
        if target is not None and parent is not None:
            parent.remove(target)
        return dry_run_response(
            f"Would delete variable '{datasource}:{path}'", preview_before, preview
        )
    async with locks.acquire(("variables", datasource)):
        before = read_json(ds_path)
        entry, _ = _walk_path(before.get("variables", []), segments)
        if entry is None:
            raise ConfigNotFoundError(f"Variable '{datasource}:{path}' not found")
        after = copy.deepcopy(before)
        target, parent = _walk_path(after.get("variables", []), segments)
        if target is not None and parent is not None:
            parent.remove(target)
        old_enabled = enabled_paths(datasource_manager.get(datasource))
        write_json(ds_path, after)
        await _sync_runtime(datasource, after, old_enabled)
        response = applied_response(
            f"Deleted variable '{datasource}:{path}'", before, after
        )
    await emit_change(
        artifact_type="variables",
        artifact_ids=[f"{datasource}/{path}"],
        summary=response["summary"],
        diff=response["diff"]
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response


@register_tool()
async def variables_set_property(
    datasource: str,
    path: str,
    patch: dict[str, Any],
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Merge-patch a variable's writable fields (RFC 7396). Toggle ``enabled``
    by passing ``patch={"enabled": <bool>}``. Core writable fields are
    ``node_id``, ``is_array``, ``array_length``, ``enabled``, ``writable``,
    ``value``, ``min``, ``max``, ``fields``; anything else must go under an
    ``extensions`` object (preserved verbatim, including per-key deletion via
    ``{"extensions": {"key": null}}``). ``kind``/``display_name``/``data_type``
    and the server-derived ``present_on_server`` cannot be patched here."""
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    validate_variable_write_fields(patch, context="variables_set_property patch")
    segments = _split_path(path)
    if not segments:
        raise ConfigValidationError("path is required")
    ds_path = _ds_path(datasource)
    if not ds_path.exists():
        raise ConfigNotFoundError(f"Datasource '{datasource}' not found")
    async with locks.acquire(("variables", datasource)):
        before = read_json(ds_path)
        after = copy.deepcopy(before)
        entry, _ = _walk_path(after.get("variables", []), segments)
        if entry is None:
            raise ConfigNotFoundError(f"Variable '{datasource}:{path}' not found")
        merge_patch(entry, patch)
        old_enabled = enabled_paths(datasource_manager.get(datasource))
        write_json(ds_path, after)
        await _sync_runtime(datasource, after, old_enabled)
        response = applied_response(
            f"Updated '{datasource}:{path}'", before, after
        )
    await emit_change(
        artifact_type="variables",
        artifact_ids=[f"{datasource}/{path}"],
        summary=response["summary"],
        diff=response["diff"]
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response
