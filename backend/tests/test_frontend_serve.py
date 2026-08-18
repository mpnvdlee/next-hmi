"""Tests for the SPA-serving module (Docker/PyInstaller path).

Covers:
  * Import-map builder — cases ported from
    ``frontend/dev-plugins/externalModules.test.ts`` so the Python port
    can't drift from the TS source on its own.
  * ``render_index_html`` — strips the build-time importmap, injects a
    fresh one, caches by (index.html, libs dir, override file) mtime.
"""
from pathlib import Path

from services import frontend_serve

# ── scan_external_libraries ─────────────────────────────────────────────────


def test_scan_returns_empty_when_dir_missing(tmp_path: Path) -> None:
    assert frontend_serve.scan_external_libraries(tmp_path / "missing") == {}


def test_scan_returns_empty_when_dir_empty(tmp_path: Path) -> None:
    (tmp_path / "ext").mkdir()
    assert frontend_serve.scan_external_libraries(tmp_path / "ext") == {}


def test_scan_maps_loose_js_by_bare_name(tmp_path: Path) -> None:
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "three.js").write_text("")
    assert frontend_serve.scan_external_libraries(ext) == {
        "three": "/external-libraries/three.js"
    }


def test_scan_maps_loose_mjs_by_bare_name(tmp_path: Path) -> None:
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "modern.mjs").write_text("")
    assert frontend_serve.scan_external_libraries(ext) == {
        "modern": "/external-libraries/modern.mjs"
    }


def test_scan_folder_without_same_name_file_only_subpath_root(tmp_path: Path) -> None:
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "three").mkdir()
    (ext / "three" / "examples").mkdir()
    (ext / "three" / "examples" / "foo.js").write_text("")
    assert frontend_serve.scan_external_libraries(ext) == {
        "three/": "/external-libraries/three/"
    }


def test_scan_folder_with_same_name_js_produces_bare_and_subpath(tmp_path: Path) -> None:
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "three").mkdir()
    (ext / "three" / "three.js").write_text("")
    (ext / "three" / "examples").mkdir()
    (ext / "three" / "examples" / "foo.js").write_text("")
    assert frontend_serve.scan_external_libraries(ext) == {
        "three": "/external-libraries/three/three.js",
        "three/": "/external-libraries/three/",
    }


def test_scan_folder_with_same_name_mjs_is_also_bare_entry(tmp_path: Path) -> None:
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "modern").mkdir()
    (ext / "modern" / "modern.mjs").write_text("")
    assert frontend_serve.scan_external_libraries(ext) == {
        "modern": "/external-libraries/modern/modern.mjs",
        "modern/": "/external-libraries/modern/",
    }


def test_scan_loose_file_and_folder_of_same_name_coexist(tmp_path: Path) -> None:
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "three.js").write_text("")
    (ext / "three").mkdir()
    assert frontend_serve.scan_external_libraries(ext) == {
        "three": "/external-libraries/three.js",
        "three/": "/external-libraries/three/",
    }


def test_scan_skips_dot_and_underscore_prefixed_entries(tmp_path: Path) -> None:
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / ".hidden").mkdir()
    (ext / "_private").mkdir()
    (ext / ".dotfile.js").write_text("")
    (ext / "_internal.js").write_text("")
    assert frontend_serve.scan_external_libraries(ext) == {}


def test_scan_ignores_non_js_files_at_root(tmp_path: Path) -> None:
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "README.md").write_text("")
    (ext / "styles.css").write_text("")
    assert frontend_serve.scan_external_libraries(ext) == {}


def test_scan_does_not_read_package_json_or_index_js(tmp_path: Path) -> None:
    ext = tmp_path / "ext"
    ext.mkdir()
    pkg = ext / "three"
    pkg.mkdir()
    (pkg / "package.json").write_text('{"module":"./build/three.module.js"}')
    (pkg / "build").mkdir()
    (pkg / "build" / "three.module.js").write_text("")
    (pkg / "index.js").write_text("")
    # Only the trailing-slash subpath entry — no bare 'three'.
    assert frontend_serve.scan_external_libraries(ext) == {
        "three/": "/external-libraries/three/"
    }


# ── read_overrides ──────────────────────────────────────────────────────────


def test_read_overrides_missing_file(tmp_path: Path) -> None:
    assert frontend_serve.read_overrides(tmp_path / "missing.json") == {}


def test_read_overrides_malformed_json(tmp_path: Path) -> None:
    path = tmp_path / "bad.json"
    path.write_text("{ not valid json")
    assert frontend_serve.read_overrides(path) == {}


def test_read_overrides_valid(tmp_path: Path) -> None:
    path = tmp_path / "ok.json"
    path.write_text('{"imports": {"weird-lib": "/external-libraries/weird/main.js"}}')
    assert frontend_serve.read_overrides(path) == {
        "weird-lib": "/external-libraries/weird/main.js"
    }


def test_read_overrides_missing_imports_key(tmp_path: Path) -> None:
    path = tmp_path / "no-imports.json"
    path.write_text('{"something": "else"}')
    assert frontend_serve.read_overrides(path) == {}


# ── build_import_map ────────────────────────────────────────────────────────


def test_build_overrides_win_over_auto_derived(tmp_path: Path) -> None:
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "three.js").write_text("")
    override = tmp_path / "ext-overrides.json"
    override.write_text(
        '{"imports": {"three": "/external-libraries/three/custom-entry.js"}}'
    )
    result = frontend_serve.build_import_map(ext, override)
    assert result["imports"]["three"] == "/external-libraries/three/custom-entry.js"


def test_build_combines_folder_convention_and_loose_root(tmp_path: Path) -> None:
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "three").mkdir()
    (ext / "three" / "three.js").write_text("")
    (ext / "uplot").mkdir()
    (ext / "uplot" / "uplot.js").write_text("")
    (ext / "tiny.js").write_text("")
    result = frontend_serve.build_import_map(ext, tmp_path / "missing.json")
    assert result["imports"] == {
        "three": "/external-libraries/three/three.js",
        "three/": "/external-libraries/three/",
        "uplot": "/external-libraries/uplot/uplot.js",
        "uplot/": "/external-libraries/uplot/",
        "tiny": "/external-libraries/tiny.js",
    }


# ── render_index_html ───────────────────────────────────────────────────────

_VITE_BUILD_HTML = """\
<!doctype html>
<html lang="en">
  <head>


    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    <script type="importmap">{"imports":{"three":"/external-libraries/three.js"}}</script>
    <script type="module" crossorigin src="/_app/index-XXX.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
"""

# What a Vite build used to emit: a runtime-globals tag baked at build time, so
# always base "/" + mode "manager". It sits after the injection point, so left in
# place it wins over the per-request globals (issue #20 — every proxied project
# instance rendered as the manager dashboard).
_STALE_GLOBALS_HTML = """\
<!doctype html>
<html lang="en">
  <head>
    <script>window.__NEXTHMI_BASE__="/";window.__NEXTHMI_MODE__="manager";</script>

    <title>App</title>
    <script type="module" crossorigin src="/_app/index-XXX.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
"""

_NO_IMPORTMAP_HTML = """\
<!doctype html>
<html><head>
<title>App</title>
<script type="module" src="/_app/index.js"></script>
</head><body><div id="root"></div></body></html>
"""


def _make_dist(tmp_path: Path, html: str = _VITE_BUILD_HTML) -> Path:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(html)
    return dist


def _make_libs(tmp_path: Path) -> Path:
    libs = tmp_path / "external-libraries"
    libs.mkdir()
    return libs


def test_render_replaces_existing_importmap_with_fresh_one(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    libs = _make_libs(tmp_path)
    (libs / "uplot.js").write_text("")

    html = frontend_serve.render_index_html(dist, libs, tmp_path / "missing.json")

    # The build-time map (referencing three) is gone — only the live scan
    # (uplot) survives.
    assert '"three":"/external-libraries/three.js"' not in html
    assert '"uplot": "/external-libraries/uplot.js"' in html or '"uplot":"/external-libraries/uplot.js"' in html
    # Exactly one importmap tag in the output.
    assert html.count('type="importmap"') == 1


def test_render_injects_importmap_when_index_has_none(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path, _NO_IMPORTMAP_HTML)
    libs = _make_libs(tmp_path)
    (libs / "uplot.js").write_text("")

    html = frontend_serve.render_index_html(dist, libs, tmp_path / "missing.json")

    assert html.count('type="importmap"') == 1
    assert "/external-libraries/uplot.js" in html


def test_render_injects_runtime_globals(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    libs = _make_libs(tmp_path)

    html = frontend_serve.render_index_html(
        dist, libs, tmp_path / "missing.json", base_path="/runtime/plant-a/", mode="instance"
    )

    assert 'window.__NEXTHMI_BASE__="/runtime/plant-a/"' in html
    assert 'window.__NEXTHMI_MODE__="instance"' in html
    assert "window.__NEXTHMI_VERSION__=" in html
    assert 'window.__NEXTHMI_EDITION__="oss"' in html


def test_edition_global_follows_the_environment(tmp_path: Path, monkeypatch) -> None:
    """The SPA drops the AGPL attribution notice on the ee build, so the
    edition has to reach the document the same way the version does."""
    monkeypatch.setenv("NEXTHMI_EDITION", "ee")
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    libs = _make_libs(tmp_path)

    html = frontend_serve.render_index_html(dist, libs, tmp_path / "missing.json")

    assert 'window.__NEXTHMI_EDITION__="ee"' in html


def test_render_replaces_build_time_runtime_globals(tmp_path: Path) -> None:
    """A stale build-time globals tag must not survive alongside the injected one.

    Regression for issue #20: the leftover tag ran last and reset the document
    to the manager dashboard, so the manager's "Open" button produced a second
    project-list tab instead of the project's runtime.
    """
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path, _STALE_GLOBALS_HTML)
    libs = _make_libs(tmp_path)

    html = frontend_serve.render_index_html(
        dist, libs, tmp_path / "missing.json", base_path="/runtime/plant-a/", mode="instance"
    )

    assert html.count("__NEXTHMI_MODE__") == 1
    assert 'window.__NEXTHMI_MODE__="manager"' not in html
    assert 'window.__NEXTHMI_BASE__="/runtime/plant-a/"' in html


def test_render_caches_by_mtime_tuple(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    libs = _make_libs(tmp_path)
    override = tmp_path / "missing.json"

    import os
    index_path = dist / "index.html"
    original_mtime_ns = index_path.stat().st_mtime_ns

    first = frontend_serve.render_index_html(dist, libs, override)
    # Mutate the file *and* restore the original mtime — the cache key is
    # the mtime tuple, so a stable mtime must still produce the cached
    # render even if contents changed underneath. Use ns-precision so the
    # restore round-trips exactly.
    index_path.write_text("<html>stale</html>")
    os.utime(index_path, ns=(original_mtime_ns, original_mtime_ns))
    second = frontend_serve.render_index_html(dist, libs, override)
    assert second == first


def test_render_picks_up_new_library_via_dir_mtime(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    libs = _make_libs(tmp_path)
    override = tmp_path / "missing.json"

    first = frontend_serve.render_index_html(dist, libs, override)
    # Dropping a new file into libs/ bumps the directory mtime → fresh render.
    (libs / "newlib.js").write_text("")
    second = frontend_serve.render_index_html(dist, libs, override)
    assert first != second
    assert "/external-libraries/newlib.js" in second


def test_render_handles_missing_override_file(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    libs = _make_libs(tmp_path)

    # No override file at all — should still render without error.
    html = frontend_serve.render_index_html(dist, libs, tmp_path / "not-there.json")
    assert '"imports"' in html


def test_render_no_libs_dir_returns_empty_imports(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    # libs dir doesn't exist
    html = frontend_serve.render_index_html(
        dist, tmp_path / "no-libs", tmp_path / "no-override.json"
    )
    assert '{"imports": {}}' in html or '{"imports":{}}' in html


# ── catch-all integration ───────────────────────────────────────────────────
# Build a minimal FastAPI app that mounts the same routes as main.py would in
# production mode and exercise the SPA fallback rules end-to-end.


def _build_spa_app(dist: Path, libs: Path, overrides: Path):
    """Reproduce the SPA-serving block from main.py against a tmp dist."""
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import FileResponse, HTMLResponse
    from fastapi.staticfiles import StaticFiles

    app = FastAPI()
    # A handful of pre-existing routes to verify the catch-all yields to them.
    @app.get("/api/health")
    async def _health() -> dict:
        return {"status": "ok"}

    app_assets = dist / "_app"
    if app_assets.is_dir():
        app.mount(
            "/_app",
            StaticFiles(directory=str(app_assets), follow_symlink=False),
            name="spa-bundle",
        )

    excluded_segments = (
        "api",
        "ws",
        "_app",
        "widgets",
        "widget-js",
        "external-libraries",
        "assets",
        "docs",
        "openapi.json",
        "redoc",
        "mcp",
    )

    @app.get("/")
    async def _root() -> HTMLResponse:
        return HTMLResponse(frontend_serve.render_index_html(dist, libs, overrides))

    @app.get("/{path:path}")
    async def _fallback(path: str):
        first_segment = path.split("/", 1)[0]
        if first_segment in excluded_segments:
            raise HTTPException(status_code=404)
        candidate = (dist / path).resolve()
        try:
            candidate.relative_to(dist.resolve())
        except ValueError:
            raise HTTPException(status_code=404) from None
        if candidate.is_file():
            return FileResponse(candidate)
        return HTMLResponse(frontend_serve.render_index_html(dist, libs, overrides))

    return app


def _client(app):
    from fastapi.testclient import TestClient
    return TestClient(app)


def test_spa_root_serves_templated_index(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    libs = _make_libs(tmp_path)
    (libs / "uplot.js").write_text("")
    app = _build_spa_app(dist, libs, tmp_path / "missing.json")

    r = _client(app).get("/")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert '"uplot":"/external-libraries/uplot.js"' in r.text or '"uplot": "/external-libraries/uplot.js"' in r.text


def test_spa_fallback_returns_index_for_react_router_paths(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    libs = _make_libs(tmp_path)
    app = _build_spa_app(dist, libs, tmp_path / "missing.json")

    # A nested route like /config/pages/foo should return the SPA HTML.
    r = _client(app).get("/config/pages/foo")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert '<div id="root">' in r.text


def test_spa_fallback_serves_public_files_from_dist_root(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    (dist / "vite.svg").write_text("<svg/>")
    libs = _make_libs(tmp_path)
    app = _build_spa_app(dist, libs, tmp_path / "missing.json")

    r = _client(app).get("/vite.svg")
    assert r.status_code == 200
    assert r.text == "<svg/>"


def test_spa_fallback_404s_for_excluded_api_prefix(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    libs = _make_libs(tmp_path)
    app = _build_spa_app(dist, libs, tmp_path / "missing.json")

    # A typo'd /api/* must 404 (so JSON parsers don't choke on returned HTML).
    r = _client(app).get("/api/nonexistent")
    assert r.status_code == 404


def test_spa_fallback_does_not_shadow_prefix_lookalikes(tmp_path: Path) -> None:
    """``openapi.json`` is excluded; ``openapi.json.bak`` and ``mcpalt`` are
    legitimate SPA routes and must not be 404'd by accident."""
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    libs = _make_libs(tmp_path)
    app = _build_spa_app(dist, libs, tmp_path / "missing.json")

    # Both should fall through to the SPA (200 + index.html), not 404.
    for url in ("/openapi.json.bak", "/mcpalt", "/docs-page"):
        r = _client(app).get(url)
        assert r.status_code == 200, f"{url} returned {r.status_code}"


def test_spa_fallback_404s_for_path_traversal_attempt(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    libs = _make_libs(tmp_path)
    # A file outside dist that exists on disk:
    (tmp_path / "secret.txt").write_text("nope")
    app = _build_spa_app(dist, libs, tmp_path / "missing.json")

    # The HTTP client normalises ``/../secret.txt`` to ``/secret.txt`` before
    # the request hits the server, so the server-side ``..`` traversal never
    # arrives on the wire. The catch-all's ``relative_to()`` check is the
    # belt-and-braces second line of defence in case somebody mounts dist
    # under a symlink later. The actual security property we care about is
    # that the secret's content never leaks into the response body.
    r = _client(app).get("/../secret.txt")
    assert "nope" not in r.text


def test_spa_explicit_api_route_wins_over_catchall(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    libs = _make_libs(tmp_path)
    app = _build_spa_app(dist, libs, tmp_path / "missing.json")

    # /api/health was registered explicitly and must still answer.
    r = _client(app).get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_spa_app_assets_mount_serves_hashed_bundles(tmp_path: Path) -> None:
    frontend_serve.reset_render_cache()
    dist = _make_dist(tmp_path)
    (dist / "_app").mkdir()
    (dist / "_app" / "index-abc.js").write_text("export const x = 1;")
    libs = _make_libs(tmp_path)
    app = _build_spa_app(dist, libs, tmp_path / "missing.json")

    r = _client(app).get("/_app/index-abc.js")
    assert r.status_code == 200
    assert "export const x = 1;" in r.text
