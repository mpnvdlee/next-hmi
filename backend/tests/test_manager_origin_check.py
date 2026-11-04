"""Origin check — cross-site writes and WebSocket upgrades are refused.

On the manager front door, and on a project instance a page reaches directly
at its loopback port; the manager proxy drops ``Origin`` so its own traffic to
the instance passes.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from core import runtime_home
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

RECIPE_LOAD = "/runtime/ghost/api/recipes/datasets/ds-1/download"


def _client(monkeypatch, tmp_path: Path, base_url: str, root_path: str = "") -> TestClient:
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home_dir))

    import manager

    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
    return TestClient(manager.app, base_url=base_url, root_path=root_path)


@pytest.fixture
def client(monkeypatch, tmp_path: Path):
    with _client(monkeypatch, tmp_path, "http://testserver") as tc:
        yield tc


class _EchoUpstream:
    """Stands in for the child's ``/ws``: echoes one frame, then ends."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()

    async def __aenter__(self) -> _EchoUpstream:
        return self

    async def __aexit__(self, *exc_info: object) -> bool:
        return False

    async def send(self, message: str) -> None:
        await self._queue.put(f"echo:{message}")
        await self._queue.put(None)

    def __aiter__(self) -> _EchoUpstream:
        return self

    async def __anext__(self) -> str:
        message = await self._queue.get()
        if message is None:
            raise StopAsyncIteration
        return message

    async def close(self) -> None:
        return None


@pytest.fixture
def running_child(monkeypatch) -> list[tuple[tuple, dict]]:
    """Each upstream ``websockets.connect`` call, as ``(args, kwargs)``."""
    import manager
    import websockets

    calls: list[tuple[tuple, dict]] = []

    def connect(*args, **kwargs) -> _EchoUpstream:
        calls.append((args, kwargs))
        return _EchoUpstream()

    monkeypatch.setattr(manager.supervisor, "port_for", lambda pid: 65000)
    monkeypatch.setattr(websockets, "connect", connect)
    return calls


def _post(client: TestClient, path: str, origin: str | None):
    headers = {} if origin is None else {"Origin": origin}
    return client.post(path, json={"username": "op"}, headers=headers)


def test_same_origin_post_passes(client: TestClient) -> None:
    resp = client.post(
        "/api/manager/auth/setup", json={"password": "secret"}, headers={"Origin": "http://testserver"}
    )
    assert resp.status_code == 200


def test_cross_origin_post_is_refused_before_it_acts(client: TestClient) -> None:
    resp = client.post(
        "/api/manager/auth/setup", json={"password": "secret"}, headers={"Origin": "http://evil.example"}
    )
    assert resp.status_code == 403
    assert client.get("/api/manager/auth/status").json()["passwordSet"] is False


@pytest.mark.parametrize("origin", ["http://evil.example", "null", "http://testserver:8000", "https://testserver"])
def test_cross_origin_post_to_public_runtime_route_is_refused(client: TestClient, origin: str) -> None:
    assert _post(client, RECIPE_LOAD, origin).status_code == 403


@pytest.mark.parametrize("origin", [None, "http://testserver", "HTTP://TestServer:80"])
def test_same_origin_or_headerless_post_reaches_the_proxy(client: TestClient, origin: str | None) -> None:
    # 503: the proxy ran and found no child — the check let it through.
    assert _post(client, RECIPE_LOAD, origin).status_code == 503


def test_cross_origin_post_to_mcp_is_refused(client: TestClient) -> None:
    resp = client.post(
        "/mcp/",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={"Origin": "http://evil.example"},
    )
    assert resp.status_code == 403


def test_cross_origin_get_is_not_checked(client: TestClient) -> None:
    resp = client.get("/api/manager/auth/status", headers={"Origin": "http://evil.example"})
    assert resp.status_code == 200


def test_runtime_socket_refuses_a_cross_origin_upgrade(client: TestClient, running_child) -> None:
    with client.websocket_connect("/runtime/ghost/ws", headers={"Origin": "http://testserver"}) as ws:
        ws.send_text("hi")
        assert ws.receive_text() == "echo:hi"
    with client.websocket_connect("/runtime/ghost/ws") as ws:
        ws.send_text("hi")
        assert ws.receive_text() == "echo:hi"

    with pytest.raises(WebSocketDisconnect) as refused:  # noqa: SIM117
        with client.websocket_connect("/runtime/ghost/ws", headers={"Origin": "http://evil.example"}):
            pass
    assert refused.value.code == 1008


def test_editor_socket_refuses_a_cross_origin_upgrade_even_with_a_session(
    client: TestClient, running_child
) -> None:
    client.post("/api/manager/auth/setup", json={"password": "secret"})
    with client.websocket_connect("/editor/ghost/ws", headers={"Origin": "http://testserver"}) as ws:
        ws.send_text("hi")
        assert ws.receive_text() == "echo:hi"

    with pytest.raises(WebSocketDisconnect) as refused:  # noqa: SIM117
        with client.websocket_connect("/editor/ghost/ws", headers={"Origin": "http://evil.example"}):
            pass
    assert refused.value.code == 1008


def test_https_origin_matches_on_scheme_and_port(monkeypatch, tmp_path: Path, running_child) -> None:
    with _client(monkeypatch, tmp_path, "https://hmi.local:8443") as tls:
        # 502: let through to a child whose port answers nothing.
        assert _post(tls, RECIPE_LOAD, "https://hmi.local:8443").status_code == 502
        # The HTTP port that only redirects here is another origin.
        assert _post(tls, RECIPE_LOAD, "http://hmi.local:8000").status_code == 403
        assert _post(tls, RECIPE_LOAD, "http://hmi.local:8443").status_code == 403
        # websocket_connect ignores base_url, so the wss URL is spelled out.
        wss = "wss://hmi.local:8443/runtime/ghost/ws"
        with tls.websocket_connect(wss, headers={"Origin": "https://hmi.local:8443"}) as ws:
            ws.send_text("hi")
            assert ws.receive_text() == "echo:hi"
        with pytest.raises(WebSocketDisconnect):  # noqa: SIM117
            with tls.websocket_connect(wss, headers={"Origin": "http://hmi.local:8443"}):
                pass


def test_default_port_is_implied(monkeypatch, tmp_path: Path) -> None:
    with _client(monkeypatch, tmp_path, "https://hmi.example") as tls:
        assert _post(tls, RECIPE_LOAD, "https://hmi.example").status_code == 503
        assert _post(tls, RECIPE_LOAD, "https://hmi.example:443").status_code == 503


def test_root_path_mount_does_not_change_the_origin(monkeypatch, tmp_path: Path) -> None:
    with _client(monkeypatch, tmp_path, "http://testserver", root_path="/hmi") as mounted:
        assert _post(mounted, RECIPE_LOAD, "http://testserver").status_code == 503
        assert _post(mounted, RECIPE_LOAD, "http://evil.example").status_code == 403


@pytest.mark.parametrize(
    ("scheme", "host", "origin", "cross"),
    [
        ("http", "[::1]:8000", "http://[::1]:8000", False),
        ("http", "[::1]:8000", "http://[::2]:8000", True),
        ("ws", "localhost:8000", "http://localhost:8000", False),
        ("wss", "localhost:8443", "https://localhost:8443", False),
        ("http", "localhost:8000", "http://localhost:notaport", True),
        ("http", "", "http://localhost", True),
        ("http", "", "http://", True),
    ],
)
def test_is_cross_origin(scheme: str, host: str, origin: str, cross: bool) -> None:
    from core.origin_check import is_cross_origin

    scope = {
        "type": "http",
        "scheme": scheme,
        "headers": [(b"host", host.encode()), (b"origin", origin.encode())],
    }
    assert is_cross_origin(scope) is cross


# ── the hop to the project instance ───────────────────────────────────────────


def test_http_proxy_forwards_only_the_peer_and_scheme_it_saw() -> None:
    import manager
    from starlette.requests import Request

    request = Request(
        {
            "type": "http",
            "scheme": "http",
            "method": "GET",
            "path": "/",
            "server": ("testserver", 80),
            "client": ("10.0.4.12", 50000),
            "headers": [
                (b"host", b"testserver"),
                (b"origin", b"http://testserver"),
                (b"x-probe", b"1"),
                (b"x-forwarded-for", b"203.0.113.7"),
                (b"x-real-ip", b"203.0.113.8"),
                (b"x-forwarded-proto", b"https"),
                (b"x-forwarded-host", b"evil.example"),
                (b"x-forwarded-prefix", b"/x/</script><script>alert(1)</script>/"),
                (b"forwarded", b"for=203.0.113.9;proto=https;host=evil.example"),
            ],
        }
    )
    forwarded = manager._forwarded_headers(request)

    def values(name: str) -> list[str]:
        return [v for k, v in forwarded if k.lower() == name]

    assert values("x-forwarded-for") == ["10.0.4.12"]
    assert values("x-forwarded-proto") == ["http"]
    assert values("x-real-ip") == values("x-forwarded-host") == values("forwarded") == []
    assert values("x-forwarded-prefix") == values("origin") == []
    assert values("x-probe") == ["1"]


def test_ws_proxy_does_not_forward_origin(client: TestClient, running_child) -> None:
    with client.websocket_connect("/runtime/ghost/ws", headers={"Origin": "http://testserver"}) as ws:
        ws.send_text("hi")
        ws.receive_text()
    (args, kwargs), = running_child
    assert args == ("ws://127.0.0.1:65000/ws",)
    # websockets sends an Origin header only when given ``origin=``; the
    # runtime hop adds no header of its own either.
    assert set(kwargs) == {"max_size", "additional_headers"}
    assert kwargs["additional_headers"] is None


# Runs in a subprocess: importing ``main`` bootstraps a project and grafts its
# singletons onto the module table for every later test.
_INSTANCE_PROBE = '''
import json
import sys

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import main

own = "http://127.0.0.1:47001"
client = TestClient(main.app, base_url=own, raise_server_exceptions=False)


def post(headers):
    return client.post("/api/recipes/datasets/ghost/download", json={}, headers=headers).status_code


try:
    with client.websocket_connect("ws://127.0.0.1:47001/ws", headers={"Origin": "http://evil.example"}):
        ws_refused = None
except WebSocketDisconnect as exc:
    ws_refused = exc.code

# DNS rebinding: a name of the page's own, pointed at the loopback port.
rebound = TestClient(main.app, base_url="http://evil.example:47001", raise_server_exceptions=False)
try:
    with rebound.websocket_connect("ws://evil.example:47001/ws"):
        rebound_ws = None
except WebSocketDisconnect as exc:
    rebound_ws = exc.code

with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(
        {
            "foreign": post({"Origin": "http://evil.example"}),
            "other_loopback_port": post({"Origin": "http://127.0.0.1:8000"}),
            "own": post({"Origin": own}),
            "none": post({}),
            "ws_refused": ws_refused,
            "rebound_get": rebound.get("/api/health").status_code,
            "rebound_ws": rebound_ws,
            "localhost_get": TestClient(main.app, base_url="http://localhost:47001")
            .get("/api/health")
            .status_code,
        },
        fh,
    )
'''


def test_instance_refuses_a_page_that_goes_around_the_manager(tmp_path: Path) -> None:
    """A page in the panel's browser can find the child's loopback port. Its
    writes and its socket are refused there, and so is everything under a
    rebound name; the manager proxy, which sends no Origin, and a standalone
    instance used from its own loopback origin still pass."""
    backend = Path(__file__).resolve().parents[1]
    home = tmp_path / "runtime-home"
    home.mkdir()
    script = tmp_path / "probe.py"
    script.write_text(_INSTANCE_PROBE, encoding="utf-8")
    out = tmp_path / "result.json"
    env = {
        **os.environ,
        "NEXTHMI_DATA_DIR": str(home),
        "PYTHONPATH": os.pathsep.join([str(backend), os.environ.get("PYTHONPATH", "")]),
    }
    env.pop("NEXTHMI_FRONTEND_DIST", None)
    proc = subprocess.run(
        [sys.executable, str(script), str(out)],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(backend.parent),
        timeout=180,
    )
    assert proc.returncode == 0, f"probe failed:\n{proc.stdout}\n{proc.stderr}"
    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["foreign"] == 403
    assert result["other_loopback_port"] == 403
    assert result["own"] != 403
    assert result["none"] != 403
    assert result["ws_refused"] == 1008
    assert result["rebound_get"] == 403
    assert result["rebound_ws"] == 1008
    assert result["localhost_get"] == 200
