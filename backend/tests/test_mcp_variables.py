"""End-to-end tests for the MCP variable write tools.

Exercises the canonical on-disk shape (``kind`` / ``display_name`` / ``writable``)
that the UI editor and runtime datasource manager both expect.
"""

import asyncio
import json
from pathlib import Path

import core.storage as storage
import pytest
from mcp_server import idempotency, locks
from mcp_server.tools import variables as variables_tools


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


def _write_ds(name: str, doc: dict) -> Path:
    path = storage.active_datasources_dir() / f"{name}.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def test_variables_add_at_root_writes_canonical_shape():
    _write_ds("Static", {"name": "Static", "type": "static", "variables": []})
    response = _run(
        variables_tools.variables_add(
            datasource="Static",
            name="myFlag",
            data_type="boolean",
        )
    )
    assert response["result"] == "applied"
    assert response["path"] == "myFlag"
    doc = json.loads((storage.active_datasources_dir() / "Static.json").read_text())
    # A simple type is persisted as its representative OPC-UA type.
    assert doc["variables"] == [
        {
            "kind": "variable",
            "display_name": "myFlag",
            "data_type": "Boolean",
            "enabled": True,
            "writable": True,
        }
    ]


def test_variables_add_under_existing_folder():
    _write_ds(
        "PLC",
        {
            "name": "PLC",
            "type": "opcua-client",
            "variables": [
                {"kind": "folder", "name": "Motor", "children": []},
            ],
        },
    )
    response = _run(
        variables_tools.variables_add(
            datasource="PLC",
            name="Speed",
            data_type="float",
            parent_path="Motor",
            settings={"node_id": "ns=4;s=Motor.Speed", "writable": False},
        )
    )
    assert response["path"] == "Motor/Speed"
    doc = json.loads((storage.active_datasources_dir() / "PLC.json").read_text())
    motor = doc["variables"][0]
    # A simple type is persisted as its representative OPC-UA type (float → Double).
    assert motor["children"][0] == {
        "kind": "variable",
        "display_name": "Speed",
        "data_type": "Double",
        "enabled": True,
        "writable": False,
        "node_id": "ns=4;s=Motor.Speed",
    }


def test_variables_add_rejects_missing_parent_folder():
    from core.exceptions import ConfigNotFoundError

    _write_ds("PLC", {"name": "PLC", "type": "opcua-client", "variables": []})
    with pytest.raises(ConfigNotFoundError):
        _run(
            variables_tools.variables_add(
                datasource="PLC",
                name="Speed",
                data_type="Real",
                parent_path="Motor",
            )
        )


def test_variables_add_rejects_duplicate_at_same_level():
    from core.exceptions import ConfigConflictError

    _write_ds(
        "Static",
        {
            "name": "Static",
            "type": "static",
            "variables": [
                {
                    "kind": "variable",
                    "display_name": "flag",
                    "data_type": "Bool",
                    "enabled": True,
                    "writable": True,
                },
            ],
        },
    )
    with pytest.raises(ConfigConflictError):
        _run(
            variables_tools.variables_add(
                datasource="Static",
                name="flag",
                data_type="Bool",
            )
        )


def test_variables_delete_two_step():
    _write_ds(
        "PLC",
        {
            "name": "PLC",
            "type": "opcua-client",
            "variables": [
                {
                    "kind": "folder",
                    "name": "Motor",
                    "children": [
                        {
                            "kind": "variable",
                            "display_name": "Speed",
                            "data_type": "Real",
                            "enabled": True,
                            "writable": False,
                        },
                    ],
                },
            ],
        },
    )
    dry = _run(
        variables_tools.variables_delete(datasource="PLC", path="Motor/Speed")
    )
    assert dry["result"] == "dry_run"

    applied = _run(
        variables_tools.variables_delete(
            datasource="PLC", path="Motor/Speed", confirm=True
        )
    )
    assert applied["result"] == "applied"
    doc = json.loads((storage.active_datasources_dir() / "PLC.json").read_text())
    assert doc["variables"][0]["children"] == []


def test_variables_set_property_toggles_enabled():
    _write_ds(
        "Static",
        {
            "name": "Static",
            "type": "static",
            "variables": [
                {
                    "kind": "variable",
                    "display_name": "flag",
                    "data_type": "Bool",
                    "enabled": True,
                    "writable": True,
                },
            ],
        },
    )
    _run(
        variables_tools.variables_set_property(
            datasource="Static", path="flag", patch={"enabled": False}
        )
    )
    doc = json.loads((storage.active_datasources_dir() / "Static.json").read_text())
    assert doc["variables"][0]["enabled"] is False


def test_variables_set_property_merge_patches_writable_fields():
    _write_ds(
        "Static",
        {
            "name": "Static",
            "type": "static",
            "variables": [
                {
                    "kind": "variable",
                    "display_name": "counter",
                    "data_type": "Int",
                    "enabled": True,
                    "writable": True,
                    "value": 0,
                },
            ],
        },
    )
    _run(
        variables_tools.variables_set_property(
            datasource="Static",
            path="counter",
            patch={"value": 42, "writable": False},
        )
    )
    doc = json.loads((storage.active_datasources_dir() / "Static.json").read_text())
    counter = doc["variables"][0]
    assert counter["value"] == 42
    assert counter["writable"] is False


@pytest.mark.parametrize("field", ["kind", "display_name", "data_type"])
def test_variables_set_property_rejects_server_managed_fields(field: str):
    from core.exceptions import ConfigValidationError

    _write_ds(
        "Static",
        {
            "name": "Static",
            "type": "static",
            "variables": [
                {
                    "kind": "variable",
                    "display_name": "counter",
                    "data_type": "Int",
                },
            ],
        },
    )
    with pytest.raises(ConfigValidationError):
        _run(
            variables_tools.variables_set_property(
                datasource="Static",
                path="counter",
                patch={field: "replacement"},
            )
        )


def test_variables_delete_not_found():
    from core.exceptions import ConfigNotFoundError

    _write_ds("PLC", {"name": "PLC", "type": "opcua-client", "variables": []})
    with pytest.raises(ConfigNotFoundError):
        _run(variables_tools.variables_delete(datasource="PLC", path="ghost"))


# ── Variable extension-field policy (item 11) ────────────────────────────────


def test_variables_add_settings_accepts_extensions_and_round_trips():
    _write_ds("Static", {"name": "Static", "type": "static", "variables": []})
    _run(
        variables_tools.variables_add(
            datasource="Static",
            name="flag",
            data_type="boolean",
            settings={"extensions": {"vendor": {"unit": "C"}}},
        )
    )
    doc = json.loads((storage.active_datasources_dir() / "Static.json").read_text())
    assert doc["variables"][0]["extensions"] == {"vendor": {"unit": "C"}}


@pytest.mark.parametrize("bogus", [{"bogus": 1}, {"present_on_server": True}, {"display_name": "evil"}])
def test_variables_add_settings_rejects_disallowed_fields(bogus):
    from core.exceptions import ConfigValidationError

    _write_ds("Static", {"name": "Static", "type": "static", "variables": []})
    with pytest.raises(ConfigValidationError):
        _run(
            variables_tools.variables_add(
                datasource="Static", name="flag", data_type="boolean", settings=bogus,
            )
        )
    doc = json.loads((storage.active_datasources_dir() / "Static.json").read_text())
    assert doc["variables"] == []


@pytest.mark.parametrize("bogus", [{"bogus": 1}, {"present_on_server": True}])
def test_variables_set_property_rejects_disallowed_fields(bogus):
    from core.exceptions import ConfigValidationError

    _write_ds(
        "Static",
        {
            "name": "Static",
            "type": "static",
            "variables": [{"kind": "variable", "display_name": "counter", "data_type": "Int"}],
        },
    )
    with pytest.raises(ConfigValidationError):
        _run(variables_tools.variables_set_property(datasource="Static", path="counter", patch=bogus))


def test_variables_set_property_rejects_non_object_extensions():
    from core.exceptions import ConfigValidationError

    _write_ds(
        "Static",
        {
            "name": "Static",
            "type": "static",
            "variables": [{"kind": "variable", "display_name": "counter", "data_type": "Int"}],
        },
    )
    with pytest.raises(ConfigValidationError):
        _run(
            variables_tools.variables_set_property(
                datasource="Static", path="counter", patch={"extensions": "nope"}
            )
        )


def test_variables_set_property_extensions_round_trip_and_merge_delete():
    _write_ds(
        "Static",
        {
            "name": "Static",
            "type": "static",
            "variables": [{"kind": "variable", "display_name": "counter", "data_type": "Int"}],
        },
    )
    _run(
        variables_tools.variables_set_property(
            datasource="Static",
            path="counter",
            patch={"extensions": {"a": 1, "b": 2}},
        )
    )
    doc = json.loads((storage.active_datasources_dir() / "Static.json").read_text())
    assert doc["variables"][0]["extensions"] == {"a": 1, "b": 2}

    # Merge-patch null deletes only the targeted key inside extensions —
    # forward-compatible/unknown keys under it survive untouched.
    _run(
        variables_tools.variables_set_property(
            datasource="Static",
            path="counter",
            patch={"extensions": {"a": None}},
        )
    )
    doc = json.loads((storage.active_datasources_dir() / "Static.json").read_text())
    assert doc["variables"][0]["extensions"] == {"b": 2}


def test_datasource_manager_registry_preserves_extension_fields():
    """Storage/datasource-sync leg of item 11: the registry built from a
    variable tree is a dict of references to the original nodes (never
    reconstructed field-by-field), so an ``extensions`` object — or any other
    field a client wrote — round-trips through the live pipeline unchanged."""
    from services.datasource_manager import DatasourceEntry, DatasourceManager

    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {
                "kind": "variable",
                "display_name": "counter",
                "data_type": "Int32",
                "enabled": True,
                "extensions": {"vendor": {"unit": "C"}},
            }
        ],
    }
    manager = DatasourceManager()
    manager.datasources["DS"] = DatasourceEntry(config)
    entry = manager.datasources["DS"]
    assert entry.registry["counter"]["extensions"] == {"vendor": {"unit": "C"}}


def test_rest_datasource_upsert_preserves_extension_fields():
    """REST's variable-tree write path stays schemaless (models.datasource
    .DatasourceUpsertBody.variables: list[Any]) and legitimately writes fields
    MCP's patch tools don't (present_on_server, renames) — but it's just as
    unopinionated about `extensions`, so the same forward-compatible data
    round-trips through either write path unchanged."""
    from models.datasource import DatasourceUpsertBody

    body = DatasourceUpsertBody.model_validate(
        {
            "type": "static",
            "variables": [
                {
                    "kind": "variable",
                    "display_name": "counter",
                    "data_type": "Int32",
                    "enabled": True,
                    "present_on_server": True,
                    "extensions": {"vendor": {"unit": "C"}},
                }
            ],
        }
    )
    stored = body.to_storage_dict("DS")
    assert stored["variables"][0]["extensions"] == {"vendor": {"unit": "C"}}
    assert stored["variables"][0]["present_on_server"] is True
