from __future__ import annotations

import copy
from typing import Any

from core.exceptions import ConfigNotFoundError, ConfigValidationError
from core.ids import slug_id
from core.storage import active_alarms_config_path, read_json, write_json
from models.alarm import AlarmConfig
from services.alarm_manager import alarm_manager

from .. import idempotency, locks
from ..confirm import applied_response, dry_run_response
from ..server import expose_read_tool, get_agent_label, register_tool
from ..write_helpers import emit_change
from ._common import merge_patch

_VALID_LEVELS = frozenset({"error", "warning", "info"})
_SERVER_MANAGED_FIELDS = frozenset({"id"})


def _empty_config() -> dict[str, Any]:
    return {"version": 1, "groups": []}


def _read_alarms() -> dict[str, Any]:
    if not active_alarms_config_path().exists():
        return _empty_config()
    raw = read_json(active_alarms_config_path())
    if not isinstance(raw, dict):
        return _empty_config()
    raw.setdefault("version", 1)
    raw.setdefault("groups", [])
    return raw


def _write_alarms(doc: dict[str, Any]) -> None:
    # Pydantic round-trip fills defaults the UI editor relies on; the parsed
    # model is also handed to the alarm_manager so the running trigger map
    # picks up the change without a restart.
    model = AlarmConfig.model_validate(doc)
    write_json(active_alarms_config_path(), model.model_dump())
    alarm_manager.apply_config(model)


def _find_group(doc: dict[str, Any], group_id: str) -> dict[str, Any] | None:
    for g in doc.get("groups", []):
        if isinstance(g, dict) and g.get("id") == group_id:
            return g
    return None


def _find_alarm_with_group(
    doc: dict[str, Any], alarm_id: str
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    for g in doc.get("groups", []):
        if not isinstance(g, dict):
            continue
        for a in g.get("alarms", []):
            if isinstance(a, dict) and a.get("id") == alarm_id:
                return a, g
    return None


alarms_get_config = expose_read_tool(
    _read_alarms,
    name="alarms_get_config",
    description="Full alarms.json document — ``{ version, groups: [{ id, title, alarms: [...] }] }``.",
)


@register_tool()
async def alarms_add(
    group_id: str,
    title: str | None = None,
    level: str = "warning",
    trigger: dict[str, Any] | None = None,
    settings: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Create a new alarm definition under ``group_id``.

    ``level`` is one of ``error`` / ``warning`` / ``info``. ``trigger`` is the
    ``AlarmTrigger`` payload — typically ``{ type: "bool", source_value: { "$var": ... }, on_true: true }``
    or ``{ type: "value_range", source_value: ..., min: ..., max: ... }``. Falls
    back to a default ``bool`` trigger when omitted. ``settings`` may override
    other ``AlarmDefinition`` fields (``code``, ``description``, ``image``,
    ``auto_popup``, ``resolutions``, ``ack_groups``).
    """
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    if level not in _VALID_LEVELS:
        raise ConfigValidationError(
            f"level must be one of {sorted(_VALID_LEVELS)}, got '{level}'"
        )
    async with locks.acquire(("alarms", "config")):
        before = _read_alarms()
        after = copy.deepcopy(before)
        group = _find_group(after, group_id)
        if group is None:
            raise ConfigNotFoundError(f"Alarm group '{group_id}' not found")
        new_alarm: dict[str, Any] = {
            "code": "",
            "level": level,
            "title": title if title is not None else "New Alarm",
            "description": "",
            "image": "",
            "auto_popup": False,
            "resolutions": [],
            "trigger": trigger if trigger is not None else {"type": "bool"},
            "ack_groups": [],
        }
        if settings:
            new_alarm.update(settings)
        existing_ids = {
            a["id"]
            for g in after.get("groups", [])
            if isinstance(g, dict)
            for a in g.get("alarms", [])
            if isinstance(a, dict) and isinstance(a.get("id"), str)
        }
        alarm_id = slug_id(new_alarm.get("code") or new_alarm.get("title") or "alarm", existing_ids)
        new_alarm["id"] = alarm_id
        group.setdefault("alarms", []).append(new_alarm)
        _write_alarms(after)
        response = applied_response(
            f"Created alarm '{new_alarm['title']}' in group '{group_id}'",
            before,
            after,
        )
        response["alarm_id"] = alarm_id
    await emit_change(
        artifact_type="alarms",
        artifact_ids=["config"],
        summary=response["summary"],
        diff=response["diff"]
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response


@register_tool()
async def alarms_delete(
    alarm_id: str,
    confirm: bool = False,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Delete an alarm. Two-step: dry-run unless ``confirm=true``."""
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    if not confirm:
        preview_before = _read_alarms()
        if _find_alarm_with_group(preview_before, alarm_id) is None:
            raise ConfigNotFoundError(f"Alarm '{alarm_id}' not found")
        preview = copy.deepcopy(preview_before)
        for g in preview.get("groups", []):
            if isinstance(g, dict) and isinstance(g.get("alarms"), list):
                g["alarms"] = [a for a in g["alarms"] if a.get("id") != alarm_id]
        return dry_run_response(f"Would delete alarm '{alarm_id}'", preview_before, preview)
    async with locks.acquire(("alarms", "config")):
        before = _read_alarms()
        if _find_alarm_with_group(before, alarm_id) is None:
            raise ConfigNotFoundError(f"Alarm '{alarm_id}' not found")
        after = copy.deepcopy(before)
        for g in after.get("groups", []):
            if not isinstance(g, dict):
                continue
            alarms = g.get("alarms")
            if not isinstance(alarms, list):
                continue
            g["alarms"] = [a for a in alarms if a.get("id") != alarm_id]
        _write_alarms(after)
        response = applied_response(f"Deleted alarm '{alarm_id}'", before, after)
    await emit_change(
        artifact_type="alarms",
        artifact_ids=["config"],
        summary=response["summary"],
        diff=response["diff"]
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response


@register_tool()
async def alarms_set(
    alarm_id: str,
    patch: dict[str, Any],
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Merge-patch an alarm definition's fields (``title``, ``level``, ``trigger``, etc.)."""
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    disallowed = set(patch) & _SERVER_MANAGED_FIELDS
    if disallowed:
        raise ConfigValidationError(
            f"alarms_set cannot patch server-managed fields: {sorted(disallowed)}"
        )
    async with locks.acquire(("alarms", "config")):
        before = _read_alarms()
        after = copy.deepcopy(before)
        found = _find_alarm_with_group(after, alarm_id)
        if found is None:
            raise ConfigNotFoundError(f"Alarm '{alarm_id}' not found")
        target, _ = found
        merge_patch(target, patch)
        _write_alarms(after)
        response = applied_response(f"Updated alarm '{alarm_id}'", before, after)
    await emit_change(
        artifact_type="alarms",
        artifact_ids=["config"],
        summary=response["summary"],
        diff=response["diff"]
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response
