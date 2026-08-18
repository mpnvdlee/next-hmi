"""Tests for the alarm config and runtime state API endpoints."""
from pathlib import Path

import api.alarm_api as alarm_api_module
import core.storage as storage
import pytest
import services.alarm_manager as alarm_manager_module
from core.exceptions import register_exception_handlers
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def alarm_client(monkeypatch, live_project_root: Path):
    storage.ensure_active_project_dirs()

    # Fresh manager instance per test
    fresh_manager = alarm_manager_module.AlarmManager()
    monkeypatch.setattr(alarm_manager_module, "alarm_manager", fresh_manager)
    monkeypatch.setattr(alarm_api_module, "alarm_manager", fresh_manager)

    test_app = FastAPI()
    register_exception_handlers(test_app)
    test_app.include_router(alarm_api_module.router)
    with TestClient(test_app) as client:
        yield client


def _group_payload(title: str = "Group A") -> dict:
    return {
        "groups": [
            {
                "id": "g1",
                "title": title,
                "alarms": [],
            }
        ]
    }


# ── GET /api/alarms/config ────────────────────────────────────────────────────


def test_get_alarm_config_returns_empty_default(alarm_client):
    resp = alarm_client.get("/api/alarms/config")
    assert resp.status_code == 200
    data = resp.json()
    assert "groups" in data
    assert data["groups"] == []


# ── PUT /api/alarms/config ────────────────────────────────────────────────────


def test_put_alarm_config_persists_groups(alarm_client):
    payload = _group_payload("Pumps")
    resp = alarm_client.put("/api/alarms/config", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["groups"]) == 1
    assert data["groups"][0]["title"] == "Pumps"


def test_put_alarm_config_replaces_previous(alarm_client):
    alarm_client.put("/api/alarms/config", json=_group_payload("First"))
    resp = alarm_client.put("/api/alarms/config", json=_group_payload("Second"))
    assert resp.status_code == 200
    assert resp.json()["groups"][0]["title"] == "Second"


def test_get_alarm_config_reflects_last_put(alarm_client):
    alarm_client.put("/api/alarms/config", json=_group_payload("Motors"))
    resp = alarm_client.get("/api/alarms/config")
    assert resp.status_code == 200
    assert resp.json()["groups"][0]["title"] == "Motors"


# ── GET /api/alarms/active ────────────────────────────────────────────────────


def test_get_active_alarms_empty_initially(alarm_client):
    resp = alarm_client.get("/api/alarms/active")
    assert resp.status_code == 200
    assert resp.json() == []


# ── GET /api/alarms/history ───────────────────────────────────────────────────


def test_get_alarm_history_empty_initially(alarm_client):
    resp = alarm_client.get("/api/alarms/history")
    assert resp.status_code == 200
    assert resp.json() == []


def test_get_alarm_history_respects_limit(alarm_client):
    resp = alarm_client.get("/api/alarms/history?limit=10")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_get_alarm_history_rejects_invalid_limit(alarm_client):
    resp = alarm_client.get("/api/alarms/history?limit=0")
    assert resp.status_code == 422


# ── GET /api/alarms/summary ───────────────────────────────────────────────────


def test_get_alarm_summary_all_zero_initially(alarm_client):
    resp = alarm_client.get("/api/alarms/summary")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 0
    assert data["unacked"] == 0
    assert data["error_count"] == 0
    assert data["warning_count"] == 0
    assert data["info_count"] == 0


# ── POST /api/alarms/ack/{id} ─────────────────────────────────────────────────


def test_ack_alarm_returns_404_for_unknown_instance(alarm_client):
    resp = alarm_client.post("/api/alarms/ack/no-such-id", json={"username": "admin"})
    assert resp.status_code == 404


def test_ack_alarm_requires_username(alarm_client):
    resp = alarm_client.post("/api/alarms/ack/some-id", json={"username": ""})
    assert resp.status_code == 422
    assert "Username" in resp.json()["detail"]


# ── POST /api/alarms/ack-all ──────────────────────────────────────────────────


def test_ack_all_requires_username(alarm_client):
    resp = alarm_client.post("/api/alarms/ack-all", json={"username": ""})
    assert resp.status_code == 422


def test_ack_all_with_no_active_alarms(alarm_client):
    resp = alarm_client.post("/api/alarms/ack-all", json={"username": "operator"})
    assert resp.status_code == 200
    assert resp.json()["count"] == 0
