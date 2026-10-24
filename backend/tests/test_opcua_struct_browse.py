"""The browse walks into a struct tag and stops at its members.

A struct tag is a Variable node whose DataType is a custom structured type and
whose members hang off it as HasComponent children — the shape both CODESYS and
S7-1500 publish. Treating every Variable as a leaf meant the browse reported the
struct itself (as data_type "struct", which the UI renders as "String") and none
of its members, so nothing inside it could be bound.

The members' own metadata (EURange, EngineeringUnits, …) are HasProperty
children of the same node. Those describe the tag rather than being tags, so
they must stay out of the tree even though the walk now descends.
"""

import socket

import pytest
from asyncua import Client, Server, ua
from opcua.client_pool import DatasourceOpcuaEngine
from opcua.limits import read_operation_limits


def _free_url(suffix: str) -> str:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"opc.tcp://127.0.0.1:{port}/nexthmi/{suffix}/"


async def _build_server(url: str) -> tuple[Server, str, str]:
    """L1_L2_Machine_Data → Battery{SOC, Voltage, Current, Cell{Temp}} + Running."""
    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace("http://nexthmi/struct")

    types = server.get_node(ua.NodeId(ua.ObjectIds.Structure))
    battery_dt = await types.add_data_type(ua.NodeId("DT_Battery", idx), "DT_Battery")
    cell_dt = await types.add_data_type(ua.NodeId("DT_Cell", idx), "DT_Cell")

    machine = await server.nodes.objects.add_object(
        ua.NodeId("L1_L2_Machine_Data", idx), "L1_L2_Machine_Data"
    )
    battery = await machine.add_variable(
        ua.NodeId("Battery", idx),
        "Battery",
        ua.Variant(None, ua.VariantType.ExtensionObject),
        datatype=battery_dt.nodeid,
    )
    for name, value in (("SOC", 82.5), ("Voltage", 48.2), ("Current", 12.0)):
        member = await battery.add_variable(
            ua.NodeId(f"Battery.{name}", idx), name, ua.Variant(value, ua.VariantType.Float)
        )
        await member.set_writable(True)

    # Metadata, not a tag: HasProperty rather than HasComponent.
    await battery.add_property(
        ua.NodeId("Battery.EURange", idx), "EURange", ua.Variant(0.0, ua.VariantType.Double)
    )

    # A nested struct, so the walk has to recurse rather than go one level deep.
    cell = await battery.add_variable(
        ua.NodeId("Battery.Cell", idx),
        "Cell",
        ua.Variant(None, ua.VariantType.ExtensionObject),
        datatype=cell_dt.nodeid,
    )
    await cell.add_variable(
        ua.NodeId("Battery.Cell.Temp", idx), "Temp", ua.Variant(31.4, ua.VariantType.Float)
    )

    await machine.add_variable(
        ua.NodeId("Running", idx), "Running", ua.Variant(True, ua.VariantType.Boolean)
    )

    # Server-defined types that are NOT structs, in the same namespace as the
    # struct types — the namespace alone cannot tell them apart. A CODESYS
    # ENUM is a subtype of Enumeration; a derived scalar subtypes a builtin.
    enum_dt = await server.get_node(ua.NodeId(ua.ObjectIds.Enumeration)).add_data_type(
        ua.NodeId("E_ControlState", idx), "E_ControlState"
    )
    await machine.add_variable(
        ua.NodeId("eControlState", idx),
        "eControlState",
        ua.Variant(0, ua.VariantType.Int32),
        datatype=enum_dt.nodeid,
    )
    name_dt = await server.get_node(ua.NodeId(ua.ObjectIds.String)).add_data_type(
        ua.NodeId("T_Name", idx), "T_Name"
    )
    await machine.add_variable(
        ua.NodeId("sName", idx),
        "sName",
        ua.Variant("robot", ua.VariantType.String),
        datatype=name_dt.nodeid,
    )
    return server, machine.nodeid.to_string(), battery.nodeid.to_string()


def _child(entry: dict, name: str) -> dict | None:
    for child in entry.get("children", []):
        if child["display_name"] == name:
            return child
    return None


def _names(entry: dict) -> set[str]:
    return {child["display_name"] for child in entry.get("children", [])}


async def _browse(url: str, root_node_id: str) -> dict:
    engine = DatasourceOpcuaEngine("struct-test")
    async with Client(url) as client:
        engine.attach_client(
            client,
            {"browse_root_node": root_node_id},
            operation_limits=await read_operation_limits(client),
        )
        return await engine.browse()


@pytest.mark.asyncio
async def test_browse_descends_into_a_struct_tag():
    url = _free_url("struct-members")
    server, machine_id, _ = await _build_server(url)
    await server.start()
    try:
        root = await _browse(url, machine_id)
    finally:
        await server.stop()

    battery = _child(root, "Battery")
    assert battery is not None
    # The struct keeps its own identity: a bindable node with a struct type.
    assert battery["data_type"] == "struct"
    assert battery["node_id"]
    # ...and now carries its members.
    assert {"SOC", "Voltage", "Current", "Cell"} <= _names(battery)
    soc = _child(battery, "SOC")
    assert soc["data_type"] == "Float"
    assert soc["writable"] is True
    # A plain sibling on the same level is unaffected.
    assert _child(root, "Running")["data_type"] == "Boolean"


@pytest.mark.asyncio
async def test_browse_recurses_through_a_nested_struct():
    url = _free_url("struct-nested")
    server, machine_id, _ = await _build_server(url)
    await server.start()
    try:
        root = await _browse(url, machine_id)
    finally:
        await server.stop()

    cell = _child(_child(root, "Battery"), "Cell")
    assert cell is not None
    assert cell["data_type"] == "struct"
    assert _child(cell, "Temp")["data_type"] == "Float"


@pytest.mark.asyncio
async def test_struct_properties_are_not_bindable_rows():
    """EURange is a HasProperty child — metadata, not a member."""
    url = _free_url("struct-properties")
    server, machine_id, battery_id = await _build_server(url)
    await server.start()
    try:
        root = await _browse(url, machine_id)
        # The server really does expose it, so its absence below is the filter
        # working rather than the node not being there.
        async with Client(url) as client:
            children = await client.get_node(battery_id).get_children()
            exposed = {(await c.read_browse_name()).Name for c in children}
    finally:
        await server.stop()

    assert "EURange" in exposed
    assert "EURange" not in _names(_child(root, "Battery"))


@pytest.mark.asyncio
async def test_a_struct_browsed_as_the_root_still_yields_its_members():
    """browse_root_node pointed straight at a struct used to return a bare leaf."""
    url = _free_url("struct-as-root")
    server, _, battery_id = await _build_server(url)
    await server.start()
    try:
        root = await _browse(url, battery_id)
    finally:
        await server.stop()

    assert root["data_type"] == "struct"
    assert {"SOC", "Voltage", "Current", "Cell"} <= _names(root)
    assert "EURange" not in _names(root)


@pytest.mark.asyncio
async def test_a_scalar_variable_is_still_a_leaf():
    """Only structs are worth a second Browse; a scalar must not sprout rows."""
    url = _free_url("struct-scalar-leaf")
    server, machine_id, _ = await _build_server(url)
    await server.start()
    try:
        root = await _browse(url, machine_id)
    finally:
        await server.stop()

    assert _child(root, "Running")["children"] == []
    soc = _child(_child(root, "Battery"), "SOC")
    assert soc["children"] == []


@pytest.mark.asyncio
async def test_a_plc_enum_is_a_bindable_integer_not_a_struct():
    """A server-defined ENUM shares the struct types' namespace.

    Reporting it as "struct" used to be cosmetic (it showed as String). Once a
    struct became a folder on import, it would have made every PLC enum
    unbindable — so the type is resolved through its HasSubtype chain.
    """
    url = _free_url("struct-enum")
    server, machine_id, _ = await _build_server(url)
    await server.start()
    try:
        root = await _browse(url, machine_id)
    finally:
        await server.stop()

    state = _child(root, "eControlState")
    assert state["data_type"] == "Int32"
    assert state["children"] == []


@pytest.mark.asyncio
async def test_a_derived_scalar_resolves_to_its_builtin():
    url = _free_url("struct-derived")
    server, machine_id, _ = await _build_server(url)
    await server.start()
    try:
        root = await _browse(url, machine_id)
    finally:
        await server.stop()

    name = _child(root, "sName")
    assert name["data_type"] == "String"
    assert name["children"] == []


@pytest.mark.asyncio
async def test_a_derived_standard_type_resolves_to_its_builtin():
    """Duration and UtcTime live in namespace 0 but are not builtins.

    Their ids lie past the builtin range, so the namespace alone used to
    label them "struct": a PLC's TIME or timestamp tag imported as a folder.
    """
    url = _free_url("struct-ns0-derived")
    server, machine_id, _ = await _build_server(url)
    machine = server.get_node(machine_id)
    idx = machine.nodeid.NamespaceIndex
    for name, dt_id, value, variant in (
        ("tCycle", ua.ObjectIds.Duration, 250.0, ua.VariantType.Double),
        ("dtStamp", ua.ObjectIds.UtcTime, None, ua.VariantType.DateTime),
        ("nCount", ua.ObjectIds.Counter, 7, ua.VariantType.UInt32),
    ):
        await machine.add_variable(
            ua.NodeId(name, idx),
            name,
            ua.Variant(value, variant),
            datatype=ua.NodeId(dt_id),
        )
    await server.start()
    try:
        root = await _browse(url, machine_id)
    finally:
        await server.stop()

    assert _child(root, "tCycle")["data_type"] == "Double"
    assert _child(root, "dtStamp")["data_type"] == "DateTime"
    assert _child(root, "nCount")["data_type"] == "UInt32"
    for name in ("tCycle", "dtStamp", "nCount"):
        assert _child(root, name)["children"] == []


@pytest.mark.asyncio
async def test_the_standard_decimal_type_is_not_resolved_to_double():
    """Decimal derives from Number, so HasSubtype reads it as Double, but it
    travels as an ExtensionObject: a Double write to it is refused."""
    url = _free_url("struct-ns0-decimal")
    server, machine_id, _ = await _build_server(url)
    machine = server.get_node(machine_id)
    await machine.add_variable(
        ua.NodeId("decPrice", machine.nodeid.NamespaceIndex),
        "decPrice",
        ua.Variant(None, ua.VariantType.ExtensionObject),
        datatype=ua.NodeId(ua.ObjectIds.Decimal),
    )
    await server.start()
    try:
        root = await _browse(url, machine_id)
    finally:
        await server.stop()

    assert _child(root, "decPrice")["data_type"] == "Decimal"
    assert _child(root, "decPrice")["children"] == []


@pytest.mark.asyncio
async def test_a_server_type_derived_from_decimal_stays_decimal():
    """The HasSubtype walk stops at Decimal rather than at the Number above it."""
    url = _free_url("struct-derived-decimal")
    server, machine_id, _ = await _build_server(url)
    machine = server.get_node(machine_id)
    idx = machine.nodeid.NamespaceIndex
    money_dt = await server.get_node(ua.NodeId(ua.ObjectIds.Decimal)).add_data_type(
        ua.NodeId("T_Money", idx), "T_Money"
    )
    await machine.add_variable(
        ua.NodeId("mPrice", idx),
        "mPrice",
        ua.Variant(None, ua.VariantType.ExtensionObject),
        datatype=money_dt.nodeid,
    )
    await server.start()
    try:
        root = await _browse(url, machine_id)
    finally:
        await server.stop()

    assert _child(root, "mPrice")["data_type"] == "Decimal"
    assert _child(root, "mPrice")["children"] == []
