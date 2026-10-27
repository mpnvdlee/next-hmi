"""DatasourceAdsEngine against a fake TwinCAT PLC on loopback (ads.engine)."""

import asyncio
import struct
from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest
import pytest_asyncio
from ads.engine import DatasourceAdsEngine
from ads.symbols import SymbolTable
from asyncua import ua
from services.datasource_manager import DatasourceEntry
from tests.ads_fake_plc import (
    OFFSETS,
    FakePlc,
    demo_datatypes,
    demo_symbols,
    symbol_entry,
)

DS = "plc"


def _stored(nodes: list[dict]) -> list[dict]:
    """A browse as the browse import stores it: every variable enabled."""
    out: list[dict] = []
    for node in nodes:
        if node["data_type"] in (None, "struct"):
            folder = {"kind": "folder", "name": node["display_name"], "node_id": node["node_id"],
                      "children": _stored(node["children"])}
            if node.get("is_array"):
                folder["is_array"] = True
            out.append(folder)
        else:
            variable = {"kind": "variable", "node_id": node["node_id"], "display_name": node["display_name"],
                        "data_type": node["data_type"], "enabled": True, "writable": node["writable"]}
            variable.update({k: node[k] for k in ("is_array", "array_length") if k in node})
            out.append(variable)
    return out


class _RecordingDM:
    """The DatasourceManager calls an engine makes, keyed by leaf path."""

    def __init__(self, entry: DatasourceEntry) -> None:
        self.entry = entry
        self.values: dict[str, Any] = {}
        self.priority: dict[str, bool] = {}

    def get(self, _name: str) -> DatasourceEntry:
        return self.entry

    def update(self, _ds: str, path: str, value: Any, priority: bool = False) -> None:
        self.values[path] = value
        self.priority[path] = priority

    def update_struct_field(
        self, _ds: str, _path: str, _field: str, value: Any, leaf_path: str | None = None, priority: bool = False,
    ) -> None:
        assert leaf_path is not None
        self.values[leaf_path] = value
        self.priority[leaf_path] = priority


async def _until(check: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def _config(plc: FakePlc, **extra: Any) -> dict[str, Any]:
    return {
        "host": "127.0.0.1",
        "tcp_port": plc.port,
        "ams_net_id": "127.0.0.1.1.1",
        "bg_publish_interval_ms": 50,
        "reconnect_interval_s": 1,
        **extra,
    }


@pytest_asyncio.fixture
async def plc() -> AsyncIterator[FakePlc]:
    fake = FakePlc()
    await fake.start()
    yield fake
    await fake.stop()


@pytest_asyncio.fixture
async def rig(plc: FakePlc) -> AsyncIterator[tuple[DatasourceAdsEngine, _RecordingDM, list[bool]]]:
    tree = SymbolTable.from_upload(demo_symbols(), demo_datatypes()).browse()
    dm = _RecordingDM(DatasourceEntry({"name": DS, "type": "ads-client", "variables": _stored(tree)}))
    statuses: list[bool] = []

    async def on_status(_name: str, connected: bool) -> None:
        statuses.append(connected)

    engine = DatasourceAdsEngine(DS)
    engine.set_datasource_manager(dm)
    engine.set_status_callback(on_status)
    await engine.connect(_config(plc))
    await _until(lambda: engine.connected)
    yield engine, dm, statuses
    await engine.disconnect()


@pytest.mark.asyncio
async def test_background_poll_publishes_changes(plc: FakePlc, rig) -> None:
    engine, dm, statuses = rig
    assert statuses == [True]
    assert engine.error is None
    plc.poke("MAIN.nCounter", "h", 42)
    plc.poke("MAIN.stMotor", "d", 12.5)
    plc.poke("MAIN.aPoints", "f", 3.0, offset=8 + 4)
    plc.write_memory(OFFSETS["MAIN.sName"], b"Pump 1\0")
    await _until(lambda: dm.values.get("MAIN/nCounter") == 42)
    await _until(lambda: dm.values.get("MAIN/aPoints/[2]/y") == 3.0)
    assert dm.values["MAIN/stMotor/fSpeed"] == 12.5
    assert dm.values["MAIN/sName"] == "Pump 1"
    assert dm.priority["MAIN/nCounter"] is False

    # Unchanged bytes are not published again.
    dm.values.clear()
    sums = plc.sum_reads
    await _until(lambda: plc.sum_reads >= sums + 2)
    assert dm.values == {}


@pytest.mark.asyncio
async def test_write_node_writes_plc_memory(plc: FakePlc, rig) -> None:
    engine, _dm, _ = rig
    await engine.write_node("MAIN.stMotor.stLimits.fMax", 99.5)
    assert plc.peek("MAIN.stMotor", "d", offset=24) == (99.5,)
    await engine.write_node("MAIN.aTemps", [1.0, 2.0, 3.0, 4.0])
    assert plc.peek("MAIN.aTemps", "4f") == (1.0, 2.0, 3.0, 4.0)
    await engine.write_node("MAIN.tCycle", 0.25)
    assert plc.peek("MAIN.tCycle", "I") == (250,)
    with pytest.raises(ValueError):
        await engine.write_node("MAIN.missing", 1)
    with pytest.raises(ValueError):
        await engine.write_node("MAIN.nCounter", 70000)


@pytest.mark.asyncio
async def test_wire_variant_type_follows_the_plc_type(rig) -> None:
    engine, _dm, _ = rig
    assert await engine.wire_variant_type("MAIN.nCounter") == ua.VariantType.Int16
    assert await engine.wire_variant_type("MAIN.tCycle") == ua.VariantType.Double
    assert await engine.wire_variant_type("MAIN.missing") is None


@pytest.mark.asyncio
async def test_read_current_values_assembles_structs_and_arrays(plc: FakePlc, rig) -> None:
    engine, _dm, _ = rig
    plc.poke("MAIN.stMotor", "d?xh", 7.0, True, 1)
    plc.poke("MAIN.stMotor", "dd", 0.0, 100.0, offset=16)
    plc.poke("MAIN.aPoints", "6f", 1, 2, 3, 4, 5, 6)
    plc.poke("MAIN.aTemps", "4f", 0.5, 1.5, 2.5, 3.5)
    values = await engine.read_current_values(
        {"MAIN/stMotor", "MAIN/aPoints", "MAIN/aTemps", "MAIN/nCounter"},
    )
    assert values[f"{DS}:MAIN/stMotor"] == {
        "fSpeed": 7.0, "bRunning": True, "eMode": 1, "stLimits": {"fMin": 0.0, "fMax": 100.0},
    }
    assert values[f"{DS}:MAIN/aPoints"] == [{"x": 1.0, "y": 2.0}, {"x": 3.0, "y": 4.0}, {"x": 5.0, "y": 6.0}]
    assert values[f"{DS}:MAIN/aPoints/[2]"] == {"x": 3.0, "y": 4.0}
    assert values[f"{DS}:MAIN/aTemps"] == [0.5, 1.5, 2.5, 3.5]
    assert values[f"{DS}:MAIN/nCounter"] == 0


@pytest.mark.asyncio
async def test_priority_paths_get_notifications(plc: FakePlc, rig) -> None:
    engine, dm, _ = rig
    await engine.set_priority_paths({"MAIN/nCounter", "MAIN/stMotor"})
    # nCounter plus the five stored members of stMotor.
    assert plc.notification_count == 6
    assert engine.subscription_status()["priority_paths"] == ["MAIN/nCounter", "MAIN/stMotor"]
    plc.poke("MAIN.nCounter", "h", 7)
    await _until(lambda: dm.values.get("MAIN/nCounter") == 7)
    assert dm.priority["MAIN/nCounter"] is True

    # Demoted: the notifications go, the poll picks the variable up again.
    await engine.set_priority_paths(set())
    assert plc.notification_count == 0
    plc.poke("MAIN.nCounter", "h", 8)
    await _until(lambda: dm.values.get("MAIN/nCounter") == 8)
    assert dm.priority["MAIN/nCounter"] is False


@pytest.mark.asyncio
async def test_a_promoted_value_is_published_at_once(plc: FakePlc, rig) -> None:
    engine, dm, _ = rig
    plc.poke("GVL.nBig", "Q", 2**60)
    await _until(lambda: dm.values.get("GVL/nBig") == str(2**60))
    await engine.set_priority_paths({"GVL/nBig"})
    assert dm.priority["GVL/nBig"] is True


@pytest.mark.asyncio
async def test_removed_variable_is_no_longer_read(plc: FakePlc, rig) -> None:
    engine, dm, _ = rig
    await engine.set_priority_paths({"MAIN/bStart"})
    assert await engine.remove_subscription_by_path(DS, "MAIN/bStart") is True
    assert plc.notification_count == 0
    dm.values.clear()
    plc.poke("MAIN.bStart", "?", True)
    sums = plc.sum_reads
    await _until(lambda: plc.sum_reads >= sums + 2)
    assert "MAIN/bStart" not in dm.values

    await engine.add_subscription_by_path("MAIN/bStart", dm.entry)
    await _until(lambda: dm.values.get("MAIN/bStart") is True)


@pytest.mark.asyncio
async def test_an_online_change_reresolves_every_address(plc: FakePlc, rig) -> None:
    engine, dm, _ = rig
    await engine.set_priority_paths({"MAIN/nCounter"})
    # The new program moves nCounter and drops everything else.
    plc.online_change(symbol_entry("MAIN.nCounter", 600, 2, "INT"), b"")
    await _until(lambda: plc.notification_count == 1)
    plc.write_memory(600, struct.pack("<h", 321))
    await _until(lambda: dm.values.get("MAIN/nCounter") == 321)
    assert engine.connected


@pytest.mark.asyncio
async def test_reconnects_after_the_connection_drops(plc: FakePlc, rig) -> None:
    engine, dm, statuses = rig
    plc.drop_connections()
    await _until(lambda: statuses == [True, False, True])
    assert engine.connected
    plc.poke("MAIN.nCounter", "h", 5)
    await _until(lambda: dm.values.get("MAIN/nCounter") == 5)


@pytest.mark.asyncio
async def test_browse(plc: FakePlc, rig) -> None:
    engine, _dm, _ = rig
    tree = await engine.browse()
    assert tree["display_name"] == "Plc30 App"
    assert tree["show_root"] is False
    assert [c["node_id"] for c in tree["children"]] == ["MAIN", "GVL"]
    assert "present_outside_browse" not in tree

    progress: list[dict] = []
    gvl = await engine.browse("GVL", on_progress=progress.append)
    assert gvl["show_root"] is True
    assert [c["node_id"] for c in gvl["children"]] == ["GVL.sVersion", "GVL.nBig"]
    # Saved variables outside the root still exist on the PLC.
    assert "MAIN.nCounter" in gvl["present_outside_browse"]
    assert progress[-1]["done"] == progress[-1]["total"]


@pytest.mark.asyncio
async def test_unreachable_device_reports_why(plc: FakePlc) -> None:
    port = plc.port
    await plc.stop()
    engine = DatasourceAdsEngine(DS)
    await engine.connect({"host": "127.0.0.1", "tcp_port": port, "connect_timeout_s": 1})
    try:
        await _until(lambda: engine.error is not None)
        assert engine.connected is False
        assert await engine.read_current_values({"MAIN/nCounter"}) == {}
        with pytest.raises(RuntimeError):
            await engine.write_node("MAIN.nCounter", 1)
    finally:
        await engine.disconnect()
