"""REST writes broadcast ``config_changed`` so open runtimes and editor tabs update."""
from __future__ import annotations

import pytest
from api import (
    alarm_api,
    change_broadcast,
    component_api,
    config_api,
    datasource_api,
    historian_api,
    recipe_api,
    theme_api,
    users_api,
)
from core.exceptions import ConfigValidationError, register_exception_handlers
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from services.websocket_manager import websocket_manager

# Every REST write that changes project content, and the kind it reports.
CONTENT_WRITES = [
    (config_api, "PUT", "/api/config/config", "page"),
    (config_api, "DELETE", "/api/config/pages/{page_id}", "page"),
    (config_api, "DELETE", "/api/config/dialogs/{page_id}", "page"),
    (config_api, "PUT", "/api/config/http-origins", "http_origins"),
    (config_api, "POST", "/api/config/dictionaries", "translations"),
    (config_api, "DELETE", "/api/config/dictionaries/{name}", "translations"),
    (config_api, "POST", "/api/config/translations", "translations"),
    (config_api, "PUT", "/api/config/translations", "translations"),
    (config_api, "POST", "/api/config/translations/language", "translations"),
    (config_api, "DELETE", "/api/config/translations/language/{code}", "translations"),
    (config_api, "DELETE", "/api/config/translations/{key:path}", "translations"),
    (theme_api, "PUT", "/api/default-theme", "theme"),
    (theme_api, "POST", "/api/themes", "theme"),
    (theme_api, "PUT", "/api/themes/{theme_id}", "theme"),
    (theme_api, "DELETE", "/api/themes/{theme_id}", "theme"),
    (component_api, "POST", "/api/components", "component"),
    (component_api, "PUT", "/api/components/{component_id}", "component"),
    (component_api, "DELETE", "/api/components/{component_id}", "component"),
    (component_api, "POST", "/api/components/folders", "component"),
    (component_api, "DELETE", "/api/components/folders/{folder_path:path}", "component"),
    (alarm_api, "PUT", "/api/alarms/config", "alarms"),
    (recipe_api, "PUT", "/api/recipes/config", "recipes"),
    (recipe_api, "POST", "/api/recipes/datasets/{dataset_id}/upload", "recipes"),
    (historian_api, "PUT", "/api/historian/config", "historian"),
    (datasource_api, "PUT", "/api/datasources/{name}", "datasource"),
    (datasource_api, "DELETE", "/api/datasources/{name}", "datasource"),
    (datasource_api, "PUT", "/api/datasources/{name}/variables", "variables"),
    (users_api, "PUT", "/api/users", "users"),
    (users_api, "PUT", "/api/users/users", "users"),
    (users_api, "DELETE", "/api/users/users/{user_id}", "users"),
    (users_api, "PUT", "/api/users/groups", "users"),
    (users_api, "DELETE", "/api/users/groups/{group_id}", "users"),
    (users_api, "PUT", "/api/users/settings", "users"),
]


def _broadcast_kinds(module, method: str, path: str) -> list[str]:
    for route in module.router.routes:
        if route.path == path and method in route.methods:
            return [
                dep.call.artifact_type
                for dep in route.dependant.dependencies
                if hasattr(dep.call, "artifact_type")
            ]
    raise AssertionError(f"no route {method} {path}")


@pytest.mark.parametrize(("module", "method", "path", "kind"), CONTENT_WRITES)
def test_every_content_write_broadcasts(module, method, path, kind) -> None:
    assert _broadcast_kinds(module, method, path) == [kind]


@pytest.mark.parametrize(
    ("module", "method", "path"),
    [
        (config_api, "POST", "/api/config/validate"),
        (theme_api, "POST", "/api/themes/{theme_id}/validate"),
        (recipe_api, "POST", "/api/recipes/datasets/{dataset_id}/download"),
        (datasource_api, "POST", "/api/datasources/write"),
    ],
)
def test_a_route_that_changes_no_content_stays_quiet(module, method, path) -> None:
    assert _broadcast_kinds(module, method, path) == []


@pytest.fixture
def events(monkeypatch) -> list:
    captured: list = []

    async def capture(event) -> None:
        captured.append(event)

    monkeypatch.setattr(websocket_manager, "broadcast_config_changed", capture)
    return captured


def _client() -> TestClient:
    router = APIRouter(dependencies=[change_broadcast.broadcasts("theme")])

    @router.get("/things/{thing_id}")
    def read(thing_id: str) -> dict:
        return {}

    @router.put("/things/{thing_id}")
    def write(thing_id: str, fail: bool = False) -> dict:
        if fail:
            raise ConfigValidationError("refused")
        return {}

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(router)
    return TestClient(app)


def test_a_write_names_the_tab_that_made_it(events) -> None:
    _client().put("/things/dark", headers={"X-NextHMI-Tab": "0f1e-tab"})

    assert len(events) == 1
    assert events[0].artifact_type == "theme"
    assert events[0].artifact_ids == ["dark"]
    assert events[0].source == "rest"
    assert events[0].tab_id == "0f1e-tab"
    assert events[0].summary == "PUT /things/dark"


def test_reads_refusals_and_odd_tab_ids(events) -> None:
    client = _client()
    client.get("/things/dark")
    assert client.put("/things/dark?fail=true").status_code == 422
    assert events == []

    client.put("/things/dark", headers={"X-NextHMI-Tab": "<script>"})
    client.put("/things/dark")
    assert [e.tab_id for e in events] == [None, None]
