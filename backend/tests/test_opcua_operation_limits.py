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
from typing import Any

import pytest
from asyncua import Client, Server, ua
from asyncua.server.internal_session import InternalSession
from asyncua.server.uaprocessor import ServiceError
from opcua.client_pool import (
    _VAR_ATTRS,
    DEFAULT_MAX_READ_OPS,
    DatasourceOpcuaEngine,
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
            engine._client = client
            engine._connected = True
            engine._config = {"browse_root_node": gvl_node_id}
            if discover:
                await engine._discover_operation_limits()
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
            engine._client = client
            await engine._discover_operation_limits()
    finally:
        await server.stop()

    assert engine._max_read_ops == SERVER_MAX_NODES_PER_READ
    # Attribute reads must budget in operations, not nodes.
    assert engine._read_ops_budget() == SERVER_MAX_NODES_PER_READ
    nodes_per_chunk = engine._read_ops_budget() // len(_VAR_ATTRS)
    assert nodes_per_chunk == 25


def test_read_budget_falls_back_when_no_limit_is_known():
    engine = DatasourceOpcuaEngine("limits-test")

    assert engine._read_ops_budget() == DEFAULT_MAX_READ_OPS
    # A server reporting 0 means "no limit" — never a zero-sized chunk.
    engine._max_read_ops = None
    assert engine._read_ops_budget() > 0


class _RecordingClient:
    """Records the size of every read_values request."""

    def __init__(self) -> None:
        self.request_sizes: list[int] = []

    def get_node(self, node_id: str) -> Any:
        return node_id

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
    engine._client = client
    engine._connected = True
    engine._max_read_ops = SERVER_MAX_NODES_PER_READ

    values = await engine.read_current_values(set(paths))

    assert len(values) == len(paths)
    assert max(client.request_sizes) <= SERVER_MAX_NODES_PER_READ
    assert sum(client.request_sizes) == len(paths)
