"""Peer pairings: expiry after 90 days without use, throttled last-use writes,
and the dashboard's list and revoke — admin session only."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from core import manager_auth, peer_tokens, runtime_home
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def home(monkeypatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: tmp_path)
    manager_auth.set_password("destination-admin")
    peer_tokens._last_used.clear()
    return tmp_path


class _Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 11, 9, 9, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def clock(monkeypatch) -> _Clock:
    clock = _Clock()
    monkeypatch.setattr(peer_tokens, "_now", clock)
    return clock


def _stored() -> list[dict]:
    return json.loads(peer_tokens.tokens_path().read_text(encoding="utf-8"))["tokens"]


def _set_stored(**fields: str) -> None:
    data = json.loads(peer_tokens.tokens_path().read_text(encoding="utf-8"))
    data["tokens"][0].update(fields)
    peer_tokens.tokens_path().write_text(json.dumps(data), encoding="utf-8")


def _iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


def test_a_pairing_unused_for_90_days_is_refused_and_pruned(clock: _Clock) -> None:
    _, token = peer_tokens.issue()
    _set_stored(createdAt=_iso(clock.now - timedelta(days=90, minutes=1)))

    assert peer_tokens.authenticate(token) is None
    assert _stored() == []


def test_use_keeps_a_pairing_alive(clock: _Clock) -> None:
    token_id, token = peer_tokens.issue()
    _set_stored(
        createdAt=_iso(clock.now - timedelta(days=400)),
        lastUsedAt=_iso(clock.now - timedelta(days=89)),
    )

    assert peer_tokens.authenticate(token) == token_id
    [listed] = peer_tokens.list_tokens()
    assert listed["lastUsedAt"] == _iso(clock.now)
    assert listed["expiresAt"] == _iso(clock.now + timedelta(days=90))


def test_last_use_is_written_at_most_once_an_hour(monkeypatch, clock: _Clock) -> None:
    token_id, token = peer_tokens.issue()
    writes: list[str] = []
    real_save = peer_tokens._save
    monkeypatch.setattr(
        peer_tokens, "_save", lambda data: writes.append("save") or real_save(data)
    )

    for _ in range(50):
        assert peer_tokens.authenticate(token) == token_id
        clock.now += timedelta(seconds=30)
    # 25 minutes of steady use: the first use is written, the rest wait.
    assert writes == ["save"]
    first_written = _stored()[0]["lastUsedAt"]

    clock.now += timedelta(minutes=40)
    assert peer_tokens.authenticate(token) == token_id
    assert writes == ["save", "save"]
    assert _stored()[0]["lastUsedAt"] > first_written
    # What the list shows is the latest use, written or not.
    assert peer_tokens.authenticate(token) == token_id
    assert peer_tokens.list_tokens()[0]["lastUsedAt"] == _iso(clock.now)


def test_listing_prunes_expired_pairings_and_names_the_device(clock: _Clock) -> None:
    peer_tokens.issue(hostname="hmi-line4", runtime_id="rid-line4", address="192.168.1.31")
    peer_tokens.issue()
    data = json.loads(peer_tokens.tokens_path().read_text(encoding="utf-8"))
    data["tokens"][1]["createdAt"] = _iso(clock.now - timedelta(days=91))
    peer_tokens.tokens_path().write_text(json.dumps(data), encoding="utf-8")

    listed = peer_tokens.list_tokens()

    assert [(item["hostname"], item["runtimeId"], item["address"]) for item in listed] == [
        ("hmi-line4", "rid-line4", "192.168.1.31")
    ]
    assert listed[0]["lastUsedAt"] is None
    assert len(_stored()) == 1
    assert "hash" not in listed[0]


# ── through the manager app: the dashboard's list and revoke ────────────────


@pytest.fixture
def manager_client(monkeypatch, home: Path):
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home))
    import manager

    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
    with TestClient(manager.app) as client:
        yield client


def _pair(client: TestClient, **device: str) -> str:
    response = client.post(
        "/api/manager/peer/pair", json={"password": "destination-admin", **device}
    )
    assert response.status_code == 201, response.text
    return response.json()["token"]


def _sign_in(client: TestClient) -> None:
    response = client.post(
        "/api/manager/auth/login", json={"password": "destination-admin"}
    )
    assert response.status_code == 200, response.text


def test_paired_devices_are_listed_and_revoked_with_an_admin_session_only(
    manager_client: TestClient,
) -> None:
    token = _pair(manager_client, hostname="hmi-line4", runtimeId="rid-line4")
    token_id = token.split(".", 1)[0]
    bearer = {"Authorization": f"Bearer {token}"}

    assert manager_client.get("/api/manager/peer-tokens").status_code == 401
    assert manager_client.delete(f"/api/manager/peer-tokens/{token_id}").status_code == 401
    assert manager_client.get("/api/manager/peer/projects", headers=bearer).status_code == 200

    _sign_in(manager_client)
    listed = manager_client.get("/api/manager/peer-tokens")
    assert listed.status_code == 200, listed.text
    [device] = listed.json()["tokens"]
    assert device["id"] == token_id
    assert (device["hostname"], device["runtimeId"]) == ("hmi-line4", "rid-line4")
    # Where the pairing request came from; the test client's own name here.
    assert device["address"] == "testclient"
    assert device["lastUsedAt"] is not None
    assert device["expiresAt"] is not None

    revoked = manager_client.delete(f"/api/manager/peer-tokens/{token_id}")
    assert revoked.status_code == 200, revoked.text
    assert manager_client.get("/api/manager/peer/projects", headers=bearer).status_code == 401
    assert manager_client.get("/api/manager/peer-tokens").json() == {"tokens": []}


def test_a_pairing_that_names_nothing_is_still_listed(manager_client: TestClient) -> None:
    _pair(manager_client, runtimeId="not a valid runtime id!")
    _sign_in(manager_client)

    [device] = manager_client.get("/api/manager/peer-tokens").json()["tokens"]

    assert device["hostname"] is None
    assert device["runtimeId"] is None


def test_changing_the_password_still_revokes_every_pairing(manager_client: TestClient) -> None:
    token = _pair(manager_client, hostname="hmi-line4")
    _sign_in(manager_client)

    changed = manager_client.post(
        "/api/manager/auth/change-password",
        json={"currentPassword": "destination-admin", "newPassword": "rotated-admin-1"},
    )

    assert changed.status_code == 200, changed.text
    assert manager_client.get("/api/manager/peer-tokens").json() == {"tokens": []}
    assert (
        manager_client.get(
            "/api/manager/peer/projects", headers={"Authorization": f"Bearer {token}"}
        ).status_code
        == 401
    )
