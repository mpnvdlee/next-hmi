"""Security tests for MCP read tools, write tools, and the JSON Pointer.

Covers the path-traversal cluster, JSON-Pointer DoS / negative-index bugs,
asset-name normalization, ``pages_set_metadata`` patch allowlist, and SVG
sanitization. Storage is redirected to ``tmp_path`` so an exploit attempt
that escapes the workspace would land somewhere harmless we can assert on.
"""

import asyncio
import base64
import json
import threading
import time
from pathlib import Path
from xml.sax.saxutils import quoteattr

import core.storage as storage
import core.validation.structure as structure
import pytest
from core.exceptions import ConfigConflictError, ConfigValidationError
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


def test_assets_delete_refuses_an_image_a_grouped_component_uses():
    schemas = json.loads(structure.WIDGET_SCHEMAS_PATH.read_text(encoding="utf-8"))
    schemas["builtin"]["Image"] = {"name": "Image", "schema": {"src": {"type": "image"}}}
    structure.WIDGET_SCHEMAS_PATH.write_text(json.dumps(schemas), encoding="utf-8")
    image = storage.active_images_dir() / "logo.png"
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(b"png")
    component = storage.active_components_dir() / "Brand" / "header.json"
    component.parent.mkdir(parents=True, exist_ok=True)
    component.write_text(
        json.dumps(
            {
                "name": "Header",
                "children": [
                    {
                        "id": "box",
                        "type": "Container",
                        "children": [
                            {
                                "id": "logo",
                                "type": "Image",
                                "properties": {"src": {"$static": {"path": "images/logo.png"}}},
                            }
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ConfigConflictError):
        _run(assets_tools.assets_delete(path="images/logo.png", confirm=True))
    assert image.exists()


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


def _upload_svg(content: str, *, name: str = "logo.svg", group: str = "icons", **kwargs):
    return _run(
        assets_tools.assets_upload(name=name, group=group, content=content, encoding="svg", **kwargs)
    )


def _assert_inert(path: Path) -> None:
    written = path.read_text().lower()
    for active in ("script", "onerror", "onload", "javascript", "alert", "foreignobject"):
        assert active not in written, written


@pytest.mark.parametrize(
    "svg",
    [
        # No whitespace between the attributes, so the old regex missed onerror.
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="x"/onerror="alert(1)"/></svg>',
        # Removing the inner tag once used to splice the outer one together.
        "<svg><scr<script/>ipt>alert(1)</scr<script/>ipt></svg>",
        # An undeclared prefix.
        "<svg><s:script>alert(1)</s:script></svg>",
    ],
)
def test_assets_upload_rejects_malformed_svg_bypasses(svg):
    with pytest.raises(ConfigValidationError):
        _upload_svg(svg)
    assert not (storage.active_icons_dir() / "logo.svg").exists()


@pytest.mark.parametrize(
    "svg",
    [
        # A prefix bound to the SVG namespace: still <script>.
        '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script><circle r="1"/></svg>',
        # An entity-encoded scheme is decoded by the parser before the check.
        '<svg><a href="jav&#x61;script:alert(1)"><circle r="1"/></a><circle r="2"/></svg>',
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="jav&#x61;script:alert(1)"/>'
        '<circle r="1"/></svg>',
        '<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/>'
        '</body></foreignObject><circle r="1"/></svg>',
        '<svg ONLOAD="alert(1)"><circle r="1" onclick="alert(1)"/></svg>',
    ],
)
def test_assets_upload_svg_bypasses_are_neutralised(svg):
    _upload_svg(svg)
    written = storage.active_icons_dir() / "logo.svg"
    _assert_inert(written)
    assert "<circle" in written.read_text()


def test_assets_upload_svg_keeps_an_icon_intact_and_reports_nothing():
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/>'
        '</linearGradient></defs><path d="M0 0h24v24H0z" fill="url(#g)" style="stroke:none"/>'
        '<use xlink:href="#g"/><title>Pump &amp; motor</title></svg>'
    )
    response = _upload_svg(svg)
    assert response["warnings"] == []
    assert "(sanitized)" not in response["summary"]
    written = (storage.active_icons_dir() / "logo.svg").read_text()
    assert 'fill="url(#g)"' in written
    assert 'style="stroke:none"' in written
    assert 'href="#g"' in written
    assert "Pump &amp; motor" in written


def test_assets_upload_svg_reports_every_removal():
    response = _upload_svg(
        '<svg onload="alert(1)"><script>a</script><script>b</script><circle r="1"/></svg>'
    )
    assert response["summary"].endswith("(sanitized)")
    messages = {w["message"] for w in response["warnings"]}
    assert messages == {"Removed <script> element (2x)", "Removed onload on <svg> (event handler)"}
    assert {w["code"] for w in response["warnings"]} == {"svg-sanitized"}


def test_assets_upload_svg_drops_external_urls_in_style_and_paint():
    _upload_svg(
        '<svg><rect style="fill:url(https://evil.example/x)" width="1"/>'
        "<rect fill=\"url('//evil.example/y')\" width=\"2\"/>"
        '<rect style="width:expression(alert(1))" width="3"/></svg>'
    )
    written = (storage.active_icons_dir() / "logo.svg").read_text()
    assert "evil.example" not in written
    assert "expression" not in written
    assert 'width="3"' in written


@pytest.mark.parametrize(
    "value",
    [
        # Chrome fetched each of these from a presentation attribute or style.
        r"\75 rl(http://evil.example/x)",
        r"u\72l(http://evil.example/x)",
        "image-set('http://evil.example/x.png' 1x)",
        "-webkit-image-set(url(#ok) 1x, 'http://evil.example/x.png' 2x)",
        "image('http://evil.example/x.png')",
        "src('http://evil.example/x')",
        "url( 'https://evil.example/x')",
        "URL(//evil.example/x)",
        "@import 'http://evil.example/x.css'",
        "expression(alert(1))",
    ],
)
@pytest.mark.parametrize("attr", ["fill", "mask", "cursor", "style"])
def test_assets_upload_svg_drops_every_reference_out_of_the_file(attr, value):
    _upload_svg(f"<svg><rect width=\"9\" {attr}={quoteattr(value)}/></svg>")
    written = (storage.active_icons_dir() / "logo.svg").read_text()
    assert written == '<svg xmlns="http://www.w3.org/2000/svg"><rect width="9"/></svg>'


def test_assets_upload_svg_keeps_references_inside_the_file():
    _upload_svg('<svg><rect fill="url(#g)" mask="url(\'#m\')" style="clip-path:url(&quot;#c&quot;)"/></svg>')
    written = (storage.active_icons_dir() / "logo.svg").read_text()
    assert 'fill="url(#g)"' in written
    assert "mask=" in written
    assert "clip-path" in written


def test_assets_upload_svg_rejects_entity_declarations():
    laughs = (
        '<!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>'
        "<svg><text>&b;</text></svg>"
    )
    with pytest.raises(ConfigValidationError):
        _upload_svg(laughs)
    assert not (storage.active_icons_dir() / "logo.svg").exists()


def test_assets_upload_svg_strips_an_external_doctype():
    response = _upload_svg(
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" '
        '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg><circle r="1"/></svg>'
    )
    written = (storage.active_icons_dir() / "logo.svg").read_text()
    assert "DOCTYPE" not in written
    assert any("DOCTYPE" in w["message"] for w in response["warnings"])


def test_assets_upload_base64_svg_is_sanitized_too():
    payload = '<svg><script>alert(1)</script><circle r="1" onload="alert(2)"/></svg>'
    _run(
        assets_tools.assets_upload(
            name="logo.svg",
            group="images",
            content=base64.b64encode(payload.encode()).decode(),
            encoding="base64",
            mime="image/svg+xml",
        )
    )
    _assert_inert(storage.active_images_dir() / "logo.svg")


@pytest.mark.parametrize(
    ("group", "name"),
    [
        ("images", "page.html"),
        ("images", "app.js"),
        ("images", "logo.svg.html"),
        ("icons", "logo.png"),
        ("icons", "logo"),
    ],
)
def test_assets_upload_rejects_extensions_outside_the_group(group, name):
    with pytest.raises(ConfigValidationError):
        _run(
            assets_tools.assets_upload(
                name=name,
                group=group,
                content=base64.b64encode(b"<script>alert(1)</script>").decode(),
                encoding="base64",
                mime="text/html",
            )
        )
    assert list(storage.active_assets_dir().rglob(name)) == []


@pytest.mark.parametrize("name", ["logo.png", "logo.jpg", "logo.gif", "logo.webp"])
def test_assets_upload_rejects_raster_without_its_signature(name):
    with pytest.raises(ConfigValidationError):
        _run(
            assets_tools.assets_upload(
                name=name,
                group="images",
                content=base64.b64encode(b"<html><script>alert(1)</script></html>").decode(),
                encoding="base64",
                mime="image/png",
            )
        )
    assert not (storage.active_images_dir() / name).exists()


@pytest.mark.parametrize(
    ("name", "data"),
    [
        ("logo.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 16),
        ("logo.jpeg", b"\xff\xd8\xff\xe0" + b"\x00" * 16),
        ("logo.gif", b"GIF89a" + b"\x00" * 16),
        ("logo.webp", b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"\x00" * 8),
    ],
)
def test_assets_upload_accepts_raster_with_its_signature(name, data):
    response = _run(
        assets_tools.assets_upload(
            name=name,
            group="images",
            content=base64.b64encode(data).decode(),
            encoding="base64",
            mime="image/png",
        )
    )
    assert response["result"] == "applied"
    assert (storage.active_images_dir() / name).read_bytes() == data


# ── SVG sanitizer cost (ReDoS) ──────────────────────────────────────────────


_FIVE_MB = 5 * 1024 * 1024 - 64


def test_assets_upload_svg_unclosed_script_flood_finishes_fast():
    # The shape that made the old lazy-DOTALL regex quadratic: hours at 5 MB.
    flood = "<svg>" + "<script>" * (_FIVE_MB // len("<script>"))
    started = time.perf_counter()
    with pytest.raises(ConfigValidationError):
        _upload_svg(flood)
    assert time.perf_counter() - started < 5


def test_assets_upload_svg_closed_script_flood_finishes_fast():
    flood = "<svg>" + "<script>x</script>" * (_FIVE_MB // len("<script>x</script>")) + "</svg>"
    started = time.perf_counter()
    response = _upload_svg(flood)
    assert time.perf_counter() - started < 5
    assert response["result"] == "applied"
    _assert_inert(storage.active_icons_dir() / "logo.svg")


def test_assets_upload_sanitizes_svg_off_the_event_loop_thread(monkeypatch):
    threads = []
    real = assets_tools._sanitize_svg

    def recording(data):
        threads.append(threading.current_thread())
        return real(data)

    monkeypatch.setattr(assets_tools, "_sanitize_svg", recording)
    _upload_svg("<svg/>")
    assert threads and threads[0] is not threading.main_thread()


# ── Datasource credentials ──────────────────────────────────────────────────


_PLC_SECRETS = {
    "password": "plc-pass-1",
    "client_private_key_password": "key-pass-2",
    "client_private_key": "certs/client-key.pem",
}


def _write_plc_datasource(**settings) -> Path:
    doc = {
        "name": "PLC",
        "type": "opcua-client",
        "settings": {
            "server_url": "opc.tcp://plc:4840",
            "username": "operator",
            "client_certificate": "certs/client-cert.der",
            **_PLC_SECRETS,
            **settings,
        },
        "variables": [
            {"kind": "variable", "display_name": "Speed", "data_type": "Double", "enabled": True},
        ],
    }
    path = storage.active_datasources_dir() / "PLC.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def test_datasources_get_redacts_plc_credentials():
    _write_plc_datasource()
    doc = datasources_tools.datasources_get("PLC")
    for key in _PLC_SECRETS:
        assert doc["settings"][key] == datasources_tools.REDACTED
    for secret in _PLC_SECRETS.values():
        assert secret not in json.dumps(doc)
    assert doc["settings"]["username"] == "operator"
    assert doc["settings"]["server_url"] == "opc.tcp://plc:4840"
    assert doc["settings"]["client_certificate"] == "certs/client-cert.der"
    assert doc["variables"][0]["display_name"] == "Speed"


def test_datasources_get_keeps_an_unset_password_empty():
    _write_plc_datasource(password="")
    assert datasources_tools.datasources_get("PLC")["settings"]["password"] == ""


@pytest.mark.parametrize(
    ("stored", "read"),
    [
        ("opc.tcp://operator:url-pass@plc:4840/", "opc.tcp://operator:<redacted>@plc:4840/"),
        ("opc.tcp://:url-pass@plc", "opc.tcp://:<redacted>@plc"),
        # The password runs to the last "@" of the authority, as URL parsers read it.
        ("opc.tcp://op@site:url@pass@[::1]:4840", "opc.tcp://op@site:<redacted>@[::1]:4840"),
        (" opc.tcp://operator:url-pass@plc", " opc.tcp://operator:<redacted>@plc"),
        # No password: the user, host, port and path stay as stored.
        ("opc.tcp://operator@plc:4840/a@b", "opc.tcp://operator@plc:4840/a@b"),
        ("opc.tcp://plc:4840", "opc.tcp://plc:4840"),
    ],
)
def test_datasources_get_redacts_the_password_in_a_url_setting(stored, read):
    # asyncua logs in with credentials embedded in the server URL.
    _write_plc_datasource(server_url=stored)
    assert datasources_tools.datasources_get("PLC")["settings"]["server_url"] == read


def test_variable_writes_keep_and_never_echo_datasource_credentials():
    """The other direction: the MCP writes that rewrite a datasource file start
    from disk, not from a redacted read, so the stored secrets survive them and
    no diff carries them out."""
    path = _write_plc_datasource(server_url="opc.tcp://operator:url-pass@plc:4840")
    responses = [
        _run(variables_tools.variables_add(datasource="PLC", name="Temp", data_type="float")),
        _run(
            variables_tools.variables_set_property(
                datasource="PLC", path="Speed", patch={"enabled": False}
            )
        ),
        _run(variables_tools.variables_delete(datasource="PLC", path="Speed")),
        _run(variables_tools.variables_delete(datasource="PLC", path="Speed", confirm=True)),
    ]
    dumped = json.dumps(responses)
    for secret in [*_PLC_SECRETS.values(), "url-pass"]:
        assert secret not in dumped
    stored = json.loads(path.read_text(encoding="utf-8"))["settings"]
    assert {key: stored[key] for key in _PLC_SECRETS} == _PLC_SECRETS
    assert stored["server_url"] == "opc.tcp://operator:url-pass@plc:4840"


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
