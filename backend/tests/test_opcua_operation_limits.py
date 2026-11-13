"""Tests for honouring the server's OperationLimits on batched OPC-UA requests.

A server that enforces MaxNodesPerRead answers an oversized Read with a
BadTooManyOperations *service* fault: every operation in the request fails, not
just the ones past the limit. The browse attribute read asks for four
attributes per variable, so an unclamped level of 26 variables was enough to
degrade a whole level to data_type "Unknown" against CODESYS Control Win V3,
which advertises MaxNodesPerRead = 100.

The server here enforces the limit at its session layer — the same place a real
server's fault comes from — so these tests exercise the real request path.
"""

import socket
import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from asyncua import Client, Server, ua
from asyncua.server.internal_session import InternalSession
from asyncua.server.uaprocessor import ServiceError
from asyncua.ua.ua_binary import nodeid_to_binary, struct_to_binary
from opcua.browse import _VAR_ATTRS
from opcua.engine import DatasourceOpcuaEngine
from opcua.limits import (
    _MONITORED_ITEM_FIXED_BYTES,
    _READ_VALUE_ID_FIXED_BYTES,
    DEFAULT_MAX_READ_OPS,
    OperationLimits,
    _encoded_node_id_bytes,
    negotiated_request_bytes,
    read_operation_limits,
)

SERVER_MAX_NODES_PER_READ = 100
# 4 attributes per variable, so more than 25 variables overflows the limit.
N_VARS = 40

VAR_TYPES = (
    ("bAlarm", ua.VariantType.Boolean, False),
    ("eControlState", ua.VariantType.Int32, 0),
    ("sDiag", ua.VariantType.String, "no connection"),
    ("rSpeed", ua.VariantType.Float, 1.5),
)


def _free_url(suffix: str) -> str:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"opc.tcp://127.0.0.1:{port}/nexthmi/{suffix}/"


@pytest.fixture
def enforce_read_limit(monkeypatch) -> None:
    """Make the in-process server reject an over-limit Read, as CODESYS does."""
    original = InternalSession.read

    async def _limited_read(self, params):
        if len(params.NodesToRead) > SERVER_MAX_NODES_PER_READ:
            raise ServiceError(ua.StatusCodes.BadTooManyOperations)
        return await original(self, params)

    monkeypatch.setattr(InternalSession, "read", _limited_read)


async def _build_server(url: str, *, advertise_limit: bool) -> tuple[Server, str]:
    """A GVL of simple-typed variables reached through Organizes, like CODESYS."""
    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace("http://nexthmi/limits")

    if advertise_limit:
        limit_node = server.get_node(
            ua.NodeId(
                ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead
            )
        )
        await limit_node.write_value(
            ua.Variant(SERVER_MAX_NODES_PER_READ, ua.VariantType.UInt32)
        )

    gvl = await server.nodes.objects.add_object(ua.NodeId("GVL", idx), "GVL")
    for i in range(N_VARS):
        name, vtype, value = VAR_TYPES[i % len(VAR_TYPES)]
        var = await gvl.add_variable(
            ua.NodeId(f"|var|Application.GVL.{name}_{i}", idx),
            f"{name}_{i}",
            value,
            varianttype=vtype,
        )
        await var.set_writable(True)
        # CODESYS links GVL members with Organizes, not HasComponent.
        await gvl.delete_reference(var, ua.ObjectIds.HasComponent)
        await gvl.add_reference(
            var, ua.ObjectIds.Organizes, forward=True, bidirectional=True
        )
    return server, gvl.nodeid.to_string()


def _leaves(entry: dict) -> list[dict]:
    if not entry.get("children"):
        return [entry]
    found: list[dict] = []
    for child in entry["children"]:
        found.extend(_leaves(child))
    return found


async def _browse_gvl(url: str, *, advertise_limit: bool, discover: bool) -> dict:
    server, gvl_node_id = await _build_server(url, advertise_limit=advertise_limit)
    await server.start()
    try:
        engine = DatasourceOpcuaEngine("limits-test")
        async with Client(url) as client:
            engine.attach_client(
                client,
                {"browse_root_node": gvl_node_id},
                operation_limits=await read_operation_limits(client) if discover else None,
            )
            return await engine.browse()
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_fixture_server_really_rejects_an_over_limit_read(enforce_read_limit):
    """Guards the tests below: without a server that faults, they prove nothing."""
    url = _free_url("limits-guard")
    server, gvl_node_id = await _build_server(url, advertise_limit=True)
    await server.start()
    try:
        async with Client(url) as client:
            params = ua.ReadParameters()
            params.TimestampsToReturn = ua.TimestampsToReturn.Neither
            gvl = client.get_node(gvl_node_id)
            for _ in range(SERVER_MAX_NODES_PER_READ + 1):
                rv = ua.ReadValueId()
                rv.NodeId = gvl.nodeid
                rv.AttributeId = ua.AttributeIds.NodeClass
                params.NodesToRead.append(rv)
            with pytest.raises(ua.UaStatusCodeError) as excinfo:
                await client.uaclient.read(params)
    finally:
        await server.stop()

    assert excinfo.value.code == ua.StatusCodes.BadTooManyOperations


@pytest.mark.asyncio
async def test_browse_types_survive_server_read_limit(enforce_read_limit):
    """The regression: every variable on an over-limit level kept its type."""
    root = await _browse_gvl(
        _free_url("limits-advertised"), advertise_limit=True, discover=True
    )

    leaves = _leaves(root)
    assert len(leaves) == N_VARS
    assert not [leaf for leaf in leaves if leaf["data_type"] == "Unknown"]
    assert {leaf["data_type"] for leaf in leaves} == {
        "Boolean",
        "Int32",
        "String",
        "Float",
    }
    # An unread AccessLevel used to leave `writable` absent rather than False,
    # which is what made the failure look like a type-mapping bug.
    assert all(leaf["writable"] is True for leaf in leaves)


@pytest.mark.asyncio
async def test_browse_types_survive_an_unadvertised_read_limit(enforce_read_limit):
    """A server may enforce a limit it never advertises (or report 0 = none).

    The oversized chunk is then split and retried instead of costing the level.
    """
    root = await _browse_gvl(
        _free_url("limits-hidden"), advertise_limit=False, discover=True
    )

    leaves = _leaves(root)
    assert len(leaves) == N_VARS
    assert not [leaf for leaf in leaves if leaf["data_type"] == "Unknown"]


@pytest.mark.asyncio
async def test_discover_operation_limits_reads_advertised_value():
    url = _free_url("limits-discovery")
    server, _ = await _build_server(url, advertise_limit=True)
    await server.start()
    try:
        engine = DatasourceOpcuaEngine("limits-test")
        async with Client(url) as client:
            engine.attach_client(client)
            await engine._discover_operation_limits()
    finally:
        await server.stop()

    assert engine.operation_limits.max_read_ops == SERVER_MAX_NODES_PER_READ
    # Attribute reads must budget in operations, not nodes.
    assert engine.operation_limits.read_ops_budget() == SERVER_MAX_NODES_PER_READ
    nodes_per_chunk = engine.operation_limits.read_ops_budget() // len(_VAR_ATTRS)
    assert nodes_per_chunk == 25


def test_read_budget_falls_back_when_no_limit_is_known():
    engine = DatasourceOpcuaEngine("limits-test")

    assert engine.operation_limits.read_ops_budget() == DEFAULT_MAX_READ_OPS
    # A server reporting 0 means "no limit" — never a zero-sized chunk.
    assert OperationLimits(max_read_ops=0).read_ops_budget() > 0


def _twincat_ids(count: int) -> list[ua.NodeId]:
    return [
        ua.NodeId.from_string(
            f"ns=4;s=gPlc.emCaseTipper.sfbAxisSideGuidingLeft.sstDev.Hmi.stMaxPosition{i}.fMax"
        )
        for i in range(count)
    ]


def test_read_value_id_size_estimate_is_exact():
    """read_chunks sizes a ReadValueId without encoding it; keep that honest."""
    nid = _twincat_ids(1)[0]
    rv = ua.ReadValueId()
    rv.NodeId = nid
    rv.AttributeId = ua.AttributeIds.DataType
    assert len(struct_to_binary(rv)) == len(nodeid_to_binary(nid)) + _READ_VALUE_ID_FIXED_BYTES


def _null_identifier(nid: ua.NodeId) -> ua.NodeId:
    """A null String/ByteString identifier: asyncua's constructor refuses
    one, but its encoder writes it (length -1)."""
    object.__setattr__(nid, "Identifier", None)
    return nid


@pytest.mark.parametrize(
    "nid",
    [
        ua.NodeId(7, 0, ua.NodeIdType.TwoByte),
        ua.NodeId(2255, 1, ua.NodeIdType.FourByte),
        ua.NodeId(4_000_000, 300, ua.NodeIdType.Numeric),
        ua.NodeId("gPlc.Motor1.fSpeed", 4, ua.NodeIdType.String),
        ua.NodeId("gPlc.Pumpe_Überdruck.温度", 4, ua.NodeIdType.String),
        ua.NodeId("", 4, ua.NodeIdType.String),
        _null_identifier(ua.NodeId("x", 4, ua.NodeIdType.String)),
        ua.NodeId(uuid.UUID("72962b91-fa75-4ae6-8d28-b404dc7daf63"), 2, ua.NodeIdType.Guid),
        ua.NodeId(b"\x00\x01\xfe\xff", 2, ua.NodeIdType.ByteString),
        _null_identifier(ua.NodeId(b"x", 2, ua.NodeIdType.ByteString)),
        ua.NodeId.from_string("nsu=urn:x;s=abc"),
        ua.NodeId.from_string("srv=2;ns=4;s=abc"),
    ],
    ids=lambda nid: f"{nid.NodeIdType.name}:{nid.Identifier!r}",
)
def test_node_id_size_matches_its_encoding(nid: ua.NodeId):
    assert _encoded_node_id_bytes(nid) == len(nodeid_to_binary(nid))


def test_read_chunks_fit_the_server_message_size():
    """TwinCAT: MaxNodesPerRead = 65535, but a 4 MiB request limit."""
    ids = _twincat_ids(30_000)
    limits = OperationLimits(max_read_ops=65535, max_request_bytes=4 * 1024 * 1024)

    spans = list(limits.read_chunks(ids, len(_VAR_ATTRS)))

    assert [i for span in spans for i in range(len(ids))[span]] == list(range(len(ids)))
    for span in spans:
        params = ua.ReadParameters()
        for nid in ids[span]:
            for attr in _VAR_ATTRS:
                rv = ua.ReadValueId()
                rv.NodeId = nid
                rv.AttributeId = attr
                params.NodesToRead.append(rv)
        assert len(struct_to_binary(params)) < 4 * 1024 * 1024
        assert len(params.NodesToRead) <= 65535


def test_monitored_item_size_estimate_covers_a_data_change_filter():
    nid = _twincat_ids(1)[0]
    request = ua.MonitoredItemCreateRequest()
    request.ItemToMonitor.NodeId = nid
    request.ItemToMonitor.AttributeId = ua.AttributeIds.Value
    request.MonitoringMode = ua.MonitoringMode.Reporting
    request.RequestedParameters.ClientHandle = 2**31
    request.RequestedParameters.SamplingInterval = -1
    request.RequestedParameters.QueueSize = 0
    request.RequestedParameters.Filter = ua.DataChangeFilter()
    assert len(struct_to_binary(request)) <= (
        len(nodeid_to_binary(nid)) + _MONITORED_ITEM_FIXED_BYTES
    )


def test_monitored_item_chunks_fit_the_server_message_size():
    """TwinCAT: MaxMonitoredItemsPerCall = 65535, but a 4 MiB request limit —
    one CreateMonitoredItems for 28,000 tags dropped the connection."""
    ids = _twincat_ids(30_000)
    limit = 4 * 1024 * 1024
    limits = OperationLimits(max_monitored_items_per_call=65535, max_request_bytes=limit)

    spans = list(limits.monitored_item_chunks(ids))

    assert len(spans) > 1
    assert [i for span in spans for i in range(len(ids))[span]] == list(range(len(ids)))
    for span in spans:
        params = ua.CreateMonitoredItemsParameters()
        for nid in ids[span]:
            request = ua.MonitoredItemCreateRequest()
            request.ItemToMonitor.NodeId = nid
            request.ItemToMonitor.AttributeId = ua.AttributeIds.Value
            request.RequestedParameters.Filter = ua.DataChangeFilter()
            params.ItemsToCreate.append(request)
        assert len(struct_to_binary(params)) < limit


def test_read_chunks_without_a_known_message_size_use_the_op_budget():
    spans = list(OperationLimits(max_read_ops=100).read_chunks(_twincat_ids(60), 4))
    assert [span.stop - span.start for span in spans] == [25, 25, 10]


def test_negotiated_request_bytes_from_the_acknowledge():
    def client(**limits: int) -> Any:
        transport = SimpleNamespace(**limits)
        return SimpleNamespace(
            uaclient=SimpleNamespace(protocol=SimpleNamespace(_connection=SimpleNamespace(_limits=transport)))
        )

    twincat = client(
        max_message_size=4194304, max_chunk_count=64, max_send_buffer=65536, max_recv_buffer=65536
    )
    # 64 chunks of 64 KiB, less each chunk's headers, is just under 4 MiB.
    assert negotiated_request_bytes(twincat) == 64 * (65536 - 128)
    assert negotiated_request_bytes(
        client(max_message_size=1000, max_chunk_count=0, max_send_buffer=8192, max_recv_buffer=8192)
    ) == 1000
    assert negotiated_request_bytes(
        client(max_message_size=0, max_chunk_count=0, max_send_buffer=65536, max_recv_buffer=65536)
    ) is None
    assert negotiated_request_bytes(SimpleNamespace()) is None


async def _build_small_message_server(url: str, n_vars: int) -> tuple[Server, str]:
    """A TwinCAT-like server: huge MaxNodesPerRead, a request limit of one
    64 KiB chunk, long string NodeIds. asyncua's server enforces MaxChunkCount
    (not MaxMessageSize), and drops the connection past it as TwinCAT does."""
    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    server.limits.max_chunk_count = 1
    idx = await server.register_namespace("http://nexthmi/message-size")
    await server.get_node(
        ua.NodeId(ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead)
    ).write_value(ua.Variant(65535, ua.VariantType.UInt32))
    plc = await server.nodes.objects.add_object(ua.NodeId("gPlc", idx), "gPlc")
    for i in range(n_vars):
        name, vtype, value = VAR_TYPES[i % len(VAR_TYPES)]
        await plc.add_variable(
            ua.NodeId(f"gPlc.emCaseTipper.sfbAxisSideGuidingLeft.sstDev.Hmi.st{i}.{name}", idx),
            f"{name}_{i}",
            value,
            varianttype=vtype,
        )
    return server, plc.nodeid.to_string()


@pytest.mark.asyncio
async def test_browse_types_survive_a_small_server_message_size():
    """The TwinCAT regression: a Read sized to MaxNodesPerRead alone was larger
    than the server's message size, the server closed the connection, and every
    variable on the level came back Unknown."""
    url = _free_url("message-size")
    n_vars = 400  # four ReadValueIds of ~100 bytes each: ~160 kB unsplit
    server, root_id = await _build_small_message_server(url, n_vars)
    await server.start()
    try:
        async with Client(url) as client:
            limits = await read_operation_limits(client)
            assert limits.max_request_bytes is not None
            assert limits.max_request_bytes <= 64 * 1024
            engine = DatasourceOpcuaEngine("message-size")
            engine.attach_client(client, {"browse_root_node": root_id}, operation_limits=limits)
            root = await engine.browse()
    finally:
        await server.stop()

    leaves = _leaves(root)
    assert len(leaves) == n_vars
    assert not [leaf for leaf in leaves if leaf["data_type"] == "Unknown"]


@pytest.mark.asyncio
async def test_create_items_puts_a_deadband_on_a_real_server():
    """`_create_items` builds a deadband request with asyncua's private
    `Subscription._make_monitored_item_request`: an asyncua release that
    changes it fails here, not on a live connection. Two items per call, so
    the three Float tags also go out in two requests."""
    url = _free_url("deadband")
    server, _ = await _build_server(url, advertise_limit=False)
    await server.start()
    try:
        async with Client(url) as client:
            engine = DatasourceOpcuaEngine("deadband-test")
            engine.attach_client(
                client,
                {"deadband_abs": 0.5},
                operation_limits=OperationLimits(max_monitored_items_per_call=2),
            )
            idx = await client.get_namespace_index("http://nexthmi/limits")
            # VAR_TYPES puts a Float at every fourth index from 3.
            paths = [f"rSpeed_{i}" for i in (3, 7, 11)]
            items = [
                (path, client.get_node(ua.NodeId(f"|var|Application.GVL.{path}", idx)))
                for path in paths
            ]
            entry = SimpleNamespace(
                registry={path: {"data_type": "Float"} for path in paths}, folder_registry={}, derived={},
            )
            sub = await client.create_subscription(500, None)
            request_sizes: list[int] = []
            create_monitored_items = sub.create_monitored_items

            async def counting_create(requests):
                request_sizes.append(len(requests))
                return await create_monitored_items(requests)

            sub.create_monitored_items = counting_create
            try:
                handles = await engine._create_items(sub, items, entry, -1)
            finally:
                await sub.delete()
    finally:
        await server.stop()

    assert request_sizes == [2, 1]
    assert len(handles) == 3 and all(isinstance(h, int) for h in handles), handles
    assert engine._deadband_refused is False


class _RecordingNode:
    def __init__(self, node_id: str) -> None:
        self.nodeid = node_id


class _RecordingClient:
    """Records the size of every read_values request."""

    def __init__(self) -> None:
        self.request_sizes: list[int] = []

    def get_node(self, node_id: str) -> Any:
        return _RecordingNode(node_id)

    async def read_values(self, nodes: list[Any]) -> list[Any]:
        self.request_sizes.append(len(nodes))
        return [1 for _ in nodes]


@pytest.mark.asyncio
async def test_read_current_values_chunks_to_the_read_limit():
    """A page context wider than MaxNodesPerRead must still get its values."""
    from services.datasource_manager import DatasourceEntry, DatasourceManager

    paths = [f"Var{i}" for i in range(250)]
    config = {
        "name": "DS",
        "type": "opcua-client",
        "variables": [
            {
                "display_name": path,
                "node_id": f"ns=2;s={path}",
                "data_type": "Boolean",
                "enabled": True,
                "writable": False,
            }
            for path in paths
        ],
    }
    dm = DatasourceManager()
    dm.datasources["DS"] = DatasourceEntry(config)

    engine = DatasourceOpcuaEngine("DS")
    engine.set_datasource_manager(dm)
    client = _RecordingClient()
    engine.attach_client(
        client, operation_limits=OperationLimits(max_read_ops=SERVER_MAX_NODES_PER_READ)
    )

    values = await engine.read_current_values(set(paths))

    assert len(values) == len(paths)
    assert max(client.request_sizes) <= SERVER_MAX_NODES_PER_READ
    assert sum(client.request_sizes) == len(paths)
