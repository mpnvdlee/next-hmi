"""Tests for core.value_types — the real-OPC-UA ↔ simple-type boundary helpers."""

import datetime
import json
import uuid
from decimal import Decimal

import pytest
from core.value_types import (
    json_ready,
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


def test_simplify_variable_tree_converts_variables_without_kind():
    tree = [
        {
            "kind": "folder",
            "name": "Kpi",
            "children": [{"display_name": "Oee", "data_type": "Double"}],
        },
    ]
    out = simplify_variable_tree(tree)
    assert out[0]["children"][0]["data_type"] == "Float"


def test_json_ready_gives_every_leaf_its_cache_form():
    value = {
        "stamp": datetime.datetime(2026, 1, 2, 3, 4, 5, 678901, tzinfo=datetime.UTC),
        "naive": datetime.datetime(2026, 1, 2, 3, 4, 5),
        "counters": (2**53 - 1, 2**53, -(2**63)),
        "flags": [True, None, 0.5, "x"],
        "blob": bytearray(b"\x00\x01"),
        "id": uuid.UUID("72962b91-fa75-4ae6-8d28-b404dc7daf63"),
        "dec": Decimal("1.5"),
    }
    assert json_ready(value) == {
        "stamp": "2026-01-02T03:04:05.678Z",
        "naive": "2026-01-02T03:04:05.000Z",
        "counters": [9007199254740991, "9007199254740992", "-9223372036854775808"],
        "flags": [True, None, 0.5, "x"],
        "blob": "AAE=",
        "id": "72962b91-fa75-4ae6-8d28-b404dc7daf63",
        "dec": "1.5",
    }


def test_json_ready_output_survives_a_round_trip_through_json():
    value = json_ready([2**64 - 1, datetime.datetime(1601, 1, 1, tzinfo=datetime.UTC)])
    assert json.loads(json.dumps(value)) == ["18446744073709551615", "1601-01-01T00:00:00.000Z"]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("9999-12-31T23:59:59.5-01:00", "9999-12-31T23:59:59.500-01:00"),
        ("0001-01-01T00:30:00+01:00", "0001-01-01T00:30:00.000+01:00"),
    ],
)
def test_an_instant_without_a_utc_form_keeps_its_own_offset(text, expected):
    # A broadcast or a verify compare carrying it must not raise; clamping it
    # would report a different instant than the one held.
    value = datetime.datetime.fromisoformat(text)
    assert json_ready({"stamp": value}) == {"stamp": expected}
    assert datetime.datetime.fromisoformat(expected) == value
