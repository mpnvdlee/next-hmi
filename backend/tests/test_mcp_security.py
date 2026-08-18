"""Security tests for MCP read tools, write tools, and the JSON Pointer.

Covers the path-traversal cluster, JSON-Pointer DoS / negative-index bugs,
asset-name normalization, ``pages_set_metadata`` patch allowlist, and SVG
sanitization. Storage is redirected to ``tmp_path`` so an exploit attempt
that escapes the workspace would land somewhere harmless we can assert on.
"""

import asyncio
import json
from pathlib import Path

import core.storage as storage
import core.validation.structure as structure
import pytest
from core.exceptions import ConfigValidationError
from mcp_server import idempotency, json_pointer, locks
from mcp_server.tools import (
    assets as assets_tools,
)
from mcp_server.tools import (
    components as components_tools,
)
from mcp_server.tools import (
    datasources as datasources_tools,
)
from mcp_server.tools import (
    pages as pages_tools,
)
from mcp_server.tools import (
    translations as translations_tools,
)
from mcp_server.tools import (
    variables as variables_tools,
)


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

    locks.reset_for_tests()
    idempotency.reset_for_tests()
    yield
    locks.reset_for_tests()
    idempotency.reset_for_tests()


def _run(coro):
    return asyncio.run(coro)


# ── Read-tool traversal ─────────────────────────────────────────────────────


def test_pages_get_rejects_traversal_id():
    (storage.active_config_dir() / "config.json").write_text(json.dumps({"secret": True}), encoding="utf-8")
    with pytest.raises(ConfigValidationError):
        pages_tools._get_page_payload("../config")


def test_pages_get_rejects_slash():
    with pytest.raises(ConfigValidationError):
        pages_tools._get_page_payload("a/b")


def test_datasources_get_rejects_traversal():
    with pytest.raises(ConfigValidationError):
        datasources_tools._get_datasource_payload("../config")


def test_translations_get_rejects_traversal():
    with pytest.raises(ConfigValidationError):
        translations_tools._dictionary_payload("../../etc/passwd")


def test_components_get_rejects_traversal():
    with pytest.raises(ConfigValidationError):
        components_tools._get_component_payload("../config")


# ── Write-tool traversal ────────────────────────────────────────────────────


def test_variables_add_rejects_datasource_traversal():
    # Create a config.json the exploit would aim at to overwrite.
    (storage.active_config_dir() / "config.json").write_text(json.dumps({"pages": []}), encoding="utf-8")
    with pytest.raises(ConfigValidationError):
        _run(
            variables_tools.variables_add(
                datasource="../config",
                name="x",
                data_type="Bool",
            )
        )
    # The config file should be untouched.
    config = json.loads((storage.active_config_dir() / "config.json").read_text())
    assert config == {"pages": []}


def test_variables_delete_rejects_datasource_traversal():
    with pytest.raises(ConfigValidationError):
        _run(variables_tools.variables_delete(datasource="../foo", path="x", confirm=True))


def test_variables_set_property_rejects_datasource_traversal():
    with pytest.raises(ConfigValidationError):
        _run(
            variables_tools.variables_set_property(
                datasource="..",
                path="x",
                patch={"label": "x"},
            )
        )


# ── Asset name + delete traversal ───────────────────────────────────────────


def test_assets_upload_rejects_double_dot_name():
    with pytest.raises(ConfigValidationError):
        _run(assets_tools.assets_upload(name="..", group="icons", content="<svg/>", encoding="svg"))


def test_assets_upload_rejects_leading_dot():
    with pytest.raises(ConfigValidationError):
        _run(assets_tools.assets_upload(name=".hidden", group="icons", content="<svg/>", encoding="svg"))


def test_assets_upload_rejects_traversal_segment_in_folder():
    with pytest.raises(ConfigValidationError):
        _run(
            assets_tools.assets_upload(
                name="../escape.svg", group="icons", content="<svg/>", encoding="svg"
            )
        )


def test_assets_upload_accepts_nested_folder_name():
    response = _run(
        assets_tools.assets_upload(
            name="machines/pump.svg", group="icons", content="<svg/>", encoding="svg"
        )
    )
    assert response["path"] == "icons/machines/pump.svg"


def test_assets_delete_rejects_absolute_path():
    with pytest.raises(ConfigValidationError):
        _run(assets_tools.assets_delete(path="/etc/passwd", confirm=True))


def test_assets_delete_rejects_traversal_segment():
    with pytest.raises(ConfigValidationError):
        _run(assets_tools.assets_delete(path="icons/../../etc/passwd", confirm=True))


# ── SVG sanitization ────────────────────────────────────────────────────────


def test_assets_upload_svg_strips_script_tag():
    response = _run(
        assets_tools.assets_upload(
            name="logo.svg",
            group="icons",
            content='<svg><script>alert(1)</script><circle/></svg>',
            encoding="svg",
        )
    )
    assert response["result"] == "applied"
    written = (storage.active_icons_dir() / "logo.svg").read_text()
    assert "<script" not in written
    assert "alert" not in written
    assert "<circle" in written


def test_assets_upload_svg_strips_on_attributes():
    _run(
        assets_tools.assets_upload(
            name="logo.svg",
            group="icons",
            content='<svg onload="alert(1)" width="10"><circle/></svg>',
            encoding="svg",
        )
    )
    written = (storage.active_icons_dir() / "logo.svg").read_text()
    assert "onload" not in written
    assert 'width="10"' in written


def test_assets_upload_svg_neutralizes_javascript_href():
    _run(
        assets_tools.assets_upload(
            name="logo.svg",
            group="icons",
            content='<svg><a href="javascript:alert(1)">x</a></svg>',
            encoding="svg",
        )
    )
    written = (storage.active_icons_dir() / "logo.svg").read_text()
    assert "javascript:" not in written


# ── JSON Pointer DoS + negative index ───────────────────────────────────────


def test_json_pointer_rejects_negative_index():
    root: dict = {"items": []}
    with pytest.raises(ConfigValidationError):
        json_pointer.set_value(root, ["items", "-1"], "x")


def test_json_pointer_caps_huge_list_index():
    root: dict = {"items": []}
    with pytest.raises(ConfigValidationError):
        json_pointer.set_value(root, ["items", "99999999"], "x")
    assert root["items"] == []


def test_json_pointer_rejects_non_digit_index_with_leading_plus():
    root: dict = {"items": []}
    with pytest.raises(ConfigValidationError):
        json_pointer.set_value(root, ["items", "+1"], "x")


# ── pages_set_metadata patch allowlist ──────────────────────────────────────


def test_pages_set_metadata_rejects_id_patch():
    created = _run(pages_tools.pages_create(title="Original"))
    pid = created["page_id"]
    with pytest.raises(ConfigValidationError):
        _run(pages_tools.pages_set_metadata(page_id=pid, patch={"id": "renamed"}))


def test_pages_set_metadata_rejects_sections_patch():
    created = _run(pages_tools.pages_create(title="Original"))
    pid = created["page_id"]
    with pytest.raises(ConfigValidationError):
        _run(pages_tools.pages_set_metadata(page_id=pid, patch={"sections": {}}))


def test_pages_set_metadata_accepts_allowlisted_fields():
    created = _run(pages_tools.pages_create(title="Original"))
    pid = created["page_id"]
    response = _run(
        pages_tools.pages_set_metadata(
            page_id=pid,
            patch={"title": "Updated", "route": "/home", "layout": "default"},
        )
    )
    assert response["result"] == "applied"
    page = storage.read_json(storage.active_pages_dir() / f"{pid}.json")
    assert page["title"] == "Updated"
    assert page["route"] == "/home"
    assert page["layout"] == "default"


# ── pages_create crash-safety ───────────────────────────────────────────────


def test_pages_create_rolls_back_page_file_when_index_write_fails(monkeypatch):
    real_write_json = storage.write_json
    config_path = storage.active_config_dir() / "config.json"

    def fail_on_config(path, data):
        if Path(path) == config_path:
            raise OSError("simulated index-write failure")
        return real_write_json(path, data)

    monkeypatch.setattr(pages_tools, "write_json", fail_on_config)

    with pytest.raises(OSError):
        _run(pages_tools.pages_create(title="Doomed"))

    # No orphaned page files left behind.
    leftover = list(storage.active_pages_dir().glob("*.json"))
    assert leftover == []
