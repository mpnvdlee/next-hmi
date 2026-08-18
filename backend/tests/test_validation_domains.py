"""Cross-reference validation for alarms / recipes / historian / users.

These domains carry `$var` bindings and user-group references that nothing else
checks, so a variable deleted out from under them used to read as "No issues"
in the editor's build diagnostics.
"""
from pathlib import Path

import core.storage as storage
import pytest
from core.validation import (
    ValidationContext,
    validate_alarms,
    validate_historian,
    validate_recipes,
    validate_users,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def ctx():
    """One datasource with one known variable, and two user groups."""
    return ValidationContext(
        widget_schemas={},
        datasource_registry={
            "Machine": {"Tanks/Level": {"kind": "scalar", "base": "Float", "array": False}}
        },
        datasource_types={"Machine": "opcua-client"},
        user_groups=frozenset({"operator", "admin"}),
    )


def codes(report):
    return [f.code for f in report.warnings]


# ── Alarms ────────────────────────────────────────────────────────────────────


def test_alarm_trigger_binding_to_missing_variable(ctx):
    alarms = {
        "groups": [
            {
                "id": "g",
                "alarms": [
                    {
                        "id": "a",
                        "trigger": {
                            "type": "value_range",
                            "source_value": {"$var": {"path": "Machine:Tanks/Gone"}},
                        },
                    }
                ],
            }
        ]
    }
    report = validate_alarms(alarms, ctx)
    finding = next(f for f in report.warnings if f.code == "var-unknown")
    assert finding.path == "/groups/0/alarms/0/trigger/source_value"
    assert finding.severity == "error"


def test_alarm_known_variable_is_clean(ctx):
    alarms = {
        "groups": [
            {
                "id": "g",
                "alarms": [
                    {
                        "id": "a",
                        "level": "warning",
                        "trigger": {
                            "type": "bool",
                            "source_value": {"$var": {"path": "Machine:Tanks/Level"}},
                        },
                    }
                ],
            }
        ]
    }
    assert validate_alarms(alarms, ctx).warnings == []


def test_alarm_unbound_trigger_is_a_warning(ctx):
    alarms = {"groups": [{"alarms": [{"id": "a", "trigger": {"type": "bool"}}]}]}
    report = validate_alarms(alarms, ctx)
    finding = next(f for f in report.warnings if f.code == "alarm-trigger-unbound")
    assert finding.severity == "warning"


def test_alarm_level_and_trigger_type_enums(ctx):
    alarms = {
        "groups": [
            {
                "alarms": [
                    {
                        "id": "a",
                        "level": "critical",
                        "trigger": {"type": "threshold", "source_value": ""},
                    }
                ]
            }
        ]
    }
    assert "alarm-level-unknown" in codes(validate_alarms(alarms, ctx))
    assert "alarm-trigger-type-unknown" in codes(validate_alarms(alarms, ctx))


def test_alarm_ack_group_must_exist(ctx):
    alarms = {
        "groups": [
            {"alarms": [{"id": "a", "ack_groups": ["admin", "nobody"], "trigger": {"type": "bool"}}]}
        ]
    }
    report = validate_alarms(alarms, ctx)
    finding = next(f for f in report.warnings if f.code == "user-group-unknown")
    assert finding.path == "/groups/0/alarms/0/ack_groups/1"


def test_alarm_groups_unchecked_when_users_file_unreadable():
    """An empty group set means "not collected", not "no groups exist" — every
    ack_groups entry would otherwise be flagged on a fresh checkout."""
    bare = ValidationContext(widget_schemas={})
    alarms = {"groups": [{"alarms": [{"id": "a", "ack_groups": ["anything"]}]}]}
    assert "user-group-unknown" not in codes(validate_alarms(alarms, bare))


def test_alarm_localizable_text_checks_translation_keys():
    ctx = ValidationContext(widget_schemas={}, translation_keys=frozenset({"alarm.known"}))
    alarms = {
        "groups": [
            {
                "alarms": [
                    {
                        "id": "a",
                        "title": {"$loc": "alarm.missing"},
                        "resolutions": [{"$loc": "alarm.known"}],
                    }
                ]
            }
        ]
    }
    report = validate_alarms(alarms, ctx)
    loc = [f for f in report.warnings if f.code == "loc-unknown"]
    assert len(loc) == 1
    assert loc[0].path == "/groups/0/alarms/0/title"


# ── Recipes ───────────────────────────────────────────────────────────────────


def test_recipe_parameter_binding_to_missing_variable(ctx):
    recipes = {
        "datasetTypes": [
            {
                "id": "t",
                "parameters": [
                    {"id": "p", "dataType": "float", "binding": {"$var": {"path": "Machine:Gone"}}}
                ],
            }
        ]
    }
    report = validate_recipes(recipes, ctx)
    finding = next(f for f in report.warnings if f.code == "var-unknown")
    assert finding.path == "/datasetTypes/0/parameters/0/binding"


def test_recipe_unbound_parameter_and_bad_data_type(ctx):
    recipes = {"datasetTypes": [{"parameters": [{"id": "p", "dataType": "decimal"}]}]}
    found = codes(validate_recipes(recipes, ctx))
    assert "recipe-parameter-unbound" in found
    assert "recipe-data-type-unknown" in found


def test_recipe_known_variable_is_clean(ctx):
    recipes = {
        "datasetTypes": [
            {
                "parameters": [
                    {
                        "id": "p",
                        "dataType": "float",
                        "binding": {"$var": {"path": "Machine:Tanks/Level"}},
                    }
                ]
            }
        ]
    }
    assert validate_recipes(recipes, ctx).warnings == []


# ── Historian ─────────────────────────────────────────────────────────────────


def test_historian_logs_a_deleted_variable(ctx):
    config = {"variables": {"Machine:Tanks/Gone": {"enabled": True, "minInterval": 2}}}
    report = validate_historian(config, ctx)
    finding = next(f for f in report.warnings if f.code == "var-unknown")
    # The composite key is JSON-pointer escaped so its '/' isn't read as depth.
    assert finding.path == "/variables/Machine:Tanks~1Gone"


def test_historian_known_variable_is_clean(ctx):
    config = {"variables": {"Machine:Tanks/Level": {"enabled": True, "retention": 604800}}}
    assert validate_historian(config, ctx).warnings == []


def test_historian_rejects_negative_interval(ctx):
    config = {"variables": {"Machine:Tanks/Level": {"minInterval": -1}}}
    assert "historian-setting-invalid" in codes(validate_historian(config, ctx))


def test_historian_rejects_a_non_numeric_variable(ctx):
    ctx.datasource_registry["Machine"]["Tanks/Name"] = {
        "kind": "scalar", "base": "String", "array": False
    }
    config = {"variables": {"Machine:Tanks/Name": {"enabled": True}}}
    assert "var-type" in codes(validate_historian(config, ctx))


def test_historian_accepts_an_array_element(ctx):
    ctx.datasource_registry["Machine"]["Tanks/Levels"] = {
        "kind": "scalar", "base": "Float", "array": True
    }
    config = {"variables": {"Machine:Tanks/Levels[2]": {"enabled": True}}}
    assert validate_historian(config, ctx).warnings == []


def test_historian_rejects_a_whole_array(ctx):
    ctx.datasource_registry["Machine"]["Tanks/Levels"] = {
        "kind": "scalar", "base": "Float", "array": True
    }
    config = {"variables": {"Machine:Tanks/Levels": {"enabled": True}}}
    assert "var-type" in codes(validate_historian(config, ctx))


# ── Users ─────────────────────────────────────────────────────────────────────


def test_user_membership_must_name_a_real_group(ctx):
    users = {
        "groups": [{"id": "operator"}],
        "users": [{"id": "u", "username": "u", "groups": ["operator", "ghost"]}],
    }
    report = validate_users(users, ctx)
    finding = next(f for f in report.warnings if f.code == "user-group-unknown")
    assert finding.path == "/users/0/groups/1"


def test_user_groups_checked_against_the_file_not_the_context(ctx):
    """`ctx.user_groups` is built *from* this file, so validating against it
    would make every finding vacuously true."""
    users = {"groups": [], "users": [{"id": "u", "username": "u", "groups": ["admin"]}]}
    # 'admin' is in ctx.user_groups but not in this document's own groups list —
    # an emptied groups list is a real answer, not a missing one.
    finding = next(f for f in validate_users(users, ctx).warnings if f.code == "user-group-unknown")
    assert finding.path == "/users/0/groups/0"


def test_auto_login_and_duplicate_usernames(ctx):
    users = {
        "groups": [{"id": "operator"}],
        "users": [
            {"id": "a", "username": "same"},
            {"id": "b", "username": "same"},
        ],
        "settings": {"autoLoginName": "nobody", "configAccessGroups": ["operator", "ghost"]},
    }
    found = codes(validate_users(users, ctx))
    assert "user-duplicate" in found
    assert "user-unknown" in found
    assert "user-group-unknown" in found


def test_valid_users_document_is_clean(ctx):
    users = {
        "groups": [{"id": "operator"}, {"id": "admin"}],
        "users": [{"id": "a", "username": "a", "groups": ["operator"]}],
        "settings": {"autoLoginName": "a", "configAccessGroups": ["admin"]},
    }
    assert validate_users(users, ctx).warnings == []


# ── Project sweep wiring ──────────────────────────────────────────────────────


@pytest.fixture()
def sweep_client(live_project_root: Path, monkeypatch, tmp_path: Path):
    import core.validation.structure as structure

    storage.ensure_active_project_dirs()
    manifest_path = tmp_path / "widget-schemas.json"
    storage.write_json(manifest_path, {"version": 2, "builtin": {}, "custom": {}})
    monkeypatch.setattr(structure, "WIDGET_SCHEMAS_PATH", manifest_path)
    monkeypatch.setattr(structure, "_manifest_cache", None)

    from api.config_api import router
    from core.exceptions import register_exception_handlers

    test_app = FastAPI()
    register_exception_handlers(test_app)
    test_app.include_router(router)
    with TestClient(test_app) as c:
        yield c


def test_sweep_reports_domain_findings(sweep_client):
    root = storage.active_project_root()
    storage.write_json(
        root / "alarms.json",
        {
            "groups": [
                {
                    "id": "g",
                    "alarms": [
                        {
                            "id": "a",
                            "ack_groups": ["ghost"],
                            "trigger": {"type": "bool", "source_value": ""},
                        }
                    ],
                }
            ]
        },
    )
    storage.write_json(root / "users.json", {"groups": [{"id": "operator"}], "users": []})

    resp = sweep_client.get("/api/config/validate")
    assert resp.status_code == 200
    diagnostics = resp.json()["diagnostics"]
    alarm_rows = [d for d in diagnostics if d["artifactKind"] == "alarms"]
    assert {d["code"] for d in alarm_rows} >= {"user-group-unknown", "alarm-trigger-unbound"}
    assert all(d["artifactId"] == "alarms" for d in alarm_rows)


def test_sweep_reports_an_unreadable_domain_file(sweep_client):
    (storage.active_project_root() / "recipes.json").write_text("{not json", encoding="utf-8")
    resp = sweep_client.get("/api/config/validate")
    rows = [d for d in resp.json()["diagnostics"] if d["artifactKind"] == "recipes"]
    assert len(rows) == 1
    assert "could not read recipes.json" in rows[0]["message"]


def test_sweep_skips_absent_domain_files(sweep_client):
    resp = sweep_client.get("/api/config/validate")
    kinds = {d["artifactKind"] for d in resp.json()["diagnostics"]}
    assert "historian" not in kinds
