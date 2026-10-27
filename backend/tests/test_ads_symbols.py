"""Symbol and data-type tables: parsing, path resolution, browse (ads.symbols)."""

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
