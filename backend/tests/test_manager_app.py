"""Manager app — auth gate + reverse-proxy guard rails (no real children)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from core import manager_auth, runtime_home
from core.passwords import is_valid_hash, verify_password
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


def _make_client(monkeypatch, tmp_path: Path, base_url: str):
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home_dir))

    import manager

    # Don't seed/spawn/teardown real instances during the lifespan.
    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)

    return TestClient(manager.app, base_url=base_url)


@pytest.fixture
def client(monkeypatch, tmp_path: Path) -> TestClient:
    with _make_client(monkeypatch, tmp_path, "http://testserver") as tc:
        yield tc


@pytest.fixture
def tls_client(monkeypatch, tmp_path: Path) -> TestClient:
    with _make_client(monkeypatch, tmp_path, "https://testserver") as tc:
        yield tc


def test_gate_blocks_unauthenticated_api(client: TestClient) -> None:
    assert client.get("/api/manager/running").status_code == 401


def test_setup_then_access(client: TestClient) -> None:
    status = client.get("/api/manager/auth/status").json()
    assert status["passwordSet"] is False
    assert status["authenticated"] is False

    resp = client.post("/api/manager/auth/setup", json={"password": "secret"})
    assert resp.status_code == 200
    assert resp.json()["authenticated"] is True

    # Cookie now lets us through the gate.
    running = client.get("/api/manager/running")
    assert running.status_code == 200
    assert running.json() == {"instances": []}


def test_second_setup_rejected(client: TestClient) -> None:
    client.post("/api/manager/auth/setup", json={"password": "secret"})
    resp = client.post("/api/manager/auth/setup", json={"password": "again"})
    assert resp.status_code == 409


def test_operator_setup_is_manager_authenticated_and_blocks_project_routes(
    client: TestClient, tmp_path: Path
) -> None:
    target = tmp_path / "Fresh-Project"
    assert client.post(
        "/api/projects", json={"name": "Fresh", "path": str(target)}
    ).status_code == 401

    client.post("/api/manager/auth/setup", json={"password": "manager-secret"})
    created = client.post(
        "/api/projects", json={"name": "Fresh", "path": str(target)}
    )
    assert created.status_code == 201
    project_id = created.json()["id"]
    assert created.json()["operatorSetupRequired"] is True
    assert client.post(f"/api/manager/projects/{project_id}/start").status_code == 409

    for prefix in ("runtime", "editor"):
        blocked = client.get(f"/{prefix}/{project_id}/", follow_redirects=False)
        assert blocked.status_code == 303
        assert blocked.headers["location"] == f"/projects?operatorSetup={project_id}"

    completed = client.post(
        f"/api/manager/projects/{project_id}/operator-setup",
        json={"password": "operator-secret"},
    )
    assert completed.status_code == 200
    assert completed.json()["operatorSetupRequired"] is False

    persisted = json.loads((target / "users.json").read_text(encoding="utf-8"))
    admin = next(user for user in persisted["users"] if user["username"] == "admin")
    assert admin["password"] == ""
    assert is_valid_hash(admin["passwordHash"]) is True
    assert verify_password(admin, "operator-secret") is True
    assert persisted["operatorSetup"]["required"] is False

    replay = client.post(
        f"/api/manager/projects/{project_id}/operator-setup",
        json={"password": "replacement"},
    )
    assert replay.status_code == 409
    assert next(
        user
        for user in json.loads((target / "users.json").read_text(encoding="utf-8"))["users"]
        if user["username"] == "admin"
    )["passwordHash"] == admin["passwordHash"]


def test_existing_project_without_setup_marker_is_not_rewritten(
    client: TestClient, tmp_path: Path
) -> None:
    client.post("/api/manager/auth/setup", json={"password": "manager-secret"})
    target = tmp_path / "Existing-Project"
    target.mkdir()
    from core.manifest import ensure_project_metadata

    ensure_project_metadata(target, name="Existing")
    existing = {
        "settings": {"autoLoginName": "guest", "configAccessGroups": ["admin"]},
        "groups": [
            {"id": "guest", "label": "Guest"},
            {"id": "admin", "label": "Admin"},
        ],
        "users": [
            {"id": "guest", "username": "guest", "password": "", "groups": ["guest"]},
            {
                "id": "admin",
                "username": "admin",
                "password": "existing-password",
                "groups": ["admin"],
            },
        ],
    }
    users_path = target / "users.json"
    users_path.write_text(json.dumps(existing), encoding="utf-8")
    before = users_path.read_bytes()

    registered = client.post("/api/projects/register", json={"path": str(target)})
    assert registered.status_code == 201
    assert registered.json()["operatorSetupRequired"] is False
    replay = client.post(
        f"/api/manager/projects/{registered.json()['id']}/operator-setup",
        json={"password": "replacement"},
    )
    assert replay.status_code == 409
    assert users_path.read_bytes() == before


@pytest.mark.parametrize("failure", ["missing", "corrupt", "unreadable"])
def test_invalid_project_credentials_fail_closed_on_all_manager_routes(
    client: TestClient, tmp_path: Path, monkeypatch, failure: str
) -> None:
    from core import operator_setup

    client.post("/api/manager/auth/setup", json={"password": "manager-secret"})
    target = tmp_path / f"Broken-{failure}"
    created = client.post(
        "/api/projects", json={"name": failure, "path": str(target)}
    ).json()
    project_id = created["id"]
    users_path = target / "users.json"
    if failure == "missing":
        users_path.unlink()
    elif failure == "corrupt":
        users_path.write_text("{not-json", encoding="utf-8")
    else:
        original_read = operator_setup.read_json

        def deny_project_users(path):
            if Path(path) == users_path:
                raise PermissionError("denied")
            return original_read(path)

        monkeypatch.setattr(operator_setup, "read_json", deny_project_users)

    listed = client.get("/api/projects").json()["projects"]
    project = next(item for item in listed if item["id"] == project_id)
    assert project["operatorSetupStatus"] == "error"
    assert project["operatorSetupError"]

    start = client.post(f"/api/manager/projects/{project_id}/start")
    assert start.status_code == 409
    assert "Project credentials are unavailable" in start.json()["detail"]

    for prefix in ("runtime", "editor"):
        root = client.get(f"/{prefix}/{project_id}/", follow_redirects=False)
        assert root.status_code == 409
        assert "Project credentials are unavailable" in root.json()["detail"]
        api = client.get(f"/{prefix}/{project_id}/api/health")
        assert api.status_code == 409
        with pytest.raises(WebSocketDisconnect) as disconnected:  # noqa: SIM117 -- no autofix offered, left as-is per the mechanical-only policy for this family
            with client.websocket_connect(f"/{prefix}/{project_id}/ws"):
                pass
        assert disconnected.value.code == 1008


def _session_set_cookie(response) -> str:
    header = next(
        value
        for key, value in response.headers.multi_items()
        if key.lower() == "set-cookie" and value.startswith(f"{manager_auth.SESSION_COOKIE}=")
    )
    return header.lower()


@pytest.mark.parametrize("route", ["setup", "login", "change-password", "logout"])
def test_session_cookie_is_secure_over_https(tls_client: TestClient, route: str) -> None:
    setup = tls_client.post("/api/manager/auth/setup", json={"password": "secret"})
    if route == "setup":
        resp = setup
    elif route == "login":
        resp = tls_client.post("/api/manager/auth/login", json={"password": "secret"})
    elif route == "change-password":
        resp = tls_client.post(
            "/api/manager/auth/change-password",
            json={"currentPassword": "secret", "newPassword": "newsecret"},
        )
    else:
        resp = tls_client.post("/api/manager/auth/logout")

    header = _session_set_cookie(resp)
    assert "secure" in header
    assert "httponly" in header
    assert "samesite=lax" in header


@pytest.mark.parametrize("route", ["setup", "logout"])
def test_session_cookie_not_secure_over_plain_http(client: TestClient, route: str) -> None:
    """Plain-HTTP installs must keep working — a Secure cookie is never stored there."""
    setup = client.post("/api/manager/auth/setup", json={"password": "secret"})
    resp = setup if route == "setup" else client.post("/api/manager/auth/logout")
    assert "secure" not in _session_set_cookie(resp)


def test_login_wrong_password(client: TestClient) -> None:
    client.post("/api/manager/auth/setup", json={"password": "secret"})
    client.post("/api/manager/auth/logout")
    bad = client.post("/api/manager/auth/login", json={"password": "nope"})
    assert bad.status_code == 422


def test_change_password_then_login_with_new(client: TestClient) -> None:
    client.post("/api/manager/auth/setup", json={"password": "secret"})
    resp = client.post(
        "/api/manager/auth/change-password",
        json={"currentPassword": "secret", "newPassword": "newsecret"},
    )
    assert resp.status_code == 200
    # Rotating the secret invalidates other sessions, but this response's cookie
    # keeps the caller signed in.
    assert client.get("/api/manager/running").status_code == 200

    client.post("/api/manager/auth/logout")
    assert client.post("/api/manager/auth/login", json={"password": "secret"}).status_code == 422
    ok = client.post("/api/manager/auth/login", json={"password": "newsecret"})
    assert ok.status_code == 200


def test_change_password_wrong_current_rejected(client: TestClient) -> None:
    client.post("/api/manager/auth/setup", json={"password": "secret"})
    resp = client.post(
        "/api/manager/auth/change-password",
        json={"currentPassword": "wrong", "newPassword": "newsecret"},
    )
    assert resp.status_code == 422
    # Old password still works.
    client.post("/api/manager/auth/logout")
    assert client.post("/api/manager/auth/login", json={"password": "secret"}).status_code == 200


def test_system_diagnostics_gated_without_auth(client: TestClient) -> None:
    assert client.get("/api/system/info").status_code == 401
    assert client.get("/api/system/logs").status_code == 401


def test_system_diagnostics_served_when_authed(client: TestClient) -> None:
    client.post("/api/manager/auth/setup", json={"password": "secret"})

    info = client.get("/api/system/info")
    assert info.status_code == 200
    assert set(info.json()) == {"uptime_seconds", "python", "pid"}

    logs = client.get("/api/system/logs")
    assert logs.status_code == 200
    assert set(logs.json()) >= {"path", "lines", "returned", "total", "truncated"}


def test_system_restart_not_exposed_on_manager(client: TestClient) -> None:
    """The manager exposes only read-only diagnostics — never /restart, which
    would SIGTERM the supervisor and tear down every running project."""
    client.post("/api/manager/auth/setup", json={"password": "secret"})
    # A production SPA catch-all can claim the URL for GET and make Starlette
    # report 405; without that optional mount the absent route reports 404.
    # Either response proves the mutating endpoint is not registered.
    assert client.post("/api/system/restart").status_code in {404, 405}


@pytest.mark.parametrize("prefix", ["runtime", "editor"])
@pytest.mark.parametrize("method", ["get", "post"])
def test_proxy_excludes_internal_reload_hook_even_when_project_is_running(
    client: TestClient, monkeypatch, prefix: str, method: str
) -> None:
    # The MCP-driven loopback reload hook is only reachable over the child's
    # own instance port, never through the manager's browser-facing proxy —
    # regardless of alias or whether the project is actually running.
    import manager as manager_module

    client.post("/api/manager/auth/setup", json={"password": "secret"})
    monkeypatch.setattr(manager_module.supervisor, "port_for", lambda pid: 65000)

    resp = getattr(client, method)(f"/{prefix}/some-project/api/internal/reload")
    assert resp.status_code == 404

    resp_nested = getattr(client, method)(
        f"/{prefix}/some-project/api/internal/anything/else"
    )
    assert resp_nested.status_code == 404


def test_runtime_editor_aliases_gated_without_auth(client: TestClient) -> None:
    assert client.get("/runtime/ghost/api/health").status_code == 401
    assert client.get("/editor/ghost/api/health").status_code == 401


@pytest.mark.parametrize("prefix", ["runtime", "editor"])
def test_unauthenticated_document_navigation_is_sent_to_sign_in(
    client: TestClient, prefix: str
) -> None:
    """A project URL opened without a session lands on the manager's sign-in
    screen carrying its own address, not on a raw 401 body."""
    resp = client.get(
        f"/{prefix}/ghost/config/pages",
        headers={"accept": "text/html"},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert resp.headers["location"] == f"/?signIn=%2F{prefix}%2Fghost%2Fconfig%2Fpages"


def test_unauthenticated_document_navigation_keeps_its_query(client: TestClient) -> None:
    resp = client.get(
        "/editor/ghost/config?tab=alarms",
        headers={"accept": "text/html"},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert resp.headers["location"] == "/?signIn=%2Feditor%2Fghost%2Fconfig%3Ftab%3Dalarms"


def test_unauthenticated_fetch_gets_a_typed_401(client: TestClient) -> None:
    """The SPA keys its "signed out" screen off this code, so a project-user 401
    (a bad write credential) is never mistaken for a lost manager session."""
    resp = client.get("/editor/ghost/api/config/config")
    assert resp.status_code == 401
    assert resp.json()["code"] == "manager_session_required"


def test_unauthenticated_api_document_request_is_not_redirected(client: TestClient) -> None:
    """Only the browser-facing project prefixes bounce to sign-in — a manager
    API must keep answering with a machine-readable 401."""
    resp = client.get(
        "/api/manager/running", headers={"accept": "text/html"}, follow_redirects=False
    )
    assert resp.status_code == 401


@pytest.mark.parametrize(
    "target",
    ["https://evil.example/", "//evil.example/", "/projects", "/api/manager/running", ""],
)
def test_sign_in_target_rejects_anything_but_a_project_path(target: str) -> None:
    import manager

    assert manager.safe_sign_in_target(target) is None


def test_runtime_editor_aliases_503_when_authed_unknown_project(client: TestClient) -> None:
    client.post("/api/manager/auth/setup", json={"password": "secret"})
    assert client.get("/runtime/ghost/api/health").status_code == 503
    assert client.get("/editor/ghost/api/health").status_code == 503


@pytest.mark.parametrize("prefix", ["runtime", "editor"])
def test_document_navigation_to_unopenable_project_is_sent_back_to_projects(
    client: TestClient, prefix: str
) -> None:
    """A typed/bookmarked ``/runtime/<id>/`` URL for a project that can't be
    opened lands on the dashboard with a reason, not a raw 503 JSON body."""
    client.post("/api/manager/auth/setup", json={"password": "secret"})

    resp = client.get(
        f"/{prefix}/ghost/", headers={"accept": "text/html"}, follow_redirects=False
    )
    assert resp.status_code == 303
    assert resp.headers["location"] == "/projects?unavailable=ghost&reason=unknown"


def test_non_document_requests_still_get_the_503(client: TestClient) -> None:
    """Only top-level navigations are redirected — an XHR/asset fetch must keep
    getting a machine-readable failure so callers can retry or report."""
    client.post("/api/manager/auth/setup", json={"password": "secret"})
    resp = client.get("/runtime/ghost/api/health", follow_redirects=False)
    assert resp.status_code == 503


def test_help_redirects_to_public_docs_when_none_are_bundled(client: TestClient) -> None:
    """A source checkout ships no rendered docs, so the Help button falls back
    to the public page rather than 404ing."""
    from api.docs_api import PUBLIC_DOCS_URL

    resp = client.get("/help", follow_redirects=False)
    assert resp.status_code == 307
    assert resp.headers["location"] == PUBLIC_DOCS_URL


def test_bundled_help_is_reachable_without_a_trailing_slash(
    monkeypatch, tmp_path: Path
) -> None:
    """The Help button opens ``/help``. A StaticFiles mount only matches below
    its own path, and the SPA catch-all matches everything else — so without an
    explicit redirect the portable builds answered 404 there."""
    import importlib

    import api.docs_api as docs_api

    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "index.html").write_text("<h1>Guide</h1>", encoding="utf-8")

    dist = tmp_path / "dist"
    (dist / "_app").mkdir(parents=True)
    (dist / "index.html").write_text("<html></html>", encoding="utf-8")

    monkeypatch.setattr(docs_api, "bundled_docs_dir", lambda: docs)
    monkeypatch.setenv("NEXTHMI_FRONTEND_DIST", str(dist))

    import manager

    monkeypatch.setattr(manager, "bundled_docs_dir", lambda: docs)
    try:
        reloaded = importlib.reload(manager)
        monkeypatch.setattr(reloaded.project_resume, "prepare_running_set", lambda: None)
        monkeypatch.setattr(reloaded.supervisor, "resume_all", lambda: None)
        monkeypatch.setattr(reloaded.supervisor, "shutdown", lambda: None)
        with TestClient(reloaded.app) as tc:
            bare = tc.get("/help", follow_redirects=False)
            assert bare.status_code in (302, 307)
            assert bare.headers["location"] == "/help/"
            assert "Guide" in tc.get("/help/").text
    finally:
        monkeypatch.undo()
        importlib.reload(manager)


def test_legacy_p_prefix_routing_removed(client: TestClient) -> None:
    """The legacy ``/p/<id>/`` alias (backlog R24/R51) is gone outright — no
    gating, no proxy, no redirect shim. A hit on it 404s like any other
    unmatched path, authenticated or not."""
    assert client.get("/p/ghost/api/health").status_code == 404
    client.post("/api/manager/auth/setup", json={"password": "secret"})
    assert client.get("/p/ghost/api/health").status_code == 404
    assert client.get("/p/ghost/").status_code == 404


def test_manager_index_served_in_manager_mode(monkeypatch, tmp_path: Path) -> None:
    """The SPA shell at the origin root must carry mode=manager so the bundle
    renders the dashboard (not the per-project HMI). Regression for the missing
    ``mode="manager"`` kwarg in ``_render_manager_index``."""
    import importlib
    import os

    from services import frontend_serve

    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home_dir))

    dist = tmp_path / "dist"
    (dist / "_app").mkdir(parents=True)
    (dist / "index.html").write_text(
        '<!doctype html><html><head></head>'
        '<body><div id="root"></div></body></html>'
    )
    frontend_serve.reset_render_cache()

    # The SPA block is gated on NEXTHMI_FRONTEND_DIST read at import time, so
    # reload manager with it set; restore the module afterwards for other tests.
    import manager

    prev = os.environ.get("NEXTHMI_FRONTEND_DIST")
    os.environ["NEXTHMI_FRONTEND_DIST"] = str(dist)
    try:
        manager = importlib.reload(manager)
        monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
        monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
        monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
        with TestClient(manager.app) as tc:
            resp = tc.get("/")
            assert resp.status_code == 200
            assert 'window.__NEXTHMI_MODE__="manager"' in resp.text
            assert 'window.__NEXTHMI_BASE__="/"' in resp.text
    finally:
        if prev is None:
            os.environ.pop("NEXTHMI_FRONTEND_DIST", None)
        else:
            os.environ["NEXTHMI_FRONTEND_DIST"] = prev
        importlib.reload(manager)


def test_root_redirects_to_running_default(monkeypatch, tmp_path: Path) -> None:
    """An authed operator hitting `/` is sent to the default project's runtime
    when it is up — unless a `signIn` round-trip names where to go back to;
    unauthenticated requests still get the manager SPA shell."""
    import importlib
    import os

    from core import manifest as manifest_mod
    from services import frontend_serve

    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home_dir))

    dist = tmp_path / "dist"
    (dist / "_app").mkdir(parents=True)
    (dist / "index.html").write_text(
        '<!doctype html><html><head></head><body><div id="root"></div></body></html>'
    )
    frontend_serve.reset_render_cache()

    pa = tmp_path / "plant-a"
    pa.mkdir()
    (pa / "users.json").write_text(
        json.dumps({"settings": {}, "groups": [], "users": []}), encoding="utf-8"
    )
    manifest = manifest_mod.ManifestV1(
        defaultProjectId="plant-a",
        projects=[
            manifest_mod.ProjectEntry(
                id="plant-a", name="Plant A", path=str(pa), addedAt="2026-05-24T10:00:00Z",
            ),
        ],
    )
    manifest_mod.save_manifest(manifest, home_dir / "projects.json")

    import manager

    prev = os.environ.get("NEXTHMI_FRONTEND_DIST")
    os.environ["NEXTHMI_FRONTEND_DIST"] = str(dist)
    try:
        manager = importlib.reload(manager)
        monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
        monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
        monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
        monkeypatch.setattr(
            manager.supervisor, "port_for", lambda pid: 12345 if pid == "plant-a" else None
        )
        with TestClient(manager.app) as tc:
            tc.post("/api/manager/auth/setup", json={"password": "secret"})
            resp = tc.get("/", follow_redirects=False)
            assert resp.status_code in (302, 307)
            assert resp.headers["location"] == "/runtime/plant-a/"

            resume = tc.get("/?signIn=/editor/plant-a/config", follow_redirects=False)
            assert resume.status_code == 303
            assert resume.headers["location"] == "/editor/plant-a/config"

            tc.post("/api/manager/auth/logout")
            anon = tc.get("/", follow_redirects=False)
            assert anon.status_code == 200
            assert 'window.__NEXTHMI_MODE__="manager"' in anon.text
    finally:
        if prev is None:
            os.environ.pop("NEXTHMI_FRONTEND_DIST", None)
        else:
            os.environ["NEXTHMI_FRONTEND_DIST"] = prev
        importlib.reload(manager)


def test_peer_transfer_body_is_rejected_before_it_is_spooled(monkeypatch, tmp_path):
    # FastAPI resolves File()/Form() during dependency solving, so an
    # in-handler auth check would let any unauthenticated LAN host write a
    # full multipart to the destination's disk before being turned away.
    import manager as manager_module
    from core import manager_auth, peer_tokens, runtime_home

    home = tmp_path / "runtime"
    home.mkdir()
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home)
    # Don't seed/spawn/teardown real instances during the lifespan — an empty
    # tmp manifest would otherwise fall back to bootstrapping and resuming
    # the repo's actual project-testbench/ (see the `client` fixture above).
    monkeypatch.setattr(manager_module.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager_module.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager_module.supervisor, "shutdown", lambda: None)
    manager_auth.set_password("device-admin")
    peer_tokens.revoke_all()

    # Watch the multipart parser itself: it only runs once FastAPI starts
    # resolving the route's File()/Form() parameters.
    from starlette.formparsers import MultiPartParser

    parsed: list[int] = []
    original_parse = MultiPartParser.parse

    async def spy_parse(self, *args, **kwargs):
        parsed.append(1)
        return await original_parse(self, *args, **kwargs)

    monkeypatch.setattr(MultiPartParser, "parse", spy_parse)

    with TestClient(manager_module.app) as client:
        response = client.post(
            "/api/manager/peer/transfers",
            headers={"Authorization": "Bearer not-a-real-token"},
            data={
                "transferId": "tx-unauth",
                "sourceProjectId": "source-id",
                "destinationProjectId": "source-id",
                "destinationFolder": "landing",
            },
            files={"file": ("project.zip", b"x" * 1024, "application/zip")},
        )

    assert response.status_code == 401, response.text
    assert parsed == []
