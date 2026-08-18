"""Install-count ping: the id, the opt-out, the payload, and staying silent offline."""
from __future__ import annotations

import json
import logging
from pathlib import Path

import httpx
import pytest
from core import runtime_home, telemetry
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def home(monkeypatch, tmp_path: Path) -> Path:
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home_dir))
    # conftest switches telemetry off for every test; these ones own the setting.
    monkeypatch.delenv(telemetry.ENV_VAR, raising=False)
    return home_dir


# ── install id ───────────────────────────────────────────────────────────────


def test_install_id_is_minted_once_and_kept(home: Path) -> None:
    first = telemetry.install_id()
    assert len(first) == 32
    assert telemetry.install_id() == first

    stored = json.loads((home / ".install-id.json").read_text(encoding="utf-8"))
    assert stored["installId"] == first
    assert stored["createdAt"]


def test_install_id_is_remade_when_the_file_is_unreadable(home: Path) -> None:
    first = telemetry.install_id()
    (home / ".install-id.json").write_text("not json", encoding="utf-8")
    assert telemetry.install_id() != first


# ── opt-out ──────────────────────────────────────────────────────────────────


def test_enabled_by_default(home: Path) -> None:
    assert telemetry.env_override() is None
    assert telemetry.is_enabled() is True


def test_setting_disables(home: Path) -> None:
    telemetry.set_enabled(False)
    assert telemetry.is_enabled() is False
    telemetry.set_enabled(True)
    assert telemetry.is_enabled() is True


@pytest.mark.parametrize("value", ["off", "0", "false", "no", "OFF"])
def test_env_off_wins_over_the_setting(monkeypatch, home: Path, value: str) -> None:
    telemetry.set_enabled(True)
    monkeypatch.setenv(telemetry.ENV_VAR, value)
    assert telemetry.env_override() is False
    assert telemetry.is_enabled() is False


def test_env_on_wins_over_the_setting(monkeypatch, home: Path) -> None:
    telemetry.set_enabled(False)
    monkeypatch.setenv(telemetry.ENV_VAR, "on")
    assert telemetry.env_override() is True
    assert telemetry.is_enabled() is True


def test_start_does_nothing_when_disabled(home: Path) -> None:
    telemetry.set_enabled(False)
    assert telemetry.start() is None


# ── payload ──────────────────────────────────────────────────────────────────


def test_payload_carries_only_what_was_agreed(home: Path) -> None:
    payload = telemetry._payload("start")
    assert set(payload) == {
        "installId",
        "version",
        "edition",
        "os",
        "osRelease",
        "python",
        "event",
    }
    assert payload["installId"] == telemetry.install_id()
    assert payload["edition"] in {"oss", "ee"}
    assert payload["event"] == "start"


# ── the ping itself ──────────────────────────────────────────────────────────


class _FakeClient:
    """Stands in for ``httpx.AsyncClient`` as an async context manager."""

    def __init__(self, *, raises: Exception | None = None, status: int = 204) -> None:
        self.raises = raises
        self.status = status
        self.posted: list[tuple[str, dict]] = []

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> bool:
        return False

    async def post(self, url: str, json: dict) -> httpx.Response:
        if self.raises is not None:
            raise self.raises
        self.posted.append((url, json))
        return httpx.Response(self.status, request=httpx.Request("POST", url))


@pytest.mark.asyncio
async def test_ping_posts_the_payload(monkeypatch, home: Path) -> None:
    fake = _FakeClient()
    monkeypatch.setattr(telemetry.httpx, "AsyncClient", fake)

    assert await telemetry._ping("heartbeat") is True
    url, body = fake.posted[0]
    assert url == telemetry.PING_URL
    assert body["event"] == "heartbeat"


@pytest.mark.asyncio
async def test_offline_ping_stays_quiet(monkeypatch, home: Path, caplog) -> None:
    """No internet is the normal plant case — it must not reach the log or the caller."""
    monkeypatch.setattr(
        telemetry.httpx,
        "AsyncClient",
        _FakeClient(raises=httpx.ConnectError("no route to host")),
    )
    with caplog.at_level(logging.INFO, logger=telemetry.logger.name):
        assert await telemetry._ping("start") is False
    assert caplog.records == []


@pytest.mark.asyncio
async def test_server_error_is_swallowed(monkeypatch, home: Path) -> None:
    monkeypatch.setattr(telemetry.httpx, "AsyncClient", _FakeClient(status=500))
    assert await telemetry._ping("start") is False


# ── manager endpoints ────────────────────────────────────────────────────────


@pytest.fixture
def client(monkeypatch, home: Path) -> TestClient:
    import manager

    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
    monkeypatch.setattr(manager.telemetry, "start", lambda: None)
    with TestClient(manager.app) as tc:
        tc.post("/api/manager/auth/setup", json={"password": "secret"})
        yield tc


def test_status_is_gated_behind_the_device_admin_session(monkeypatch, home: Path) -> None:
    import manager

    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
    monkeypatch.setattr(manager.telemetry, "start", lambda: None)
    with TestClient(manager.app) as tc:
        assert tc.get("/api/system/telemetry").status_code == 401


def test_toggle_round_trip(client: TestClient) -> None:
    status = client.get("/api/system/telemetry").json()
    assert status == {
        "enabled": True,
        "envOverride": None,
        "installId": telemetry.install_id(),
    }

    off = client.put("/api/system/telemetry", json={"enabled": False})
    assert off.status_code == 200
    assert off.json()["enabled"] is False
    assert client.get("/api/system/telemetry").json()["enabled"] is False


def test_environment_pinned_setting_refuses_edits(
    monkeypatch, client: TestClient
) -> None:
    monkeypatch.setenv(telemetry.ENV_VAR, "off")
    assert client.get("/api/system/telemetry").json()["envOverride"] is False
    assert client.put("/api/system/telemetry", json={"enabled": True}).status_code == 409
