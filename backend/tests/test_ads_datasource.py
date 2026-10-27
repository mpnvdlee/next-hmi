"""The ads-client datasource type: pool, REST API and validation wiring."""

import asyncio
import errno
import json
import logging
import socket
from collections.abc import AsyncIterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import api.datasource_api as datasource_api_module
import core.storage as storage
import core.validation.structure as structure
import httpx
import pytest
import pytest_asyncio
import services.datasource_manager as datasource_manager_module
from ads.engine import DatasourceAdsEngine
from core.exceptions import register_exception_handlers
from core.validation.report import ValidationReport
from fastapi import FastAPI
from mcp_server.tools.datasources import _get_datasource_payload
from opcua.engine import DatasourceOpcuaEngine
from opcua.pool import OpcuaPool
from services.datasource_manager import DatasourceManager
from tests.ads_fake_plc import FakePlc


async def _until(check: Any, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def _settings(plc: FakePlc, **extra: Any) -> dict[str, Any]:
    return {"host": "127.0.0.1", "tcp_port": plc.port, "ams_net_id": "127.0.0.1.1.1", **extra}


def _closed_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest_asyncio.fixture
async def plc() -> AsyncIterator[FakePlc]:
    fake = FakePlc()
    await fake.start()
    yield fake
    await fake.stop()


# ── Pool ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_pool_starts_the_engine_each_client_type_needs() -> None:
    pool = OpcuaPool()
    entries = {
        "opc": SimpleNamespace(ds_type="opcua-client", config={"settings": {"server_url": "opc.tcp://127.0.0.1:1"}}),
        "ads": SimpleNamespace(ds_type="ads-client", config={"settings": {"host": "127.0.0.1", "tcp_port": 1}}),
        "mem": SimpleNamespace(ds_type="static", config={}),
        "sim": SimpleNamespace(ds_type="opcua-test-server", config={}),
    }
    try:
        await pool.start_all(SimpleNamespace(datasources=entries))
        assert isinstance(pool.get("opc"), DatasourceOpcuaEngine)
        assert isinstance(pool.get("ads"), DatasourceAdsEngine)
        assert pool.get("mem") is None and pool.get("sim") is None

        await pool.restart("ads", {"host": "127.0.0.1", "tcp_port": 1}, "ads-client")
        assert isinstance(pool.get("ads"), DatasourceAdsEngine)
        # The test server's paired client starts with no type: OPC-UA.
        await pool.start("sim", {"server_url": "opc.tcp://127.0.0.1:1"})
        assert isinstance(pool.get("sim"), DatasourceOpcuaEngine)
    finally:
        await pool.stop_all()


# ── REST API ──────────────────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def api(monkeypatch, live_project_root: Path) -> AsyncIterator[tuple[httpx.AsyncClient, DatasourceManager, OpcuaPool]]:
    """The datasource router over a real manager and pool, on this test's loop
    so engines reach the fake PLC."""
    storage.active_datasources_dir().mkdir(parents=True, exist_ok=True)
    manager = DatasourceManager()
    pool = OpcuaPool()
    pool.set_datasource_manager(manager)
    monkeypatch.setattr(datasource_api_module, "datasource_manager", manager)
    monkeypatch.setattr(datasource_api_module, "_opcua_pool", pool)
    monkeypatch.setattr(datasource_api_module, "_test_server_pool", None)
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(datasource_api_module.router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            yield client, manager, pool
    finally:
        await pool.stop_all()


def _ads_body(plc: FakePlc, **extra: Any) -> dict[str, Any]:
    return {"type": "ads-client", "settings": _settings(plc, reconnect_interval_s=1, **extra), "variables": []}


@pytest.mark.asyncio
async def test_ads_datasource_lifecycle(plc: FakePlc, api) -> None:
    client, manager, pool = api
    resp = await client.put("/api/datasources/plc", json=_ads_body(plc, browse_mode="lazy"))
    assert resp.status_code == 200
    assert resp.json()["settings"]["browse_mode"] == "lazy"
    assert manager.get("plc").ds_type == "ads-client"
    engine = pool.get("plc")
    assert isinstance(engine, DatasourceAdsEngine)
    await _until(lambda: engine.connected)
    listed = (await client.get("/api/datasources")).json()
    assert [(d["type"], d["connected"]) for d in listed] == [("ads-client", True)]

    # A settings change replaces the engine with a new one for the new settings.
    resp = await client.put("/api/datasources/plc", json=_ads_body(plc, browse_mode="all"))
    assert resp.status_code == 200
    engine = pool.get("plc")
    assert isinstance(engine, DatasourceAdsEngine)
    await _until(lambda: engine.connected)

    assert (await client.post("/api/datasources/plc/stop")).json() == {"status": "disconnected"}
    assert pool.get("plc") is None
    assert (await client.post("/api/datasources/plc/start")).json() == {"status": "connected"}
    assert isinstance(pool.get("plc"), DatasourceAdsEngine)
    assert (await client.post("/api/datasources/plc/restart")).json() == {"status": "reconnecting"}
    engine = pool.get("plc")
    assert isinstance(engine, DatasourceAdsEngine)
    await _until(lambda: engine.connected)

    # Changing type stops the ADS engine.
    resp = await client.put("/api/datasources/plc", json={"type": "static", "variables": []})
    assert resp.status_code == 200
    assert pool.get("plc") is None

    await client.put("/api/datasources/plc", json=_ads_body(plc))
    assert isinstance(pool.get("plc"), DatasourceAdsEngine)
    assert (await client.delete("/api/datasources/plc")).json() == {"status": "deleted"}
    assert pool.get("plc") is None
    assert manager.get("plc") is None


@pytest.mark.asyncio
async def test_ads_browse_takes_a_node_id(plc: FakePlc, api) -> None:
    client, _manager, pool = api
    await client.put("/api/datasources/plc", json=_ads_body(plc, browse_mode="lazy"))
    await _until(lambda: pool.get("plc").connected)

    top = (await client.get("/api/datasources/plc/browse")).json()
    assert [(c["node_id"], c["has_children"]) for c in top["children"]] == [("MAIN", True), ("GVL", True)]
    motor = (await client.get("/api/datasources/plc/browse", params={"node_id": "MAIN.stMotor"})).json()
    assert motor["node_id"] == "MAIN.stMotor"
    assert [c["display_name"] for c in motor["children"]] == ["fSpeed", "bRunning", "eMode", "stLimits"]

    resp = await client.get("/api/datasources/plc/browse/stream", params={"node_id": "MAIN.stMotor"})
    lines = [json.loads(line) for line in resp.text.splitlines()]
    assert lines[-1]["type"] == "result"
    assert lines[-1]["tree"]["node_id"] == "MAIN.stMotor"


@pytest.mark.asyncio
async def test_ads_check_variables_lists_what_the_plc_no_longer_has(plc: FakePlc, api) -> None:
    client, manager, pool = api
    body = _ads_body(plc)
    body["variables"] = [{"kind": "folder", "name": "MAIN", "node_id": "MAIN", "children": [
        {"kind": "variable", "display_name": "fSpeed", "node_id": "MAIN.fSpeed", "data_type": "Double", "enabled": True},
        {"kind": "variable", "display_name": "bGone", "node_id": "MAIN.bGone", "data_type": "Boolean", "enabled": False},
        {"kind": "struct", "display_name": "stMotor", "node_id": "MAIN.stMotor", "data_type": "struct", "enabled": False},
        # Saved as a value, but a struct on the PLC now: it no longer reads.
        {"kind": "variable", "display_name": "stLimits", "node_id": "MAIN.stMotor.stLimits", "data_type": "Double",
         "enabled": False},
        {"kind": "folder", "name": "aPoints", "node_id": "MAIN.aPoints", "is_array": True, "children": [
            {"kind": "folder", "name": "[1]", "node_id": "MAIN.aPoints[1]", "children": [
                {"kind": "variable", "display_name": "x", "node_id": "MAIN.aPoints[1].x", "data_type": "Float", "enabled": False},
                {"kind": "variable", "display_name": "z", "node_id": "MAIN.aPoints[1].z", "data_type": "Float", "enabled": False},
            ]},
        ]},
    ]}]
    await client.put("/api/datasources/plc", json=body)
    await _until(lambda: pool.get("plc").connected)

    resp = await client.post("/api/datasources/plc/check-variables")
    assert resp.status_code == 200
    assert resp.json() == {"missing": ["MAIN.bGone", "MAIN.stMotor.stLimits", "MAIN.aPoints[1].z"]}
    # Nothing is written: marking them stale is the editor's save.
    assert "present_on_server" not in json.dumps(manager.get("plc").config["variables"])


@pytest.mark.asyncio
async def test_ads_check_variables_needs_a_connected_ads_datasource(api) -> None:
    client, _manager, _pool = api
    await client.put("/api/datasources/mem", json={"type": "static", "variables": []})
    assert (await client.post("/api/datasources/mem/check-variables")).status_code == 422
    await client.put("/api/datasources/plc", json={
        "type": "ads-client", "variables": [], "settings": {"host": "127.0.0.1", "tcp_port": _closed_port()},
    })
    assert (await client.post("/api/datasources/plc/check-variables")).status_code == 503
    assert (await client.post("/api/datasources/nope/check-variables")).status_code == 404


@pytest.mark.asyncio
async def test_ads_check_variables_failure_is_a_503_with_the_reason(plc: FakePlc, api, monkeypatch) -> None:
    client, _manager, pool = api
    await client.put("/api/datasources/plc", json=_ads_body(plc))
    await _until(lambda: pool.get("plc").connected)

    async def lost() -> list[str]:
        raise ConnectionError("connection closed")

    monkeypatch.setattr(pool.get("plc"), "missing_node_ids", lost)
    resp = await client.post("/api/datasources/plc/check-variables")
    assert resp.status_code == 503
    assert resp.json()["detail"] == "Could not read the PLC's symbols: connection closed"


@pytest.mark.asyncio
async def test_ads_browse_spells_a_typed_root_as_the_plc_does(plc: FakePlc, api) -> None:
    client, _manager, pool = api
    await client.put("/api/datasources/plc", json=_ads_body(plc, browse_mode="lazy", browse_root="main.stmotor"))
    await _until(lambda: pool.get("plc").connected)

    tree = (await client.get("/api/datasources/plc/browse")).json()
    assert (tree["node_id"], tree["display_name"]) == ("MAIN.stMotor", "MAIN.stMotor")
    assert [c["node_id"] for c in tree["children"]][:2] == ["MAIN.stMotor.fSpeed", "MAIN.stMotor.bRunning"]
    level = (await client.get("/api/datasources/plc/browse", params={"node_id": "main"})).json()
    assert level["node_id"] == "MAIN"
    assert "MAIN.stMotor" in [c["node_id"] for c in level["children"]]


@pytest.mark.asyncio
async def test_a_connected_ads_datasource_lists_the_identity_its_route_names(plc: FakePlc, api) -> None:
    client, _manager, pool = api
    await client.put("/api/datasources/plc", json=_ads_body(plc, local_ams_net_id="10.0.0.5.1.1"))
    await _until(lambda: pool.get("plc").connected)
    [item] = (await client.get("/api/datasources")).json()
    assert (item["local_net_id"], item["local_ip"]) == ("10.0.0.5.1.1", "127.0.0.1")

    await client.post("/api/datasources/plc/stop")
    [item] = (await client.get("/api/datasources")).json()
    assert "local_net_id" not in item


@pytest.mark.asyncio
async def test_ads_test_connection_reports_the_device(plc: FakePlc, api) -> None:
    client, _manager, _pool = api
    resp = await client.post(
        "/api/datasources/ads/test-connection",
        json={"host": "127.0.0.1", "tcp_port": plc.port, "ams_net_id": "127.0.0.1.1.1"},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "ok": True, "error": None, "device_name": "Plc30 App", "version": "3.1.4024", "ads_state": "RUN",
        "local_net_id": "127.0.0.1.1.1", "local_ip": "127.0.0.1",
    }


@pytest.mark.asyncio
async def test_ads_test_connection_says_when_a_route_is_missing(plc: FakePlc, api) -> None:
    client, _manager, _pool = api
    plc.require_route = True
    resp = await client.post(
        "/api/datasources/ads/test-connection",
        json={"host": "127.0.0.1", "tcp_port": plc.port, "ams_net_id": "127.0.0.1.1.1",
              "local_ams_net_id": "10.0.0.5.1.1", "request_timeout_s": 0.5},
    )
    result = resp.json()
    assert result["ok"] is False
    assert result["error"] == (
        "No answer to ADS requests: the PLC probably has no route for this HMI (AMS NetID 10.0.0.5.1.1, IP 127.0.0.1)"
    )
    assert (result["local_net_id"], result["local_ip"]) == ("10.0.0.5.1.1", "127.0.0.1")


@pytest.mark.asyncio
async def test_ads_add_route_creates_the_route(plc: FakePlc, api, caplog) -> None:
    client, _manager, _pool = api
    caplog.set_level(logging.DEBUG)
    plc.route_password = "s3cr3t-pw"
    body = {"host": "127.0.0.1", "udp_port": plc.udp_port, "user": "Administrator", "route_name": "panel"}

    resp = await client.post("/api/datasources/ads/add-route", json={**body, "password": "wrong-pw"})
    assert resp.status_code == 200
    result = resp.json()
    assert result["ok"] is False
    assert result["error"].startswith("Route refused by the PLC: check the PLC user name and password")
    assert plc.routes == set()

    resp = await client.post(
        "/api/datasources/ads/add-route", json={**body, "password": "s3cr3t-pw", "route_address": "203.0.113.7"},
    )
    assert resp.json() == {
        "ok": True, "error": None, "route_name": "panel", "net_id": "127.0.0.1.1.1", "address": "203.0.113.7",
    }
    assert plc.routes == {bytes([127, 0, 0, 1, 1, 1])}
    assert plc.route_requests[-1][5] == b"203.0.113.7\0"
    assert "s3cr3t-pw" not in caplog.text and "wrong-pw" not in caplog.text


@pytest.mark.asyncio
async def test_ads_add_route_failure_is_a_result_not_an_error(api) -> None:
    client, _manager, _pool = api
    resp = await client.post("/api/datasources/ads/add-route", json={"host": "127.0.0.1", "user": "", "password": "x"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is False
    assert resp.json()["error"] == "No PLC user name configured to create the route with"


@pytest.mark.asyncio
async def test_route_password_is_stored_and_returned_like_the_opcua_password(plc: FakePlc, api) -> None:
    """Both are plain settings fields: saved as given and returned as-is by
    the REST API and the MCP read tool."""
    client, _manager, _pool = api
    await client.put("/api/datasources/opc", json={
        "type": "opcua-client", "variables": [],
        "settings": {"server_url": "opc.tcp://127.0.0.1:1", "username": "op", "password": "opc-pw"},
    })
    await client.put("/api/datasources/plc", json=_ads_body(
        plc, route_method="custom", route_user="Administrator", route_password="ads-pw",
    ))
    opc = (await client.get("/api/datasources/opc")).json()["settings"]
    ads = (await client.get("/api/datasources/plc", params={"include_variables": False})).json()["settings"]
    assert (opc["password"], ads["route_password"]) == ("opc-pw", "ads-pw")
    assert _get_datasource_payload("opc")["settings"]["password"] == "opc-pw"
    assert _get_datasource_payload("plc")["settings"]["route_password"] == "ads-pw"


@pytest.mark.asyncio
async def test_ads_test_connection_failure_is_a_result_not_an_error(api) -> None:
    client, _manager, _pool = api
    port = _closed_port()
    resp = await client.post(
        "/api/datasources/ads/test-connection", json={"host": "127.0.0.1", "tcp_port": port},
    )
    assert resp.status_code == 200
    result = resp.json()
    assert result["ok"] is False
    assert result["error"] == (
        f"127.0.0.1:{port} refused the connection: check the PLC IP and the TCP port, "
        "and that TwinCAT runs on the PLC"
    )
    assert result["device_name"] is None

    # A host that is not a valid name at all is a failed probe too.
    for host in ("a\x00b", "\u00e4" * 70 + ".example"):
        resp = await client.post(
            "/api/datasources/ads/test-connection", json={"host": host, "ams_net_id": "1.2.3.4.1.1"},
        )
        assert resp.status_code == 200
        assert resp.json()["ok"] is False
        assert resp.json()["error"]

    # A host name gives no default NetID.
    resp = await client.post("/api/datasources/ads/test-connection", json={"host": "plc.local"})
    assert resp.json()["ok"] is False
    assert resp.json()["error"] == "No AMS NetID configured"


# ── Validation ────────────────────────────────────────────────────────────────


def test_var_bindings_to_an_ads_datasource_validate(monkeypatch, live_project_root: Path) -> None:
    storage.active_datasources_dir().mkdir(parents=True, exist_ok=True)
    manager = DatasourceManager()
    manager.save("plc", {
        "name": "plc",
        "type": "ads-client",
        "settings": {"host": "127.0.0.1"},
        "variables": [{"kind": "folder", "name": "MAIN", "node_id": "MAIN", "children": [
            {"kind": "variable", "display_name": "fSpeed", "node_id": "MAIN.fSpeed",
             "data_type": "Double", "enabled": True, "writable": True},
        ]}],
    })
    monkeypatch.setattr(datasource_manager_module, "datasource_manager", manager)
    monkeypatch.setattr(structure, "_live_registry_cache", None)
    ctx = structure.build_context()
    assert ctx.datasource_types["plc"] == "ads-client"

    report = ValidationReport()
    structure.validate_var_ref({"path": "plc:MAIN/fSpeed"}, ctx, "/p", report, {"type": "float"})
    structure._validate_action(
        {"type": "writeDataVariable", "target": {"$var": {"path": "plc:MAIN/fSpeed"}}, "value": 1},
        ctx, "/a", report,
    )
    assert (report.findings, report.warnings) == ([], [])

    structure.validate_var_ref({"path": "plc:MAIN/missing"}, ctx, "/p", report, {"type": "float"})
    assert [w.code for w in report.warnings] == ["var-unknown"]


def test_probe_errors_name_what_to_check() -> None:
    from ads.engine import _probe_error

    settings = {"host": "10.0.0.20", "tcp_port": 48898}
    assert _probe_error(TimeoutError(), settings) == (
        "No answer from 10.0.0.20:48898: check the PLC IP, the network and any firewall between them"
    )
    assert _probe_error(socket.gaierror(-2, "Name or service not known"), {"host": "plc.local"}) == (
        "Host name plc.local could not be resolved: check the PLC IP / host"
    )
    assert _probe_error(OSError(errno.EHOSTUNREACH, "No route to host"), settings) == (
        "10.0.0.20 cannot be reached from this machine: check the PLC IP and the network"
    )
    assert _probe_error(ConnectionRefusedError(), {**settings, "local_router": True}) == (
        "Nothing answers at 127.0.0.1:48898: check that TwinCAT runs on this PC"
    )
    assert _probe_error(ValueError("No AMS NetID configured"), settings) == "No AMS NetID configured"
