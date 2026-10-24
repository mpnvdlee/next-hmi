"""A saved variable the browse did not reach is checked, not assumed gone.

A browse below an explicit root walks only part of the server. Every saved
variable outside it that the server still has is reported as
present_outside_browse, so a re-browse cannot list it as removed or turn it
stale.
"""

import contextlib
import socket
from collections.abc import AsyncIterator
from typing import Any

import pytest
from asyncua import Client, Server, ua
from opcua.browse import AddressSpaceBrowser
from opcua.client_pool import DatasourceOpcuaEngine
from opcua.limits import OperationLimits
from services.datasource_manager import DatasourceEntry, DatasourceManager

SERVER = "i=2253"
SERVER_STATUS = "i=2256"
CURRENT_TIME = "i=2258"
NS_URI = "http://nexthmi/saved-outside"


def _free_url() -> str:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"opc.tcp://127.0.0.1:{port}/nexthmi/saved-outside/"


@contextlib.asynccontextmanager
async def _live_server() -> AsyncIterator[str]:
    """Plant → Speed/Running, and a DI-style DeviceSet in its own namespace."""
    url = _free_url()
    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace(NS_URI)
    di = await server.register_namespace("http://opcfoundation.org/UA/DI/")
    plant = await server.nodes.objects.add_folder(ua.NodeId("Plant", idx), "Plant")
    await plant.add_variable(ua.NodeId("Plant.Speed", idx), "Speed", 1.5)
    await plant.add_variable(ua.NodeId("Plant.Running", idx), "Running", True)
    devices = await server.nodes.objects.add_object(ua.NodeId(5001, di), "DeviceSet")
    await devices.add_variable(ua.NodeId("Device.Serial", idx), "SerialNumber", "SN-1")
    await server.start()
    try:
        yield url
    finally:
        await server.stop()


async def _plant_speed(client: Client) -> str:
    idx = await client.get_namespace_index(NS_URI)
    return ua.NodeId("Plant.Speed", idx).to_string()


def _ids(entry: dict) -> set[str]:
    return {entry["node_id"]} | {i for c in entry.get("children", []) for i in _ids(c)}


def _engine_with_saved(variables: list[dict[str, Any]]) -> DatasourceOpcuaEngine:
    engine = DatasourceOpcuaEngine("PLC")
    manager = DatasourceManager()
    manager.datasources["PLC"] = DatasourceEntry(
        {"name": "PLC", "type": "opcua-client", "variables": variables}
    )
    engine.set_datasource_manager(manager)
    return engine


def _var(node_id: str, name: str, **extra: Any) -> dict[str, Any]:
    return {
        "kind": "variable",
        "node_id": node_id,
        "display_name": name,
        "data_type": "Double",
        "enabled": True,
        **extra,
    }


@pytest.mark.asyncio
async def test_a_saved_variable_outside_the_root_is_present_and_a_removed_one_is_not():
    async with _live_server() as url, Client(url) as client:
        plc_speed = await _plant_speed(client)
        plant = plc_speed.replace("Plant.Speed", "Plant")
        gone = plc_speed.replace("Plant.Speed", "Plant.Removed")
        engine = _engine_with_saved(
            [
                _var(CURRENT_TIME, "CurrentTime", data_type="DateTime"),
                {
                    "kind": "folder",
                    "name": "Plant",
                    "children": [_var(plc_speed, "Speed"), _var(gone, "Removed")],
                },
            ]
        )
        engine.attach_client(client, {"browse_root_node": plant})
        tree = await engine.browse()

    assert plc_speed in _ids(tree)
    assert tree["present_outside_browse"] == [CURRENT_TIME]


@pytest.mark.asyncio
async def test_a_default_browse_that_reaches_every_saved_variable_reports_none():
    async with _live_server() as url, Client(url) as client:
        engine = _engine_with_saved([_var(await _plant_speed(client), "Speed")])
        engine.attach_client(client, {})
        tree = await engine.browse()

    assert "present_outside_browse" not in tree


@pytest.mark.asyncio
async def test_saved_variables_outside_an_explicit_root_are_present_not_gone():
    """Browsing Server on its own, to refresh its tags, must not report the
    PLC's tags as removed either."""
    async with _live_server() as url, Client(url) as client:
        plc_speed = await _plant_speed(client)
        engine = _engine_with_saved([_var(plc_speed, "Speed"), _var(CURRENT_TIME, "CurrentTime")])
        engine.attach_client(client, {"browse_root_node": SERVER})
        tree = await engine.browse()

    assert CURRENT_TIME in _ids(tree)
    assert tree["present_outside_browse"] == [plc_speed]


@pytest.mark.asyncio
async def test_a_check_that_cannot_be_read_counts_as_present():
    async with _live_server() as url, Client(url) as client:
        browser = AddressSpaceBrowser(client)

        async def refuse(_params: Any) -> Any:
            raise ua.UaStatusCodeError(ua.StatusCodes.BadTooManyOperations)

        client.uaclient.read = refuse  # type: ignore[method-assign]
        present = await browser.existing_node_ids([CURRENT_TIME, "ns=1;s=Nope"])

    assert present == [CURRENT_TIME, "ns=1;s=Nope"]


@pytest.mark.asyncio
async def test_existence_is_checked_within_the_read_budget():
    sizes: list[int] = []
    async with _live_server() as url, Client(url) as client:
        ids = [CURRENT_TIME, SERVER_STATUS, await _plant_speed(client), "ns=1;s=Nope", "not an id"]
        browser = AddressSpaceBrowser(client, OperationLimits(max_read_ops=2))
        real_read = client.uaclient.read

        async def counting(params: Any) -> Any:
            sizes.append(len(params.NodesToRead))
            return await real_read(params)

        client.uaclient.read = counting  # type: ignore[method-assign]
        present = await browser.existing_node_ids(ids)

    assert present == ids[:3]
    assert sizes == [2, 2]
