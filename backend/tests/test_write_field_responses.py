"""Tests for write_response / write_error emission from _handle_write_field.

Every termination path in _handle_write_field must emit one of:
  - write_response  on success
  - write_error     on failure (with a reason code from the documented vocab)

Requests without `requestId` must produce *no* response — preserving the old
fire-and-forget behaviour for clients that haven't opted into result handling.
"""

import asyncio
from typing import Any

from conftest import (
    FakeDatasourceEntry,
    FakeDatasourceManager,
    FakeEngine,
    FakePool,
    FakeWebSocket,
)
from services.websocket_manager import WebSocketManager


def _msg(**extra: Any) -> dict[str, Any]:
    base = {
        "type": "write_field",
        "datasource": "DS",
        "path": "Tag",
        "field": "fValue",
        "value": 1,
        "scope": "runtime:tab1:inst1",
        "requestId": "req-1",
    }
    base.update(extra)
    return base


def _run_write(manager: WebSocketManager, msg: dict[str, Any]) -> None:
    asyncio.run(manager._handle_write_field("c1", msg))


def _make_manager(
    ws: FakeWebSocket,
    *,
    ds_entry: FakeDatasourceEntry | None,
    engine: FakeEngine | None = None,
) -> WebSocketManager:
    manager = WebSocketManager()
    datasources = {"DS": ds_entry} if ds_entry is not None else {}
    manager.set_datasource_manager(FakeDatasourceManager(datasources=datasources))
    manager.set_opcua_pool(FakePool(engine))
    manager._connections["c1"] = ws  # type: ignore[attr-defined]
    manager._client_users["c1"] = {}
    return manager


# ── Success paths ────────────────────────────────────────────────────────────


def test_static_write_emits_write_response() -> None:
    ws = FakeWebSocket()
    ds_entry = FakeDatasourceEntry(ds_type="static", registry={"Tag": {"data_type": "int32"}})
    manager = _make_manager(ws, ds_entry=ds_entry)

    _run_write(manager, _msg())

    assert ws.messages == [
        {"type": "write_response", "requestId": "req-1", "datasource": "DS", "path": "Tag"},
    ]


def test_opcua_write_success_emits_write_response() -> None:
    ws = FakeWebSocket()
    ds_entry = FakeDatasourceEntry(
        ds_type="opcua-client",
        registry={"Tag": {"data_type": "int32", "node_id": "ns=2;s=Tag"}},
    )
    engine = FakeEngine()
    manager = _make_manager(ws, ds_entry=ds_entry, engine=engine)

    _run_write(manager, _msg())

    assert engine.write_calls == [("ns=2;s=Tag", 1)]
    assert ws.messages == [
        {"type": "write_response", "requestId": "req-1", "datasource": "DS", "path": "Tag"},
    ]


# ── Failure paths — every reason code ────────────────────────────────────────


def test_bad_request_when_value_missing() -> None:
    ws = FakeWebSocket()
    manager = _make_manager(ws, ds_entry=None)

    msg = _msg()
    del msg["value"]
    _run_write(manager, msg)

    assert ws.messages == [
        {
            "type": "write_error",
            "requestId": "req-1",
            "datasource": "DS",
            "path": "Tag",
            "reason": "bad_request",
        },
    ]


def test_bad_path_when_entry_unknown() -> None:
    ws = FakeWebSocket()
    manager = _make_manager(ws, ds_entry=None)

    _run_write(manager, _msg())

    assert ws.messages == [
        {
            "type": "write_error",
            "requestId": "req-1",
            "datasource": "DS",
            "path": "Tag",
            "reason": "bad_path",
        },
    ]


def test_permission_denied_when_group_mismatch() -> None:
    ws = FakeWebSocket()
    ds_entry = FakeDatasourceEntry(
        ds_type="static",
        registry={"Tag": {"data_type": "int32", "interactableByGroups": ["engineer"]}},
    )
    manager = _make_manager(ws, ds_entry=ds_entry)
    # client identity carries only "guest", not "engineer"
    manager._client_users["c1"] = {  # type: ignore[attr-defined]
        "runtime:tab1:inst1": {"username": "guest", "groups": ["guest"]}
    }

    _run_write(manager, _msg())

    assert ws.messages == [
        {
            "type": "write_error",
            "requestId": "req-1",
            "datasource": "DS",
            "path": "Tag",
            "reason": "permission_denied",
        },
    ]


def test_invalid_value_when_coercion_fails() -> None:
    ws = FakeWebSocket()
    ds_entry = FakeDatasourceEntry(ds_type="static", registry={"Tag": {"data_type": "int32"}})
    manager = _make_manager(ws, ds_entry=ds_entry)

    _run_write(manager, _msg(value="not-a-number"))

    assert ws.messages == [
        {
            "type": "write_error",
            "requestId": "req-1",
            "datasource": "DS",
            "path": "Tag",
            "reason": "invalid_value",
        },
    ]


def test_present_null_is_invalid_value_not_bad_request() -> None:
    ws = FakeWebSocket()
    ds_entry = FakeDatasourceEntry(ds_type="static", registry={"Tag": {"data_type": "int32"}})
    manager = _make_manager(ws, ds_entry=ds_entry)
    _run_write(manager, _msg(value=None))
    assert ws.messages[0]["reason"] == "invalid_value"


def test_bad_field_when_node_id_unresolvable() -> None:
    ws = FakeWebSocket()
    # OPC-UA path but no node_id and no matching field → _resolve_node_id returns None
    ds_entry = FakeDatasourceEntry(
        ds_type="opcua-client",
        registry={"Tag": {"data_type": "int32", "fields": {}}},
    )
    manager = _make_manager(ws, ds_entry=ds_entry, engine=FakeEngine())

    _run_write(manager, _msg())

    assert ws.messages == [
        {
            "type": "write_error",
            "requestId": "req-1",
            "datasource": "DS",
            "path": "Tag",
            "reason": "bad_field",
        },
    ]


def test_opcua_unreachable_when_engine_missing() -> None:
    ws = FakeWebSocket()
    ds_entry = FakeDatasourceEntry(
        ds_type="opcua-client",
        registry={"Tag": {"data_type": "int32", "node_id": "ns=2;s=Tag"}},
    )
    # pool returns no engine
    manager = _make_manager(ws, ds_entry=ds_entry, engine=None)

    _run_write(manager, _msg())

    assert ws.messages == [
        {
            "type": "write_error",
            "requestId": "req-1",
            "datasource": "DS",
            "path": "Tag",
            "reason": "opcua_unreachable",
        },
    ]


def test_write_failed_when_engine_raises() -> None:
    ws = FakeWebSocket()
    ds_entry = FakeDatasourceEntry(
        ds_type="opcua-client",
        registry={"Tag": {"data_type": "int32", "node_id": "ns=2;s=Tag"}},
    )
    manager = _make_manager(ws, ds_entry=ds_entry, engine=FakeEngine(raises=True))

    _run_write(manager, _msg())

    assert ws.messages == [
        {
            "type": "write_error",
            "requestId": "req-1",
            "datasource": "DS",
            "path": "Tag",
            "reason": "write_failed",
        },
    ]


# ── No requestId → no response emitted ───────────────────────────────────────


def test_no_request_id_means_silent_success() -> None:
    ws = FakeWebSocket()
    ds_entry = FakeDatasourceEntry(ds_type="static", registry={"Tag": {"data_type": "int32"}})
    manager = _make_manager(ws, ds_entry=ds_entry)

    msg = _msg()
    del msg["requestId"]
    _run_write(manager, msg)

    assert ws.messages == []


def test_no_request_id_means_silent_failure() -> None:
    ws = FakeWebSocket()
    manager = _make_manager(ws, ds_entry=None)

    msg = _msg()
    del msg["requestId"]
    _run_write(manager, msg)

    assert ws.messages == []
