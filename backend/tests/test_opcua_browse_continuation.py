"""A struct is walked for its members even when the server is short of help.

An S7-1500 answers a Browse with a bounded number of references per node and
keeps only a few continuation points per session for the rest. A level with
many large structs used them up, the structs past that point came back
BadNoContinuationPoints with no references, and the import showed each one as
a bare variable without members. A struct whose DataType could not be read was
not walked at all and showed as an Unknown leaf.
"""

import socket

import pytest
from asyncua import Client, Server, ua
from opcua.client_pool import DatasourceOpcuaEngine
from opcua.limits import OperationLimits

N_STRUCTS = 4
MEMBERS_PER_STRUCT = 8
REFS_PER_ANSWER = 3
CONTINUATION_POINTS = 1


def _free_url(suffix: str) -> str:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"opc.tcp://127.0.0.1:{port}/nexthmi/{suffix}/"


async def _build_server(url: str) -> tuple[Server, str]:
    """DB → S0..S3, each a struct of M0..M7."""
    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace("http://nexthmi/continuation")
    struct_dt = await server.get_node(ua.NodeId(ua.ObjectIds.Structure)).add_data_type(
        ua.NodeId("DT_Block", idx), "DT_Block"
    )
    db = await server.nodes.objects.add_object(ua.NodeId("DB", idx), "DB")
    for s in range(N_STRUCTS):
        struct = await db.add_variable(
            ua.NodeId(f"S{s}", idx),
            f"S{s}",
            ua.Variant(None, ua.VariantType.ExtensionObject),
            datatype=struct_dt.nodeid,
        )
        for m in range(MEMBERS_PER_STRUCT):
            await struct.add_variable(
                ua.NodeId(f"S{s}.M{m}", idx), f"M{m}", ua.Variant(m, ua.VariantType.Int16)
            )
    return server, db.nodeid.to_string()


def _limit_continuation_points(uaclient) -> list[int]:
    """Make the client see a server that pages references the way an S7-1500
    does: REFS_PER_ANSWER per answer, CONTINUATION_POINTS held at once.

    Returns a list that gets one entry per node the server refused."""
    real_browse = uaclient.browse
    held: dict[bytes, list[ua.ReferenceDescription]] = {}
    refused: list[int] = []

    def page(result: ua.BrowseResult, refs: list[ua.ReferenceDescription]) -> None:
        result.References = refs[:REFS_PER_ANSWER]
        rest = refs[REFS_PER_ANSWER:]
        result.ContinuationPoint = None
        if rest:
            if len(held) >= CONTINUATION_POINTS:
                result.References = []
                result.StatusCode = ua.StatusCode(ua.StatusCodes.BadNoContinuationPoints)
                refused.append(1)
                return
            token = f"cp{id(rest)}".encode()
            held[token] = rest
            result.ContinuationPoint = token

    async def browse(params):
        results = await real_browse(params)
        for result in results:
            page(result, list(result.References))
        return results

    async def browse_next(params):
        answers = []
        for token in params.ContinuationPoints:
            result = ua.BrowseResult()
            page(result, held.pop(token))
            answers.append(result)
        return answers

    uaclient.browse = browse
    uaclient.browse_next = browse_next
    return refused


def _deny_data_type(uaclient, node_id: str) -> None:
    """Refuse every attribute of *node_id* the way a server refuses access."""
    real_read = uaclient.read

    async def read(params):
        results = await real_read(params)
        for i, rv in enumerate(params.NodesToRead):
            if rv.NodeId.to_string() == node_id and rv.AttributeId != ua.AttributeIds.NodeClass:
                results[i] = ua.DataValue(StatusCode=ua.StatusCode(ua.StatusCodes.BadUserAccessDenied))
        return results

    uaclient.read = read


async def _browse(
    url: str,
    root_id: str,
    *,
    deny: str | None = None,
    limits: OperationLimits | None = None,
) -> tuple[dict, list[int]]:
    engine = DatasourceOpcuaEngine("continuation-test")
    async with Client(url) as client:
        refused = _limit_continuation_points(client.uaclient)
        if deny is not None:
            _deny_data_type(client.uaclient, deny)
        engine.attach_client(client, {"browse_root_node": root_id}, operation_limits=limits)
        return await engine.browse(), refused


def _members(entry: dict, name: str) -> list[str]:
    struct = next(c for c in entry["children"] if c["display_name"] == name)
    return sorted(c["display_name"] for c in struct["children"])


@pytest.mark.asyncio
async def test_structs_past_the_last_continuation_point_still_get_their_members():
    url = _free_url("continuation-starved")
    server, db_id = await _build_server(url)
    await server.start()
    try:
        root, refused = await _browse(url, db_id)
    finally:
        await server.stop()

    expected = sorted(f"M{m}" for m in range(MEMBERS_PER_STRUCT))
    assert refused  # the walk really did run the server out
    for s in range(N_STRUCTS):
        assert _members(root, f"S{s}") == expected


@pytest.mark.asyncio
async def test_a_browse_within_the_advertised_continuation_points_is_never_refused():
    url = _free_url("continuation-capped")
    server, db_id = await _build_server(url)
    await server.start()
    try:
        root, refused = await _browse(
            url,
            db_id,
            limits=OperationLimits(max_browse_continuation_points=CONTINUATION_POINTS),
        )
    finally:
        await server.stop()

    assert refused == []
    expected = sorted(f"M{m}" for m in range(MEMBERS_PER_STRUCT))
    for s in range(N_STRUCTS):
        assert _members(root, f"S{s}") == expected


def test_the_browse_batch_is_capped_by_the_continuation_points():
    assert OperationLimits(max_browse_continuation_points=5).browse_nodes_budget() == 5
    assert (
        OperationLimits(max_browse_nodes=3, max_browse_continuation_points=5)
        .browse_nodes_budget()
        == 3
    )
    # 0 means "no restriction", never a zero-sized batch.
    assert OperationLimits(max_browse_continuation_points=0).browse_nodes_budget() > 0


@pytest.mark.asyncio
async def test_a_struct_whose_type_cannot_be_read_is_still_walked():
    url = _free_url("continuation-unknown")
    server, db_id = await _build_server(url)
    await server.start()
    try:
        s1_id = ua.NodeId("S1", 2).to_string()
        root, _ = await _browse(url, db_id, deny=s1_id)
    finally:
        await server.stop()

    s1 = next(c for c in root["children"] if c["display_name"] == "S1")
    assert s1["data_type"] == "struct"
    assert len(s1["children"]) == MEMBERS_PER_STRUCT
