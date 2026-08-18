"""Tests for ``GET /api/system/runtime-home``.

GET returns the resolved runtime home path. The endpoint reads runtime-home
fresh on each call so monkeypatching ``runtime_home_path`` is enough — no app
rebuild between requests.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def system_client(monkeypatch, tmp_path):
    runtime_home_dir = tmp_path / "runtime-home"
    runtime_home_dir.mkdir()

    from core import runtime_home

    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: runtime_home_dir)

    from api.system_api import router as system_router
    from core.exceptions import register_exception_handlers

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(system_router)
    with TestClient(app) as c:
        yield c, runtime_home_dir


def test_get_runtime_home_returns_path(system_client):
    client, runtime_home_dir = system_client
    resp = client.get("/api/system/runtime-home")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"path": str(runtime_home_dir)}
