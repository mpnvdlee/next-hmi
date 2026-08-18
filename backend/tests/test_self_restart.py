"""Phase 3 of the project-management redesign: self-restart mechanism.

The endpoint ``POST /api/system/restart`` writes a sentinel under the
runtime home, broadcasts ``{type: "restarting"}`` to every WS client, then
signals ``SIGTERM`` to itself so uvicorn's lifespan teardown runs. The
supervisor (``launcher.py`` or ``start-dev.py``) consults the sentinel after the
clean exit to decide whether to relaunch.

These tests cover:
  * the sentinel write/clear is atomic and the file format is parseable,
  * the endpoint returns 202 with the expected body,
  * a fake websocket receives the ``restarting`` broadcast,
  * ``signal.raise_signal`` is invoked (without actually killing the test
    process — we monkeypatch it),
  * the hard-exit fallback fires after the grace window when SIGTERM is
    swallowed (again, monkeypatched).
"""
from __future__ import annotations

import asyncio
import signal
import sys
from pathlib import Path

import pytest
from api import system_api
from core import runtime_home
from fastapi import FastAPI
from fastapi.testclient import TestClient
from services.websocket_manager import websocket_manager
from tests.conftest import FakeWebSocket


@pytest.fixture
def isolated_runtime_home(monkeypatch, tmp_path: Path) -> Path:
    """Point ``runtime_home.runtime_home_path()`` at a tmp dir for this test.

    Also short-circuits ``_hard_exit_grace_seconds`` so the fallback path is
    fast to assert against.
    """
    home = tmp_path / "runtime-home"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home)
    return home


@pytest.fixture
def restart_app(monkeypatch, isolated_runtime_home: Path) -> FastAPI:
    """A bare FastAPI app mounting only the system router.

    We never want the real ``os._exit`` or ``signal.raise_signal`` to fire
    during the test process — both are monkeypatched to record calls instead.
    """
    calls: dict[str, list] = {"raise_signal": [], "os_exit": [], "kill": []}

    def fake_raise_signal(sig: int) -> None:
        calls["raise_signal"].append(sig)

    def fake_os_exit(code: int) -> None:
        calls["os_exit"].append(code)
        # Don't actually exit — let the test observe the call and proceed.

    def fake_os_kill(pid: int, sig: int) -> None:
        calls["kill"].append((pid, sig))

    monkeypatch.setattr(system_api.signal, "raise_signal", fake_raise_signal)
    monkeypatch.setattr(system_api.os, "_exit", fake_os_exit)
    monkeypatch.setattr(system_api.os, "kill", fake_os_kill)
    monkeypatch.setattr(system_api, "_hard_exit_grace_seconds", lambda: 0.05)

    app = FastAPI()
    app.include_router(system_api.router)
    app.state.restart_calls = calls
    return app


# ── sentinel I/O ──────────────────────────────────────────────────────────────


def test_write_restart_sentinel_is_atomic(isolated_runtime_home: Path) -> None:
    system_api.write_restart_sentinel("manual")
    sentinel = runtime_home.restart_sentinel_path()
    assert sentinel.exists()
    raw = sentinel.read_text(encoding="utf-8").strip()
    ts_str, _, reason = raw.partition(" ")
    assert int(ts_str) > 0
    assert reason == "manual"
    # Re-writing replaces the contents — no leftover tmp files.
    system_api.write_restart_sentinel("project-switch")
    siblings = [p.name for p in sentinel.parent.iterdir() if p.name != sentinel.name]
    assert all(not name.endswith(".tmp") for name in siblings), siblings
    assert sentinel.read_text(encoding="utf-8").strip().endswith("project-switch")


def test_restart_sentinel_path_under_runtime_home(isolated_runtime_home: Path) -> None:
    assert runtime_home.restart_sentinel_path() == isolated_runtime_home / ".restart-pending"


# ── endpoint behaviour ────────────────────────────────────────────────────────


def test_restart_endpoint_writes_sentinel_and_returns_202(restart_app: FastAPI) -> None:
    with TestClient(restart_app) as client:
        resp = client.post("/api/system/restart")
    assert resp.status_code == 202
    assert resp.json() == {"status": "restarting", "reason": "manual"}
    assert runtime_home.restart_sentinel_path().exists()


def test_restart_endpoint_accepts_custom_reason(restart_app: FastAPI) -> None:
    with TestClient(restart_app) as client:
        resp = client.post("/api/system/restart", params={"reason": "make-live"})
    assert resp.status_code == 202
    assert resp.json()["reason"] == "make-live"
    raw = runtime_home.restart_sentinel_path().read_text(encoding="utf-8")
    assert "make-live" in raw


def test_restart_broadcasts_to_connected_clients(restart_app: FastAPI) -> None:
    fake_ws = FakeWebSocket()
    websocket_manager._connections["test-client"] = fake_ws  # type: ignore[assignment]
    try:
        with TestClient(restart_app) as client:
            resp = client.post("/api/system/restart")
        assert resp.status_code == 202
        assert any(
            msg.get("type") == "restarting" and msg.get("reason") == "manual"
            for msg in fake_ws.messages
        ), fake_ws.messages
    finally:
        websocket_manager._connections.pop("test-client", None)


def test_shutdown_coroutine_raises_sigterm_then_hard_exits(restart_app: FastAPI) -> None:
    # The endpoint kicks off ``shutdown_after_response`` as a background task,
    # but TestClient closes its loop too quickly to observe it. Drive the
    # coroutine directly instead — same code path, deterministic timing.
    asyncio.run(system_api.shutdown_after_response("test"))
    calls = restart_app.state.restart_calls
    assert signal.SIGTERM in calls["raise_signal"]
    assert calls["os_exit"] == [0]


def test_shutdown_coroutine_falls_back_to_os_kill_when_raise_signal_missing(
    restart_app: FastAPI, monkeypatch
) -> None:
    # Simulate a platform where ``signal.raise_signal`` raises (e.g. an older
    # Python build). The fallback uses ``os.kill(getpid(), SIGTERM)``.
    def boom(_sig: int) -> None:
        raise OSError("not supported")

    monkeypatch.setattr(system_api.signal, "raise_signal", boom)
    asyncio.run(system_api.shutdown_after_response("test"))
    calls = restart_app.state.restart_calls
    assert calls["kill"], "expected os.kill fallback to be invoked"
    pid, sig = calls["kill"][0]
    assert sig == signal.SIGTERM
    assert pid == system_api.os.getpid()


# ── broadcast helper ──────────────────────────────────────────────────────────


def test_broadcast_restarting_is_noop_with_no_clients() -> None:
    # No clients connected — must not raise.
    asyncio.run(websocket_manager.broadcast_restarting(reason="manual"))


def test_broadcast_restarting_payload_shape() -> None:
    fake_ws = FakeWebSocket()
    websocket_manager._connections["client-x"] = fake_ws  # type: ignore[assignment]
    try:
        asyncio.run(websocket_manager.broadcast_restarting(reason="project-switch"))
    finally:
        websocket_manager._connections.pop("client-x", None)
    assert fake_ws.messages == [{"type": "restarting", "reason": "project-switch"}]


# ── surviving uvicorn's signal re-raise ───────────────────────────────────────


def test_launcher_absorbs_the_signal_uvicorn_re_raises() -> None:
    """The SIGTERM that asks for a restart must not also kill the restart.

    ``uvicorn.Server.capture_signals`` restores the previous handlers and then
    re-raises the signal that stopped it, so ``uvicorn.run()`` returns straight
    into the default disposition. Without the launcher owning SIGTERM across
    that boundary the process dies at 128+SIGTERM and never reaches its
    sentinel re-exec — the device shuts down instead of restarting.
    """
    import launcher

    original = signal.getsignal(signal.SIGTERM)
    try:
        with launcher._absorb_uvicorns_signal_reraise():
            # Under SIG_DFL this call would terminate the test process.
            signal.raise_signal(signal.SIGTERM)
        assert signal.getsignal(signal.SIGTERM) is original
    finally:
        signal.signal(signal.SIGTERM, original)


# ── hard-exit grace window ────────────────────────────────────────────────────


def test_grace_window_falls_back_to_the_floor_without_a_supervisor(monkeypatch) -> None:
    """A project instance has no children, so it never pays the per-child cost."""
    monkeypatch.delitem(sys.modules, "services.supervisor", raising=False)
    assert system_api._hard_exit_grace_seconds() == system_api._HARD_EXIT_GRACE_FLOOR_SECONDS


def test_grace_window_scales_with_running_children(monkeypatch) -> None:
    """Children are terminated one at a time, so the honest shutdown cost grows.

    The old fixed 8s equalled a single child's SIGTERM grace, so the backstop
    fired mid-shutdown and hard-exited past the launcher's sentinel re-exec.
    """
    from services import supervisor as supervisor_module

    monkeypatch.setattr(
        supervisor_module.supervisor, "running_snapshot", lambda: [{}] * 6
    )
    grace = system_api._hard_exit_grace_seconds()
    worst_case = 6 * (supervisor_module._STOP_GRACE_SECONDS + 5.0)
    assert grace > worst_case
