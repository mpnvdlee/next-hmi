"""End-to-end tests for the MCP alarm write tools.

Confirms the canonical on-disk shape — slug ids, alarms nested inside their
group's ``alarms`` array, and ``level`` (not ``severity``) — so that
``AlarmConfig.model_validate`` accepts the document on reload. Group lifecycle
is handled in the UI editor and not tested here; tests seed groups directly
on disk before exercising the alarm tools.
"""

import asyncio
import json
import uuid
from pathlib import Path

import core.storage as storage
import pytest
from mcp_server import idempotency, locks
from mcp_server.tools import alarms as alarms_tools


@pytest.fixture(autouse=True)
def _isolated_workspace(live_project_root: Path):
    storage.ensure_active_project_dirs()
    locks.reset_for_tests()
    idempotency.reset_for_tests()
    yield
    locks.reset_for_tests()
    idempotency.reset_for_tests()


def _run(coro):
    return asyncio.run(coro)


def _seed_group(title: str = "Motor") -> str:
    """Seed an alarm group on disk and return its UUID."""
    group_id = str(uuid.uuid4())
    storage.active_alarms_config_path().write_text(
        json.dumps(
            {
                "version": 1,
                "groups": [{"id": group_id, "title": title, "alarms": []}],
            }
        ),
        encoding="utf-8",
    )
    return group_id


def test_add_alarm_nests_inside_group_with_slug_id():
    group_id = _seed_group()
    alarm = _run(
        alarms_tools.alarms_add(
            group_id=group_id,
            title="Overtemperature",
            level="error",
            trigger={"type": "bool", "on_true": True},
        )
    )
    assert alarm["alarm_id"] == "overtemperature"
    doc = storage.read_json(storage.active_alarms_config_path())
    group_doc = doc["groups"][0]
    assert group_doc["id"] == group_id
    nested = group_doc["alarms"][0]
    assert nested["id"] == alarm["alarm_id"]
    assert nested["title"] == "Overtemperature"
    assert nested["level"] == "error"
    assert nested["trigger"]["type"] == "bool"
    # Confirm the canonical full shape is present (UI expects all of these).
    for field in (
        "code",
        "description",
        "image",
        "auto_popup",
        "resolutions",
        "ack_groups",
    ):
        assert field in nested


def test_add_alarm_rejects_invalid_level():
    from core.exceptions import ConfigValidationError

    group_id = _seed_group()
    with pytest.raises(ConfigValidationError):
        _run(
            alarms_tools.alarms_add(
                group_id=group_id,
                title="Bad",
                level="severity-9000",
            )
        )


def test_add_alarm_rejects_unknown_group():
    from core.exceptions import ConfigNotFoundError

    _seed_group()
    with pytest.raises(ConfigNotFoundError):
        _run(alarms_tools.alarms_add(group_id="ghost", title="X"))


def test_alarms_set_merges_patch_into_alarm():
    group_id = _seed_group()
    alarm = _run(
        alarms_tools.alarms_add(group_id=group_id, title="Old", level="warning")
    )
    _run(
        alarms_tools.alarms_set(
            alarm_id=alarm["alarm_id"],
            patch={"title": "Renamed", "level": "error"},
        )
    )
    doc = storage.read_json(storage.active_alarms_config_path())
    a = doc["groups"][0]["alarms"][0]
    assert a["title"] == "Renamed"
    assert a["level"] == "error"


def test_alarms_set_rejects_server_managed_id():
    from core.exceptions import ConfigValidationError

    group_id = _seed_group()
    alarm = _run(alarms_tools.alarms_add(group_id=group_id, title="Old"))
    with pytest.raises(ConfigValidationError):
        _run(
            alarms_tools.alarms_set(
                alarm_id=alarm["alarm_id"],
                patch={"id": "replacement"},
            )
        )


def test_alarms_delete_two_step():
    group_id = _seed_group()
    alarm = _run(alarms_tools.alarms_add(group_id=group_id, title="X"))
    dry = _run(alarms_tools.alarms_delete(alarm_id=alarm["alarm_id"]))
    assert dry["result"] == "dry_run"

    applied = _run(
        alarms_tools.alarms_delete(alarm_id=alarm["alarm_id"], confirm=True)
    )
    assert applied["result"] == "applied"
    doc = storage.read_json(storage.active_alarms_config_path())
    assert doc["groups"][0]["alarms"] == []


def test_written_file_round_trips_through_pydantic_model():
    """The whole point of this rewrite: alarm_manager loads alarms.json via
    ``AlarmConfig.model_validate`` and silently falls back to an empty config
    if validation fails. We confirm a round-trip succeeds end-to-end.
    """
    from models.alarm import AlarmConfig

    group_id = _seed_group()
    _run(
        alarms_tools.alarms_add(
            group_id=group_id,
            title="Overtemp",
            level="error",
            trigger={
                "type": "value_range",
                "source_value": {
                    "$var": {
                        "path": "PLC:Motor/Temp",
                    }
                },
                "min": 0,
                "max": 80,
            },
        )
    )
    raw = storage.read_json(storage.active_alarms_config_path())
    cfg = AlarmConfig.model_validate(raw)
    assert len(cfg.groups) == 1
    assert len(cfg.groups[0].alarms) == 1
    assert cfg.groups[0].alarms[0].level == "error"
