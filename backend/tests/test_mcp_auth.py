"""MCP transport authentication.

Covers ``core.mcp_tokens`` (issue/resolve/revoke/generation-binding),
``mcp_server.auth.require_mcp_access`` (the per-call project/access check),
the ``/mcp`` HTTP auth gate, and the ``/api/manager/mcp*`` pairing/list/revoke
endpoints — including that a password change revokes outstanding tokens and
that ``mcpEnabled`` remains an independent write gate even for a token with
write access.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from core import manager_auth, mcp_tokens, runtime_home
from core.manifest import ProjectEntry, save_manifest
from core.time_utils import iso_now
from fastapi.testclient import TestClient
from mcp_server.auth import (
    McpAuthError,
    McpIdentity,
    identity_for_tests,
    require_mcp_access,
)


def _configure_home(monkeypatch, tmp_path: Path) -> Path:
    home = tmp_path / "runtime"
    home.mkdir()
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home)
    manager_auth.set_password("device-admin")
    return home


# ── core.mcp_tokens ──────────────────────────────────────────────────────────


def test_issue_persists_only_hash(monkeypatch, tmp_path: Path):
    _configure_home(monkeypatch, tmp_path)
    token_id, token = mcp_tokens.issue(access="write", name="Agent")
    stored = mcp_tokens.tokens_path().read_text(encoding="utf-8")
    assert token not in stored
    assert token_id in stored
    scope = mcp_tokens.resolve(token)
    assert scope is not None
    assert scope.access == "write"
    assert scope.token_id == token_id


def test_resolve_rejects_garbage_and_wrong_signature(monkeypatch, tmp_path: Path):
    _configure_home(monkeypatch, tmp_path)
    _, token = mcp_tokens.issue(access="read")
    assert mcp_tokens.resolve(None) is None
    assert mcp_tokens.resolve("garbage") is None
    assert mcp_tokens.resolve(token + "x") is None


def test_revoke_and_revoke_all(monkeypatch, tmp_path: Path):
    _configure_home(monkeypatch, tmp_path)
    id1, token1 = mcp_tokens.issue(access="read")
    _id2, token2 = mcp_tokens.issue(access="write")
    assert mcp_tokens.revoke(id1) is True
    assert mcp_tokens.revoke(id1) is False
    assert mcp_tokens.resolve(token1) is None
    assert mcp_tokens.resolve(token2) is not None
    assert mcp_tokens.revoke_all() == 1
    assert mcp_tokens.resolve(token2) is None
    assert mcp_tokens.list_tokens() == []


def test_password_change_invalidates_tokens_via_generation(monkeypatch, tmp_path: Path):
    """Belt-and-braces: even without an explicit revoke_all() call, a token
    minted under the old password generation stops resolving."""
    _configure_home(monkeypatch, tmp_path)
    _, token = mcp_tokens.issue(access="write")
    assert mcp_tokens.resolve(token) is not None
    manager_auth.set_password("new-device-admin")
    assert mcp_tokens.resolve(token) is None


# ── mcp_server.auth.require_mcp_access ───────────────────────────────────────


def test_require_mcp_access_raises_when_unauthenticated():
    with pytest.raises(McpAuthError):
        require_mcp_access(need_write=False)


def test_session_identity_has_full_access():
    with identity_for_tests(McpIdentity(kind="session")):
        require_mcp_access(need_write=False)
        require_mcp_access(need_write=True)


def test_token_identity_is_held_to_its_access():
    write_token = McpIdentity(kind="token", access="write")
    with identity_for_tests(write_token):
        require_mcp_access(need_write=False)
        require_mcp_access(need_write=True)

    read_token = McpIdentity(kind="token", access="read")
    with identity_for_tests(read_token):
        require_mcp_access(need_write=False)
        with pytest.raises(McpAuthError):
            require_mcp_access(need_write=True)


# ── /mcp HTTP auth gate ──────────────────────────────────────────────────────


@pytest.fixture
def manager_client(monkeypatch, tmp_path: Path):
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home_dir))

    import manager

    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)

    # A session manager runs once per process (run_session_manager_once), so
    # each test mounts a fresh transport and lets this lifespan start it; the
    # previous one is put back afterwards.
    from mcp_server import server as mcp_server

    lowlevel = mcp_server.mcp_app._lowlevel_server
    monkeypatch.setattr(lowlevel, "_session_manager", lowlevel._session_manager)
    monkeypatch.setattr(mcp_server, "_session_started", False)
    mount = next(r for r in manager.app.routes if getattr(r, "path", None) == "/mcp")
    monkeypatch.setattr(mount, "app", mcp_server.build_mcp_asgi_app())
    with TestClient(manager.app) as tc:
        yield tc


_INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "test", "version": "0"},
    },
}


def _initialize(client: TestClient, **headers: str):
    """An MCP initialize; asserts the transport answered it, not just the gate."""
    resp = client.post(
        "/mcp",
        json=_INITIALIZE,
        headers={"Accept": "application/json, text/event-stream", **headers},
    )
    assert resp.status_code == 200, resp.text
    assert '"serverInfo"' in resp.text
    return resp


def test_mcp_rejects_request_with_no_credentials(manager_client: TestClient):
    resp = manager_client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert resp.status_code == 401
    assert "MCP" in resp.json()["detail"]


def test_mcp_rejects_invalid_bearer_token(manager_client: TestClient):
    resp = manager_client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert resp.status_code == 401


def test_mcp_without_trailing_slash_is_not_a_redirect(manager_client: TestClient):
    """Clients that don't follow redirects still reach the transport at ``/mcp``:
    the path is rewritten to ``/mcp/`` before routing instead of 307-ing there."""
    manager_client.post("/api/manager/auth/setup", json={"password": "secret"})
    resp = manager_client.post(
        "/mcp",
        json=_INITIALIZE,
        headers={"Accept": "application/json, text/event-stream"},
        follow_redirects=False,
    )
    assert resp.status_code == 200


def test_mcp_forged_forwarded_headers_do_not_bypass_auth(manager_client: TestClient):
    """Auth is decided purely from the Cookie/Authorization headers — a proxy
    or container in front of the manager can't be tricked into granting access
    by forging a loopback-looking client address."""
    resp = manager_client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={"X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1"},
    )
    assert resp.status_code == 401


def test_mcp_accepts_valid_session_cookie(manager_client: TestClient):
    manager_client.post("/api/manager/auth/setup", json={"password": "secret"})
    _initialize(manager_client)


def test_mcp_accepts_valid_bearer_token(manager_client: TestClient):
    manager_client.post("/api/manager/auth/setup", json={"password": "secret"})
    _seed_project(manager_client)
    pair = manager_client.post(
        "/api/manager/mcp/pair",
        json={"password": "secret", "access": "read"},
    )
    assert pair.status_code == 201
    token = pair.json()["token"]
    _drop_session_cookie(manager_client)  # exercise the bearer token alone
    _initialize(manager_client, Authorization=f"Bearer {token}")


def test_mcp_answers_a_client_on_the_lan(manager_client: TestClient):
    """A client on another machine sends the manager's LAN address as Host; the
    SDK's loopback-only Host check would answer that 421."""
    manager_client.post("/api/manager/auth/setup", json={"password": "secret"})
    _seed_project(manager_client)
    token = manager_client.post(
        "/api/manager/mcp/pair",
        json={"password": "secret", "access": "read"},
    ).json()["token"]
    _drop_session_cookie(manager_client)
    _initialize(manager_client, Authorization=f"Bearer {token}", Host="192.168.1.5:8000")


def _drop_session_cookie(client: TestClient) -> None:
    """setup/login/change-password all leave a session cookie on the client,
    which would otherwise authenticate every later request on its own and
    mask whether a bearer token specifically is doing the work."""
    client.cookies.delete(manager_auth.SESSION_COOKIE)


def _seed_project(client: TestClient) -> str:
    import manager as manager_module
    from core.manifest import load_manifest

    manifest = load_manifest()
    project_dir = Path(manager_module.__file__).parent  # any existing dir works for a stub
    manifest.projects.append(
        ProjectEntry(id="P1", name="P1", path=str(project_dir), addedAt=iso_now())
    )
    save_manifest(manifest)
    return "P1"


# ── /api/manager/mcp/pair, mcp-tokens list/revoke ────────────────────────────


def test_pair_requires_correct_password_and_takes_no_project(manager_client: TestClient):
    manager_client.post("/api/manager/auth/setup", json={"password": "secret"})
    _seed_project(manager_client)

    wrong = manager_client.post(
        "/api/manager/mcp/pair",
        json={"password": "nope", "access": "read"},
    )
    assert wrong.status_code == 422

    # A 1.x script naming a project is refused, not handed a token for every project.
    one_project = manager_client.post(
        "/api/manager/mcp/pair",
        json={"password": "secret", "projectId": "P1", "access": "read"},
    )
    assert one_project.status_code == 422

    ok = manager_client.post(
        "/api/manager/mcp/pair",
        json={"password": "secret", "access": "write"},
    )
    assert ok.status_code == 201
    body = ok.json()
    assert "projectId" not in body
    assert body["access"] == "write"


def test_mcp_token_list_and_revoke_require_manager_session(manager_client: TestClient):
    assert manager_client.get("/api/manager/mcp-tokens").status_code == 401
    assert manager_client.delete("/api/manager/mcp-tokens/anything").status_code == 401

    manager_client.post("/api/manager/auth/setup", json={"password": "secret"})
    _seed_project(manager_client)
    pair = manager_client.post(
        "/api/manager/mcp/pair",
        json={"password": "secret", "access": "read"},
    )
    token_id = pair.json()["tokenId"]

    listed = manager_client.get("/api/manager/mcp-tokens")
    assert listed.status_code == 200
    assert token_id in {t["id"] for t in listed.json()["tokens"]}

    revoked = manager_client.delete(f"/api/manager/mcp-tokens/{token_id}")
    assert revoked.status_code == 200
    assert manager_client.delete(f"/api/manager/mcp-tokens/{token_id}").status_code == 404


def test_dashboard_create_needs_session_not_password(manager_client: TestClient):
    """The dashboard's create route takes the manager session as its proof: no
    password in the body, and nothing minted without the session."""
    manager_client.post("/api/manager/auth/setup", json={"password": "secret"})
    _seed_project(manager_client)
    _drop_session_cookie(manager_client)
    body = {"access": "write", "name": "Laptop"}
    assert manager_client.post("/api/manager/mcp-tokens", json=body).status_code == 401

    manager_client.post("/api/manager/auth/login", json={"password": "secret"})
    one_project = manager_client.post(
        "/api/manager/mcp-tokens", json={"projectId": "P1", "access": "read"}
    )
    assert one_project.status_code == 422

    bad_scopes = manager_client.post(
        "/api/manager/mcp-tokens", json={"kind": "api", "scopes": ["root"]}
    )
    assert bad_scopes.status_code == 422
    assert bad_scopes.json()["detail"].startswith("An API token needs one or more of:")

    created = manager_client.post("/api/manager/mcp-tokens", json=body)
    assert created.status_code == 201
    issued = created.json()
    assert issued["access"] == "write"
    assert issued["transport"] == "http"

    # Shown once: the listing never carries the secret.
    listed = manager_client.get("/api/manager/mcp-tokens").json()["tokens"]
    entry = next(t for t in listed if t["id"] == issued["tokenId"])
    assert entry["name"] == "Laptop"
    assert issued["token"] not in str(listed)

    _drop_session_cookie(manager_client)
    _initialize(manager_client, Authorization=f"Bearer {issued['token']}")


def test_password_change_revokes_mcp_tokens(manager_client: TestClient):
    manager_client.post("/api/manager/auth/setup", json={"password": "secret"})
    _seed_project(manager_client)
    pair = manager_client.post(
        "/api/manager/mcp/pair",
        json={"password": "secret", "access": "write"},
    )
    token = pair.json()["token"]
    _drop_session_cookie(manager_client)

    _initialize(manager_client, Authorization=f"Bearer {token}")

    # change-password re-authenticates with the *current* password and
    # re-issues a session cookie for the caller — drop it again so this
    # second /mcp call still exercises only the (now revoked) bearer token.
    changed = manager_client.post(
        "/api/manager/auth/change-password",
        json={"currentPassword": "secret", "newPassword": "new-secret"},
    )
    assert changed.status_code == 200
    _drop_session_cookie(manager_client)

    resp = manager_client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 401


# ── mcpEnabled remains an independent write gate ─────────────────────────────


def test_write_scoped_token_still_blocked_by_mcp_disabled(monkeypatch, tmp_path: Path):
    """A token with write access to a project doesn't bypass that project's
    own mcpEnabled=False — the two gates are independent: mcpEnabled is an
    *additional* write gate. Drives a
    real tool call through the registered scoped wrapper (mcp_server.scoped),
    not just the auth helper in isolation."""
    import json

    from core import manifest as manifest_mod
    from core.manifest import ManifestV1, ProjectEntry, save_manifest
    from mcp.server.mcpserver import Context
    from mcp_server.server import mcp_app, prepare_workspace_tools

    manifest_path = tmp_path / "projects.json"
    monkeypatch.setattr(manifest_mod, "manifest_path", lambda: manifest_path)
    project_root = tmp_path / "P1"
    (project_root / "pages").mkdir(parents=True)
    (project_root / "config.json").write_text(
        json.dumps({"mcpEnabled": False, "pages": []}), encoding="utf-8"
    )
    save_manifest(
        ManifestV1(projects=[ProjectEntry(id="P1", name="P1", path=str(project_root), addedAt=iso_now())])
    )
    prepare_workspace_tools()

    write_token = McpIdentity(kind="token", access="write")
    with identity_for_tests(write_token):  # noqa: SIM117 -- no autofix offered (inner block has a local import), left as-is per the mechanical-only policy for this family
        with pytest.raises(Exception) as excinfo:
            import asyncio

            asyncio.run(
                mcp_app._tool_manager.call_tool(
                    "pages_create", {"project": "P1", "title": "X"}, Context(mcp_server=mcp_app)
                )
            )
    assert "disabled" in str(excinfo.value).lower()
    assert list((project_root / "pages").glob("*.json")) == []


# ── bind default ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("env_host", "expected"),
    [(None, ""), ("127.0.0.1", "127.0.0.1")],
)
def test_manager_binds_through_the_shared_resolver(monkeypatch, tmp_path: Path, env_host, expected):
    """The manager must bind what ``core.net`` resolves, not a default of its own.

    What that resolver answers — every interface unless NEXTHMI_HOST says
    otherwise — is pinned in ``test_net.py``; what matters here is that /mcp's
    exposure follows it, since ``McpAuthMiddleware`` above authenticates every
    request whichever interface it arrived on. Driven through ``_run_manager``
    with the listener stubbed out, so the assertion is on the address actually
    handed to the server rather than on the launcher's source text.
    """
    import argparse

    import launcher
    from api import system_api
    from core import net, tls_settings

    home = _configure_home(monkeypatch, tmp_path)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home))
    monkeypatch.setenv("NEXTHMI_PORT", "8000")
    monkeypatch.setenv("NEXTHMI_HTTPS_PORT", "8443")
    for name in ("NEXTHMI_SSL_CERTFILE", "NEXTHMI_SSL_KEYFILE"):
        monkeypatch.delenv(name, raising=False)
    if env_host is None:
        monkeypatch.delenv("NEXTHMI_HOST", raising=False)
    else:
        monkeypatch.setenv("NEXTHMI_HOST", env_host)

    served: dict[str, str] = {}
    monkeypatch.setattr(launcher, "_load_manager_app", lambda: object())
    monkeypatch.setattr(
        launcher, "_serve", lambda app, host, port, verbose, **kwargs: served.update(host=host)
    )
    monkeypatch.setattr(launcher, "_resolve_port_conflict", lambda host, port: port)
    monkeypatch.setattr(launcher, "print_banner", lambda *args, **kwargs: None)
    monkeypatch.setattr(launcher, "_apply_pending_restart", lambda: None)
    monkeypatch.setattr(system_api, "apply_pending_restart", lambda: None)
    tls_settings.mark_served(False, None)

    args = argparse.Namespace(verbose=False, port=None, https_port=None)
    assert launcher._run_manager(home, args) == 0

    assert served["host"] == net.resolve_bind_host() == expected
