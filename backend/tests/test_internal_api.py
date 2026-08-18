"""Internal loopback reload hook — driven by the manager MCP, not browsers."""
from __future__ import annotations

from pathlib import Path

import pytest
from api import internal_api
from fastapi import FastAPI
from fastapi.testclient import TestClient
from services.websocket_manager import ConfigChangedEvent, websocket_manager


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(internal_api.router)
    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_app())


def test_reload_broadcasts_config_changed_event(client: TestClient, monkeypatch) -> None:
    events: list[ConfigChangedEvent] = []

    async def capture(event: ConfigChangedEvent) -> None:
        events.append(event)

    monkeypatch.setattr(websocket_manager, "broadcast_config_changed", capture)

    resp = client.post(
        "/api/internal/reload",
        json={
            "artifact_type": "pages",
            "artifact_ids": ["Main"],
            "source": "mcp",
            "summary": "renamed a widget",
            "diff": [{"op": "replace", "path": "/name", "value": "Main"}],
            "agent_label": "claude",
        },
    )

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    assert len(events) == 1
    assert events[0].artifact_type == "pages"
    assert events[0].artifact_ids == ["Main"]
    assert events[0].summary == "renamed a widget"
    assert events[0].agent_label == "claude"


def test_reload_defaults_omit_optional_fields(client: TestClient, monkeypatch) -> None:
    events: list[ConfigChangedEvent] = []

    async def capture(event: ConfigChangedEvent) -> None:
        events.append(event)

    monkeypatch.setattr(websocket_manager, "broadcast_config_changed", capture)

    resp = client.post("/api/internal/reload", json={"artifact_type": "theme"})

    assert resp.status_code == 200
    assert events[0].artifact_ids == []
    assert events[0].source == "mcp"
    assert events[0].agent_label is None


def test_reload_variables_applies_datasource_delta_before_broadcast(
    client: TestClient, monkeypatch, live_project_root: Path
) -> None:
    import core.storage as storage

    storage.ensure_active_project_dirs()
    (storage.active_datasources_dir() / "DS.json").write_text(
        '{"config": {}, "type": "opcua-client"}', encoding="utf-8"
    )

    calls: list[str] = []
    order: list[str] = []

    monkeypatch.setattr(internal_api.datasource_manager, "get", lambda name: None)
    monkeypatch.setattr(internal_api, "enabled_paths", lambda entry: set())

    async def fake_apply(name: str, after, old_enabled) -> None:
        calls.append(name)
        order.append("apply")

    monkeypatch.setattr(internal_api, "apply_datasource_change", fake_apply)

    async def broadcast(event):
        order.append("broadcast")

    monkeypatch.setattr(websocket_manager, "broadcast_config_changed", broadcast)

    resp = client.post(
        "/api/internal/reload",
        json={"artifact_type": "variables", "artifact_ids": ["DS/Tag1", "DS/Tag2"]},
    )

    assert resp.status_code == 200
    assert calls == ["DS"]  # de-duplicated distinct datasource names
    assert order == ["apply", "broadcast"]


def test_reload_non_variable_artifact_skips_datasource_reload(
    client: TestClient, monkeypatch
) -> None:
    called = False

    async def fake_reload(artifact_ids):
        nonlocal called
        called = True

    monkeypatch.setattr(internal_api, "_reload_datasources", fake_reload)

    async def no_broadcast(event) -> None:
        return None

    monkeypatch.setattr(websocket_manager, "broadcast_config_changed", no_broadcast)

    resp = client.post(
        "/api/internal/reload", json={"artifact_type": "pages", "artifact_ids": ["Main"]}
    )

    assert resp.status_code == 200
    assert called is False


@pytest.mark.asyncio
async def test_reload_datasources_skips_missing_datasource_file(
    live_project_root: Path,
) -> None:
    import core.storage as storage

    storage.ensure_active_project_dirs()
    # No DS.json written — the reload hook must not raise for a stale/unknown id.
    await internal_api._reload_datasources(["DS/Tag1"])


@pytest.mark.asyncio
async def test_reload_datasources_swallows_unreadable_json_and_warns(
    live_project_root: Path, monkeypatch, caplog
) -> None:
    import core.storage as storage

    storage.ensure_active_project_dirs()
    (storage.active_datasources_dir() / "DS.json").write_text(
        "{not-json", encoding="utf-8"
    )
    called = False

    async def fail_if_called(*args, **kwargs):
        nonlocal called
        called = True

    monkeypatch.setattr(internal_api, "apply_datasource_change", fail_if_called)

    with caplog.at_level("WARNING"):
        await internal_api._reload_datasources(["DS/Tag1"])

    assert called is False
    assert "failed to read datasource DS" in caplog.text
