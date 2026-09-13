"""Manager app — auth gate + reverse-proxy guard rails (no real children)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import pytest
from core import manager_auth, runtime_home
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


def _make_client(monkeypatch, tmp_path: Path, base_url: str, root_path: str = ""):
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home_dir))

    import manager

    # Don't seed/spawn/teardown real instances during the lifespan.
    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)

    return TestClient(manager.app, base_url=base_url, root_path=root_path)


@pytest.fixture
def client(monkeypatch, tmp_path: Path) -> TestClient:
    with _make_client(monkeypatch, tmp_path, "http://testserver") as tc:
        yield tc


@pytest.fixture
def tls_client(monkeypatch, tmp_path: Path) -> TestClient:
    with _make_client(monkeypatch, tmp_path, "https://testserver") as tc:
        yield tc


@pytest.fixture
def mounted_client(monkeypatch, tmp_path: Path) -> TestClient:
    """The manager behind a reverse-proxy mount prefix (uvicorn ``--root-path``)."""
    with _make_client(monkeypatch, tmp_path, "http://testserver", root_path="/hmi") as tc:
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


def test_fresh_project_is_manager_authenticated_and_opens_with_no_operator_credential(
    client: TestClient, tmp_path: Path
) -> None:
    """The device-admin password is the only gate: a new project ships no
    operator account and nothing asks for one before it can be opened."""
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
    assert created.json()["credentialsStatus"] == "ok"
    assert created.json()["credentialsError"] is None

    seeded = json.loads((target / "users.json").read_text(encoding="utf-8"))
    assert [user["username"] for user in seeded["users"]] == ["guest"]
    assert all("passwordHash" not in user for user in seeded["users"])
    assert "operatorSetup" not in seeded

    gone = client.post(
        f"/api/manager/projects/{project_id}/operator-setup",
        json={"password": "operator-secret"},
    )
    assert gone.status_code == 404

    for prefix in ("runtime", "editor"):
        opened = client.get(f"/{prefix}/{project_id}/", follow_redirects=False)
        assert "operatorSetup" not in opened.headers.get("location", "")


def test_registering_an_existing_project_does_not_rewrite_its_users(
    client: TestClient, tmp_path: Path
) -> None:
    client.post("/api/manager/auth/setup", json={"password": "manager-secret"})
    target = tmp_path / "Existing-Project"
    target.mkdir()
    from core.manifest import ensure_project_metadata

    ensure_project_metadata(target, name="Existing")
    existing = {
        "settings": {"autoLoginName": "guest"},
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
    assert registered.json()["credentialsStatus"] == "ok"
    assert users_path.read_bytes() == before


@pytest.mark.parametrize("failure", ["missing", "corrupt", "unreadable"])
def test_invalid_project_credentials_fail_closed_on_all_manager_routes(
    client: TestClient, tmp_path: Path, monkeypatch, failure: str
) -> None:
    from core import users_document

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
        original_read = users_document.read_json

        def deny_project_users(path):
            if Path(path) == users_path:
                raise PermissionError("denied")
            return original_read(path)

        monkeypatch.setattr(users_document, "read_json", deny_project_users)

    listed = client.get("/api/projects").json()["projects"]
    project = next(item for item in listed if item["id"] == project_id)
    assert project["credentialsStatus"] == "error"
    assert project["credentialsError"]

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
    """Both prefixes still gate anything off the public runtime table — and
    ``api/health`` is off it, so this is the same assertion for both."""
    assert client.get("/runtime/ghost/api/health").status_code == 401
    assert client.get("/editor/ghost/api/health").status_code == 401


# ── the public live view ──────────────────────────────────────────────────────

# Every call an operator panel makes. Reachable with no device-admin session
# under /runtime/; every one of them still gated under /editor/.
_RUNTIME_PUBLIC_CALLS = [
    ("GET", ""),
    ("GET", "pages/home"),
    ("GET", "_app/index-abc123.js"),
    ("GET", "assets/logo.png"),
    # An asset really named with a per-cent sign: the gate sees an already
    # decoded path, so a blanket "%" rule would 401 this.
    ("GET", "assets/50% mix.png"),
    ("GET", "assets/50%25%20mix.png"),
    ("GET", "widget-js/Gauge/index.js"),
    ("GET", "builtin-widgets-js/Button/index.js"),
    ("GET", "external-libraries/chartlib/index.js"),
    ("GET", "widgets/Gauge/widget.json"),
    ("GET", "api/config/config"),
    ("GET", "api/config/pages/home"),
    ("GET", "api/config/dictionaries"),
    ("GET", "api/config/translations"),
    ("GET", "api/config/translations?lang=nl"),
    ("GET", "api/themes"),
    ("GET", "api/themes/dark"),
    ("GET", "api/default-theme"),
    ("GET", "api/components"),
    ("GET", "api/components/folders"),
    ("GET", "api/widgets"),
    ("GET", "api/device/info"),
    ("GET", "api/users"),
    ("GET", "api/alarms/history"),
    ("GET", "api/historian/query"),
    ("POST", "api/alarms/ack/alarm-1"),
    ("POST", "api/alarms/ack-all"),
    ("POST", "api/recipes/datasets/ds-1/download"),
    ("POST", "api/recipes/datasets/ds-1/upload"),
    ("POST", "api/http-request"),
    # HEAD is a GET without the body: a conditional fetch of public content
    # must not need a session the GET beside it does not.
    ("HEAD", ""),
    ("HEAD", "pages/home"),
    ("HEAD", "assets/logo.png"),
    ("HEAD", "api/config/config"),
    ("HEAD", "api/config/pages/home"),
]

# Deny by default: everything the child also serves, and that the operator
# panel has no business asking for.
_RUNTIME_GATED_CALLS = [
    # The child leaves FastAPI's docs enabled, and they enumerate the routes
    # the table above withholds.
    ("GET", "openapi.json"),
    ("GET", "docs"),
    ("GET", "redoc"),
    ("GET", "api/health"),
    ("GET", "api/datasources"),
    ("GET", "api/datasources/Machine"),
    ("GET", "api/config/validate"),
    ("GET", "api/alarms/config"),
    ("GET", "api/recipes/config"),
    ("GET", "api/historian/config"),
    ("GET", "api/historian/available-variables"),
    ("GET", "api/widget-schemas"),
    ("GET", "api/assets"),
    ("GET", "api/projects"),
    ("GET", "api/components/some-component"),
    ("GET", "api/internal/reload"),
    # HEAD follows the GET table, so it opens exactly what GET opens and
    # nothing more. OPTIONS is deliberately not folded in: the live view is
    # same-origin and never preflights, and an anonymous OPTIONS would return
    # the child's ``Allow:`` header for the routes the table withholds.
    ("HEAD", "api/datasources"),
    ("HEAD", "openapi.json"),
    ("OPTIONS", ""),
    ("OPTIONS", "assets/logo.png"),
    ("OPTIONS", "api/config/config"),
    ("PUT", "api/config/config"),
    ("PUT", "api/config/pages/home"),
    ("DELETE", "api/config/pages/home"),
    ("PUT", "api/users"),
    ("PUT", "api/users/settings"),
    ("PUT", "api/users/groups"),
    ("POST", "api/themes"),
    ("PUT", "api/themes/dark"),
    ("DELETE", "api/themes/dark"),
    ("PUT", "api/default-theme"),
    ("POST", "api/components"),
    ("POST", "api/components/folders"),
    ("POST", "api/widgets/recompile"),
    ("PUT", "api/alarms/config"),
    ("PUT", "api/recipes/config"),
    ("PUT", "api/historian/config"),
    ("POST", "api/config/validate"),
    ("POST", "api/config/dictionaries"),
    ("POST", "api/config/translations"),
    ("PUT", "api/config/translations"),
    ("POST", "api/internal/reload"),
    ("POST", ""),
    ("POST", "assets/payload.png"),
]

# Reject, never normalize: httpx collapses dot segments when the proxy rebuilds
# the upstream URL, so an allowlisted prefix plus a way back out of it is a way
# into the datasource passwords. Every one of these must 401 under both
# prefixes, with no session and with one.
#
# Double-encoded forms are deliberately absent: httpx collapses ``%252f`` on
# the way out, so a TestClient row for one asserts nothing. Those live in
# test_manager_gate_raw_http.py, against a real server over a raw socket.
_RUNTIME_TRAVERSAL_ATTEMPTS = [
    # Collapsed by the client before it is sent, landing on a gated path.
    "api/config/pages/../../datasources/Machine",
    # Not collapsed by the client — the server decodes these to dot segments.
    "api/config/pages/%2e%2e/%2e%2e/datasources/Machine",
    "api/config/pages/%2E%2E/%2E%2E/datasources/Machine",
    "api/config/%252e%252e/datasources",
    "api/config/pages%2f%2e%2e%2f%2e%2e%2fdatasources",
    "api/config/%2e/config",
    "api/config//config",
    "api/config/config/",
    "api/config\\..\\..\\datasources",
    "api/config/%5c..%5cdatasources",
    "assets/%2e%2e/%2e%2e/users.json",
    # Case-folded first segment: a child route only on a stack that folds case,
    # so it must be denied rather than served as a document.
    "API/CONFIG/CONFIG",
]


def _offenders(
    client: TestClient, prefix: str, calls: list[tuple[str, str]], expected: int
) -> dict[tuple[str, str], int]:
    """Every call in *calls* whose status is not *expected*, with what it got.

    Looped rather than parametrized: each of these tables is long, and one
    ``client`` fixture per row means a whole manager app stood up and torn down
    per assertion.
    """
    statuses = {
        (method, sub_path): client.request(
            method, f"/{prefix}/ghost/{sub_path}", follow_redirects=False
        ).status_code
        for method, sub_path in calls
    }
    return {call: status for call, status in statuses.items() if status != expected}


def test_runtime_public_surface_needs_no_session(client: TestClient) -> None:
    """A live view opens on a wall-mounted browser with no device-admin
    password. 503 is the proxy answering for a project that is not running —
    the point is that the gate let every one of these through."""
    assert _offenders(client, "runtime", _RUNTIME_PUBLIC_CALLS, 503) == {}


def test_runtime_keeps_everything_else_gated(client: TestClient) -> None:
    assert _offenders(client, "runtime", _RUNTIME_GATED_CALLS, 401) == {}


def test_editor_prefix_is_unchanged(client: TestClient) -> None:
    """The editor did not become public with the runtime: every path in either
    table still needs the device-admin session under ``/editor/``."""
    calls = _RUNTIME_PUBLIC_CALLS + _RUNTIME_GATED_CALLS
    assert _offenders(client, "editor", calls, 401) == {}


@pytest.mark.parametrize("prefix", ["runtime", "editor"])
def test_traversal_out_of_the_public_subtree_is_rejected(
    client: TestClient, prefix: str
) -> None:
    calls = [("GET", sub_path) for sub_path in _RUNTIME_TRAVERSAL_ATTEMPTS]
    assert _offenders(client, prefix, calls, 401) == {}


def test_runtime_child_api_docs_are_not_public(client: TestClient) -> None:
    """Singled out from the table above because it is the one exception to
    "any GET outside api/ is public" that is easy to reintroduce."""
    assert client.get("/runtime/ghost/openapi.json").status_code == 401
    assert client.get("/runtime/ghost/docs").status_code == 401
    assert client.get("/runtime/ghost/redoc").status_code == 401


def test_unauthenticated_editor_document_navigation_is_sent_to_sign_in(
    client: TestClient,
) -> None:
    """An editor URL opened without a session lands on the manager's sign-in
    screen carrying its own address, not on a raw 401 body."""
    resp = client.get(
        "/editor/ghost/config/pages",
        headers={"accept": "text/html"},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert resp.headers["location"] == "/?signIn=%2Feditor%2Fghost%2Fconfig%2Fpages"


def test_unauthenticated_runtime_document_navigation_is_not_sent_to_sign_in(
    client: TestClient,
) -> None:
    """The live view is public, so its document is never bounced to the login
    screen — this one only reaches the dashboard because ``ghost`` is not a
    project that can be opened."""
    resp = client.get(
        "/runtime/ghost/pages/home",
        headers={"accept": "text/html"},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert resp.headers["location"] == "/projects?unavailable=ghost&reason=unknown"


def test_unauthenticated_document_navigation_keeps_its_query(client: TestClient) -> None:
    resp = client.get(
        "/editor/ghost/config?tab=alarms",
        headers={"accept": "text/html"},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert resp.headers["location"] == "/?signIn=%2Feditor%2Fghost%2Fconfig%3Ftab%3Dalarms"


_UPSTREAM_EOF = object()


class _FakeUpstreamSocket:
    """Stand-in for the child's ``/ws``: echoes one message, then ends.

    Ending the upstream is what lets the proxy's pump finish on its own. A
    stand-in that stays open leaves the endpoint mid-``asyncio.wait`` when the
    test client tears the session down, and the cancellation it delivers there
    surfaces as a teardown error rather than as anything about this app.
    """

    def __init__(self) -> None:
        import asyncio

        self._queue: asyncio.Queue[object] = asyncio.Queue()

    async def __aenter__(self) -> _FakeUpstreamSocket:
        return self

    async def __aexit__(self, *exc_info: object) -> bool:
        return False

    async def send(self, message: str) -> None:
        await self._queue.put(f"echo:{message}")
        await self._queue.put(_UPSTREAM_EOF)

    def __aiter__(self) -> _FakeUpstreamSocket:
        return self

    async def __anext__(self) -> str:
        message = await self._queue.get()
        if message is _UPSTREAM_EOF:
            raise StopAsyncIteration
        return cast(str, message)

    async def close(self) -> None:
        return None


def test_runtime_socket_is_public_and_editor_socket_is_not(
    client: TestClient, monkeypatch
) -> None:
    """The variable pipeline is what makes a panel a panel, so the live view's
    socket opens with no cookie. The editor's — same child socket, other prefix
    — still closes 1008."""
    import manager as manager_module
    import websockets

    monkeypatch.setattr(manager_module.supervisor, "port_for", lambda pid: 65000)
    monkeypatch.setattr(websockets, "connect", lambda *a, **k: _FakeUpstreamSocket())

    with client.websocket_connect("/runtime/ghost/ws") as ws:
        ws.send_text("hello")
        assert ws.receive_text() == "echo:hello"

    with pytest.raises(WebSocketDisconnect) as disconnected:  # noqa: SIM117 -- matches the sibling cases in this module
        with client.websocket_connect("/editor/ghost/ws"):
            pass
    assert disconnected.value.code == 1008


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
    [
        "https://evil.example/",
        "//evil.example/",
        "/projects",
        "/api/manager/running",
        "",
        # The browser normalizes the Location it is handed, so a project path
        # that walks back out of its own prefix is a request for whatever it
        # lands on — same origin, but not the project it names.
        "/runtime/x/../../evil",
        "/runtime/x/%2e%2e/%2e%2e/evil",
        "/editor/ghost/config/../../../evil",
        "/runtime/../evil",
        "/runtime/%2e%2e/evil",
        "/editor/ghost/..",
        # Decodes to a separator at whatever reads it next.
        "/runtime/ghost/api%2fdatasources",
        # Header-splitting characters. Tab belongs with CR and LF.
        "/runtime/ghost/a\tb",
        "/runtime/ghost/a\rb",
        "/runtime/ghost/a\nb",
        "/runtime/ghost/a\\b",
    ],
)
def test_sign_in_target_rejects_anything_but_a_project_path(target: str) -> None:
    import manager

    assert manager.safe_sign_in_target(target) is None


@pytest.mark.parametrize(
    "target",
    [
        "/editor/plant-a/config/pages",
        "/runtime/plant-a/",
        "/runtime/plant-a/pages/home?lang=nl",
        "/editor/plant-a/config?tab=alarms",
    ],
)
def test_sign_in_target_keeps_a_canonical_project_path(target: str) -> None:
    import manager

    assert manager.safe_sign_in_target(target) == target


# ── behind a reverse-proxy mount prefix ───────────────────────────────────────

# The gate has to judge the path the *router* will route on. Under a
# ``root_path`` mount the request path carries the prefix and the route path
# does not, so a gate reading the request path finds no "/api/" and no proxy
# prefix, calls every one of these ungated, and the router serves them anyway.
_MOUNTED_GATED = [
    "/hmi/api/manager/running",
    "/hmi/api/projects",
    "/hmi/api/manager/mcp/tokens",
    "/hmi/editor/ghost/",
    "/hmi/editor/ghost/api/config/config",
    "/hmi/runtime/ghost/api/datasources",
    "/hmi/runtime/ghost/openapi.json",
]


@pytest.mark.parametrize("target", _MOUNTED_GATED)
def test_gate_still_holds_behind_a_root_path_mount(
    mounted_client: TestClient, target: str
) -> None:
    assert mounted_client.get(target).status_code == 401


@pytest.mark.parametrize(
    "target",
    ["/hmi/runtime/ghost/", "/hmi/runtime/ghost/api/config/config", "/hmi/api/health"],
)
def test_root_path_mount_keeps_the_public_surface_public(
    mounted_client: TestClient, target: str
) -> None:
    """503 is the proxy answering for a project that is not running, 200 the
    health probe — the point is that neither needs a session."""
    assert mounted_client.get(target).status_code in (200, 503)


def test_runtime_editor_aliases_503_when_authed_unknown_project(client: TestClient) -> None:
    client.post("/api/manager/auth/setup", json={"password": "secret"})
    assert client.get("/runtime/ghost/api/health").status_code == 503
    assert client.get("/editor/ghost/api/health").status_code == 503


@pytest.mark.parametrize("prefix", ["runtime", "editor"])
def test_document_navigation_to_unopenable_project_is_sent_back_to_projects(
    client: TestClient, prefix: str
) -> None:
    """Fallback for a build with no frontend bundle to render (a source
    checkout): a typed/bookmarked ``/runtime/<id>/`` URL for a project that
    can't be opened lands on the dashboard with a reason, not a raw 503 JSON
    body. A build that ships the bundle serves the project shell instead and
    explains the outage in place — see the test below."""
    client.post("/api/manager/auth/setup", json={"password": "secret"})

    resp = client.get(
        f"/{prefix}/ghost/", headers={"accept": "text/html"}, follow_redirects=False
    )
    assert resp.status_code == 303
    assert resp.headers["location"] == "/projects?unavailable=ghost&reason=unknown"


@pytest.mark.parametrize("prefix", ["runtime", "editor"])
def test_document_navigation_to_unopenable_project_is_served_the_project_shell(
    monkeypatch, tmp_path: Path, prefix: str
) -> None:
    """With a bundle to render, the manager answers a project document itself
    rather than bouncing it: there is no child to serve that URL, so the app
    boots in *instance* mode under the project's own base and says why it is
    empty (ProjectUnavailableOverlay) without the operator losing the URL."""
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
        '<!doctype html><html><head></head><body><div id="root"></div></body></html>'
    )
    frontend_serve.reset_render_cache()

    import manager

    prev = os.environ.get("NEXTHMI_FRONTEND_DIST")
    os.environ["NEXTHMI_FRONTEND_DIST"] = str(dist)
    try:
        manager = importlib.reload(manager)
        monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
        monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
        monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
        with TestClient(manager.app) as tc:
            tc.post("/api/manager/auth/setup", json={"password": "secret"})
            resp = tc.get(
                f"/{prefix}/ghost/", headers={"accept": "text/html"}, follow_redirects=False
            )
            assert resp.status_code == 200
            assert 'window.__NEXTHMI_MODE__="instance"' in resp.text
            assert f'window.__NEXTHMI_BASE__="/{prefix}/ghost/"' in resp.text

            # An XHR under the same prefix keeps the machine-readable failure —
            # that 503 is what drives the overlay.
            assert tc.get(f"/{prefix}/ghost/api/health").status_code == 503
    finally:
        if prev is None:
            os.environ.pop("NEXTHMI_FRONTEND_DIST", None)
        else:
            os.environ["NEXTHMI_FRONTEND_DIST"] = prev
        frontend_serve.reset_render_cache()
        importlib.reload(manager)


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
    """Hitting `/` is sent to the default project's runtime when it is up —
    signed in or not, because the live view is public. A `signIn` round-trip
    wins over that either way: authenticated it resumes its destination,
    unauthenticated it gets the login screen it was bounced here for."""
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
            assert anon.status_code in (302, 307)
            assert anon.headers["location"] == "/runtime/plant-a/"

            # Without this the sign-in round-trip dies: the gate bounces an
            # editor navigation to `/?signIn=…`, and a redirect straight back
            # to the runtime would mean the login screen never renders.
            anon_sign_in = tc.get(
                "/?signIn=/editor/plant-a/config", follow_redirects=False
            )
            assert anon_sign_in.status_code == 200
            assert 'window.__NEXTHMI_MODE__="manager"' in anon_sign_in.text
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


def test_proxy_answers_400_for_a_target_httpx_cannot_build(
    client: TestClient, monkeypatch
) -> None:
    """A NUL inside a segment makes ``httpx.URL`` raise ``InvalidURL`` while the
    upstream request is being assembled. ``InvalidURL`` is not an ``HTTPError``,
    so the proxy's own ``except`` never saw it and a malformed request target
    became an anonymous 500 the moment a project was running."""
    import asyncio

    import manager
    from fastapi import HTTPException
    from starlette.requests import Request

    monkeypatch.setattr(manager, "_upstream_port_or_503", lambda project_id: 9999)

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/runtime/ghost/api\x00/datasources",
            "raw_path": b"/runtime/ghost/api%00/datasources",
            "root_path": "",
            "headers": [],
            "query_string": b"",
            "scheme": "http",
            "client": ("127.0.0.1", 5555),
            "server": ("127.0.0.1", 8000),
        },
        receive,
    )

    with pytest.raises(HTTPException) as raised:
        asyncio.run(manager._proxy_http_to_child("ghost", "api\x00/datasources", request))
    assert raised.value.status_code == 400
