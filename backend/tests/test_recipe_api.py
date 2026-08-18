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
    fresh.set_datasource_manager(FakeStaticDM({"Temp": {"data_type": "float"}}))
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
