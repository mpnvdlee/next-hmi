"""The manager caps request bodies instead of holding whatever arrives.

Neither uvicorn nor Starlette sets a limit, so one anonymous chunked multi-GB
POST used to fill the manager's memory and take every project down with it.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from core import manager_auth, runtime_home
from fastapi.testclient import TestClient

MIB = 1024 * 1024


@pytest.fixture
def home(monkeypatch, tmp_path: Path) -> Path:
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir()
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home_dir))
    return home_dir


@pytest.fixture(autouse=True)
def _reset_throttle():
    manager_auth.register_login_success()
    yield
    manager_auth.register_login_success()


@pytest.fixture
def client(monkeypatch, home: Path):
    import manager

    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
    with TestClient(manager.app) as tc:
        yield tc


@pytest.fixture
def child(monkeypatch, client: TestClient) -> list[httpx.Request]:
    """A running project child that records every request the proxy hands it."""
    import manager

    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        received = json.dumps({"received": len(request.content)}).encode()
        # The proxy streams the response on, so the fake must not be pre-read.
        return httpx.Response(200, stream=httpx.ByteStream(received))

    monkeypatch.setattr(manager.supervisor, "port_for", lambda pid: 65000)
    monkeypatch.setattr(
        manager, "_proxy_client", httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    return seen


def _sign_in(client: TestClient) -> None:
    resp = client.post(
        "/api/manager/auth/setup",
        json={"password": "secret", "setupCode": manager_auth.setup_code()},
    )
    assert resp.status_code == 200


def _chunks(total: int, size: int = 64 * 1024):
    sent = 0
    while sent < total:
        step = min(size, total - sent)
        sent += step
        yield b"x" * step


def _call_raw(method: str, path: str, headers: list[tuple[bytes, bytes]]) -> tuple[int, bytes, bool]:
    """Drive the ASGI app directly with a receive that records whether the body
    was ever asked for, which no HTTP client can show."""
    import manager

    body_read = False
    sent: list[dict] = []

    async def receive() -> dict:
        nonlocal body_read
        body_read = True
        return {"type": "http.request", "body": b"x" * 1024, "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": b"",
        "headers": [(b"host", b"testserver"), *headers],
        "client": ("192.168.1.50", 50000),
        "server": ("testserver", 80),
    }
    asyncio.run(manager.app(scope, receive, send))
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, body, body_read


@pytest.mark.parametrize(
    ("path", "declared"),
    [
        ("/runtime/ghost/api/http-request", 10 * 1024 * MIB),
        ("/runtime/ghost/api/http-request", MIB + 1),
        ("/api/manager/auth/login", 10 * 1024 * MIB),
        ("/editor/ghost/api/config/pages/p1", 64 * MIB + 1),
    ],
)
def test_oversized_content_length_is_refused_before_the_body_is_read(
    home: Path, path: str, declared: int
) -> None:
    status, body, body_read = _call_raw(
        "POST", path, [(b"content-type", b"application/json"), (b"content-length", str(declared).encode())]
    )

    assert status == 413
    assert b"Request body too large" in body
    assert body_read is False


def test_oversized_chunked_body_to_the_live_view_is_refused(
    client: TestClient, child: list[httpx.Request]
) -> None:
    resp = client.post(
        "/runtime/ghost/api/http-request",
        content=_chunks(MIB + 1),
        headers={"content-type": "application/json"},
    )

    assert resp.status_code == 413
    assert resp.json()["detail"] == "Request body too large: this address accepts at most 1 MB."
    assert child == []


def test_oversized_chunked_body_to_sign_in_is_refused(client: TestClient) -> None:
    """FastAPI reads a JSON body before anything checks the caller, so the
    sign-in endpoints were as open to it as the proxy."""
    resp = client.post(
        "/api/manager/auth/login",
        content=_chunks(2 * MIB),
        headers={"content-type": "application/json"},
    )

    assert resp.status_code == 413
    assert "1 MB" in resp.json()["detail"]


def test_normal_live_view_request_reaches_the_child_unchanged(
    client: TestClient, child: list[httpx.Request]
) -> None:
    payload = b'{"url": "http://plc.local/api", "method": "GET", "headers": {}}'

    resp = client.post(
        "/runtime/ghost/api/http-request",
        content=payload,
        headers={"content-type": "application/json"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"received": len(payload)}
    (forwarded,) = child
    assert forwarded.content == payload
    assert forwarded.headers["content-length"] == str(len(payload))
    assert "transfer-encoding" not in forwarded.headers


def test_get_without_a_body_is_not_reframed_as_an_upload(
    client: TestClient, child: list[httpx.Request]
) -> None:
    assert client.get("/runtime/ghost/api/config/config").status_code == 200

    (forwarded,) = child
    assert forwarded.content == b""
    assert "transfer-encoding" not in forwarded.headers
    assert "content-length" not in forwarded.headers


def test_chunked_body_under_the_cap_is_streamed_through(
    client: TestClient, child: list[httpx.Request]
) -> None:
    resp = client.post(
        "/runtime/ghost/api/recipes/datasets/ds-1/upload",
        content=_chunks(MIB - 1),
        headers={"content-type": "application/json"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"received": MIB - 1}


def test_editor_sized_request_passes(client: TestClient, child: list[httpx.Request]) -> None:
    """A signed-in editor saves bodies far past the public cap: a page, a large
    variable list, the 2 MB thumbnail."""
    _sign_in(client)
    body = b"x" * (3 * MIB)

    resp = client.put(
        "/editor/ghost/api/config/pages/p1",
        content=body,
        headers={"content-type": "application/json"},
    )
    chunked = client.post(
        "/editor/ghost/api/thumbnail", content=_chunks(2 * MIB), headers={"content-type": "image/png"}
    )

    assert resp.status_code == 200
    assert resp.json() == {"received": 3 * MIB}
    assert chunked.status_code == 200
    assert chunked.json() == {"received": 2 * MIB}


def test_the_same_body_on_the_public_prefix_is_refused(
    client: TestClient, child: list[httpx.Request]
) -> None:
    _sign_in(client)

    resp = client.post(
        "/runtime/ghost/api/http-request",
        content=b"x" * (3 * MIB),
        headers={"content-type": "application/json"},
    )

    assert resp.status_code == 413
    assert child == []


@pytest.mark.parametrize(
    ("method", "path"),
    [
        # Their own limits and streaming: the transfer is held to its
        # Content-Length cap by the gate, the import spools to disk behind the
        # session, and /mcp authenticates before its transport reads a byte.
        ("POST", "/api/manager/peer/transfers"),
        ("POST", "/api/projects/import"),
        ("POST", "/mcp"),
        ("POST", "/mcp/"),
    ],
)
def test_routes_with_their_own_limits_are_left_to_them(method: str, path: str) -> None:
    import manager

    scope = {"type": "http", "method": method, "path": path, "raw_path": path.encode(), "root_path": ""}
    assert manager._body_limit(scope) is None
