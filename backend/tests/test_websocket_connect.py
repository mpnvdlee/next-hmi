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

import pytest
import services.websocket_manager as websocket_manager_module
from conftest import FakeDatasourceManager, FakeEngine, FakePool, FakeWebSocket
from fastapi import WebSocketDisconnect
from services.websocket_manager import _BOOT_ID, WebSocketManager


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

    assert ws.messages[0] == {"type": "var_snapshot", "values": {}, "bootId": _BOOT_ID}
    # No metadata or value snapshot: both follow the client's set_context.
    # opcua_status replay follows the pool snapshot, in the pool's own order.
    assert ws.messages[1] == {"type": "opcua_status", "datasource": "DS1", "connected": True}
    assert ws.messages[2] == {"type": "opcua_status", "datasource": "DS2", "connected": False}
    assert len(ws.messages) == 3


def test_connect_with_no_datasource_manager_or_pool_sends_minimal_snapshot() -> None:
    ws = FakeWebSocket()
    manager = WebSocketManager()

    client_id = asyncio.run(manager.connect(ws))

    assert ws.accepted is True
    assert client_id in manager._connections
    assert ws.messages == [{"type": "var_snapshot", "values": {}, "bootId": _BOOT_ID}]


def test_connect_sends_no_values_however_large_the_cache() -> None:
    """A client holds only what its pages bind, so a 100k-variable cache must
    not be streamed to every socket that opens."""
    ws = FakeWebSocket()
    manager = WebSocketManager()
    big_snapshot = {f"DS:V{i}": i for i in range(1200)}
    manager.set_datasource_manager(FakeDatasourceManager(snapshot_values=big_snapshot))

    asyncio.run(manager.connect(ws))

    assert [m for m in ws.messages if m["type"] == "var_update"] == []


def test_connect_failure_mid_replay_disconnects_client_and_reraises() -> None:
    # Fail on the very first send (var_snapshot).
    ws = FakeWebSocket(fail_after=0)
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


# -- _broadcast_values() ---------------------------------------------------------


def test_broadcast_values_sends_each_client_only_its_context_keys() -> None:
    manager = WebSocketManager()
    page_a, page_b, idle = FakeWebSocket(), FakeWebSocket(), FakeWebSocket()
    manager._connections = {"a": page_a, "b": page_b, "idle": idle}  # type: ignore[assignment]
    manager._client_keys = {"a": {"DS:A", "DS:Shared"}, "b": {"DS:B"}}

    asyncio.run(manager._broadcast_values({"DS:A": 1, "DS:B": 2, "DS:C": 3}))

    assert page_a.messages == [{"type": "var_update", "values": {"DS:A": 1}}]
    assert page_b.messages == [{"type": "var_update", "values": {"DS:B": 2}}]
    assert idle.messages == []


def test_delivery_keys_add_recipe_parameters_and_whole_array_elements() -> None:
    """What a client receives is decided once per set_context: its promoted
    keys, every recipe parameter, and the elements of an array it binds whole."""
    from services.datasource_manager import DatasourceEntry, DatasourceManager

    class _Recipes:
        def get_parameter_paths_by_datasource(self) -> dict[str, set[str]]:
            return {"DS": {"Setpoint"}}

    def element(i: int) -> dict:
        return {"kind": "folder", "name": f"[{i}]", "children": [
            {"kind": "variable", "display_name": "Speed", "node_id": f"ns=2;s=M{i}", "data_type": "Float", "enabled": True},
        ]}

    dm = DatasourceManager()
    dm.datasources["DS"] = DatasourceEntry({"name": "DS", "type": "opcua-client", "variables": [
        {"kind": "folder", "name": "Motors", "is_array": True, "children": [element(0), element(1)]},
    ]})
    manager = WebSocketManager()
    manager.set_datasource_manager(dm)
    manager.set_recipe_manager(_Recipes())

    assert manager._delivery_keys({"DS:Motors", "DS:Plain"}) == {
        "DS:Motors", "DS:Motors/[0]", "DS:Motors/[1]", "DS:Plain", "DS:Setpoint",
    }
    # An element promoted on its own brings no siblings.
    assert manager._delivery_keys({"DS:Motors/[1]"}) == {"DS:Motors/[1]", "DS:Setpoint"}


def test_broadcast_values_shares_one_frame_between_clients_on_the_same_page() -> None:
    manager = WebSocketManager()
    a, b = FakeWebSocket(), FakeWebSocket()
    manager._connections = {"a": a, "b": b}  # type: ignore[assignment]
    manager._client_keys = {"a": {"DS:A"}, "b": {"DS:A"}}

    asyncio.run(manager._broadcast_values({"DS:A": 1, "DS:B": 2}))

    assert a.messages == b.messages == [{"type": "var_update", "values": {"DS:A": 1}}]
    assert manager._client_bytes["a"] == manager._client_bytes["b"] > 0


def test_a_runtime_socket_over_the_cap_is_closed_try_again_later(monkeypatch) -> None:
    """Each socket holds state and can resubscribe and read the PLC; with no
    ceiling, any number of anonymous sockets could be opened at once."""
    monkeypatch.setattr(websocket_manager_module, "_MAX_RUNTIME_CONNECTIONS", 2)
    manager = WebSocketManager()

    async def _run() -> None:
        first = await manager.connect(FakeWebSocket())
        await manager.connect(FakeWebSocket())
        refused = FakeWebSocket()
        with pytest.raises(WebSocketDisconnect):
            await manager.connect(refused)
        assert refused.closed == (1013, "Too many open connections to this project")
        assert refused.messages == []
        # The device admin's editor is never refused for the runtime's crowd.
        await manager.connect(FakeWebSocket(), editor=True)
        await manager.disconnect(first)
        await manager.connect(FakeWebSocket())

    asyncio.run(_run())

    assert len(manager._connections) == 3


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

    async def _run() -> None:
        await manager.disconnect("c1")
        # The recompute is scheduled, not awaited, so a slow engine never
        # delays the socket cleanup; wait for it here.
        await manager._priority_recompute_task

    asyncio.run(_run())

    assert "c1" not in manager._connections
    assert "c1" not in manager._client_users
    assert "c1" not in manager._client_connected_at
    assert dm.cleared_clients == ["c1"]
    # The disconnect scheduled the priority union computation, which pushed
    # it (now empty, since dm._client_keys was reset) to the engine.
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
