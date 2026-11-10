"""Framing policy on every HTML document, and safe serving of project files.

The manager's own documents and a project instance's, reached through the
proxy, must carry ``frame-ancestors`` exactly once — ``X-Frame-Options`` too
while no other site may embed them — and the sites listed under Settings must
appear in it. User files on the origin must not run script as the origin.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from core import embed_settings, manager_auth, runtime_home
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parents[1]


def _frame_ancestors(response) -> list[str]:
    return [
        directive.strip()
        for value in response.headers.get_list("content-security-policy")
        for policy in value.split(",")
        for directive in policy.split(";")
        if directive.strip().startswith("frame-ancestors")
    ]


# ── origin validation ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("entry", "expected"),
    [
        ("https://portal.example.com", "https://portal.example.com"),
        ("  HTTPS://Portal.Example.COM/ ", "https://portal.example.com"),
        ("https://portal.example.com:443", "https://portal.example.com"),
        ("http://portal.example.com:80", "http://portal.example.com"),
        ("https://portal.example.com:8443", "https://portal.example.com:8443"),
        ("http://10.0.0.5:8080", "http://10.0.0.5:8080"),
        ("http://plant-portal", "http://plant-portal"),
    ],
)
def test_a_site_is_stored_as_its_canonical_origin(entry: str, expected: str) -> None:
    assert embed_settings.parse_origin(entry) == expected


@pytest.mark.parametrize(
    "entry",
    [
        "",
        "portal.example.com",
        "ftp://portal.example.com",
        "javascript:alert(1)",
        "https://portal.example.com/hmi",
        "https://portal.example.com?x=1",
        "https://portal.example.com#top",
        "https://user:pass@portal.example.com",
        "https://*.example.com",
        "*",
        "https://[::1]:8443",
        "https://portal.example.com:0",
        "https://portal.example.com:99999",
        "https://portal example.com",
        "https://portal.example.com;script-src *",
        "https://portal.example.com 'unsafe-inline'",
        "https://portal.example.com,https://evil.example",
        "https://pörtal.example.com",
        None,
        42,
    ],
)
def test_anything_but_a_bare_origin_is_refused(entry: object) -> None:
    with pytest.raises(ValueError, match="is not a site address"):
        embed_settings.parse_origin(entry)


def test_a_hand_edited_entry_that_would_be_refused_is_ignored(tmp_path: Path) -> None:
    (tmp_path / ".embedding.json").write_text(
        json.dumps(
            {"allowedOrigins": ["https://portal.example.com", "https://x.example.com; script-src *"]}
        ),
        encoding="utf-8",
    )

    assert embed_settings.allowed_origins(tmp_path) == ("https://portal.example.com",)


def _sites(count: int) -> list[str]:
    return [f"https://site{i}.example.com" for i in range(count)]


def test_a_host_longer_than_a_dns_name_is_refused() -> None:
    with pytest.raises(ValueError, match="is not a site address"):
        embed_settings.parse_origin("https://" + "a" * 254)
    assert embed_settings.parse_origin("https://" + "a" * 253) == "https://" + "a" * 253


def test_a_list_past_the_cap_is_refused_and_nothing_is_stored(tmp_path: Path) -> None:
    # Every HTML page carries the list; 20 000 sites made a header no browser
    # loads, the Settings page that would undo it included.
    embed_settings.set_allowed_origins(_sites(1), tmp_path)

    with pytest.raises(ValueError, match="At most 32 sites may embed NEXT HMI, and this list has 33"):
        embed_settings.set_allowed_origins(_sites(embed_settings.MAX_ORIGINS + 1), tmp_path)

    assert embed_settings.allowed_origins(tmp_path) == tuple(_sites(1))
    # Counted once canonical: spellings of one site are one site.
    sites = _sites(embed_settings.MAX_ORIGINS)
    assert embed_settings.set_allowed_origins([*sites, sites[0] + ":443/"], tmp_path) == tuple(sites)


def test_a_hand_edited_list_past_the_cap_is_cut_at_the_cap(tmp_path: Path) -> None:
    (tmp_path / ".embedding.json").write_text(
        json.dumps({"allowedOrigins": ["bad", *_sites(40)]}), encoding="utf-8"
    )

    assert embed_settings.allowed_origins(tmp_path) == tuple(_sites(embed_settings.MAX_ORIGINS))


def test_the_list_is_read_once_per_change_of_the_file(monkeypatch, tmp_path: Path) -> None:
    embed_settings.set_allowed_origins(_sites(2), tmp_path)
    reads = []
    real_read = embed_settings._read
    monkeypatch.setattr(embed_settings, "_read", lambda path: reads.append(path) or real_read(path))

    for _ in range(3):
        assert embed_settings.allowed_origins(tmp_path) == tuple(_sites(2))
    assert len(reads) == 1

    # Written by this process: dropped from the cache at once.
    embed_settings.set_allowed_origins(_sites(3), tmp_path)
    assert embed_settings.allowed_origins(tmp_path) == tuple(_sites(3))
    # Written by another (the manager, while a project instance serves pages).
    path = tmp_path / ".embedding.json"
    other = tmp_path / "other.json"
    other.write_text(json.dumps({"allowedOrigins": _sites(1)}), encoding="utf-8")
    os.replace(other, path)
    assert embed_settings.allowed_origins(tmp_path) == tuple(_sites(1))
    path.unlink()
    assert embed_settings.allowed_origins(tmp_path) == ()
    assert len(reads) == 3


# ── settings API and the manager's documents ─────────────────────────────────


@pytest.fixture
def home(monkeypatch, tmp_path: Path) -> Path:
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir()
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home_dir))
    return home_dir


@pytest.fixture
def manager_module(monkeypatch, home: Path):
    import manager

    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
    return manager


@pytest.fixture
def client(manager_module) -> TestClient:
    with TestClient(manager_module.app) as tc:
        tc.post(
            "/api/manager/auth/setup",
            json={"password": "secret-pw", "setupCode": manager_auth.setup_code()},
        )
        yield tc


@pytest.fixture
def child(monkeypatch, manager_module):
    """A running child answering every proxied request with *child.headers*."""
    import httpx

    child = SimpleNamespace(headers={"content-type": "text/html; charset=utf-8"})

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers=child.headers, stream=httpx.ByteStream(b"<html></html>"))

    monkeypatch.setattr(manager_module.supervisor, "port_for", lambda pid: 65000)
    monkeypatch.setattr(
        manager_module, "_proxy_client", httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    return child


def test_the_setting_needs_the_device_admin_session(manager_module) -> None:
    with TestClient(manager_module.app) as tc:
        assert tc.get("/api/system/embedding").status_code == 401
        assert tc.put("/api/system/embedding", json={"origins": []}).status_code == 401


def test_sites_are_stored_canonical_and_once(client: TestClient, home: Path) -> None:
    assert client.get("/api/system/embedding").json() == {"origins": []}

    response = client.put(
        "/api/system/embedding",
        json={"origins": ["https://Portal.example.com/", "https://portal.example.com:443"]},
    )

    assert response.status_code == 200
    assert response.json() == {"origins": ["https://portal.example.com"]}
    assert client.get("/api/system/embedding").json() == {"origins": ["https://portal.example.com"]}
    assert embed_settings.allowed_origins(home) == ("https://portal.example.com",)


def test_an_invalid_site_is_refused_and_nothing_is_stored(client: TestClient) -> None:
    client.put("/api/system/embedding", json={"origins": ["https://portal.example.com"]})

    response = client.put(
        "/api/system/embedding",
        json={"origins": ["https://other.example.com", "https://x.example.com/path"]},
    )

    assert response.status_code == 422
    assert "is not a site address" in response.json()["detail"]
    assert client.get("/api/system/embedding").json() == {"origins": ["https://portal.example.com"]}


def test_a_list_past_the_cap_is_a_readable_422(client: TestClient) -> None:
    client.put("/api/system/embedding", json={"origins": ["https://portal.example.com"]})

    response = client.put("/api/system/embedding", json={"origins": _sites(20_000)})

    assert response.status_code == 422
    assert response.json()["detail"].startswith("At most 32 sites may embed NEXT HMI")
    assert client.get("/api/system/embedding").json() == {"origins": ["https://portal.example.com"]}


def test_a_proxied_document_without_a_policy_gets_one(client: TestClient, child) -> None:
    """A child that sent none (an older build, a stand-in) is still covered."""
    response = client.get("/runtime/ghost/")

    assert _frame_ancestors(response) == ["frame-ancestors 'self'"]
    assert response.headers.get_list("x-frame-options") == ["SAMEORIGIN"]


def test_an_added_site_is_allowed_to_embed(client: TestClient, child) -> None:
    client.put(
        "/api/system/embedding",
        json={"origins": ["https://portal.example.com", "http://10.0.0.5:8080"]},
    )

    response = client.get("/runtime/ghost/")

    assert _frame_ancestors(response) == [
        "frame-ancestors 'self' https://portal.example.com http://10.0.0.5:8080"
    ]
    # X-Frame-Options cannot name a site, and would block the one just listed.
    assert "x-frame-options" not in response.headers


def test_a_proxied_document_keeps_the_childs_policy_once(client: TestClient, child) -> None:
    child.headers = {
        "content-type": "text/html",
        "content-security-policy": "frame-ancestors 'self'",
        "x-frame-options": "SAMEORIGIN",
    }

    response = client.get("/editor/ghost/")

    assert response.headers.get_list("content-security-policy") == ["frame-ancestors 'self'"]
    assert response.headers.get_list("x-frame-options") == ["SAMEORIGIN"]


def test_a_sandboxed_html_file_gets_the_framing_policy_beside_its_sandbox(
    client: TestClient, child
) -> None:
    child.headers = {"content-type": "text/html", "content-security-policy": "sandbox"}

    response = client.get("/runtime/ghost/assets/report.html")

    assert "sandbox" in response.headers.get_list("content-security-policy")
    assert _frame_ancestors(response) == ["frame-ancestors 'self'"]


def test_data_responses_carry_no_framing_policy(client: TestClient, child) -> None:
    child.headers = {"content-type": "application/json"}

    response = client.get("/runtime/ghost/api/config/config")

    assert _frame_ancestors(response) == []
    assert "x-frame-options" not in response.headers


# ── the real instance behind the real manager ────────────────────────────────

# Runs in a subprocess: both app modules read NEXTHMI_FRONTEND_DIST at import,
# and importing ``main`` bootstraps a project and grafts its singletons onto
# the module table for every later test.
_PROBE = '''
import asyncio
import json
import sys

import httpx
from fastapi.testclient import TestClient

import main
import manager
from core import manager_auth, storage

assets = storage.active_assets_dir()
(assets / "images").mkdir(parents=True, exist_ok=True)
(assets / "images" / "evil.svg").write_text(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', encoding="utf-8"
)
(assets / "report.html").write_text("<script>alert(1)</script>", encoding="utf-8")
(storage.WIDGET_BUILD_DIR / "Probe").mkdir(parents=True, exist_ok=True)
(storage.WIDGET_BUILD_DIR / "Probe" / "index.js").write_text("export default 1;", encoding="utf-8")
(storage.active_custom_widgets_dir() / "Probe").mkdir(parents=True, exist_ok=True)
(storage.active_custom_widgets_dir() / "Probe" / "style.css").write_text("a{}", encoding="utf-8")
(storage.active_external_libraries_dir() / "lib").mkdir(parents=True, exist_ok=True)
(storage.active_external_libraries_dir() / "lib" / "index.mjs").write_text("export {};", encoding="utf-8")

manager.supervisor.port_for = lambda project_id: 65000
manager._proxy_client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app))
browser = TestClient(manager.app)


def seen(response):
    return {
        "status": response.status_code,
        "type": response.headers.get("content-type", ""),
        "csp": response.headers.get_list("content-security-policy"),
        "xfo": response.headers.get_list("x-frame-options"),
        "nosniff": response.headers.get_list("x-content-type-options"),
    }


result = {
    "direct": seen(TestClient(main.app, base_url="http://127.0.0.1").get("/")),
    "runtime": seen(browser.get("/runtime/ghost/")),
    "runtime_deep": seen(browser.get("/runtime/ghost/some/page")),
    "manager": seen(browser.get("/settings")),
    "svg": seen(browser.get("/runtime/ghost/assets/images/evil.svg")),
    "html": seen(browser.get("/runtime/ghost/assets/report.html")),
    "widget_css": seen(browser.get("/runtime/ghost/widgets/Probe/style.css")),
    "widget_js": seen(browser.get("/runtime/ghost/widget-js/Probe/index.js")),
    "library": seen(browser.get("/runtime/ghost/external-libraries/lib/index.mjs")),
}
browser.post(
    "/api/manager/auth/setup",
    json={"password": "probe-password", "setupCode": manager_auth.setup_code()},
)
result["editor"] = seen(browser.get("/editor/ghost/"))
browser.put("/api/system/embedding", json={"origins": ["https://portal.example.com"]})
result["runtime_embeddable"] = seen(browser.get("/runtime/ghost/"))
result["manager_embeddable"] = seen(browser.get("/settings"))

with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(result, fh)
'''


@pytest.fixture(scope="module")
def served(tmp_path_factory) -> dict:
    tmp_path = tmp_path_factory.mktemp("served")
    dist = tmp_path / "dist"
    (dist / "_app").mkdir(parents=True)
    (dist / "index.html").write_text(
        '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
        encoding="utf-8",
    )
    home = tmp_path / "runtime-home"
    home.mkdir()
    script = tmp_path / "probe.py"
    script.write_text(_PROBE, encoding="utf-8")
    out = tmp_path / "result.json"
    env = {
        **os.environ,
        "NEXTHMI_FRONTEND_DIST": str(dist),
        "NEXTHMI_DATA_DIR": str(home),
        "NEXTHMI_TELEMETRY": "off",
        "PYTHONPATH": os.pathsep.join([str(BACKEND), os.environ.get("PYTHONPATH", "")]),
    }
    for name in ("NEXTHMI_EDITION", "NEXTHMI_ACTIVE_PROJECT_PATH", "NEXTHMI_BASE_PATH"):
        env.pop(name, None)
    proc = subprocess.run(
        [sys.executable, str(script), str(out)],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(BACKEND.parent),
        timeout=180,
    )
    assert proc.returncode == 0, f"probe failed:\n{proc.stdout}\n{proc.stderr}"
    return json.loads(out.read_text(encoding="utf-8"))


def _directives(seen: dict, name: str) -> list[str]:
    return [
        directive.strip()
        for value in seen["csp"]
        for policy in value.split(",")
        for directive in policy.split(";")
        if directive.strip().split(" ")[0] == name
    ]


@pytest.mark.parametrize("document", ["direct", "runtime", "runtime_deep", "editor", "manager"])
def test_every_document_forbids_framing_by_other_sites(served: dict, document: str) -> None:
    seen = served[document]

    assert seen["status"] == 200
    assert seen["type"].startswith("text/html")
    assert _directives(seen, "frame-ancestors") == ["frame-ancestors 'self'"]
    assert seen["xfo"] == ["SAMEORIGIN"]


@pytest.mark.parametrize("document", ["runtime_embeddable", "manager_embeddable"])
def test_a_listed_site_may_frame_every_document(served: dict, document: str) -> None:
    seen = served[document]

    assert _directives(seen, "frame-ancestors") == [
        "frame-ancestors 'self' https://portal.example.com"
    ]
    assert seen["xfo"] == []


@pytest.mark.parametrize(("file", "type_"), [("svg", "image/svg+xml"), ("html", "text/html")])
def test_an_asset_opened_as_a_document_runs_no_script(served: dict, file: str, type_: str) -> None:
    seen = served[file]

    assert seen["status"] == 200
    assert seen["type"].startswith(type_)
    assert _directives(seen, "sandbox") == ["sandbox"]
    assert seen["nosniff"] == ["nosniff"]


def test_an_html_asset_is_not_framable_by_other_sites_either(served: dict) -> None:
    assert _directives(served["html"], "frame-ancestors") == ["frame-ancestors 'self'"]


def test_a_custom_widget_stylesheet_is_sandboxed_and_stays_css(served: dict) -> None:
    seen = served["widget_css"]

    assert seen["type"].startswith("text/css")
    assert _directives(seen, "sandbox") == ["sandbox"]
    assert seen["nosniff"] == ["nosniff"]


@pytest.mark.parametrize("module", ["widget_js", "library"])
def test_a_module_script_is_served_as_javascript_without_a_sandbox(
    served: dict, module: str
) -> None:
    seen = served[module]

    assert seen["status"] == 200
    assert seen["type"] == "text/javascript; charset=utf-8"
    assert seen["nosniff"] == ["nosniff"]
    assert seen["csp"] == []
