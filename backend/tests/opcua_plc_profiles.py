"""Address spaces shaped like the OPC UA servers of common PLC brands.

These are not the vendors' servers. Each profile reproduces the *conventions*
its vendor's server is known for — how NodeIds are spelled, how a variable
list hangs off its parent, how structs, enums and arrays are published — on an
in-process asyncua server, so the whole datasource pipeline can be exercised
against every shape without a PLC on the bench.

Every node gets an explicit NodeId and every profile registers its namespaces
in the same order, so a browse of a profile is deterministic. That is what
lets ``opcuaBrowseProfiles.json`` pin it as a contract both halves of the app
are tested against:

    backend   live browse of the profile    == fixture[profile]["browse"]
    frontend  buildFromBrowse(browse)       == fixture[profile]["tree"]
    backend   fixture[profile]["tree"] as a datasource config, against the
              live server: read, subscribe and write all work

Regenerate deliberately, never to make a red test green without reading the
diff: ``python -m tests.opcua_plc_profiles`` (from ``backend/``) rewrites the
``browse`` halves; the frontend test's ``NEXTHMI_WRITE_FIXTURE=1`` run
rewrites the ``tree`` halves from the real ``buildFromBrowse``.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import socket
import sys
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from asyncua import Server, ua
from asyncua.common.node import Node
from asyncua.server.internal_session import InternalSession

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "shared"
    / "types"
    / "__fixtures__"
    / "opcuaBrowseProfiles.json"
)

# ── Building blocks ───────────────────────────────────────────────────────────


@dataclass
class Leaf:
    """What a scalar or array tag must look like after a browse."""

    value: Any
    data_type: str
    writable: bool
    array_length: int | None = None  # None: scalar; 0: dynamic; >0: fixed
    # A value the E2E test writes, then reads back from the server.
    write: Any = None


@dataclass
class Profile:
    name: str
    title: str
    # Namespaces to register; the profile's own is the last one, so its index
    # is len(namespaces) + 1 — chosen to match the vendor (CODESYS 4, S7 3, …).
    namespaces: list[str]
    build: Callable[[Server, int], Awaitable[str]]
    # Display-name path (excluding the browse root) → expected leaf.
    leaves: dict[tuple[str, ...], Leaf] = field(default_factory=dict)
    # Paths that must be a struct carrying exactly these member names.
    structs: dict[tuple[str, ...], set[str]] = field(default_factory=dict)
    # Paths that must be plain folders (Objects) with exactly these children.
    folders: dict[tuple[str, ...], set[str]] = field(default_factory=dict)
    # Paths that must not appear: methods, metadata properties.
    absent: list[tuple[str, ...]] = field(default_factory=list)
    # Enforce MaxNodesPerRead the way the vendor does (CODESYS: 100).
    max_nodes_per_read: int | None = None


async def _register(server: Server, namespaces: list[str]) -> int:
    idx = 0
    for uri in namespaces:
        idx = await server.register_namespace(uri)
    return idx


async def _struct_type(server: Server, idx: int, name: str) -> ua.NodeId:
    base = server.get_node(ua.NodeId(ua.ObjectIds.Structure))
    return (await base.add_data_type(ua.NodeId(f"DT:{name}", idx), name)).nodeid


async def _enum_type(server: Server, idx: int, name: str) -> ua.NodeId:
    base = server.get_node(ua.NodeId(ua.ObjectIds.Enumeration))
    return (await base.add_data_type(ua.NodeId(f"DT:{name}", idx), name)).nodeid


async def _var(
    parent: Node,
    nid: ua.NodeId,
    name: str,
    value: Any,
    vtype: ua.VariantType,
    *,
    writable: bool = False,
    datatype: ua.NodeId | None = None,
    array_length: int | None = None,
) -> Node:
    var = await parent.add_variable(nid, name, ua.Variant(value, vtype), datatype=datatype)
    if array_length is not None:
        await var.write_value_rank(1)
        await var.write_array_dimensions([array_length])
    await var.set_writable(writable)
    return var


async def _struct(
    parent: Node, nid: ua.NodeId, name: str, datatype: ua.NodeId, *, array: bool = False
) -> Node:
    var = await parent.add_variable(
        nid, name, ua.Variant(None, ua.VariantType.ExtensionObject), datatype=datatype
    )
    if array:
        await var.write_value_rank(1)
        await var.write_array_dimensions([0])
    return var


async def _organize(parent: Node, child: Node) -> None:
    """Re-link *child* by Organizes, the way PLC servers attach variable lists."""
    await parent.delete_reference(child, ua.ObjectIds.HasComponent)
    await parent.add_reference(child, ua.ObjectIds.Organizes, forward=True, bidirectional=True)


# ── CODESYS Control (V3) ──────────────────────────────────────────────────────
# String NodeIds `|var|<device>.Application.<GVL>.<name>` in ns=4; a GVL hangs
# off the application by Organizes; ENUMs are subtypes of Enumeration in the
# same namespace as STRUCTs; MaxNodesPerRead = 100 — a 28-tag GVL overflows a
# 4-attribute-per-tag read.

_CDS = "|var|CODESYS Control Win V3 x64.Application"


async def _build_codesys(server: Server, idx: int) -> str:
    app = await server.nodes.objects.add_object(ua.NodeId(f"{_CDS}", idx), "Application")
    gvl = await app.add_object(ua.NodeId(f"{_CDS}.GVL_Robot", idx), "GVL_Robot")
    await _organize(app, gvl)
    n = lambda tag: ua.NodeId(f"{_CDS}.GVL_Robot.{tag}", idx)  # noqa: E731

    e_state = await _enum_type(server, idx, "E_ControlState")
    dt_axis = await _struct_type(server, idx, "DT_Axis")
    tags = [
        await _var(gvl, n("bAlarm"), "bAlarm", False, ua.VariantType.Boolean, writable=True),
        await _var(gvl, n("bCommsError"), "bCommsError", True, ua.VariantType.Boolean),
        await _var(gvl, n("eControlState"), "eControlState", 0, ua.VariantType.Int32,
                   writable=True, datatype=e_state),
        await _var(gvl, n("sDiag"), "sDiag", "Geen Modbus-verbinding", ua.VariantType.String),
        await _var(gvl, n("rSpeed"), "rSpeed", 1.5, ua.VariantType.Float, writable=True),
        await _var(gvl, n("lrPosition"), "lrPosition", 12.25, ua.VariantType.Double, writable=True),
        await _var(gvl, n("aTemps"), "aTemps", [20.0, 21.0, 22.0, 23.0], ua.VariantType.Float,
                   writable=True, array_length=4),
    ]
    axis = await _struct(gvl, n("stAxis"), "stAxis", dt_axis)
    await _var(axis, n("stAxis.rPos"), "rPos", 0.5, ua.VariantType.Float, writable=True)
    await _var(axis, n("stAxis.bHomed"), "bHomed", True, ua.VariantType.Boolean)
    await axis.add_property(n("stAxis.EURange"), "EURange", ua.Variant(0.0, ua.VariantType.Double))
    # Enough plain inputs that one level of attribute reads exceeds 100 ops.
    for i in range(20):
        tags.append(
            await _var(gvl, n(f"xIn{i:02d}"), f"xIn{i:02d}", False, ua.VariantType.Boolean)
        )
    for tag in tags:
        await _organize(gvl, tag)
    await _organize(gvl, axis)
    return app.nodeid.to_string()


CODESYS = Profile(
    name="codesys",
    title="CODESYS Control V3",
    namespaces=["urn:cds:DeviceSet", "urn:cds:Types", "urn:cds:Application"],
    build=_build_codesys,
    leaves={
        ("GVL_Robot", "bAlarm"): Leaf(False, "Boolean", True, write=True),
        ("GVL_Robot", "bCommsError"): Leaf(True, "Boolean", False),
        ("GVL_Robot", "eControlState"): Leaf(0, "Int32", True, write=2),
        ("GVL_Robot", "sDiag"): Leaf("Geen Modbus-verbinding", "String", False),
        ("GVL_Robot", "rSpeed"): Leaf(1.5, "Float", True, write=2.5),
        ("GVL_Robot", "lrPosition"): Leaf(12.25, "Double", True, write=99.125),
        ("GVL_Robot", "aTemps"): Leaf([20.0, 21.0, 22.0, 23.0], "Float", True, array_length=4),
        ("GVL_Robot", "stAxis", "rPos"): Leaf(0.5, "Float", True, write=7.5),
        ("GVL_Robot", "stAxis", "bHomed"): Leaf(True, "Boolean", False),
        **{("GVL_Robot", f"xIn{i:02d}"): Leaf(False, "Boolean", False) for i in range(20)},
    },
    structs={("GVL_Robot", "stAxis"): {"rPos", "bHomed"}},
    folders={("GVL_Robot",): {
        "bAlarm", "bCommsError", "eControlState", "sDiag", "rSpeed", "lrPosition", "aTemps",
        "stAxis", *{f"xIn{i:02d}" for i in range(20)},
    }},
    absent=[("GVL_Robot", "stAxis", "EURange")],
    max_nodes_per_read=100,
)


# ── Siemens SIMATIC S7-1500 ───────────────────────────────────────────────────
# String NodeIds with quoted names `"DB"."member"` in ns=3; global DBs under a
# DataBlocksGlobal folder, I/O under Inputs/Outputs; a UDT is a Variable whose
# members are HasComponent children, and UDTs nest. S7 types map onto OPC UA
# builtins: Real→Float, LReal→Double, Int→Int16, DInt→Int32, LInt→Int64,
# Word→UInt16, DWord→UInt32, ULInt→UInt64, SInt→SByte, USInt→Byte.


async def _build_s7(server: Server, idx: int) -> str:
    plc = await server.nodes.objects.add_object(ua.NodeId("PLC_1", idx), "PLC_1")
    dbs = await plc.add_folder(ua.NodeId("DataBlocksGlobal", idx), "DataBlocksGlobal")
    inputs = await plc.add_folder(ua.NodeId("Inputs", idx), "Inputs")
    outputs = await plc.add_folder(ua.NodeId("Outputs", idx), "Outputs")
    db = await dbs.add_object(ua.NodeId('"DB_Machine"', idx), "DB_Machine")
    q = lambda *names: ua.NodeId(".".join(f'"{x}"' for x in names), idx)  # noqa: E731

    udt_battery = await _struct_type(server, idx, "UDT_Battery")
    udt_cell = await _struct_type(server, idx, "UDT_Cell")
    battery = await _struct(db, q("DB_Machine", "Battery"), "Battery", udt_battery)
    await _var(battery, q("DB_Machine", "Battery", "SOC"), "SOC", 82.5, ua.VariantType.Float,
               writable=True)
    await _var(battery, q("DB_Machine", "Battery", "Voltage"), "Voltage", 48.2,
               ua.VariantType.Float, writable=True)
    await _var(battery, q("DB_Machine", "Battery", "Current"), "Current", 12.0,
               ua.VariantType.Float)
    cell = await _struct(battery, q("DB_Machine", "Battery", "Cell"), "Cell", udt_cell)
    await _var(cell, q("DB_Machine", "Battery", "Cell", "Temp"), "Temp", 31.5,
               ua.VariantType.Float)

    scalars = [
        ("Running", True, ua.VariantType.Boolean, True),
        ("Counter", 1000, ua.VariantType.Int32, True),  # DInt
        ("Mode", 3, ua.VariantType.Int16, True),  # Int
        ("Status", 0x00FF, ua.VariantType.UInt16, True),  # Word
        ("Flags", 0xDEADBEEF, ua.VariantType.UInt32, False),  # DWord
        ("Energy", 2**40, ua.VariantType.Int64, True),  # LInt
        ("Hours", 2**40, ua.VariantType.UInt64, False),  # ULInt
        ("Offset", -5, ua.VariantType.SByte, True),  # SInt
        ("Level", 200, ua.VariantType.Byte, True),  # USInt
        ("Pressure", 1.0123456789, ua.VariantType.Double, True),  # LReal
        ("Recipe", "Pils", ua.VariantType.String, True),
    ]
    for name, value, vtype, writable in scalars:
        await _var(db, q("DB_Machine", name), name, value, vtype, writable=writable)
    await _var(db, q("DB_Machine", "Levels"), "Levels", [0.0] * 8, ua.VariantType.Float,
               writable=True, array_length=8)
    await _var(inputs, ua.NodeId('"I_Start"', idx), "I_Start", False, ua.VariantType.Boolean)
    await _var(outputs, ua.NodeId('"Q_Motor"', idx), "Q_Motor", False, ua.VariantType.Boolean,
               writable=True)
    return plc.nodeid.to_string()


S7_1500 = Profile(
    name="s7_1500",
    title="Siemens SIMATIC S7-1500",
    namespaces=["urn:siemens:simatic", "urn:siemens:PLC_1"],
    build=_build_s7,
    leaves={
        ("DataBlocksGlobal", "DB_Machine", "Battery", "SOC"): Leaf(82.5, "Float", True, write=40.0),
        ("DataBlocksGlobal", "DB_Machine", "Battery", "Voltage"): Leaf(48.2, "Float", True),
        ("DataBlocksGlobal", "DB_Machine", "Battery", "Current"): Leaf(12.0, "Float", False),
        ("DataBlocksGlobal", "DB_Machine", "Battery", "Cell", "Temp"): Leaf(31.5, "Float", False),
        ("DataBlocksGlobal", "DB_Machine", "Running"): Leaf(True, "Boolean", True, write=False),
        ("DataBlocksGlobal", "DB_Machine", "Counter"): Leaf(1000, "Int32", True, write=-7),
        ("DataBlocksGlobal", "DB_Machine", "Mode"): Leaf(3, "Int16", True, write=12),
        ("DataBlocksGlobal", "DB_Machine", "Status"): Leaf(0x00FF, "UInt16", True, write=65535),
        ("DataBlocksGlobal", "DB_Machine", "Flags"): Leaf(0xDEADBEEF, "UInt32", False),
        ("DataBlocksGlobal", "DB_Machine", "Energy"): Leaf(2**40, "Int64", True, write=2**41),
        ("DataBlocksGlobal", "DB_Machine", "Hours"): Leaf(2**40, "UInt64", False),
        ("DataBlocksGlobal", "DB_Machine", "Offset"): Leaf(-5, "SByte", True, write=-128),
        ("DataBlocksGlobal", "DB_Machine", "Level"): Leaf(200, "Byte", True, write=255),
        ("DataBlocksGlobal", "DB_Machine", "Pressure"): Leaf(1.0123456789, "Double", True,
                                                             write=2.5),
        ("DataBlocksGlobal", "DB_Machine", "Recipe"): Leaf("Pils", "String", True, write="Weizen"),
        ("DataBlocksGlobal", "DB_Machine", "Levels"): Leaf([0.0] * 8, "Float", True,
                                                           array_length=8),
        ("Inputs", "I_Start"): Leaf(False, "Boolean", False),
        ("Outputs", "Q_Motor"): Leaf(False, "Boolean", True, write=True),
    },
    structs={
        ("DataBlocksGlobal", "DB_Machine", "Battery"): {"SOC", "Voltage", "Current", "Cell"},
        ("DataBlocksGlobal", "DB_Machine", "Battery", "Cell"): {"Temp"},
    },
    folders={
        (): {"DataBlocksGlobal", "Inputs", "Outputs"},
        ("DataBlocksGlobal",): {"DB_Machine"},
    },
)


# ── Beckhoff TwinCAT 3 (TF6100) ───────────────────────────────────────────────
# String NodeIds `<POU>.<symbol>` in ns=4 under a PLC1 object; LREAL→Double,
# INT→Int16; nested STRUCTs; dynamic arrays; methods of a POU exposed as
# Method nodes — callable, never a tag.


async def _build_twincat(server: Server, idx: int) -> str:
    plc = await server.nodes.objects.add_object(ua.NodeId("PLC1", idx), "PLC1")
    main = await plc.add_object(ua.NodeId("MAIN", idx), "MAIN")
    gvl = await plc.add_object(ua.NodeId("GVL", idx), "GVL")
    s = lambda sym: ua.NodeId(sym, idx)  # noqa: E731

    st_motor = await _struct_type(server, idx, "ST_Motor")
    st_limits = await _struct_type(server, idx, "ST_Limits")
    e_state = await _enum_type(server, idx, "E_State")

    await _var(main, s("MAIN.bStart"), "bStart", False, ua.VariantType.Boolean, writable=True)
    await _var(main, s("MAIN.nCounter"), "nCounter", 0, ua.VariantType.Int16, writable=True)
    await _var(main, s("MAIN.fSpeed"), "fSpeed", 0.0, ua.VariantType.Double, writable=True)
    await _var(main, s("MAIN.eState"), "eState", 1, ua.VariantType.Int32, writable=True,
               datatype=e_state)
    motor = await _struct(main, s("MAIN.stMotor"), "stMotor", st_motor)
    await _var(motor, s("MAIN.stMotor.fActualSpeed"), "fActualSpeed", 1450.0,
               ua.VariantType.Double)
    await _var(motor, s("MAIN.stMotor.bRunning"), "bRunning", True, ua.VariantType.Boolean)
    limits = await _struct(motor, s("MAIN.stMotor.stLimits"), "stLimits", st_limits)
    await _var(limits, s("MAIN.stMotor.stLimits.fMin"), "fMin", 0.0, ua.VariantType.Double,
               writable=True)
    await _var(limits, s("MAIN.stMotor.stLimits.fMax"), "fMax", 3000.0, ua.VariantType.Double,
               writable=True)

    async def _reset(parent: Any) -> list:
        return []

    await main.add_method(s("MAIN#M_Reset"), "M_Reset", _reset, [], [])

    await _var(gvl, s("GVL.aBuffer"), "aBuffer", [1, 2, 3], ua.VariantType.UInt16,
               writable=True, array_length=0)
    await _var(gvl, s("GVL.sVersion"), "sVersion", "3.1.4024", ua.VariantType.String)
    return plc.nodeid.to_string()


TWINCAT = Profile(
    name="twincat",
    title="Beckhoff TwinCAT 3",
    namespaces=["urn:beckhoff:types", "urn:beckhoff:system", "urn:beckhoff:PLC1"],
    build=_build_twincat,
    leaves={
        ("MAIN", "bStart"): Leaf(False, "Boolean", True, write=True),
        ("MAIN", "nCounter"): Leaf(0, "Int16", True, write=-32768),
        ("MAIN", "fSpeed"): Leaf(0.0, "Double", True, write=1500.5),
        ("MAIN", "eState"): Leaf(1, "Int32", True, write=3),
        ("MAIN", "stMotor", "fActualSpeed"): Leaf(1450.0, "Double", False),
        ("MAIN", "stMotor", "bRunning"): Leaf(True, "Boolean", False),
        ("MAIN", "stMotor", "stLimits", "fMin"): Leaf(0.0, "Double", True),
        ("MAIN", "stMotor", "stLimits", "fMax"): Leaf(3000.0, "Double", True, write=2800.0),
        ("GVL", "aBuffer"): Leaf([1, 2, 3], "UInt16", True, array_length=0),
        ("GVL", "sVersion"): Leaf("3.1.4024", "String", False),
    },
    structs={
        ("MAIN", "stMotor"): {"fActualSpeed", "bRunning", "stLimits"},
        ("MAIN", "stMotor", "stLimits"): {"fMin", "fMax"},
    },
    folders={
        ("MAIN",): {"bStart", "nCounter", "fSpeed", "eState", "stMotor"},
        ("GVL",): {"aBuffer", "sVersion"},
    },
    absent=[("MAIN", "M_Reset")],
)


# ── Kepware KEPServerEX (e.g. fronting an Allen-Bradley ControlLogix) ─────────
# String NodeIds `<Channel>.<Device>.<Tag>` in ns=2, channel/device/tag-group
# folders; flat tags, no structs; system tags start with an underscore and are
# ordinary readable/writable tags.


async def _build_kepware(server: Server, idx: int) -> str:
    channel = await server.nodes.objects.add_folder(ua.NodeId("Channel1", idx), "Channel1")
    device = await channel.add_folder(ua.NodeId("Channel1.Device1", idx), "Device1")
    group = await device.add_folder(ua.NodeId("Channel1.Device1.Line_A", idx), "Line_A")
    system = await device.add_folder(ua.NodeId("Channel1.Device1._System", idx), "_System")
    t = lambda tag: ua.NodeId(f"Channel1.Device1.{tag}", idx)  # noqa: E731

    await _var(device, t("Run"), "Run", False, ua.VariantType.Boolean, writable=True)
    await _var(device, t("Speed"), "Speed", 1200, ua.VariantType.UInt16, writable=True)
    await _var(device, t("Total"), "Total", 123456, ua.VariantType.UInt32)
    await _var(device, t("Setpoint"), "Setpoint", 55.5, ua.VariantType.Float, writable=True)
    await _var(device, t("Batch"), "Batch", "B-0042", ua.VariantType.String, writable=True)
    await _var(device, t("Profile"), "Profile", [0.0] * 10, ua.VariantType.Float,
               writable=True, array_length=10)
    await _var(group, t("Line_A.Temp"), "Temp", 71.3, ua.VariantType.Double)
    await _var(system, t("_System._Enabled"), "_Enabled", True, ua.VariantType.Boolean,
               writable=True)
    await _var(system, t("_System._NoError"), "_NoError", True, ua.VariantType.Boolean)
    return channel.nodeid.to_string()


KEPWARE = Profile(
    name="kepware",
    title="Kepware KEPServerEX (Allen-Bradley)",
    namespaces=["KEPServerEX"],
    build=_build_kepware,
    leaves={
        ("Device1", "Run"): Leaf(False, "Boolean", True, write=True),
        ("Device1", "Speed"): Leaf(1200, "UInt16", True, write=1800),
        ("Device1", "Total"): Leaf(123456, "UInt32", False),
        ("Device1", "Setpoint"): Leaf(55.5, "Float", True, write=60.25),
        ("Device1", "Batch"): Leaf("B-0042", "String", True, write="B-0043"),
        ("Device1", "Profile"): Leaf([0.0] * 10, "Float", True, array_length=10),
        ("Device1", "Line_A", "Temp"): Leaf(71.3, "Double", False),
        ("Device1", "_System", "_Enabled"): Leaf(True, "Boolean", True, write=False),
        ("Device1", "_System", "_NoError"): Leaf(True, "Boolean", False),
    },
    folders={
        (): {"Device1"},
        ("Device1",): {"Run", "Speed", "Total", "Setpoint", "Batch", "Profile", "Line_A",
                       "_System"},
        ("Device1", "Line_A"): {"Temp"},
        ("Device1", "_System"): {"_Enabled", "_NoError"},
    },
)


# ── B&R Automation Runtime ────────────────────────────────────────────────────
# String NodeIds `::<global>` and `<Program>:<local>` in ns=6; identifiers and
# display names in any language — the HMI must carry non-ASCII end to end.


async def _build_bnr(server: Server, idx: int) -> str:
    modules = await server.nodes.objects.add_object(ua.NodeId("Modules", idx), "Modules")
    globals_ = await modules.add_object(ua.NodeId("::", idx), "Global")
    program = await modules.add_object(ua.NodeId("Program", idx), "Program")
    machine_t = await _struct_type(server, idx, "MachineType")

    machine = await _struct(globals_, ua.NodeId("::gMachine", idx), "gMachine", machine_t)
    await _var(machine, ua.NodeId("::gMachine.speed", idx), "speed", 10.0,
               ua.VariantType.Double, writable=True)
    await _var(machine, ua.NodeId("::gMachine.Füllstand", idx), "Füllstand", 64.0,
               ua.VariantType.Float)
    await _var(globals_, ua.NodeId("::gCount", idx), "gCount", 7, ua.VariantType.UInt32,
               writable=True)
    await _var(program, ua.NodeId("Program:enable", idx), "enable", False,
               ua.VariantType.Boolean, writable=True)
    await _var(program, ua.NodeId("Program:温度", idx), "温度", 36.6, ua.VariantType.Float)
    await _var(program, ua.NodeId("Program:Störmeldung", idx), "Störmeldung", "Tür offen",
               ua.VariantType.String, writable=True)
    return modules.nodeid.to_string()


BNR = Profile(
    name="bnr",
    title="B&R Automation Runtime",
    namespaces=["urn:br:1", "urn:br:2", "urn:br:3", "urn:br:4", "http://br-automation.com/OpcUa/PLC/"],
    build=_build_bnr,
    leaves={
        ("Global", "gMachine", "speed"): Leaf(10.0, "Double", True, write=12.5),
        ("Global", "gMachine", "Füllstand"): Leaf(64.0, "Float", False),
        ("Global", "gCount"): Leaf(7, "UInt32", True, write=4000000000),
        ("Program", "enable"): Leaf(False, "Boolean", True, write=True),
        ("Program", "温度"): Leaf(36.6, "Float", False),
        ("Program", "Störmeldung"): Leaf("Tür offen", "String", True, write="Tür zu ✓"),
    },
    structs={("Global", "gMachine"): {"speed", "Füllstand"}},
    folders={("Global",): {"gMachine", "gCount"}, ("Program",): {"enable", "温度", "Störmeldung"}},
)


# ── Generic server, numeric NodeIds: the edge cases ───────────────────────────
# Every builtin scalar type; a struct nested five deep; a dynamic array; an
# array of structs published as `[n]` element children; a method; a property
# on an object (kept — it is a value) and on a scalar (never browsed); a node
# reachable through two parents; and a reference cycle back to the root.

_BUILTINS: list[tuple[str, Any, ua.VariantType, Any]] = [
    ("Boolean", True, ua.VariantType.Boolean, False),
    ("SByte", -1, ua.VariantType.SByte, 127),
    ("Byte", 1, ua.VariantType.Byte, 254),
    ("Int16", -2, ua.VariantType.Int16, 32767),
    ("UInt16", 2, ua.VariantType.UInt16, 65000),
    ("Int32", -3, ua.VariantType.Int32, -2147483648),
    ("UInt32", 3, ua.VariantType.UInt32, 4294967295),
    # Beyond 2**53 a JSON number cannot carry the value exactly, so the HMI
    # sends these as strings — the form the write path accepts for them.
    ("Int64", -4, ua.VariantType.Int64, str(-(2**62))),
    ("UInt64", 4, ua.VariantType.UInt64, str(2**63)),
    ("Float", 0.5, ua.VariantType.Float, -0.25),
    ("Double", 0.125, ua.VariantType.Double, 1e300),
    ("String", "abc", ua.VariantType.String, "Ünïcødé ✓"),
    ("DateTime", datetime.datetime(2026, 1, 2, 3, 4, 5, tzinfo=datetime.UTC),
     ua.VariantType.DateTime, None),
    ("Guid", uuid.UUID("72962b91-fa75-4ae6-8d28-b404dc7daf63"), ua.VariantType.Guid, None),
    ("ByteString", b"\x00\x01", ua.VariantType.ByteString, None),
    ("LocalizedText", ua.LocalizedText("Hallo", "nl"), ua.VariantType.LocalizedText, None),
]


async def _build_generic(server: Server, idx: int) -> str:
    i = lambda n: ua.NodeId(n, idx)  # noqa: E731
    plant = await server.nodes.objects.add_folder(i(1000), "Plant")
    await plant.add_property(i(1001), "SerialNumber", ua.Variant("SN-1", ua.VariantType.String))

    types = await plant.add_folder(i(1100), "Types")
    for offset, (name, value, vtype, _) in enumerate(_BUILTINS, start=1):
        var = await _var(types, i(1100 + offset), name, value, vtype, writable=True)
        if name == "Double":
            await var.add_property(i(1190), "EURange", ua.Variant(0.0, ua.VariantType.Double))

    level_type = await _struct_type(server, idx, "Level")
    parent: Node = plant
    for depth in range(1, 6):
        parent = await _struct(parent, i(1200 + depth), f"L{depth}", level_type)
    await _var(parent, i(1299), "Value", 3.0, ua.VariantType.Double, writable=True)

    await _var(plant, i(1300), "History", [1, 2, 3, 4, 5], ua.VariantType.Int32, array_length=0)

    point_type = await _struct_type(server, idx, "Point")
    points = await _struct(plant, i(1400), "Points", point_type, array=True)
    for n in range(2):
        element = await _struct(points, i(1410 + n * 10), f"[{n}]", point_type)
        await _var(element, i(1411 + n * 10), "x", float(n), ua.VariantType.Double, writable=True)
        await _var(element, i(1412 + n * 10), "y", float(-n), ua.VariantType.Double, writable=True)

    async def _reset(parent: Any) -> list:
        return []

    # With arguments, so the method carries InputArguments/OutputArguments
    # properties — which a walk into the method would offer as tags.
    await plant.add_method(i(1500), "Reset", _reset, [ua.VariantType.Int32],
                           [ua.VariantType.Boolean])

    favorites = await plant.add_folder(i(1600), "Favorites")
    await favorites.add_reference(i(1101), ua.ObjectIds.Organizes, forward=True, bidirectional=False)
    # A cycle the way real servers make one: an event-notifier chain pointing
    # back up the tree. HasEventSource is hierarchical, so the walk follows it.
    await favorites.add_reference(plant.nodeid, ua.ObjectIds.HasEventSource, forward=True,
                                  bidirectional=False)
    return plant.nodeid.to_string()


GENERIC = Profile(
    name="generic",
    title="Generic server, numeric NodeIds (edge cases)",
    namespaces=["urn:generic:plant"],
    build=_build_generic,
    leaves={
        **{
            ("Types", name): Leaf(value, name, True, write=write)
            for name, value, _vtype, write in _BUILTINS
        },
        ("L1", "L2", "L3", "L4", "L5", "Value"): Leaf(3.0, "Double", True, write=4.0),
        ("History",): Leaf([1, 2, 3, 4, 5], "Int32", False, array_length=0),
        ("Points", "[0]", "x"): Leaf(0.0, "Double", True, write=9.0),
        ("Points", "[1]", "y"): Leaf(-1.0, "Double", True),
        ("SerialNumber",): Leaf("SN-1", "String", False),
    },
    structs={
        ("L1",): {"L2"},
        ("L1", "L2", "L3", "L4", "L5"): {"Value"},
        ("Points",): {"[0]", "[1]"},
        ("Points", "[0]"): {"x", "y"},
    },
    folders={(): {"SerialNumber", "Types", "L1", "History", "Points", "Favorites"}},
    absent=[
        ("Reset",),
        ("Reset", "InputArguments"),
        ("Reset", "OutputArguments"),
        ("Types", "Double", "EURange"),
    ],
)


# ── Exotic NodeId spellings ───────────────────────────────────────────────────
# Every NodeId identifier type OPC UA allows, and string identifiers carrying
# the characters a parser is most likely to trip on. Node ids travel as
# strings through config, WebSocket and REST, so each must round-trip.


async def _build_exotic(server: Server, idx: int) -> str:
    root = await server.nodes.objects.add_folder(ua.NodeId("Exotic", idx), "Exotic")
    await _var(root, ua.NodeId(uuid.UUID("0b9a8f1e-6b1d-4c3a-9f77-2a1e3c4d5e6f"), idx),
               "GuidTag", 1, ua.VariantType.Int32, writable=True)
    await _var(root, ua.NodeId(b"\x01\x02\xff", idx, ua.NodeIdType.ByteString),
               "OpaqueTag", 2, ua.VariantType.Int32, writable=True)
    await _var(root, ua.NodeId("Tag;With=Specials", idx), "Semicolon", 3,
               ua.VariantType.Int32, writable=True)
    await _var(root, ua.NodeId('Tag "quoted" and spaces', idx), "Quoted", 4,
               ua.VariantType.Int32, writable=True)
    await _var(root, ua.NodeId("a/b\\c:d.e", idx), "Separators", 5, ua.VariantType.Int32,
               writable=True)
    return root.nodeid.to_string()


EXOTIC = Profile(
    name="exotic_ids",
    title="Every NodeId identifier type",
    namespaces=["urn:exotic"],
    build=_build_exotic,
    leaves={
        ("GuidTag",): Leaf(1, "Int32", True, write=11),
        ("OpaqueTag",): Leaf(2, "Int32", True, write=12),
        ("Semicolon",): Leaf(3, "Int32", True, write=13),
        ("Quoted",): Leaf(4, "Int32", True, write=14),
        ("Separators",): Leaf(5, "Int32", True, write=15),
    },
)


PROFILES: list[Profile] = [CODESYS, S7_1500, TWINCAT, KEPWARE, BNR, GENERIC, EXOTIC]


# ── Running a profile ─────────────────────────────────────────────────────────


def free_url(suffix: str) -> str:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"opc.tcp://127.0.0.1:{port}/nexthmi/{suffix}/"


class _ReadLimit:
    """Fault an over-limit Read at the session layer, as a real server does."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self._original = None

    def __enter__(self) -> _ReadLimit:
        from asyncua.server.uaprocessor import ServiceError

        original = InternalSession.read
        limit = self.limit

        async def limited(session: Any, params: Any) -> Any:
            if len(params.NodesToRead) > limit:
                raise ServiceError(ua.StatusCodes.BadTooManyOperations)
            return await original(session, params)

        self._original = original
        InternalSession.read = limited  # type: ignore[method-assign]
        return self

    def __exit__(self, *exc: object) -> None:
        InternalSession.read = self._original  # type: ignore[method-assign]


class RunningProfile:
    """A started profile server: ``async with RunningProfile(p) as run:``."""

    def __init__(self, profile: Profile) -> None:
        self.profile = profile
        self.url = free_url(profile.name)
        self.server = Server()
        self.root_id = ""
        self._limit: _ReadLimit | None = None

    async def __aenter__(self) -> RunningProfile:
        await self.server.init()
        self.server.set_endpoint(self.url)
        self.server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
        if self.profile.max_nodes_per_read:
            await self.server.get_node(
                ua.NodeId(ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead)
            ).write_value(ua.Variant(self.profile.max_nodes_per_read, ua.VariantType.UInt32))
            self._limit = _ReadLimit(self.profile.max_nodes_per_read)
            self._limit.__enter__()
        idx = await _register(self.server, self.profile.namespaces)
        self.root_id = await self.profile.build(self.server, idx)
        await self.server.start()
        return self

    async def __aexit__(self, *exc: object) -> None:
        try:
            await self.server.stop()
        finally:
            if self._limit is not None:
                self._limit.__exit__()


async def browse_profile(profile: Profile) -> dict:
    """The browse tree NEXT HMI produces for *profile*, as the API returns it."""
    from asyncua import Client
    from opcua.client_pool import DatasourceOpcuaEngine
    from opcua.limits import read_operation_limits

    async with RunningProfile(profile) as run:
        engine = DatasourceOpcuaEngine(profile.name)
        async with Client(run.url) as client:
            engine.attach_client(
                client,
                {"browse_root_node": run.root_id},
                operation_limits=await read_operation_limits(client),
            )
            return await engine.browse()


def load_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


async def _write_browse_fixture() -> None:
    try:
        fixture = load_fixture()
    except FileNotFoundError:
        fixture = {}
    for profile in PROFILES:
        entry = fixture.setdefault(profile.name, {})
        entry["title"] = profile.title
        entry["browse"] = await browse_profile(profile)
        entry.setdefault("tree", None)
    FIXTURE_PATH.write_text(
        json.dumps(fixture, indent=2, ensure_ascii=False, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {FIXTURE_PATH} ({len(PROFILES)} profiles)")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    asyncio.run(_write_browse_fixture())
