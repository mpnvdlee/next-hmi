"""Writes use the type the server actually sends, not only the configured one.

A configured data_type is only as good as the browse that produced it, and a
browse can mislabel a tag: "Unknown" when an attribute read failed, String for
an enum, Float for what the PLC declares as Double. Writing a Variant whose
type differs from the node's own is refused by the server (BadTypeMismatch),
and "Unknown" was refused before the write was even attempted.

The configured type still applies where it refines the wire type rather than
contradicting it: Date, Time and Duration travel as String and Double but carry
their own validation.
"""

import socket
from typing import Any

import pytest
from asyncua import Client, Server, ua
from opcua.client_pool import DatasourceOpcuaEngine, _DsSubHandler
from services import write_service

# ── Fakes ─────────────────────────────────────────────────────────────────────


class _Entry:
    def __init__(self, ds_type: str = "opcua-client") -> None:
        self.ds_type = ds_type
        self.cache: dict[str, Any] = {}


class _DM:
    def __init__(self, registry: dict[str, dict[str, Any]], ds_type: str = "opcua-client") -> None:
        self._registry = registry
        self._entry = _Entry(ds_type)

    def get_entry(self, ds_name: str, path: str) -> dict[str, Any] | None:
        return self._registry.get(path)

    def get(self, name: str) -> _Entry:
        return self._entry

    def get_cached_values(self, keys: set[str]) -> dict[str, Any]:
        return {}


class _WireEngine:
    """Reports a fixed wire type and records what each write was sent as."""

    def __init__(self, wire: ua.VariantType | None) -> None:
        self.wire = wire
        self.writes: list[tuple[str, Any, ua.VariantType | None]] = []

    async def wire_variant_type(self, node_id: str) -> ua.VariantType | None:
        return self.wire

    async def write_node(self, node_id: str, value: Any, variant: ua.VariantType | None) -> None:
        self.writes.append((node_id, value, variant))


class _Pool:
    def __init__(self, engine: Any) -> None:
        self._engine = engine

    def get(self, name: str) -> Any:
        return self._engine


def _tag(data_type: str) -> dict[str, Any]:
    return {"node_id": "ns=2;s=Tag", "data_type": data_type, "writable": True}


async def _write(configured: str, wire: ua.VariantType | None, value: Any):
    engine = _WireEngine(wire)
    dm = _DM({"Tag": _tag(configured)})
    outcome = await write_service.write_value(dm, _Pool(engine), "PLC", "Tag", value)
    return outcome, engine.writes


# ── The decision rule ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_an_unknown_tag_is_written_with_the_servers_type():
    """Walter's import: every CODESYS tag came in as "Unknown" — unwritable."""
    outcome, writes = await _write("Unknown", ua.VariantType.Boolean, True)

    assert outcome.ok, outcome.reason
    assert writes == [("ns=2;s=Tag", True, ua.VariantType.Boolean)]


@pytest.mark.asyncio
async def test_a_mislabelled_tag_is_written_with_the_servers_type():
    """Configured String, really Boolean: used to send the string "True"."""
    outcome, writes = await _write("String", ua.VariantType.Boolean, True)

    assert outcome.ok, outcome.reason
    assert writes == [("ns=2;s=Tag", True, ua.VariantType.Boolean)]


@pytest.mark.asyncio
async def test_a_float_the_server_declares_double_is_written_as_double():
    outcome, writes = await _write("Float", ua.VariantType.Double, 1.5)

    assert outcome.ok, outcome.reason
    assert writes[0][2] == ua.VariantType.Double


@pytest.mark.asyncio
async def test_the_servers_type_bounds_the_value():
    """Configured Integer (Int32) on an Int16 node: Int16's range applies."""
    outcome, writes = await _write("Integer", ua.VariantType.Int16, 70000)

    assert not outcome.ok
    assert outcome.reason == write_service.REASON_INVALID_VALUE
    assert writes == []


@pytest.mark.asyncio
async def test_a_refining_type_keeps_its_own_validation():
    """Date travels as String; an invalid date must still be refused."""
    bad, bad_writes = await _write("Date", ua.VariantType.String, "2026-13-45")
    good, good_writes = await _write("Date", ua.VariantType.String, "2026-10-20")

    assert not bad.ok
    assert bad.reason == write_service.REASON_INVALID_VALUE
    assert bad_writes == []
    assert good.ok, good.reason
    assert good_writes[0][2] == ua.VariantType.String


@pytest.mark.asyncio
async def test_without_a_wire_type_the_configured_type_applies():
    outcome, writes = await _write("Float", None, 1.5)

    assert outcome.ok, outcome.reason
    assert writes[0][2] == ua.VariantType.Float


@pytest.mark.asyncio
async def test_a_wire_type_the_coercer_cannot_target_is_ignored():
    """ByteString, Guid…: no coercion exists, so the configured type stays."""
    outcome, writes = await _write("String", ua.VariantType.ByteString, "abc")

    assert outcome.ok, outcome.reason
    assert writes[0][2] == ua.VariantType.String


@pytest.mark.asyncio
async def test_a_static_datasource_never_consults_an_engine():
    class _Exploding:
        async def wire_variant_type(self, node_id: str) -> Any:
            raise AssertionError("static writes must not look up a wire type")

    dm = _DM({"Tag": {"data_type": "Float", "writable": True}}, ds_type="static")
    dm.update_static_value = lambda *a, **k: None  # type: ignore[attr-defined]
    outcome = await write_service.write_value(dm, _Pool(_Exploding()), "DS", "Tag", "1.5")

    assert outcome.ok, outcome.reason


# ── The engine learns the type ────────────────────────────────────────────────


def test_datachange_records_the_wire_type():
    engine = DatasourceOpcuaEngine("PLC")
    handler = _DsSubHandler(engine)
    node_id = ua.NodeId("Tag", 2)

    class _Node:
        nodeid = node_id

    class _Notification:
        class monitored_item:
            Value = ua.DataValue(ua.Variant(True, ua.VariantType.Boolean))

    handler.datachange_notification(_Node(), True, _Notification())

    assert engine._wire_types[node_id] == ua.VariantType.Boolean


def _free_url(suffix: str) -> str:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"opc.tcp://127.0.0.1:{port}/nexthmi/{suffix}/"


@pytest.mark.asyncio
async def test_a_mislabelled_tag_is_really_written_on_a_live_server():
    """End to end: a real server refuses a mismatched Variant outright."""
    url = _free_url("wire-type")
    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace("http://nexthmi/wire")
    alarm = await server.nodes.objects.add_variable(
        ua.NodeId("bAlarm", idx), "bAlarm", ua.Variant(False, ua.VariantType.Boolean)
    )
    await alarm.set_writable(True)
    await server.start()
    try:
        engine = DatasourceOpcuaEngine("PLC")
        async with Client(url) as client:
            engine.attach_client(client)
            # As Walter's browse imported it: a Boolean labelled String.
            dm = _DM(
                {
                    "bAlarm": {
                        "node_id": alarm.nodeid.to_string(),
                        "data_type": "String",
                        "writable": True,
                    }
                }
            )
            outcome = await write_service.write_value(dm, _Pool(engine), "PLC", "bAlarm", True)
        value = await alarm.read_value()
    finally:
        await server.stop()

    assert outcome.ok, outcome.reason
    assert value is True
