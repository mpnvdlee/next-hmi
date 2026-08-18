"""Tests for WebSocketManager.connect()/disconnect() and handle_message() dispatch.

These exercise the wire-boundary contracts that individual `_handle_*` unit
tests (test_websocket_validation.py, test_users.py, test_write_field_responses.py,
test_websocket_recipe.py, test_websocket_priority_recompute.py) bypass by
calling private handlers directly: the actual `connect()` snapshot/replay
sequence, `disconnect()`'s cleanup side effects, the `handle_message` string
dispatch itself, and malformed-message handling at the wire boundary.
"""

from __future__ import annotations

import asyncio
import json

from conftest import FakeDatasourceManager, FakeEngine, FakePool, FakeWebSocket
from services.websocket_manager import WebSocketManager


def _json(msg: dict) -> str:
    return json.dumps(msg)


# -- connect() -----------------------------------------------------------------


def test_connect_sends_full_replay_sequence_and_registers_client() -> None:
    ws = FakeWebSocket()
    manager = WebSocketManager()
    manager.set_datasource_manager(
        FakeDatasourceManager(
            snapshot_values={"DS:A": 1, "DS:B": 2},
            metadata={"DS:A": {"kind": "scalar", "base": "int", "array": False}},
        )
    )
    manager.set_opcua_pool(FakePool(FakeEngine(), statuses={"DS1": True, "DS2": False}))

    client_id = asyncio.run(manager.connect(ws))

    assert ws.accepted is True
    assert client_id in manager._connections
    assert manager._client_users[client_id] == {}
    assert client_id in manager._client_connected_at

    assert ws.messages[0] == {"type": "var_snapshot", "values": {}}
    assert ws.messages[1] == {
        "type": "var_metadata",
        "meta": {"DS:A": {"kind": "scalar", "base": "int", "array": False}},
    }
    assert ws.messages[2] == {"type": "var_update", "values": {"DS:A": 1, "DS:B": 2}}
    # opcua_status replay follows the pool snapshot, in the pool's own order.
    assert ws.messages[3] == {"type": "opcua_status", "datasource": "DS1", "connected": True}
    assert ws.messages[4] == {"type": "opcua_status", "datasource": "DS2", "connected": False}
    assert len(ws.messages) == 5


def test_connect_with_no_datasource_manager_or_pool_sends_minimal_snapshot() -> None:
    ws = FakeWebSocket()
    manager = WebSocketManager()

    client_id = asyncio.run(manager.connect(ws))

    assert ws.accepted is True
    assert client_id in manager._connections
    assert ws.messages == [
        {"type": "var_snapshot", "values": {}},
        {"type": "var_metadata", "meta": {}},
    ]


def test_connect_chunks_large_snapshot_into_multiple_var_update_messages() -> None:
    ws = FakeWebSocket()
    manager = WebSocketManager()
    big_snapshot = {f"DS:V{i}": i for i in range(1200)}
    manager.set_datasource_manager(FakeDatasourceManager(snapshot_values=big_snapshot))

    asyncio.run(manager.connect(ws))

    chunk_messages = [m for m in ws.messages if m["type"] == "var_update"]
    assert len(chunk_messages) == 3  # 500 + 500 + 200
    merged: dict = {}
    for m in chunk_messages:
        merged.update(m["values"])
    assert merged == big_snapshot


def test_connect_failure_mid_replay_disconnects_client_and_reraises() -> None:
    # Fail on the 3rd send (the var_update chunk), after var_snapshot + var_metadata.
    ws = FakeWebSocket(fail_after=2)
    manager = WebSocketManager()
    dm = FakeDatasourceManager(snapshot_values={"DS:A": 1})
    manager.set_datasource_manager(dm)
    manager.set_opcua_pool(FakePool(FakeEngine()))

    async def _run() -> str:
        return await manager.connect(ws)

    try:
        asyncio.run(_run())
        raised = False
    except RuntimeError:
        raised = True
    assert raised, "connect() must re-raise after cleaning up"

    # disconnect()'s full cleanup path ran: client removed and datasource-manager
    # cleanup invoked, even though the client never finished connecting.
    assert manager._connections == {}
    assert len(dm.cleared_clients) == 1


# -- disconnect() ----------------------------------------------------------------


def test_disconnect_removes_client_and_demotes_priority_keys() -> None:
    manager = WebSocketManager()
    dm = FakeDatasourceManager()
    engine = FakeEngine()
    manager.set_datasource_manager(dm)
    manager.set_opcua_pool(FakePool(engine))
    manager._connections["c1"] = FakeWebSocket()  # type: ignore[assignment]
    manager._client_users["c1"] = {"runtime": {"username": "op", "groups": ["ops"]}}
    manager._client_connected_at["c1"] = "2026-01-01T00:00:00+00:00"
    dm._client_keys = {"DS:A"}

    asyncio.run(manager.disconnect("c1"))

    assert "c1" not in manager._connections
    assert "c1" not in manager._client_users
    assert "c1" not in manager._client_connected_at
    assert dm.cleared_clients == ["c1"]
    # _apply_priority_keys("c1", set()) re-ran the priority union computation
    # and pushed it (now empty, since dm._client_keys was reset) to the engine.
    assert dm._client_keys == set()
    assert engine.priority_paths[-1] == set()


def test_disconnect_without_datasource_manager_only_removes_connection() -> None:
    manager = WebSocketManager()
    manager._connections["c1"] = FakeWebSocket()  # type: ignore[assignment]
    manager._client_users["c1"] = {}
    manager._client_connected_at["c1"] = "2026-01-01T00:00:00+00:00"

    asyncio.run(manager.disconnect("c1"))

    assert manager._connections == {}
    assert manager._client_users == {}
    assert manager._client_connected_at == {}


# -- handle_message() dispatch and malformed-message handling --------------------


def _spy(manager: WebSocketManager, name: str) -> list[tuple]:
    calls: list[tuple] = []

    async def _fake(client_id, msg, *, _calls=calls):
        _calls.append((client_id, msg))

    setattr(manager, name, _fake)
    return calls


def test_handle_message_dispatches_set_context_by_type_string() -> None:
    manager = WebSocketManager()
    calls = _spy(manager, "_handle_set_context")
    asyncio.run(manager.handle_message("c1", _json({"type": "set_context", "currentPageIds": ["p1"]})))
    assert calls == [("c1", {"type": "set_context", "currentPageIds": ["p1"]})]


def test_handle_message_dispatches_write_field_by_type_string() -> None:
    manager = WebSocketManager()
    calls = _spy(manager, "_handle_write_field")
    msg = {"type": "write_field", "datasource": "DS", "path": "P", "field": "value", "value": 1}
    asyncio.run(manager.handle_message("c1", _json(msg)))
    assert calls == [("c1", msg)]


def test_handle_message_dispatches_recipe_load_and_save_by_type_string() -> None:
    manager = WebSocketManager()
    load_calls = _spy(manager, "_handle_recipe_load")
    save_calls = _spy(manager, "_handle_recipe_save")
    asyncio.run(manager.handle_message("c1", _json({"type": "recipe_load", "datasetId": "d1"})))
    asyncio.run(manager.handle_message("c1", _json({"type": "recipe_save", "datasetId": "d1"})))
    assert load_calls == [("c1", {"type": "recipe_load", "datasetId": "d1"})]
    assert save_calls == [("c1", {"type": "recipe_save", "datasetId": "d1"})]


def test_handle_message_dispatches_login_logout_and_request_identity() -> None:
    manager = WebSocketManager()
    login_calls = _spy(manager, "_handle_login")
    logout_calls = _spy(manager, "_handle_logout")
    identity_calls = _spy(manager, "_handle_request_identity")
    asyncio.run(manager.handle_message("c1", _json({"type": "login", "username": "op", "password": "x"})))
    asyncio.run(manager.handle_message("c1", _json({"type": "logout"})))
    asyncio.run(manager.handle_message("c1", _json({"type": "request_identity"})))
    assert len(login_calls) == 1
    assert len(logout_calls) == 1
    assert len(identity_calls) == 1


def test_handle_message_ignores_unknown_type_without_error() -> None:
    manager = WebSocketManager()
    calls = _spy(manager, "_handle_write_field")
    asyncio.run(manager.handle_message("c1", _json({"type": "totally_unknown_type"})))
    assert calls == []


def test_handle_message_ignores_invalid_json_without_error() -> None:
    manager = WebSocketManager()
    calls = _spy(manager, "_handle_write_field")
    asyncio.run(manager.handle_message("c1", "{not valid json"))
    assert calls == []


def test_handle_message_rejects_oversized_message_without_dispatch() -> None:
    manager = WebSocketManager()
    calls = _spy(manager, "_handle_write_field")
    oversized = _json({"type": "write_field", "padding": "x" * (64 * 1024 + 1)})
    asyncio.run(manager.handle_message("c1", oversized))
    assert calls == []
