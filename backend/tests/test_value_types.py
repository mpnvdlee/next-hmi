"""Tests for core.value_types — the real-OPC-UA ↔ simple-type boundary helpers."""

import pytest
from core.value_types import (
    representative_opcua_type,
    simplify_variable_tree,
    to_simple_type,
)


@pytest.mark.parametrize(
    "opcua,simple",
    [
        ("Boolean", "Boolean"),
        ("Bool", "Boolean"),
        ("SByte", "Integer"),
        ("Byte", "Integer"),
        ("Int8", "Integer"),
        ("Int16", "Integer"),
        ("Int32", "Integer"),
        ("Int64", "Integer"),
        ("UInt8", "Integer"),
        ("UInt16", "Integer"),
        ("UInt32", "Integer"),
        ("UInt64", "Integer"),
        ("enumeration", "Integer"),
        ("Float", "Float"),
        ("Single", "Float"),
        ("Double", "Float"),
        ("Decimal", "Float"),
        ("String", "String"),
        ("ByteString", "String"),
        ("Guid", "String"),
        ("NodeId", "String"),
        ("DateTime", "DateTime"),
    ],
)
def test_to_simple_type_maps_every_real_type(opcua, simple):
    assert to_simple_type(opcua) == simple


def test_to_simple_type_is_case_insensitive():
    assert to_simple_type("iNt32") == "Integer"
    assert to_simple_type("DOUBLE") == "Float"


def test_to_simple_type_unknown_falls_back_to_string():
    assert to_simple_type("WeirdType") == "String"
    assert to_simple_type("") == "String"
    assert to_simple_type(None) == "String"


def test_to_simple_type_is_idempotent():
    for value_type in ("Boolean", "Integer", "Float", "String", "DateTime"):
        assert to_simple_type(value_type) == value_type


def test_to_simple_type_array_suffix():
    assert to_simple_type("Int32", is_array=True) == "Integer[]"
    assert to_simple_type("Float", is_array=True) == "Float[]"
    assert to_simple_type("Int32", is_array=False) == "Integer"
    assert to_simple_type("Int32") == "Integer"
    assert to_simple_type("Int32", is_array=True, as_array_suffix=False) == "Integer"


@pytest.mark.parametrize(
    "simple,real",
    [
        ("Integer", "Int32"),
        ("Float", "Double"),
        ("Boolean", "Boolean"),
        ("String", "String"),
        ("DateTime", "DateTime"),
    ],
)
def test_representative_opcua_type(simple, real):
    assert representative_opcua_type(simple) == real


def test_representative_round_trips_to_same_simple():
    for value_type in ("Integer", "Float", "Boolean", "String", "DateTime"):
        assert to_simple_type(representative_opcua_type(value_type)) == value_type


def test_representative_unknown_falls_back_to_string():
    assert representative_opcua_type("nope") == "String"


def test_simplify_variable_tree_converts_leaves_and_preserves_fields():
    tree = [
        {
            "kind": "folder",
            "name": "Motor",
            "children": [
                {"kind": "variable", "display_name": "Speed", "data_type": "Float", "node_id": "n1"},
                {
                    "kind": "variable",
                    "display_name": "Hist",
                    "data_type": "Int16",
                    "is_array": True,
                    "array_length": 5,
                    "writable": True,
                },
            ],
        },
        {"kind": "variable", "display_name": "Flag", "data_type": "Bool"},
    ]
    out = simplify_variable_tree(tree)
    # No [] suffix on tree nodes — array-ness stays in is_array/array_length.
    assert out[0]["children"][0]["data_type"] == "Float"
    assert out[0]["children"][1]["data_type"] == "Integer"
    assert out[0]["children"][1]["is_array"] is True
    assert out[0]["children"][1]["array_length"] == 5
    assert out[0]["children"][1]["writable"] is True
    assert out[0]["children"][0]["node_id"] == "n1"
    assert out[1]["data_type"] == "Boolean"
    # Folders keep their kind/name.
    assert out[0]["kind"] == "folder"
    assert out[0]["name"] == "Motor"


def test_simplify_variable_tree_does_not_mutate_input():
    tree = [{"kind": "variable", "display_name": "Flag", "data_type": "Bool"}]
    simplify_variable_tree(tree)
    assert tree[0]["data_type"] == "Bool"
