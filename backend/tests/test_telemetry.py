"""Install-count ping: the id, the opt-out, the payload, and staying silent offline."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from core import runtime_home, telemetry
from fastapi.testclient import TestClient

_REAL_MARK = telemetry.mark


@pytest.fixture(autouse=True)
def home(monkeypatch, tmp_path: Path) -> Path:
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home_dir))
    # conftest switches telemetry off for every test; these ones own the setting.
    monkeypatch.delenv(telemetry.ENV_VAR, raising=False)
    monkeypatch.setattr(telemetry, "mark", _REAL_MARK)
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


def _write_project(root: Path, *, pages: int, opcua: int, tags_each: int, mcp: bool) -> None:
    (root / "pages").mkdir(parents=True)
    (root / "datasources").mkdir()
    for i in range(pages):
        (root / "pages" / f"p{i}.json").write_text("{}", encoding="utf-8")
    variables = [
        {
            "kind": "folder",
            "name": "Line",
            "children": [{"display_name": f"T{i}", "data_type": "Float"} for i in range(tags_each)],
        }
    ]
    for i in range(opcua):
        (root / "datasources" / f"plc{i}.json").write_text(
            json.dumps({"type": "opcua-client", "name": f"plc{i}", "variables": variables}),
            encoding="utf-8",
        )
    (root / "datasources" / "ui.json").write_text(
        json.dumps({"type": "static", "name": "ui", "variables": variables}), encoding="utf-8"
    )
    (root / "config.json").write_text(json.dumps({"mcpEnabled": mcp}), encoding="utf-8")


def _manifest_of(*roots: Path) -> SimpleNamespace:
    """Just the part of a manifest usage() reads."""
    return SimpleNamespace(projects=[SimpleNamespace(path=str(root)) for root in roots])


def test_payload_carries_only_what_was_agreed(home: Path) -> None:
    session = telemetry._begin_session()
    payload = telemetry._payload("heartbeat", session)
    assert set(payload) == {
        "installId",
        "version",
        "edition",
        "os",
        "osRelease",
        "python",
        "event",
        "installMethod",
        "sessionId",
        "uptimeS",
        "connected",
        "pageSaved",
        "mcpUsed",
        "opcuaConns",
        "tags",
        "pages",
        "mcpEnabled",
    }
    assert payload["installId"] == telemetry.install_id()
    assert payload["edition"] in {"oss", "ee"}
    assert payload["event"] == "heartbeat"
    assert payload["sessionId"] == session["sessionId"]
    assert payload["installMethod"] in {"bundle", "source", "docker", "other"}


def test_start_also_says_how_the_last_session_ended(home: Path) -> None:
    payload = telemetry._payload("start", telemetry._begin_session())
    assert payload["prevExit"] == "none"
    assert payload["prevVersion"] == ""


@pytest.mark.parametrize(
    ("count", "expected"), [(0, "0"), (1, "1-10"), (10, "1-10"), (11, "11-100"), (101, "100+")]
)
def test_size_classes(count: int, expected: str) -> None:
    assert telemetry.size_class(count) == expected


def test_usage_counts_across_projects_without_naming_anything(monkeypatch, home: Path) -> None:
    a, b = home / "a", home / "b"
    _write_project(a, pages=3, opcua=1, tags_each=6, mcp=False)
    _write_project(b, pages=9, opcua=0, tags_each=2, mcp=True)
    monkeypatch.setattr(telemetry, "load_manifest", lambda: _manifest_of(a, b))

    # 12 pages; one OPC-UA client (the static source does not count); 6+6+2+2 tags.
    assert telemetry.usage() == {
        "opcuaConns": "1-10",
        "tags": "11-100",
        "pages": "11-100",
        "mcpEnabled": True,
    }


def test_usage_survives_a_malformed_project(monkeypatch, home: Path) -> None:
    broken = home / "broken"
    (broken / "datasources").mkdir(parents=True)
    # A folder without a name: flatten_with_paths raises on it.
    (broken / "datasources" / "x.json").write_text(
        json.dumps({"type": "opcua-client", "variables": [{"kind": "folder"}]}), encoding="utf-8"
    )
    monkeypatch.setattr(telemetry, "load_manifest", lambda: _manifest_of(broken))
    assert telemetry.usage()["tags"] == "0"


# ── sessions ─────────────────────────────────────────────────────────────────


def test_a_session_that_never_stopped_reads_as_unclean(home: Path) -> None:
    telemetry._begin_session()
    assert telemetry._begin_session()["prevExit"] == "unclean"


def test_a_stopped_session_reads_as_clean(home: Path) -> None:
    telemetry._end_session(telemetry._begin_session())
    assert telemetry._begin_session()["prevExit"] == "clean"


def test_an_old_session_cannot_close_the_current_one(home: Path) -> None:
    old = telemetry._begin_session()
    telemetry._begin_session()
    telemetry._end_session(old)
    assert telemetry._begin_session()["prevExit"] == "unclean"


def test_prev_version_only_when_it_changed(monkeypatch, home: Path) -> None:
    monkeypatch.setattr(telemetry, "app_version", lambda: "1.0.0")
    telemetry._begin_session()
    assert telemetry._begin_session()["prevVersion"] == ""
    monkeypatch.setattr(telemetry, "app_version", lambda: "1.1.0")
    assert telemetry._begin_session()["prevVersion"] == "1.0.0"


# ── milestones and the contact prompt ────────────────────────────────────────


def test_milestones_are_sticky(home: Path) -> None:
    assert telemetry.milestones() == {"connected": False, "pageSaved": False, "mcpUsed": False}
    telemetry.mark("connected")
    telemetry.mark("connected")
    assert telemetry.milestones() == {"connected": True, "pageSaved": False, "mcpUsed": False}


def test_contact_prompt_waits_for_real_use_and_stays_dismissed(home: Path) -> None:
    assert telemetry.status()["contactPrompt"] is False
    telemetry.mark("connected")
    assert telemetry.status()["contactPrompt"] is False
    telemetry.mark("pageSaved")
    assert telemetry.status()["contactPrompt"] is True

    telemetry.dismiss_contact_prompt()
    assert telemetry.status()["contactPrompt"] is False
    # Flipping the reporting switch must not bring the question back.
    telemetry.set_enabled(False)
    telemetry.set_enabled(True)
    assert telemetry.status()["contactPrompt"] is False


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

    assert await telemetry._ping("heartbeat", telemetry._begin_session()) is True
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
        assert await telemetry._ping("start", telemetry._begin_session()) is False
    assert caplog.records == []


@pytest.mark.asyncio
async def test_server_error_is_swallowed(monkeypatch, home: Path) -> None:
    monkeypatch.setattr(telemetry.httpx, "AsyncClient", _FakeClient(status=500))
    assert await telemetry._ping("start", telemetry._begin_session()) is False


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
        "contactPrompt": False,
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


def test_dismissing_the_prompt_works_under_the_env_pin(monkeypatch, client: TestClient) -> None:
    telemetry.mark("connected")
    telemetry.mark("pageSaved")
    monkeypatch.setenv(telemetry.ENV_VAR, "off")
    assert client.get("/api/system/telemetry").json()["contactPrompt"] is True

    dismissed = client.delete("/api/system/telemetry/contact-prompt")
    assert dismissed.status_code == 200
    assert dismissed.json()["contactPrompt"] is False
