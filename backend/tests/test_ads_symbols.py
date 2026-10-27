"""Symbol and data-type tables: parsing, path resolution, browse (ads.symbols)."""

from pathlib import Path
from typing import Any

from ads.symbols import SymbolTable, parse_datatypes, parse_symbols
from tests.ads_fake_plc import (
    OFFSETS,
    PLC_MEMORY,
    datatype_entry,
    demo_datatypes,
    demo_symbols,
    member,
    symbol_entry,
)

# Beckhoff library types (Tc2_MC2.AXIS_REF, Tc2_System.FB_IecCriticalSection and
# what they reference) exactly as a TwinCAT 3 PLC uploaded them: real GUID,
# method-info and attribute blocks. No program symbols or names of its own.
REAL_LIBRARY_TYPES = Path(__file__).parent / "fixtures" / "ads_twincat_library_types.bin"


def _table() -> SymbolTable:
    return SymbolTable.from_upload(demo_symbols(), demo_datatypes())


def _find(nodes: list[dict[str, Any]], node_id: str) -> dict[str, Any] | None:
    for node in nodes:
        if node["node_id"] == node_id:
            return node
        found = _find(node.get("children", []), node_id)
        if found is not None:
            return found
    return None


def test_parses_entries_by_their_length() -> None:
    """Trailing data a newer TwinCAT appends (GUIDs, attributes) is skipped."""
    symbols = parse_symbols(demo_symbols())
    assert [s.name for s in symbols][:3] == ["MAIN.bStart", "MAIN.nCounter", "MAIN.fSpeed"]
    assert symbols[1].comment == "cycles"
    assert symbols[2].index_offset == OFFSETS["MAIN.fSpeed"]
    types = parse_datatypes(demo_datatypes())
    motor = types["st_motor"]
    assert [m.name for m in motor.sub_items] == ["fSpeed", "bRunning", "eMode", "stLimits", "Speed"]
    assert types["st_point"].size == 8
    assert types["array [1..3] of st_point"].array_dims == ((1, 3),)


def test_browse_has_the_opcua_browse_shape() -> None:
    tree = _table().browse()
    assert [n["node_id"] for n in tree] == ["MAIN", "GVL"]
    assert tree[0]["data_type"] is None

    assert _find(tree, "MAIN.nCounter") == {
        "node_id": "MAIN.nCounter", "display_name": "nCounter", "data_type": "Int16",
        "children": [], "writable": True,
    }
    # An alias and an enum read as their base type.
    assert _find(tree, "MAIN.fSpeed")["data_type"] == "Double"
    assert _find(tree, "MAIN.stMotor.eMode")["data_type"] == "Int16"

    motor = _find(tree, "MAIN.stMotor")
    assert motor["data_type"] == "struct"
    assert motor["writable"] is False
    # The property is not a stored member.
    assert [c["display_name"] for c in motor["children"]] == ["fSpeed", "bRunning", "eMode", "stLimits"]
    assert _find(tree, "MAIN.stMotor.stLimits.fMax")["data_type"] == "Double"

    points = _find(tree, "MAIN.aPoints")
    assert points["is_array"] is True
    assert [c["display_name"] for c in points["children"]] == ["[1]", "[2]", "[3]"]
    assert _find(tree, "MAIN.aPoints[2].y")["data_type"] == "Float"

    temps = _find(tree, "MAIN.aTemps")
    assert (temps["data_type"], temps["is_array"], temps["array_length"]) == ("Float", True, 4)
    assert _find(tree, "GVL.sVersion")["writable"] is False


def test_browse_leaves_out_what_it_cannot_show() -> None:
    tree = _table().browse()
    assert _find(tree, "MAIN.pData") is None
    assert _find(tree, "MAIN.xBit") is None


def test_browse_below_a_root() -> None:
    table = _table()
    assert [n["node_id"] for n in table.browse("GVL")] == ["GVL.sVersion", "GVL.nBig"]
    assert [n["display_name"] for n in table.browse("main")][:2] == ["bStart", "nCounter"]
    assert table.browse("Nowhere") == []


def test_namespaced_symbol_names_become_nested_folders() -> None:
    table = SymbolTable.from_upload(
        symbol_entry("Lib.GVL_Io.nIn", 0, 2, "INT") + symbol_entry("Lib.nTop", 2, 2, "INT"), b"",
    )
    tree = table.browse()
    assert tree[0]["node_id"] == "Lib"
    assert [c["node_id"] for c in tree[0]["children"]] == ["Lib.GVL_Io", "Lib.nTop"]
    assert tree[0]["children"][0]["children"][0]["node_id"] == "Lib.GVL_Io.nIn"


def test_library_globals_named_with_a_leading_dot() -> None:
    table = SymbolTable.from_upload(
        symbol_entry(".TCPADS_MAXUDP_BUFFSIZE", 0, 4, "UDINT") + symbol_entry("MAIN.n", 4, 2, "INT"), b"",
    )
    tree = table.browse()
    assert [(n["node_id"], n["display_name"]) for n in tree] == [
        (".TCPADS_MAXUDP_BUFFSIZE", ".TCPADS_MAXUDP_BUFFSIZE"), ("MAIN", "MAIN"),
    ]
    assert table.resolve(".TCPADS_MAXUDP_BUFFSIZE").index_offset == 0
    assert table.resolve("TCPADS_MAXUDP_BUFFSIZE") is None


def test_resolves_member_paths_to_byte_addresses() -> None:
    table = _table()
    base = OFFSETS["MAIN.stMotor"]
    limits = table.resolve("MAIN.stMotor.stLimits.fMax")
    assert (limits.index_group, limits.index_offset, limits.size) == (PLC_MEMORY, base + 24, 8)
    assert limits.writable is True
    # IEC identifiers are case-insensitive.
    assert table.resolve("main.STMOTOR.eMode").index_offset == base + 10
    # Array bounds start where the declaration says: [1..3].
    assert table.resolve("MAIN.aPoints[1].x").index_offset == OFFSETS["MAIN.aPoints"]
    assert table.resolve("MAIN.aPoints[3].y").index_offset == OFFSETS["MAIN.aPoints"] + 2 * 8 + 4
    temps = table.resolve("MAIN.aTemps")
    assert (temps.count, temps.size) == (4, 16)
    assert table.resolve("MAIN.aTemps[2]").index_offset == OFFSETS["MAIN.aTemps"] + 8
    assert table.resolve("GVL.sVersion").writable is False


def test_unresolvable_paths() -> None:
    table = _table()
    for path in (
        "MAIN.aPoints[0].x",   # below the lower bound
        "MAIN.aPoints[4].x",   # past the upper bound
        "MAIN.stMotor",        # a struct is read member by member
        "MAIN.stMotor.Speed",  # a property
        "MAIN.pData",
        "MAIN.xBit",
        "MAIN.nCounter.x",
        "MAIN.nCounter[0]",
        "MAIN.missing",
        "MAIN.aPoints[a].x",
        "",
    ):
        assert table.resolve(path) is None, path


def test_multidimensional_array_declarations() -> None:
    table = SymbolTable.from_upload(symbol_entry("MAIN.aGrid", 0, 12, "ARRAY [0..1, 1..3] OF INT"), b"")
    grid = table.resolve("MAIN.aGrid")
    assert (grid.count, grid.size) == (6, 12)
    # Row-major, as IEC lays it out.
    assert table.resolve("MAIN.aGrid[1,2]").index_offset == (1 * 3 + 1) * 2
    assert table.resolve("MAIN.aGrid[2,1]") is None


def test_a_size_that_disagrees_with_the_type_is_skipped() -> None:
    types = datatype_entry("ST_Odd", "", 8, sub_items=(member("n", "INT", 4, 0), member("b", "BOOL", 1, 4)))
    table = SymbolTable.from_upload(symbol_entry("MAIN.st", 0, 8, "ST_Odd"), types)
    assert table.resolve("MAIN.st.n") is None
    assert table.resolve("MAIN.st.b") is not None


def test_self_referencing_alias_does_not_recurse_forever() -> None:
    table = SymbolTable.from_upload(
        symbol_entry("MAIN.x", 0, 2, "T_A"),
        datatype_entry("T_A", "T_B", 2) + datatype_entry("T_B", "T_A", 2),
    )
    assert table.resolve("MAIN.x") is None
    assert table.browse() == []


def _ids(nodes: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for node in nodes:
        out.append(node["node_id"])
        out.extend(_ids(node["children"]))
    return out


# ── Attributes and the marked browse ────────────────────────────────────────


def test_attributes_after_the_optional_blocks() -> None:
    symbols = parse_symbols(
        symbol_entry("GVL.a", 0, 2, "INT", attributes={"OPC.UA.DA": "1", "TcLinkTo": "TIIB[x]"}, guid=True)
        + symbol_entry("GVL.b", 2, 2, "INT"),
    )
    assert symbols[0].attributes == {"opc.ua.da": "1", "tclinkto": "TIIB[x]"}
    assert symbols[1].attributes == {}
    types = parse_datatypes(datatype_entry(
        "FB_X", "", 8, sub_items=(member("n", "INT", 2, 0, attributes={"hide": ""}),),
        guid=True, copy_mask=True, methods=(b"m1" * 9, b"m2" * 30), attributes={"PouType": "FunctionBlock"},
    ))
    assert types["fb_x"].attributes == {"poutype": "FunctionBlock"}
    assert types["fb_x"].sub_items[0].attributes == {"hide": ""}


def test_marked_browse_shows_only_what_is_marked() -> None:
    table = _table()
    tree = table.browse(attributes=("OPC.UA.DA",))
    # A marked member is reached through its unmarked parents; a marked
    # symbol comes with everything in it.
    assert _ids(tree) == [
        "MAIN", "MAIN.stMotor", "MAIN.stMotor.stLimits",
        "MAIN.stMotor.stLimits.fMin", "MAIN.stMotor.stLimits.fMax",
        "GVL", "GVL.sVersion",
    ]
    assert table.browse(attributes=("hmi",)) == []


def test_marked_browse_rules() -> None:
    types = b"".join([
        datatype_entry("ST_Io", "", 4, sub_items=(
            member("nIn", "INT", 2, 0),
            member("nSecret", "INT", 2, 2, attributes={"hmi": "0"}),
        )),
        datatype_entry("ST_Unit", "", 8, sub_items=(
            member("stIo", "ST_Io", 4, 0, attributes={"hmi": ""}),
            member("nOther", "INT", 2, 4),
        )),
        datatype_entry("ST_Marked", "", 2, sub_items=(member("n", "INT", 2, 0),), attributes={"hmi": "1"}),
        datatype_entry("ARRAY [1..2] OF ST_Unit", "ST_Unit", 16, array_dims=((1, 2),)),
    ])
    symbols = b"".join([
        symbol_entry("MAIN.aUnits", 0, 16, "ARRAY [1..2] OF ST_Unit"),
        symbol_entry("MAIN.stTyped", 16, 2, "ST_Marked"),
        symbol_entry("MAIN.stAll", 20, 8, "ST_Unit", attributes={"hmi": "1"}),
        symbol_entry("MAIN.stOff", 28, 8, "ST_Unit", attributes={"hmi": "0"}),
        symbol_entry("MAIN.nPlain", 36, 2, "INT"),
    ])
    tree = SymbolTable.from_upload(symbols, types).browse(attributes=("HMI",))
    assert _ids(tree) == [
        "MAIN",
        # An attribute without a value marks too; '0' hides below a mark.
        "MAIN.aUnits", "MAIN.aUnits[1]", "MAIN.aUnits[1].stIo", "MAIN.aUnits[1].stIo.nIn",
        "MAIN.aUnits[2]", "MAIN.aUnits[2].stIo", "MAIN.aUnits[2].stIo.nIn",
        # A marked type marks its instances.
        "MAIN.stTyped", "MAIN.stTyped.n",
        "MAIN.stAll", "MAIN.stAll.stIo", "MAIN.stAll.stIo.nIn", "MAIN.stAll.nOther",
    ]


# ── Lazy browse ─────────────────────────────────────────────────────────────


def test_lazy_browse_one_level_at_a_time() -> None:
    table = _table()
    top = table.browse_level()
    assert [(n["node_id"], n["has_children"], n["children"]) for n in top] == [("MAIN", True, []), ("GVL", True, [])]
    main = {n["display_name"]: n for n in table.browse_level("MAIN")}
    assert list(main)[:4] == ["bStart", "nCounter", "fSpeed", "stMotor"]
    assert main["nCounter"]["data_type"] == "Int16" and "has_children" not in main["nCounter"]
    assert main["stMotor"] == {
        "node_id": "MAIN.stMotor", "display_name": "stMotor", "data_type": "struct",
        "children": [], "writable": False, "has_children": True,
    }
    assert main["aPoints"]["is_array"] and main["aPoints"]["has_children"]
    assert main["aTemps"]["array_length"] == 4
    assert [n["display_name"] for n in table.browse_level("MAIN.stMotor")] == ["fSpeed", "bRunning", "eMode", "stLimits"]
    assert [n["node_id"] for n in table.browse_level("MAIN.aPoints")] == [
        "MAIN.aPoints[1]", "MAIN.aPoints[2]", "MAIN.aPoints[3]",
    ]
    assert [n["display_name"] for n in table.browse_level("MAIN.aPoints[2]")] == ["x", "y"]
    assert table.browse_level("MAIN.nCounter") == []
    assert table.browse_level("Nowhere") == []


# ── Real TwinCAT library types ──────────────────────────────────────────────


def _axis_program() -> SymbolTable:
    """A program around the real library types, laid out as TwinCAT does:
    the I/O-linked NcToPlc inside the axis is also its own symbol, in the
    input process image at the same offset."""
    types = parse_datatypes(REAL_LIBRARY_TYPES.read_bytes())
    axis = types["tc2_mc2.axis_ref"]
    nc_to_plc = next(m for m in axis.sub_items if m.name == "NcToPlc")
    symbols = b"".join([
        symbol_entry(".TCPADS_MAXUDP_BUFFSIZE", 0, 4, "UDINT"),
        symbol_entry("MAIN.stAxis", 1000, axis.size, "Tc2_MC2.AXIS_REF"),
        symbol_entry(
            "MAIN.stAxis.NcToPlc", 1000 + nc_to_plc.offset, nc_to_plc.size, "MC.NCTOPLC_AXIS_REF",
            index_group=0xF020, guid=True, attributes={"TcLinkTo": "TINC^NC-Task 1-SAF^Axes^Axis 1^Inputs^FromNc"},
        ),
        symbol_entry("MAIN.fbLock", 3000, 32, "Tc2_System.FB_IecCriticalSection"),
    ])
    return SymbolTable(parse_symbols(symbols), types)


def test_real_library_types_parse() -> None:
    types = parse_datatypes(REAL_LIBRARY_TYPES.read_bytes())
    assert len(types) == 44
    axis = types["tc2_mc2.axis_ref"]
    assert [m.name for m in axis.sub_items] == [
        "PlcToNc", "NcToPlc", "ADS", "Status", "DriveAddress", "_internal", "Storage",
    ]
    assert axis.sub_items[1].attributes == {"tcdataarea": "Input"}
    # Its attributes follow a method-info block, so they parse only when that is skipped right.
    assert types["tc2_system.fb_ieccriticalsection"].attributes["poutype"] == "FunctionBlock"


def test_real_axis_browse_and_resolve() -> None:
    table = _axis_program()
    tree = table.browse()
    ids = _ids(tree)
    # The process-image copy of NcToPlc is not shown a second time.
    assert len(ids) == len(set(ids))
    assert ids.count("MAIN.stAxis.NcToPlc") == 1
    assert [n["node_id"] for n in tree] == [".TCPADS_MAXUDP_BUFFSIZE", "MAIN"]
    act_pos = table.resolve("MAIN.stAxis.NcToPlc.ActPos")
    assert (act_pos.codec.type_name, act_pos.size) == ("Double", 8)
    assert table.resolve("main.stAxis.Status.Homed").codec.type_name == "Boolean"
    assert [n["display_name"] for n in table.browse_level("MAIN.stAxis")][:5] == [
        "PlcToNc", "NcToPlc", "ADS", "Status", "DriveAddress",
    ]
    assert _ids(table.browse("MAIN"))[:2] == ["MAIN.stAxis", "MAIN.stAxis.PlcToNc"]


def test_canonical_spells_a_path_as_the_plc_names_it() -> None:
    table = _table()
    assert table.canonical("main.stmotor.stlimits.FMAX") == "MAIN.stMotor.stLimits.fMax"
    assert table.canonical("Main.APoints[2].X") == "MAIN.aPoints[2].x"
    assert table.canonical("main") == "MAIN"  # a symbol-name prefix
    assert table.canonical("MAIN.stMotor.nope") is None
    assert table.canonical("MAIN.aPoints[9]") is None
    assert table.canonical("nothing") is None


def test_exists_answers_for_structs_that_resolve_does_not() -> None:
    table = _table()
    assert table.exists("MAIN.stMotor") and table.resolve("MAIN.stMotor") is None
    assert table.exists("main.apoints[1]")
    assert table.exists("MAIN.fSpeed")
    assert not table.exists("MAIN.bGone")
