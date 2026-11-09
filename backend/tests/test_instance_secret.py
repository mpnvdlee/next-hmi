"""A project child answers only the manager that spawned it.

The child binds a loopback port with no user authentication; any local process
could call it directly — write config, read datasource passwords, write to the
PLC, drive the internal panel sign-in. Spawned with a secret, it refuses every
request that does not carry it, and proves it holds the secret when asked.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from core import instance_secret
from fastapi import FastAPI, Request, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

SECRET = "s3cret-for-this-spawn"


def _app(secret: str | None) -> FastAPI:
    app = FastAPI()

    @app.get("/echo")
    async def echo(request: Request) -> dict:
        return {"headers": sorted(request.headers.keys())}

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        await websocket.accept()
        await websocket.send_text("hello")
        await websocket.close()

    app.add_middleware(instance_secret.RequireInstanceSecret, secret=secret)
    return app


def test_a_spawned_child_refuses_a_request_without_its_secret() -> None:
    client = TestClient(_app(SECRET))
    assert client.get("/echo").status_code == 403
    assert client.get("/echo", headers={instance_secret.HEADER: "guess"}).status_code == 403
    assert client.get("/echo", headers={instance_secret.HEADER: SECRET}).status_code == 200


def test_a_spawned_child_refuses_a_socket_without_its_secret() -> None:
    client = TestClient(_app(SECRET))
    with pytest.raises(WebSocketDisconnect) as refused, client.websocket_connect("/ws"):
        pass
    assert refused.value.code == 1008
    with client.websocket_connect("/ws", headers={instance_secret.HEADER: SECRET}) as ws:
        assert ws.receive_text() == "hello"


def test_no_route_ever_sees_the_secret_or_the_nonce() -> None:
    client = TestClient(_app(SECRET))
    seen = client.get(
        "/echo", headers={instance_secret.HEADER: SECRET, instance_secret.NONCE_HEADER: "n"}
    ).json()["headers"]
    assert instance_secret.HEADER not in seen
    assert instance_secret.NONCE_HEADER not in seen


def test_the_child_proves_it_holds_the_secret() -> None:
    client = TestClient(_app(SECRET))
    nonce = instance_secret.new_nonce()
    answer = client.get(
        "/echo", headers={instance_secret.HEADER: SECRET, instance_secret.NONCE_HEADER: nonce}
    ).headers[instance_secret.PROOF_HEADER]
    assert instance_secret.is_proof(SECRET, nonce, answer)
    assert not instance_secret.is_proof("another-spawn", nonce, answer)
    assert not instance_secret.is_proof(SECRET, instance_secret.new_nonce(), answer)


def test_a_standalone_child_serves_as_before() -> None:
    """``uvicorn main:app`` by hand has no manager to send a secret."""
    client = TestClient(_app(None))
    assert client.get("/echo").status_code == 200
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_text() == "hello"


# Runs in a subprocess: importing ``main`` bootstraps a project and grafts its
# singletons onto the module table for every later test.
_INSTANCE_PROBE = '''
import json
import os
import sys

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import main
from core import instance_secret

secret = sys.argv[2]
client = TestClient(main.app, base_url="http://127.0.0.1:47001")
signed = {instance_secret.HEADER: secret}

try:
    with client.websocket_connect("ws://127.0.0.1:47001/ws"):
        ws_refused = None
except WebSocketDisconnect as exc:
    ws_refused = exc.code

with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(
        {
            "unsigned_health": client.get("/api/health").status_code,
            "unsigned_datasources": client.get("/api/datasources").status_code,
            "unsigned_reload": client.post(
                "/api/internal/reload", json={"artifact_type": "pages"}
            ).status_code,
            "signed_health": client.get("/api/health", headers=signed).status_code,
            "ws_refused": ws_refused,
            "env_left": instance_secret.ENV_VAR in os.environ,
        },
        fh,
    )
'''


def test_the_instance_app_requires_the_secret_it_was_spawned_with(tmp_path: Path) -> None:
    backend = Path(__file__).resolve().parents[1]
    home = tmp_path / "runtime-home"
    home.mkdir()
    script = tmp_path / "probe.py"
    script.write_text(_INSTANCE_PROBE, encoding="utf-8")
    out = tmp_path / "result.json"
    env = {
        **os.environ,
        "NEXTHMI_DATA_DIR": str(home),
        instance_secret.ENV_VAR: SECRET,
        "PYTHONPATH": os.pathsep.join([str(backend), os.environ.get("PYTHONPATH", "")]),
    }
    env.pop("NEXTHMI_FRONTEND_DIST", None)
    proc = subprocess.run(
        [sys.executable, str(script), str(out), SECRET],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(backend.parent),
        timeout=180,
    )
    assert proc.returncode == 0, f"probe failed:\n{proc.stdout}\n{proc.stderr}"
    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["unsigned_health"] == 403
    assert result["unsigned_datasources"] == 403
    assert result["unsigned_reload"] == 403
    assert result["signed_health"] == 200
    assert result["ws_refused"] == 1008
    # Nothing the instance starts (the widget compiler, say) inherits it.
    assert result["env_left"] is False
