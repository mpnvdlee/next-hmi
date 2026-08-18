"""Tests for the custom-widget endpoints.

``POST /api/widgets/recompile`` and ``POST /api/widgets/recompile/{key}`` shell
out to the real esbuild binary (same toolchain as production), so the
``widgets_client`` fixture skips its tests when esbuild is absent — run ``npm
install`` in frontend/ once locally. The gate lives on that fixture rather than
on the module so the read-only ``/api/widget-schemas`` cases, which compile
nothing, still run on a checkout without node_modules.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import core.storage as storage
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from services import widget_compiler


def _esbuild_present() -> bool:
    if shutil.which("esbuild"):
        return True
    node_bin = storage.repo_root() / "frontend" / "node_modules" / ".bin" / "esbuild"
    return node_bin.is_file()


GOOD_WIDGET = """\
export const schema = { label: { type: 'string', label: 'Label' } };
export default function Foo({ properties }: HmiWidgetProps) {
  const label = usePropString(properties, 'label', '');
  return React.createElement('div', null, label);
}
"""

BAD_WIDGET = """\
export const schema = { label: { type: 'string' } };
export default function Broken() {
  return React.createElement('div', null, ;
}
"""


def _write_widget(root: Path, key: str, source: str) -> Path:
    widget_dir = root
    for part in key.split("/"):
        widget_dir = widget_dir / part
    widget_dir.mkdir(parents=True, exist_ok=True)
    entry = widget_dir / "index.tsx"
    entry.write_text(source, encoding="utf-8")
    return entry


@pytest.fixture()
def widgets_client(monkeypatch, tmp_path):
    """Redirect the custom-widgets src + build dirs into a tmp workspace and
    serve the widgets router over a TestClient."""
    if not _esbuild_present():
        pytest.skip("esbuild binary required for widget compiler")
    src = tmp_path / "custom-widgets"
    build = tmp_path / "widget-build"
    src.mkdir()
    build.mkdir()

    import api.widgets_api as widgets_api

    for mod in (storage, widget_compiler, widgets_api):
        monkeypatch.setattr(mod, "WIDGET_BUILD_DIR", build, raising=False)
        monkeypatch.setattr(mod, "BUILD_STATUS_PATH", build / ".build-status.json", raising=False)
        monkeypatch.setattr(mod, "active_custom_widgets_dir", lambda: src, raising=False)

    from core.exceptions import register_exception_handlers

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(widgets_api.router)
    with TestClient(app) as c:
        yield c, src, build


def test_recompile_all_builds_every_widget(widgets_client):
    client, src, build = widgets_client
    _write_widget(src, "Inputs/Foo", GOOD_WIDGET)
    _write_widget(src, "FlatWidget", GOOD_WIDGET)

    resp = client.post("/api/widgets/recompile")

    assert resp.status_code == 200, resp.text
    assert (build / "Inputs" / "Foo" / "index.js").is_file()
    assert (build / "FlatWidget" / "index.js").is_file()
    names = {w["name"]: w for w in resp.json()}
    assert names["Foo"]["buildOk"] is True
    assert names["FlatWidget"]["buildOk"] is True


def test_duplicate_leaf_names_return_independent_canonical_status(widgets_client):
    client, src, _ = widgets_client
    _write_widget(src, "Inputs/Display", GOOD_WIDGET)
    _write_widget(src, "Other/Display", BAD_WIDGET)

    resp = client.post("/api/widgets/recompile")

    assert resp.status_code == 200, resp.text
    widgets = {w["key"]: w for w in resp.json()}
    assert widgets["Inputs/Display"]["buildOk"] is True
    assert widgets["Other/Display"]["buildOk"] is False
    assert widgets["Other/Display"]["buildError"]


def test_recompile_single_widget_by_grouped_key(widgets_client):
    client, src, build = widgets_client
    _write_widget(src, "Inputs/Foo", GOOD_WIDGET)
    _write_widget(src, "Inputs/Bar", GOOD_WIDGET)

    resp = client.post("/api/widgets/recompile/Inputs/Foo")

    assert resp.status_code == 200, resp.text
    assert (build / "Inputs" / "Foo" / "index.js").is_file()
    # The sibling widget was not part of this single-entry recompile.
    assert not (build / "Inputs" / "Bar" / "index.js").exists()


def test_recompile_unknown_widget_returns_404(widgets_client):
    client, src, _ = widgets_client
    _write_widget(src, "Inputs/Foo", GOOD_WIDGET)

    resp = client.post("/api/widgets/recompile/Does/NotExist")

    assert resp.status_code == 404, resp.text


@pytest.mark.parametrize(
    "encoded_key",
    [
        "Inputs%2FDisplay",
        "Inputs%5CDisplay",
        "Inputs%255CDisplay",
        "Inputs%252FDisplay",
        "Inputs%2544isplay",
        "Inputs%253Fmode/Display",
        "Inputs%2523fragment/Display",
    ],
)
def test_recompile_rejects_encoded_path_and_url_aliases(widgets_client, encoded_key):
    client, src, _ = widgets_client
    _write_widget(src, "Inputs/Display", GOOD_WIDGET)

    resp = client.post(f"/api/widgets/recompile/{encoded_key}")

    assert resp.status_code == 404, resp.text


@pytest.fixture()
def uncompiled_client(monkeypatch, tmp_path):
    """The widgets router over a runtime home that has never compiled: an empty
    build dir with no ``widget-schemas.json``, and a stubbed stdlib catalog.

    The manifest cache and both stdlib readers are module-level in
    ``core.validation.structure``, so a test that leaves them alone reads
    whatever the last stdlib build wrote into this checkout.
    """
    import api.widgets_api as widgets_api
    import core.validation.structure as structure
    from core.exceptions import register_exception_handlers

    build = tmp_path / "widget-build"
    build.mkdir()
    stdlib: dict = {
        "Container": {"name": "Container", "category": "Layout", "hostsChildren": True},
        "Button": {"name": "Button", "category": "Inputs", "schema": {}},
    }
    # The build dir is redirected on every module that binds it, not just the
    # loader's path: a dev machine's real runtime home usually *has* a compiled
    # manifest, which would hide a re-introduced existence check.
    for mod in (storage, widgets_api):
        monkeypatch.setattr(mod, "WIDGET_BUILD_DIR", build, raising=False)
    monkeypatch.setattr(structure, "WIDGET_SCHEMAS_PATH", build / "widget-schemas.json")
    monkeypatch.setattr(structure, "_manifest_cache", None)
    monkeypatch.setattr(structure, "stdlib_catalog", lambda: ((1, 1), stdlib))

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(widgets_api.router)
    with TestClient(app) as client:
        yield client, stdlib


def test_widget_schemas_serves_stdlib_before_anything_is_compiled(uncompiled_client):
    """Stdlib widgets ship with the product, so a fresh runtime home that has
    never run the compiler must still answer with them — a 404 here left every
    built-in unregistered until someone compiled a project widget."""
    client, _ = uncompiled_client

    resp = client.get("/api/widget-schemas")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["builtin"]["Container"]["hostsChildren"] is True
    assert set(body["builtin"]) == {"Container", "Button"}
    assert body["custom"] == {}


def test_widget_schemas_404s_when_neither_map_has_anything(uncompiled_client):
    """Nothing compiled *and* no stdlib build is the one genuinely unbuilt
    case, and it keeps the endpoint's 404."""
    client, stdlib = uncompiled_client
    stdlib.clear()

    resp = client.get("/api/widget-schemas")

    assert resp.status_code == 404, resp.text


def test_widgets_api_rejects_file_and_parent_symlink_entries(widgets_client):
    client, src, _ = widgets_client
    target_file = src.parent / "target.tsx"
    target_file.write_text(GOOD_WIDGET, encoding="utf-8")
    file_link = src / "Inputs" / "FileLink" / "index.tsx"
    file_link.parent.mkdir(parents=True)
    try:
        file_link.symlink_to(target_file)
    except OSError as err:
        pytest.skip(f"symlinks unavailable: {err}")

    target_group = src.parent / "target-group"
    _write_widget(target_group, "DirectoryLink", GOOD_WIDGET)
    (src / "LinkedGroup").symlink_to(target_group, target_is_directory=True)

    assert client.get("/api/widgets").json() == []
    assert client.post("/api/widgets/recompile/Inputs/FileLink").status_code == 404
    assert (
        client.post("/api/widgets/recompile/LinkedGroup/DirectoryLink").status_code
        == 404
    )
