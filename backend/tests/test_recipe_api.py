"""Tests for the recipe config / state / download / upload API endpoints."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import api.recipe_api as recipe_api_module
import core.storage as storage
import pytest
import services.recipe_manager as recipe_manager_module
from core.exceptions import register_exception_handlers
from fastapi import FastAPI
from fastapi.testclient import TestClient
from models.datasource import build_var_key
from services.recipe_manager import RecipeManager


@dataclass
class FakeEntry:
    ds_type: str = "static"
    cache: dict[str, Any] = field(default_factory=dict)


class FakeStaticDM:
    def __init__(self, registry: dict[str, dict[str, Any]]):
        self._registry = registry
        self._entry = FakeEntry(ds_type="static")

    def get_entry(self, ds_name, path):
        return self._registry.get(path)

    def get(self, name):
        return self._entry

    def update_static_value(self, ds_name, path, value):
        self._entry.cache[build_var_key(ds_name, path)] = value

    def get_cached_values(self, keys):
        return {k: self._entry.cache[k] for k in keys if k in self._entry.cache}


def _config() -> dict:
    return {
        "version": 1,
        "datasetTypes": [{
            "id": "coffee", "name": "Coffee",
            "parameters": [{"id": "temp", "label": "Temp",
                            "binding": {"$var": {"path": "DS:Temp"}}, "dataType": "float"}],
            "datasets": [{"id": "espresso", "name": "Espresso", "values": {"temp": 92.0}}],
        }],
    }


@pytest.fixture()
def recipe_client(monkeypatch, live_project_root: Path):
    storage.ensure_active_project_dirs()
    fresh = RecipeManager()
    dm = FakeStaticDM({"Temp": {"data_type": "float", "enabled": True, "writable": True}})
    fresh.set_datasource_manager(dm)
    monkeypatch.setattr(recipe_manager_module, "recipe_manager", fresh)
    monkeypatch.setattr(recipe_api_module, "recipe_manager", fresh)

    # Stub the priority recompute so the async PUT handler doesn't touch OPC-UA.
    class _WS:
        async def recompute_priority_subscriptions(self):
            return None
    monkeypatch.setattr(recipe_api_module, "websocket_manager", _WS())

    test_app = FastAPI()
    register_exception_handlers(test_app)
    test_app.include_router(recipe_api_module.router)
    with TestClient(test_app) as client:
        client.dm = dm
        yield client


def test_get_empty_config(recipe_client):
    r = recipe_client.get("/api/recipes/config")
    assert r.status_code == 200
    assert r.json() == {"version": 1, "datasetTypes": []}


def test_put_get_config_round_trip(recipe_client):
    r = recipe_client.put("/api/recipes/config", json=_config())
    assert r.status_code == 200
    body = r.json()
    assert body["datasetTypes"][0]["name"] == "Coffee"
    assert body["datasetTypes"][0]["parameters"][0]["dataType"] == "float"

    r2 = recipe_client.get("/api/recipes/config")
    assert r2.json()["datasetTypes"][0]["datasets"][0]["values"] == {"temp": 92.0}


def test_state_endpoint(recipe_client):
    recipe_client.put("/api/recipes/config", json=_config())
    r = recipe_client.get("/api/recipes/state")
    assert r.status_code == 200
    assert r.json() == {"loaded": {}}


def test_download_endpoint(recipe_client):
    recipe_client.put("/api/recipes/config", json=_config())
    r = recipe_client.post("/api/recipes/datasets/espresso/download", json={"verify": True})
    assert r.status_code == 200
    body = r.json()
    assert body["result"] == "success"
    assert body["verified"] is True
    # State now reflects the loaded dataset
    state = recipe_client.get("/api/recipes/state").json()
    assert state["loaded"]["coffee"]["datasetId"] == "espresso"


@pytest.mark.parametrize(
    ("headers", "expected"),
    [
        ({}, ("guest", "anonymous")),
        ({"x-nexthmi-editor": "1"}, ("engineer", "device_admin")),
    ],
)
def test_download_endpoint_audits_the_load(recipe_client, headers, expected):
    """The SDK's recipeDownload takes this route; its writes are audited too."""
    from core import audit

    recipe_client.put("/api/recipes/config", json=_config())
    seen: list = []
    audit.register_listener(seen.append)
    try:
        recipe_client.post("/api/recipes/datasets/espresso/download", json={}, headers=headers)
    finally:
        audit.unregister_listener(seen.append)

    assert [(e.actor, e.actor_source, e.action, e.subject) for e in seen] == [
        (*expected, "recipe.load", "espresso")
    ]


def test_download_unknown_dataset_404(recipe_client):
    recipe_client.put("/api/recipes/config", json=_config())
    r = recipe_client.post("/api/recipes/datasets/nope/download", json={})
    assert r.status_code == 404


def test_upload_endpoint(recipe_client):
    recipe_client.put("/api/recipes/config", json=_config())
    r = recipe_client.post("/api/recipes/datasets/espresso/upload")
    assert r.status_code == 200
    # Temp not in cache → read returns None, overwriting stored value
    values = r.json()["datasetTypes"][0]["datasets"][0]["values"]
    assert "temp" in values


# ── Attribution on the REST upload path ───────────────────────────────────────


def test_rest_upload_attributes_the_authenticated_caller(recipe_client, monkeypatch):
    """Project credentials on the request name who saved the dataset."""

    async def authenticate(username, password):
        if (username, password) == ("boss", "secret"):
            return {"username": username, "groups": ["admin"]}, {}
        return None

    monkeypatch.setattr(recipe_api_module.users_manager, "authenticate", authenticate)
    recipe_client.put("/api/recipes/config", json=_config())
    recipe_client.dm.update_static_value("DS", "Temp", 150.0)

    r = recipe_client.post(
        "/api/recipes/datasets/espresso/upload", auth=("boss", "secret")
    )

    assert r.status_code == 200
    dataset = r.json()["datasetTypes"][0]["datasets"][0]
    assert dataset["values"]["temp"] == 150.0
    assert dataset["updatedBy"] == "boss"


def test_rest_upload_through_the_editor_is_the_engineer_s(recipe_client):
    recipe_client.put("/api/recipes/config", json=_config())

    r = recipe_client.post(
        "/api/recipes/datasets/espresso/upload", headers={"x-nexthmi-editor": "1"}
    )

    assert r.json()["datasetTypes"][0]["datasets"][0]["updatedBy"] == "engineer"


def test_rest_upload_rejects_invalid_credentials(recipe_client, monkeypatch):
    """Credentials that do not authenticate are refused, not downgraded to guest."""

    async def authenticate(username, password):
        return None

    monkeypatch.setattr(recipe_api_module.users_manager, "authenticate", authenticate)
    recipe_client.put("/api/recipes/config", json=_config())

    r = recipe_client.post(
        "/api/recipes/datasets/espresso/upload", auth=("boss", "wrong")
    )

    assert r.status_code == 401
    assert r.json()["detail"] == "invalid_credentials"
