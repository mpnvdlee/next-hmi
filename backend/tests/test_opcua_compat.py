"""Tests for opcua.compat: watchdog log demotion (§2.9) + asyncua serializer health."""

import logging
import socket
from datetime import UTC, datetime

import pytest
from asyncua import Client, Server, ua
from asyncua.ua import ua_binary
from opcua.client_pool import DatasourceOpcuaEngine
from opcua.compat import apply_asyncua_watchdog_log_patch


class _RecordingHandler(logging.Handler):
    def __init__(self, level: int) -> None:
        super().__init__(level=level)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def test_error_threshold_handler_still_receives_demoted_watchdog_record():
    apply_asyncua_watchdog_log_patch()
    logger = logging.getLogger("asyncua.client.client")

    handler = _RecordingHandler(level=logging.ERROR)
    logger.addHandler(handler)
    logger.propagate = False
    try:
        try:
            raise RuntimeError("boom")
        except RuntimeError:
            logger.error("Error in watchdog loop: server unreachable", exc_info=True)
    finally:
        logger.removeHandler(handler)
        logger.propagate = True

    assert len(handler.records) == 1
    record = handler.records[0]
    # Display level demoted to WARNING, traceback stripped...
    assert record.levelname == "WARNING"
    assert record.exc_info is None
    assert record.exc_text is None
    # ...but the record still reached an ERROR-thresholded handler at all,
    # which requires levelno to have stayed at ERROR through the threshold
    # check in Logger.callHandlers.
    assert record.levelno == logging.ERROR


def test_unrelated_error_records_are_not_touched():
    apply_asyncua_watchdog_log_patch()
    logger = logging.getLogger("asyncua.client.client")

    handler = _RecordingHandler(level=logging.ERROR)
    logger.addHandler(handler)
    logger.propagate = False
    try:
        logger.error("some unrelated failure")
    finally:
        logger.removeHandler(handler)
        logger.propagate = True

    assert len(handler.records) == 1
    record = handler.records[0]
    assert record.levelname == "ERROR"
    assert record.levelno == logging.ERROR


@pytest.mark.asyncio
async def test_asyncua_serializes_without_a_local_ua_binary_patch():
    """asyncua must round-trip its own wire types on the supported interpreter.

    Until this baseline, `opcua.compat` monkey-patched asyncua 1.x's ua_binary
    serializer because CPython 3.14 made it call `issubclass` with non-class
    typing objects. asyncua 2.0 fixed that upstream, and the patch itself broke
    2.x (`field_serializer` gained an argument), so it was removed. This test
    owns that decision: it exercises the encode/decode paths the patch used to
    intercept, against a real server, with nothing patched.
    """
    assert not hasattr(ua_binary, "_nexthmi_py314_patch")

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    url = f"opc.tcp://127.0.0.1:{port}/nexthmi/compat/"

    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace("http://nexthmi/compat")

    cases = {
        "Int32": ua.Variant(-7, ua.VariantType.Int32),
        "UInt64": ua.Variant(2**40, ua.VariantType.UInt64),
        "Double": ua.Variant(1.5, ua.VariantType.Double),
        "Boolean": ua.Variant(True, ua.VariantType.Boolean),
        "String": ua.Variant("hello", ua.VariantType.String),
        "DateTime": ua.Variant(datetime(2026, 6, 15, 12, 0, tzinfo=UTC), ua.VariantType.DateTime),
    }
    nodes = {}
    for name, variant in cases.items():
        node = await server.nodes.objects.add_variable(idx, name, variant)
        await node.set_writable()
        nodes[name] = node
    # An array exercises create_list_serializer, a separate patched entry point.
    array_node = await server.nodes.objects.add_variable(
        idx, "Int16Array", ua.Variant([1, 2, 3], ua.VariantType.Int16)
    )
    await array_node.set_writable()

    await server.start()
    try:
        async with Client(url) as client:
            for name, variant in cases.items():
                assert await client.get_node(nodes[name].nodeid).read_value() == variant.Value

            arr = client.get_node(array_node.nodeid)
            assert await arr.read_value() == [1, 2, 3]
            await arr.write_value(ua.Variant([9, 8], ua.VariantType.Int16))
            assert await arr.read_value() == [9, 8]

            # Structured read: DataValue carries status/timestamps, which is the
            # nested-dataclass path that most exercised the old patch.
            data_value = await client.get_node(nodes["Int32"].nodeid).read_data_value()
            assert data_value.Value.Value == -7
            assert data_value.StatusCode.is_good()
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_batch_read_var_attrs_reads_real_attribute_names():
    """Browse-time attribute reads must survive against a real server.

    Every attribute access in `_batch_read_var_attrs` sits inside
    `except Exception: pass`, so any drift in asyncua's DataValue shape fails
    silently: variables degrade to ("Unknown", not writable, scalar) rather
    than raising. asyncua 2.0 renamed the `StatusCode_` field to `StatusCode`
    (1.x kept a property under the new name, so both versions happened to
    work), which is exactly the kind of change the existing fake-based tests
    cannot see. This one talks to a live server.
    """
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    url = f"opc.tcp://127.0.0.1:{port}/nexthmi/attrs/"

    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace("http://nexthmi/attrs")

    read_only = await server.nodes.objects.add_variable(
        idx, "ReadOnlyDouble", ua.Variant(1.5, ua.VariantType.Double)
    )
    writable = await server.nodes.objects.add_variable(
        idx, "WritableInt32", ua.Variant(3, ua.VariantType.Int32)
    )
    await writable.set_writable()
    array = await server.nodes.objects.add_variable(
        idx, "FixedArray", ua.Variant([1, 2, 3, 4], ua.VariantType.Int16)
    )
    await array.write_value_rank(1)
    await array.write_array_dimensions([4])

    await server.start()
    try:
        engine = DatasourceOpcuaEngine("attrs-test")
        async with Client(url) as client:
            engine._client = client
            attrs = await engine._batch_read_var_attrs(
                [read_only.nodeid, writable.nodeid, array.nodeid]
            )
    finally:
        await server.stop()

    assert attrs[0] == ("Double", False, -1)
    assert attrs[1] == ("Int32", True, -1)
    data_type, _, array_length = attrs[2]
    assert data_type == "Int16"
    assert array_length == 4
