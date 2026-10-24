"""A full browse reports its progress, and streams it to the client.

The size of an address space is unknown until it has been walked, so progress
is reported as work done against work known so far. These tests pin the
contract a progress bar relies on: `done` never goes backwards, never passes
`total`, and meets it exactly when the walk is over — plus the stream that
carries it, including a failure mid-walk and a client that leaves.
"""

import asyncio
import json
import socket
from pathlib import Path
from typing import Any

import api.datasource_api as datasource_api_module
import core.storage as storage
import pytest
from asyncua import Client, Server, ua
from core.exceptions import register_exception_handlers
from fastapi import FastAPI
from fastapi.testclient import TestClient
from opcua.client_pool import DatasourceOpcuaEngine
from opcua.limits import OperationLimits
from services.datasource_manager import DatasourceManager

N_FOLDERS = 3
VARS_PER_FOLDER = 40


def _free_url(suffix: str) -> str:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"opc.tcp://127.0.0.1:{port}/nexthmi/{suffix}/"


async def _build_server(url: str) -> tuple[Server, str]:
    """Plant → Line{0..2} → 40 tags each, and one struct with members."""
    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace("http://nexthmi/progress")
    plant = await server.nodes.objects.add_folder(ua.NodeId("Plant", idx), "Plant")
    for f in range(N_FOLDERS):
        line = await plant.add_folder(ua.NodeId(f"Line{f}", idx), f"Line{f}")
        for v in range(VARS_PER_FOLDER):
            await line.add_variable(
                ua.NodeId(f"Line{f}.T{v}", idx), f"T{v}", ua.Variant(float(v), ua.VariantType.Double)
            )
    struct_dt = await server.get_node(ua.NodeId(ua.ObjectIds.Structure)).add_data_type(
        ua.NodeId("DT_Drive", idx), "DT_Drive"
    )
    drive = await plant.add_variable(
        ua.NodeId("Drive", idx),
        "Drive",
        ua.Variant(None, ua.VariantType.ExtensionObject),
        datatype=struct_dt.nodeid,
    )
    for name in ("Speed", "Torque"):
        await drive.add_variable(
            ua.NodeId(f"Drive.{name}", idx), name, ua.Variant(0.0, ua.VariantType.Double)
        )
    return server, plant.nodeid.to_string()


def _count_nodes(entry: dict) -> int:
    return sum(1 + _count_nodes(child) for child in entry.get("children", []))


async def _browse_with_progress(url: str, root_id: str) -> tuple[dict, list[dict]]:
    events: list[dict] = []
    engine = DatasourceOpcuaEngine("progress-test")
    async with Client(url) as client:
        engine.attach_client(
            client,
            {"browse_root_node": root_id},
            # Small budgets so even this modest tree reports many chunks:
            # 2 parents per Browse, 10 variables per attribute Read.
            operation_limits=OperationLimits(max_read_ops=40, max_browse_nodes=2),
        )
        tree = await engine.browse(on_progress=events.append)
    return tree, events


@pytest.mark.asyncio
async def test_progress_climbs_to_completion_and_never_overshoots():
    url = _free_url("progress-live")
    server, root_id = await _build_server(url)
    await server.start()
    try:
        tree, events = await _browse_with_progress(url, root_id)
    finally:
        await server.stop()

    assert len(events) > 10, "a multi-chunk walk should report as it goes"
    done = [e["done"] for e in events]
    assert done == sorted(done), "done must never go backwards"
    assert all(e["done"] <= e["total"] for e in events), "done must never pass total"
    last = events[-1]
    assert last["done"] == last["total"], "the walk ends exactly at 100%"
    # Every node the tree holds was counted, and nothing else was.
    assert last["nodes"] == _count_nodes(tree)
    # `level` counts Browse rounds: Plant, then the Lines and the Drive struct.
    # The tags and members below are scalar leaves, never browsed themselves.
    assert last["level"] == 2


@pytest.mark.asyncio
async def test_a_browse_without_a_listener_still_works():
    url = _free_url("progress-none")
    server, root_id = await _build_server(url)
    await server.start()
    try:
        engine = DatasourceOpcuaEngine("progress-test")
        async with Client(url) as client:
            engine.attach_client(client, {"browse_root_node": root_id})
            tree = await engine.browse()
    finally:
        await server.stop()

    assert _count_nodes(tree) == N_FOLDERS * (1 + VARS_PER_FOLDER) + 1 + 2


@pytest.mark.asyncio
async def test_a_broken_listener_cannot_break_the_browse():
    url = _free_url("progress-broken")
    server, root_id = await _build_server(url)
    await server.start()
    try:
        engine = DatasourceOpcuaEngine("progress-test")
        async with Client(url) as client:
            engine.attach_client(client, {"browse_root_node": root_id})

            def explode(_: dict) -> None:
                raise RuntimeError("listener bug")

            tree = await engine.browse(on_progress=explode)
    finally:
        await server.stop()

    assert _count_nodes(tree) > 0


# ── The stream ────────────────────────────────────────────────────────────────


class _ScriptedEngine:
    """Reports scripted progress, then returns or raises."""

    datasource_name = "PLC"
    connected = True

    def __init__(self, steps: int = 3, fail: bool = False, hang: bool = False) -> None:
        self.steps = steps
        self.fail = fail
        self.hang = hang
        self.cancelled = False

    async def browse(self, node_id: str | None = None, *, on_progress: Any = None) -> dict:
        try:
            for i in range(1, self.steps + 1):
                on_progress({"done": i, "total": self.steps, "nodes": i * 10, "level": i})
                await asyncio.sleep(0)
            if self.hang:
                await asyncio.Event().wait()
            if self.fail:
                raise RuntimeError("BadSessionClosed")
            return {"node_id": "i=85", "display_name": "Objects", "children": []}
        except asyncio.CancelledError:
            self.cancelled = True
            raise


async def _collect(engine: Any) -> list[dict]:
    return [json.loads(line) async for line in datasource_api_module._browse_stream_lines(engine)]


@pytest.mark.asyncio
async def test_stream_sends_progress_then_one_result_last():
    lines = await _collect(_ScriptedEngine(steps=3))

    assert [line["type"] for line in lines[:-1]] == ["progress"] * (len(lines) - 1)
    assert len(lines) >= 2
    assert lines[-1]["type"] == "result"
    assert lines[-1]["tree"]["display_name"] == "Objects"
    progress = [line for line in lines if line["type"] == "progress"]
    # Coalescing may drop intermediate states, never the newest one.
    assert progress[-1]["done"] == 3


@pytest.mark.asyncio
async def test_a_failure_mid_walk_arrives_as_an_error_line():
    lines = await _collect(_ScriptedEngine(steps=2, fail=True))

    assert lines[-1] == {"type": "error", "error": "BadSessionClosed"}
    assert not any(line["type"] == "result" for line in lines)


@pytest.mark.asyncio
async def test_a_client_that_leaves_cancels_the_browse():
    engine = _ScriptedEngine(steps=1, hang=True)
    stream = datasource_api_module._browse_stream_lines(engine)

    first = json.loads(await stream.__anext__())
    assert first["type"] == "progress"
    # What Starlette does when the client disconnects.
    await stream.aclose()

    assert engine.cancelled is True


@pytest.fixture()
def ds_client(monkeypatch, live_project_root: Path):
    storage.active_datasources_dir().mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(datasource_api_module, "_opcua_pool", None)
    monkeypatch.setattr(datasource_api_module, "_test_server_pool", None)
    manager = DatasourceManager()
    monkeypatch.setattr(datasource_api_module, "datasource_manager", manager)
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(datasource_api_module.router)
    with TestClient(app) as c:
        yield c, manager


def test_the_endpoint_refuses_before_streaming(ds_client):
    """A datasource that cannot be browsed keeps its HTTP status, not a 200."""
    client, manager = ds_client
    manager.datasources["Static"] = type(
        "E", (), {"ds_type": "static", "config": {"name": "Static"}}
    )()

    resp = client.get("/api/datasources/Static/browse/stream")

    assert resp.status_code in (400, 422)


def test_the_endpoint_streams_ndjson(ds_client, monkeypatch):
    client, manager = ds_client
    manager.datasources["PLC"] = type(
        "E", (), {"ds_type": "opcua-client", "config": {"name": "PLC"}}
    )()

    class _Pool:
        def get(self, name: str) -> Any:
            return _ScriptedEngine(steps=2)

    monkeypatch.setattr(datasource_api_module, "_opcua_pool", _Pool())

    resp = client.get("/api/datasources/PLC/browse/stream")

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/x-ndjson")
    lines = [json.loads(line) for line in resp.text.splitlines() if line]
    assert lines[-1]["type"] == "result"
