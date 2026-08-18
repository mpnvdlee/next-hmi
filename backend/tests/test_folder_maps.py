"""Tests for nested struct and array-of-struct folder map building.

Covers _build_folder_maps, _wire_ancestor_map, and _build_folder_fields_snapshot
to guard against regressions (including the O(n²) performance bug).
"""

import time

from models.datasource import build_var_key
from services.datasource_manager import DatasourceEntry, DatasourceManager


def _make_var(name: str, *, enabled: bool = True, writable: bool = False) -> dict:
    return {
        "display_name": name,
        "node_id": f"ns=2;s={name}",
        "data_type": "Float",
        "enabled": enabled,
        "writable": writable,
    }


def _make_folder(name: str, children: list, *, is_array: bool = False) -> dict:
    folder = {"kind": "folder", "name": name, "node_id": f"ns=2;s={name}", "children": children}
    if is_array:
        folder["is_array"] = True
    return folder


# ── Flat struct ──────────────────────────────────────────────────────────────

def test_flat_struct_folder_registry():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("Motor", [_make_var("Speed"), _make_var("Torque")]),
        ],
    }
    entry = DatasourceEntry(config)
    assert "Motor" in entry.folder_registry
    fentry = entry.folder_registry["Motor"]
    assert set(fentry["fields"]) == {"Speed", "Torque"}
    assert fentry.get("_nested_fields") == {}
    assert fentry.get("_is_array") is None


def test_flat_struct_var_to_folder():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [_make_folder("S", [_make_var("a"), _make_var("b")])],
    }
    entry = DatasourceEntry(config)
    assert entry._var_to_folder["S/a"] == ("S", "a")
    assert entry._var_to_folder["S/b"] == ("S", "b")


# ── Nested struct (struct-in-struct) ─────────────────────────────────────────

def test_nested_struct_detected():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("Root", [
                _make_var("x"),
                _make_folder("Inner", [_make_var("a"), _make_var("b")]),
            ]),
        ],
    }
    entry = DatasourceEntry(config)
    assert "Root" in entry.folder_registry
    assert "Root/Inner" in entry.folder_registry
    assert entry.folder_registry["Root"]["_nested_fields"] == {"Inner": "Root/Inner"}


def test_nested_struct_var_to_folder_maps_to_root():
    """Every leaf variable must map to the topmost ancestor folder."""
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("Top", [
                _make_var("x"),
                _make_folder("Mid", [
                    _make_var("y"),
                    _make_folder("Deep", [_make_var("z")]),
                ]),
            ]),
        ],
    }
    entry = DatasourceEntry(config)
    # All leaves must point to "Top"
    assert entry._var_to_folder["Top/x"][0] == "Top"
    assert entry._var_to_folder["Top/Mid/y"][0] == "Top"
    assert entry._var_to_folder["Top/Mid/Deep/z"][0] == "Top"


def test_nested_struct_snapshot():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("S", [
                _make_var("x"),
                _make_folder("Inner", [_make_var("a"), _make_var("b")]),
            ]),
        ],
    }
    entry = DatasourceEntry(config)
    # Simulate cached values
    entry.cache[build_var_key("DS", "S/x")] = 1.0
    entry.cache[build_var_key("DS", "S/Inner/a")] = 2.0
    entry.cache[build_var_key("DS", "S/Inner/b")] = 3.0

    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    fentry = entry.folder_registry["S"]
    snap = dm._build_folder_fields_snapshot(entry, fentry)
    assert snap == {"x": 1.0, "Inner": {"a": 2.0, "b": 3.0}}


# ── Array-of-struct ──────────────────────────────────────────────────────────

def test_array_of_struct_detected():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("Arr", [
                _make_folder("[0]", [_make_var("a"), _make_var("b")]),
                _make_folder("[1]", [_make_var("a"), _make_var("b")]),
            ], is_array=True),
        ],
    }
    entry = DatasourceEntry(config)
    fentry = entry.folder_registry["Arr"]
    assert fentry["_is_array"] is True
    assert fentry["_array_length"] == 2
    assert fentry["_element_paths"] == ["Arr/[0]", "Arr/[1]"]


def test_array_of_struct_var_to_folder_maps_to_root():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("Arr", [
                _make_folder("[0]", [_make_var("x")]),
                _make_folder("[1]", [_make_var("x")]),
            ], is_array=True),
        ],
    }
    entry = DatasourceEntry(config)
    assert entry._var_to_folder["Arr/[0]/x"][0] == "Arr"
    assert entry._var_to_folder["Arr/[1]/x"][0] == "Arr"


def test_array_of_struct_snapshot():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("Arr", [
                _make_folder("[0]", [_make_var("a"), _make_var("b")]),
                _make_folder("[1]", [_make_var("a"), _make_var("b")]),
            ], is_array=True),
        ],
    }
    entry = DatasourceEntry(config)
    entry.cache[build_var_key("DS", "Arr/[0]/a")] = 1.0
    entry.cache[build_var_key("DS", "Arr/[0]/b")] = 2.0
    entry.cache[build_var_key("DS", "Arr/[1]/a")] = 3.0
    entry.cache[build_var_key("DS", "Arr/[1]/b")] = 4.0

    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    fentry = entry.folder_registry["Arr"]
    snap = dm._build_folder_fields_snapshot(entry, fentry)
    assert isinstance(snap, list)
    assert snap == [{"a": 1.0, "b": 2.0}, {"a": 3.0, "b": 4.0}]


# ── Mixed: array-of-struct with nested structs in elements ───────────────────

def test_array_of_nested_struct_snapshot():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("Motors", [
                _make_folder("[0]", [
                    _make_var("speed"),
                    _make_folder("limits", [_make_var("min"), _make_var("max")]),
                ]),
            ], is_array=True),
        ],
    }
    entry = DatasourceEntry(config)
    entry.cache[build_var_key("DS", "Motors/[0]/speed")] = 50.0
    entry.cache[build_var_key("DS", "Motors/[0]/limits/min")] = 0.0
    entry.cache[build_var_key("DS", "Motors/[0]/limits/max")] = 100.0

    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    fentry = entry.folder_registry["Motors"]
    snap = dm._build_folder_fields_snapshot(entry, fentry)
    assert snap == [{"speed": 50.0, "limits": {"min": 0.0, "max": 100.0}}]


# ── Unbounded snapshot depth ─────────────────────────────────────────────────

def test_snapshot_no_depth_limit():
    """§1.7/§6.2: nesting deeper than the old 4-level cap resolves fully now."""
    # Build 6 levels of nesting: L0 > L1 > L2 > L3 > L4 > L5
    inner = _make_folder("L5", [_make_var("v")])
    for i in range(4, -1, -1):
        inner = _make_folder(f"L{i}", [_make_var("x"), inner])

    config = {"name": "DS", "type": "static", "variables": [inner]}
    entry = DatasourceEntry(config)

    dm = DatasourceManager()
    dm.datasources["DS"] = entry

    # Populate all leaf caches
    for depth in range(6):
        path = "/".join(f"L{d}" for d in range(depth + 1)) + "/x"
        if depth < 5:
            entry.cache[build_var_key("DS", path)] = float(depth)
    entry.cache[build_var_key("DS", "L0/L1/L2/L3/L4/L5/v")] = 99.0

    fentry = entry.folder_registry["L0"]
    snap = dm._build_folder_fields_snapshot(entry, fentry)

    assert snap["x"] == 0.0
    assert snap["L1"]["x"] == 1.0
    assert snap["L1"]["L2"]["x"] == 2.0
    assert snap["L1"]["L2"]["L3"]["x"] == 3.0
    assert snap["L1"]["L2"]["L3"]["L4"]["x"] == 4.0
    # The deepest level (formerly truncated to {} past the old cap) now
    # includes its own fields.
    assert snap["L1"]["L2"]["L3"]["L4"]["L5"]["v"] == 99.0


# ── Performance: prevent O(n²) regression ────────────────────────────────────

def test_wire_ancestor_map_performance():
    """Building folder maps for thousands of folders must complete in < 2 seconds.

    The O(n²) _wire_ancestor_map bug caused 8559 folders to hang indefinitely.
    With the O(n) fix this should take < 0.5s even for 10k folders.
    """
    n_folders = 5000
    variables = []
    for i in range(n_folders):
        variables.append(
            _make_folder(f"Struct{i}", [_make_var("a"), _make_var("b")])
        )

    config = {"name": "DS", "type": "static", "variables": variables}
    t0 = time.perf_counter()
    entry = DatasourceEntry(config)
    elapsed = time.perf_counter() - t0

    assert len(entry.folder_registry) == n_folders
    assert elapsed < 2.0, f"DatasourceEntry init took {elapsed:.2f}s for {n_folders} folders — likely O(n²) regression"


def test_wire_ancestor_map_performance_nested():
    """Nested structs with many folders must also be fast."""
    n_groups = 500
    variables = []
    for i in range(n_groups):
        variables.append(
            _make_folder(f"G{i}", [
                _make_var("x"),
                _make_folder("Inner", [_make_var("a"), _make_var("b")]),
            ])
        )

    config = {"name": "DS", "type": "static", "variables": variables}
    t0 = time.perf_counter()
    entry = DatasourceEntry(config)
    elapsed = time.perf_counter() - t0

    assert len(entry.folder_registry) == n_groups * 2  # each group has 2 folders
    assert elapsed < 2.0, f"DatasourceEntry init took {elapsed:.2f}s — likely O(n²) regression"
    # Verify correctness: inner leaves should point to outer group
    assert entry._var_to_folder["G0/Inner/a"][0] == "G0"


# ── Edge cases ───────────────────────────────────────────────────────────────

def test_empty_folder_not_registered():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [_make_folder("Empty", [])],
    }
    entry = DatasourceEntry(config)
    assert "Empty" not in entry.folder_registry


def test_folder_with_only_non_indexed_subfolders_not_array():
    """A folder whose children are named sub-folders (not [N]) is a nested struct, not array."""
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("Parent", [
                _make_folder("Child1", [_make_var("a")]),
                _make_folder("Child2", [_make_var("b")]),
            ]),
        ],
    }
    entry = DatasourceEntry(config)
    fentry = entry.folder_registry["Parent"]
    assert fentry.get("_is_array") is None
    assert set(fentry["_nested_fields"]) == {"Child1", "Child2"}


def test_indexed_named_children_without_is_array_flag_not_array():
    """A struct whose children incidentally look [N]-indexed is NOT struct[]
    unless the folder itself carries is_array (D-ARRAY.4 — detection no longer
    infers from child names alone)."""
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("Lines", [
                _make_folder("Line[1]", [_make_var("a")]),
                _make_folder("Line[2]", [_make_var("b")]),
            ]),
        ],
    }
    entry = DatasourceEntry(config)
    fentry = entry.folder_registry["Lines"]
    assert fentry.get("_is_array") is None


def test_mixed_indexed_and_named_children_not_array():
    """If a folder has a mix of [N] and named children, it's NOT an array."""
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("Mixed", [
                _make_folder("[0]", [_make_var("a")]),
                _make_folder("Extra", [_make_var("b")]),
            ]),
        ],
    }
    entry = DatasourceEntry(config)
    fentry = entry.folder_registry["Mixed"]
    assert fentry.get("_is_array") is None


# ── variable_metadata simple-type boundary ───────────────────────────────────

def _make_array_var(name: str, data_type: str, length: int) -> dict:
    return {
        "display_name": name,
        "node_id": f"ns=2;s={name}",
        "data_type": data_type,
        "is_array": True,
        "array_length": length,
        "enabled": True,
        "writable": False,
    }


def test_variable_metadata_emits_simple_scalar_types():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {"display_name": "Temp", "data_type": "Float", "enabled": True},
            {"display_name": "Count", "data_type": "Int16", "enabled": True},
        ],
    }
    mgr = DatasourceManager()
    mgr.datasources["DS"] = DatasourceEntry(config)
    meta = mgr.variable_metadata()
    assert meta[build_var_key("DS", "Temp")]["type"] == {
        "kind": "scalar", "base": "Float", "array": False,
    }
    assert meta[build_var_key("DS", "Count")]["type"] == {
        "kind": "scalar", "base": "Integer", "array": False,
    }


def test_variable_metadata_array_type_carries_base_and_length():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [_make_array_var("Arr", "String", 5)],
    }
    mgr = DatasourceManager()
    mgr.datasources["DS"] = DatasourceEntry(config)
    meta = mgr.variable_metadata()[build_var_key("DS", "Arr")]
    assert meta["type"] == {
        "kind": "scalar", "base": "String", "array": True, "length": 5,
    }


def test_variable_metadata_array_of_struct_uses_folder_name():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("Alarms", [
                _make_folder("Alarms[0]", [_make_var("bRaised")]),
                _make_folder("Alarms[1]", [_make_var("bRaised")]),
            ], is_array=True),
        ],
    }
    mgr = DatasourceManager()
    mgr.datasources["DS"] = DatasourceEntry(config)
    meta = mgr.variable_metadata()[build_var_key("DS", "Alarms")]["type"]
    assert meta["kind"] == "struct"
    assert meta["array"] is True
    assert meta["name"] == "Alarms"


# ── min/max range metadata ────────────────────────────────────────────────────


def test_variable_metadata_scalar_min_max():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {"display_name": "Temp", "data_type": "Float", "enabled": True, "min": 0, "max": 100},
            {"display_name": "Count", "data_type": "Int16", "enabled": True},
        ],
    }
    mgr = DatasourceManager()
    mgr.datasources["DS"] = DatasourceEntry(config)
    meta = mgr.variable_metadata()
    assert meta[build_var_key("DS", "Temp")]["min"] == 0
    assert meta[build_var_key("DS", "Temp")]["max"] == 100
    assert "min" not in meta[build_var_key("DS", "Count")]
    assert "max" not in meta[build_var_key("DS", "Count")]


def test_folder_registry_collects_field_ranges():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("Motor", [
                {**_make_var("Speed"), "min": 0, "max": 3000},
                _make_var("Torque"),
            ]),
        ],
    }
    entry = DatasourceEntry(config)
    fentry = entry.folder_registry["Motor"]
    assert fentry["field_ranges"] == {"Speed": {"min": 0, "max": 3000}}


def test_variable_metadata_struct_field_ranges():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            _make_folder("HMI", [
                {**_make_var("fValue"), "min": 0, "max": 100},
                _make_var("bEnabled"),
            ]),
        ],
    }
    mgr = DatasourceManager()
    mgr.datasources["DS"] = DatasourceEntry(config)
    meta = mgr.variable_metadata()[build_var_key("DS", "HMI")]
    assert meta["fieldRanges"] == {"fValue": {"min": 0, "max": 100}}


def test_variable_metadata_struct_without_ranges_omits_key():
    config = {
        "name": "DS",
        "type": "static",
        "variables": [_make_folder("Motor", [_make_var("Speed"), _make_var("Torque")])],
    }
    mgr = DatasourceManager()
    mgr.datasources["DS"] = DatasourceEntry(config)
    meta = mgr.variable_metadata()[build_var_key("DS", "Motor")]
    assert "fieldRanges" not in meta


def test_invalid_persisted_range_logs_warning(caplog):
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {"display_name": "Temp", "data_type": "Float", "enabled": True, "min": 10, "max": -20},
        ],
    }
    with caplog.at_level("WARNING"):
        DatasourceEntry(config)
    assert any("Temp" in r.message and "min=10" in r.message for r in caplog.records)


def test_valid_persisted_range_logs_no_warning(caplog):
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {"display_name": "Temp", "data_type": "Float", "enabled": True, "min": -20, "max": 10},
        ],
    }
    with caplog.at_level("WARNING"):
        DatasourceEntry(config)
    assert not any("Temp" in r.message for r in caplog.records)
