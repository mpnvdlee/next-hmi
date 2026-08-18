"""Tests for the recipe_load / recipe_save WebSocket handlers."""

from __future__ import annotations

import asyncio
from typing import Any

from conftest import FakeWebSocket
from models.recipe import DownloadResult, LoadedDataset
from services.websocket_manager import WebSocketManager


class FakeRecipeManager:
    def __init__(self) -> None:
        self.downloaded: list[tuple[str, bool]] = []
        self.permission_checks: list[Any] = []
        self.uploaded: list[tuple[str, str]] = []
        self.state: dict[str, LoadedDataset] = {}
        self.download_result: DownloadResult | None = DownloadResult(
            result="success", datasetId="d1", written=1, total=1,
        )
        self.upload_result: Any = object()  # non-None → success

    async def download(self, dataset_id: str, *, verify: bool = False, permission_check=None):
        self.downloaded.append((dataset_id, verify))
        self.permission_checks.append(permission_check)
        return self.download_result

    async def upload_into(self, dataset_id: str, *, username: str = ""):
        self.uploaded.append((dataset_id, username))
        return self.upload_result

    def get_state(self) -> dict[str, LoadedDataset]:
        return self.state


def _make_manager(rm: FakeRecipeManager | None) -> tuple[WebSocketManager, FakeWebSocket]:
    ws = FakeWebSocket()
    manager = WebSocketManager()
    manager.set_recipe_manager(rm)
    manager._connections["c1"] = ws  # type: ignore[attr-defined]
    manager._client_users["c1"] = {"runtime": {"username": "op", "groups": ["ops"]}}
    return manager, ws


def test_recipe_load_success_emits_response():
    rm = FakeRecipeManager()
    manager, ws = _make_manager(rm)
    asyncio.run(manager.handle_message("c1", _json({
        "type": "recipe_load", "datasetId": "d1", "verify": True, "requestId": "r1",
    })))
    assert rm.downloaded == [("d1", True)]
    # The handler forwards a permission_check so recipe downloads honour the
    # same per-variable write ACL as direct client writes.
    assert callable(rm.permission_checks[-1])
    assert ws.messages[-1]["type"] == "recipe_response"
    assert ws.messages[-1]["requestId"] == "r1"
    assert ws.messages[-1]["result"]["result"] == "success"


def test_recipe_load_unknown_dataset_emits_error():
    rm = FakeRecipeManager()
    rm.download_result = None
    manager, ws = _make_manager(rm)
    asyncio.run(manager.handle_message("c1", _json({
        "type": "recipe_load", "datasetId": "ghost", "requestId": "r2",
    })))
    assert ws.messages[-1]["type"] == "recipe_error"
    assert ws.messages[-1]["reason"] == "not_found"


def test_recipe_load_missing_id_bad_request():
    rm = FakeRecipeManager()
    manager, ws = _make_manager(rm)
    asyncio.run(manager.handle_message("c1", _json({
        "type": "recipe_load", "requestId": "r3",
    })))
    assert ws.messages[-1]["type"] == "recipe_error"
    assert ws.messages[-1]["reason"] == "bad_request"


def test_recipe_load_no_request_id_no_reply():
    rm = FakeRecipeManager()
    manager, ws = _make_manager(rm)
    asyncio.run(manager.handle_message("c1", _json({
        "type": "recipe_load", "datasetId": "d1",
    })))
    assert rm.downloaded == [("d1", False)]
    assert ws.messages == []  # fire-and-forget, no reply


def test_recipe_save_uses_username_from_scope():
    rm = FakeRecipeManager()
    manager, ws = _make_manager(rm)
    asyncio.run(manager.handle_message("c1", _json({
        "type": "recipe_save", "datasetId": "d1", "scope": "runtime", "requestId": "r4",
    })))
    assert rm.uploaded == [("d1", "op")]
    assert ws.messages[-1]["type"] == "recipe_response"


def test_recipe_save_omitted_id_uses_single_loaded():
    rm = FakeRecipeManager()
    rm.state = {"coffee": LoadedDataset(datasetId="d9", loadedAt="now")}
    manager, _ws = _make_manager(rm)
    asyncio.run(manager.handle_message("c1", _json({
        "type": "recipe_save", "requestId": "r5",
    })))
    assert rm.uploaded == [("d9", "")]


def test_recipe_save_omitted_id_ambiguous_target():
    rm = FakeRecipeManager()
    rm.state = {
        "coffee": LoadedDataset(datasetId="d1", loadedAt="now"),
        "tea": LoadedDataset(datasetId="d2", loadedAt="now"),
    }
    manager, ws = _make_manager(rm)
    asyncio.run(manager.handle_message("c1", _json({
        "type": "recipe_save", "requestId": "r6",
    })))
    assert ws.messages[-1]["type"] == "recipe_error"
    assert ws.messages[-1]["reason"] == "ambiguous_target"


def test_recipe_save_omitted_id_none_loaded():
    rm = FakeRecipeManager()  # empty state → nothing loaded
    manager, ws = _make_manager(rm)
    asyncio.run(manager.handle_message("c1", _json({
        "type": "recipe_save", "requestId": "r7",
    })))
    assert ws.messages[-1]["type"] == "recipe_error"
    assert ws.messages[-1]["reason"] == "no_loaded_dataset"


def _json(payload: dict) -> str:
    import json
    return json.dumps(payload)
