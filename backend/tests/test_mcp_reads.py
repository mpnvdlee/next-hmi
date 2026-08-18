"""Read-tool coverage for the MCP server."""

import json
from pathlib import Path

import core.storage as storage
import core.validation.structure as structure
import pytest
from mcp_server.tools import alarms as alarms_tools
from mcp_server.tools import assets as assets_tools
from mcp_server.tools import components as components_tools
from mcp_server.tools import datasources as datasources_tools
from mcp_server.tools import pages as pages_tools
from mcp_server.tools import translations as translations_tools
from mcp_server.tools import users as users_tools
from mcp_server.tools import variables as variables_tools
from mcp_server.tools import widgets as widgets_tools


@pytest.fixture(autouse=True)
def _isolated_workspace(monkeypatch, tmp_path: Path, live_project_root: Path):
    storage.ensure_active_project_dirs()
    widget_build = tmp_path / "widget-build"
    widget_build.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(storage, "WIDGET_BUILD_DIR", widget_build)
    monkeypatch.setattr(structure, "WIDGET_SCHEMAS_PATH", widget_build / "widget-schemas.json")

    manifest = {
        "version": 2,
        "builtin": {
            "Container": {
                "name": "Container",
                "category": "Layout",
                "schema": {"title": {"type": "string"}},
            },
        },
        "custom": {},
    }
    (widget_build / "widget-schemas.json").write_text(json.dumps(manifest), encoding="utf-8")

    yield


# ── Pages ──────────────────────────────────────────────────────────────────

def test_pages_list_returns_summaries_from_index():
    (storage.active_config_dir() / "config.json").write_text(
        json.dumps({"pages": [{"id": "page-home", "type": "page"}]}),
        encoding="utf-8",
    )
    result = pages_tools.pages_list()
    assert {"id": "page-home", "type": "page"} in result["items"]


def test_pages_list_handles_missing_config():
    result = pages_tools.pages_list()
    assert result == {"items": []}


def test_pages_get_raises_not_found_when_missing():
    from core.exceptions import ConfigNotFoundError

    with pytest.raises(ConfigNotFoundError):
        pages_tools.pages_get("page-nope")


def test_pages_get_returns_full_page_json():
    (storage.active_pages_dir() / "page-home.json").write_text(
        json.dumps({"id": "page-home", "sections": {"content": [{"id": "w1", "type": "Container"}]}}),
        encoding="utf-8",
    )
    result = pages_tools.pages_get("page-home")
    assert result["sections"]["content"][0]["id"] == "w1"


def test_pages_list_paginates_with_cursor():
    pages_index = [{"id": f"p-{i:03d}", "type": "page"} for i in range(150)]
    (storage.active_config_dir() / "config.json").write_text(
        json.dumps({"pages": pages_index}), encoding="utf-8"
    )
    page1 = pages_tools.pages_list(limit=100)
    assert len(page1["items"]) == 100
    assert "next_cursor" in page1

    page2 = pages_tools.pages_list(cursor=page1["next_cursor"], limit=100)
    assert len(page2["items"]) == 50
    assert "next_cursor" not in page2


# ── Datasources ────────────────────────────────────────────────────────────

def test_datasources_list_and_get():
    (storage.active_datasources_dir() / "PLC.json").write_text(
        json.dumps({"name": "PLC", "type": "opcua-client", "enabled": True, "settings": {"url": "opc.tcp://x"}}),
        encoding="utf-8",
    )
    summaries = datasources_tools.datasources_list()
    assert {"name": "PLC", "type": "opcua-client", "enabled": True} in summaries["items"]

    full = datasources_tools.datasources_get("PLC")
    assert full["settings"]["url"] == "opc.tcp://x"


def test_datasources_get_missing_raises_not_found():
    from core.exceptions import ConfigNotFoundError

    with pytest.raises(ConfigNotFoundError):
        datasources_tools.datasources_get("Nope")


# ── Alarms ─────────────────────────────────────────────────────────────────

def test_alarms_get_config_returns_empty_default():
    assert alarms_tools.alarms_get_config() == {"version": 1, "groups": []}


def test_alarms_get_config_returns_existing_doc():
    storage.active_alarms_config_path().write_text(
        json.dumps(
            {
                "version": 1,
                "groups": [{"id": "g1", "title": "G", "alarms": []}],
            }
        ),
        encoding="utf-8",
    )
    result = alarms_tools.alarms_get_config()
    assert result["groups"][0]["title"] == "G"


# ── Variables ──────────────────────────────────────────────────────────────

def test_variables_list_walks_all_datasources():
    (storage.active_datasources_dir() / "PLC.json").write_text(
        json.dumps(
            {
                "name": "PLC",
                "variables": [
                    {
                        "kind": "folder",
                        "name": "Motor",
                        "children": [
                            {
                                "kind": "variable",
                                "display_name": "Speed",
                                "data_type": "Float",
                                "enabled": True,
                            },
                            {
                                "kind": "variable",
                                "display_name": "Running",
                                "data_type": "Bool",
                                "enabled": False,
                            },
                        ],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    result = variables_tools.variables_list()
    paths = sorted(item["path"] for item in result["items"])
    assert paths == ["Motor/Running", "Motor/Speed"]


def _seed_two_datasources():
    (storage.active_datasources_dir() / "PLC.json").write_text(
        json.dumps(
            {
                "name": "PLC",
                "variables": [
                    {
                        "kind": "folder",
                        "name": "Motor",
                        "children": [
                            {
                                "kind": "variable",
                                "display_name": "Speed",
                                "data_type": "Float",
                                "enabled": True,
                            },
                            {
                                "kind": "variable",
                                "display_name": "Running",
                                "data_type": "Bool",
                                "enabled": False,
                            },
                            {
                                "kind": "folder",
                                "name": "Sub",
                                "children": [
                                    {
                                        "kind": "variable",
                                        "display_name": "Temp",
                                        "data_type": "Float",
                                        "enabled": True,
                                    },
                                ],
                            },
                        ],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    (storage.active_datasources_dir() / "Static.json").write_text(
        json.dumps(
            {
                "name": "Static",
                "variables": [
                    {
                        "kind": "variable",
                        "display_name": "Flag",
                        "data_type": "Bool",
                        "enabled": True,
                    },
                ],
            }
        ),
        encoding="utf-8",
    )


def test_variables_list_filters_by_datasource():
    _seed_two_datasources()
    result = variables_tools.variables_list(datasource="Static")
    assert [item["datasource"] for item in result["items"]] == ["Static"]
    assert [item["path"] for item in result["items"]] == ["Flag"]


def test_variables_list_filters_by_path_pattern_glob():
    _seed_two_datasources()
    # fnmatch: ``*`` matches any character including ``/``, so ``Motor/*``
    # matches every descendant of ``Motor``.
    descendants = variables_tools.variables_list(path_pattern="Motor/*")
    paths = sorted(item["path"] for item in descendants["items"])
    assert paths == ["Motor/Running", "Motor/Speed", "Motor/Sub/Temp"]

    substring = variables_tools.variables_list(path_pattern="*Speed*")
    assert [item["path"] for item in substring["items"]] == ["Motor/Speed"]

    exact = variables_tools.variables_list(path_pattern="Motor/Sub/Temp")
    assert [item["path"] for item in exact["items"]] == ["Motor/Sub/Temp"]


def test_variables_list_filters_by_data_type():
    _seed_two_datasources()
    result = variables_tools.variables_list(data_type="Bool")
    paths = sorted(item["path"] for item in result["items"])
    assert paths == ["Flag", "Motor/Running"]


def test_variables_list_filters_by_enabled_false():
    _seed_two_datasources()
    result = variables_tools.variables_list(enabled=False)
    assert [item["path"] for item in result["items"]] == ["Motor/Running"]


def test_variables_list_filters_combine_with_and():
    _seed_two_datasources()
    result = variables_tools.variables_list(datasource="PLC", data_type="Bool")
    assert [
        (item["datasource"], item["path"]) for item in result["items"]
    ] == [("PLC", "Motor/Running")]


def test_variables_list_invalid_datasource_name_raises():
    from core.exceptions import ConfigValidationError

    with pytest.raises(ConfigValidationError):
        variables_tools.variables_list(datasource="../etc")


# ── Translations ───────────────────────────────────────────────────────────

def test_translations_list_and_get():
    (storage.active_translations_dir() / "Default.csv").write_text(
        "en;nl\nhello;hallo\nbye;doei\n", encoding="utf-8"
    )
    summaries = translations_tools.translations_list()
    assert summaries["items"] == [{"name": "Default", "filename": "Default.csv"}]

    full = translations_tools.translations_get("Default")
    assert full["languages"] == [{"code": "en"}, {"code": "nl"}]
    assert full["rows"]["hello"] == {"en": "hello", "nl": "hallo"}


def test_translations_get_missing_dictionary_raises_not_found():
    from core.exceptions import ConfigNotFoundError

    with pytest.raises(ConfigNotFoundError):
        translations_tools.translations_get("DoesNotExist")


# ── Assets ─────────────────────────────────────────────────────────────────

def test_assets_list_walks_icons_and_images():
    (storage.active_icons_dir() / "alarm.svg").write_text("<svg/>", encoding="utf-8")
    (storage.active_images_dir() / "logo.png").write_bytes(b"\x89PNG\r\n")
    result = assets_tools.assets_list()
    paths = sorted(item["path"] for item in result["items"])
    assert paths == ["icons/alarm.svg", "images/logo.png"]


def test_assets_list_empty_when_no_assets():
    assert assets_tools.assets_list() == {"items": []}


def test_assets_list_walks_nested_subfolders():
    (storage.active_icons_dir() / "machines").mkdir()
    (storage.active_icons_dir() / "machines" / "pump.svg").write_text("<svg/>", encoding="utf-8")
    (storage.active_images_dir() / "logos" / "brand").mkdir(parents=True)
    (storage.active_images_dir() / "logos" / "brand" / "logo.png").write_bytes(b"\x89PNG\r\n")
    result = assets_tools.assets_list()
    paths = sorted(item["path"] for item in result["items"])
    assert paths == ["icons/machines/pump.svg", "images/logos/brand/logo.png"]


# ── Components ─────────────────────────────────────────────────────────────

def test_components_list_and_get():
    (storage.active_components_dir() / "MyCard.json").write_text(
        json.dumps({"id": "MyCard", "name": "MyCard", "tree": []}),
        encoding="utf-8",
    )
    summaries = components_tools.components_list()
    assert summaries["items"] == [{"id": "MyCard", "name": "MyCard"}]

    full = components_tools.components_get("MyCard")
    assert full["tree"] == []


def test_components_get_missing_raises_not_found():
    from core.exceptions import ConfigNotFoundError

    with pytest.raises(ConfigNotFoundError):
        components_tools.components_get("Nope")


def test_components_list_skips_dunder_files():
    (storage.active_components_dir() / "__meta.json").write_text("{}", encoding="utf-8")
    (storage.active_components_dir() / "Real.json").write_text(
        json.dumps({"id": "Real", "name": "Real"}), encoding="utf-8"
    )
    summaries = components_tools.components_list()
    names = [item["name"] for item in summaries["items"]]
    assert names == ["Real"]


# ── Users ──────────────────────────────────────────────────────────────────

def test_users_list_returns_safe_projection(monkeypatch):
    class _FakeManager:
        def load(self):
            return {
                "users": [
                    {
                        "username": "admin",
                        "password_hash": "DO_NOT_LEAK",
                        "salt": "SECRET",
                        "groups": ["admin", "editor"],
                        "enabled": True,
                    }
                ]
            }

    monkeypatch.setattr(users_tools, "users_manager", _FakeManager())
    result = users_tools.users_list()
    assert result["items"] == [
        {"id": "admin", "display_name": "admin", "roles": ["admin", "editor"], "enabled": True}
    ]
    flat = json.dumps(result)
    assert "DO_NOT_LEAK" not in flat
    assert "SECRET" not in flat


# ── Widgets ────────────────────────────────────────────────────────────────

def test_widgets_get_schemas_returns_manifest():
    result = widgets_tools.widgets_get_schemas()
    assert "Container" in result["builtin"]
    assert result["builtin"]["Container"]["name"] == "Container"
