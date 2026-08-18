import json
from pathlib import Path

import pytest
from core.validation import vartype

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "shared"
    / "types"
    / "__fixtures__"
    / "varTypeAccepts.json"
)


def _load_cases() -> list[dict]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", _load_cases(), ids=lambda c: c["name"])
def test_accepts_parity(case: dict) -> None:
    """Same fixture drives frontend/src/shared/types/varType.test.ts — a
    divergence between the TS and Python `accepts` implementations fails
    exactly one side."""
    required_fields = case.get("requiredFields")
    result = any(
        vartype.accepts(vartype.parse_type_token(token), case["varType"], required_fields)
        for token in case["acceptTokens"]
    )
    assert result == case["expected"]


def test_parse_type_token_scalar_and_array() -> None:
    assert vartype.parse_type_token("float") == {"kind": "scalar", "base": "Float", "array": False}
    assert vartype.parse_type_token("string[]") == {
        "kind": "scalar",
        "base": "String",
        "array": True,
    }
    assert vartype.parse_type_token("INTEGER") == {
        "kind": "scalar",
        "base": "Integer",
        "array": False,
    }


def test_parse_type_token_struct_fallback() -> None:
    assert vartype.parse_type_token("Alarm") == {"kind": "struct", "array": False}
    assert vartype.parse_type_token("Alarm[]") == {"kind": "struct", "array": True}


def test_canonical_base_falls_back_to_string() -> None:
    assert vartype.canonical_base("integer") == "Integer"
    assert vartype.canonical_base("int16") == "String"
    assert vartype.canonical_base("weird") == "String"


def test_element_of_drops_array_ness() -> None:
    arr = {"kind": "scalar", "base": "Integer", "array": True, "length": 6}
    assert vartype.element_of(arr) == {"kind": "scalar", "base": "Integer", "array": False}
    scalar = {"kind": "scalar", "base": "Integer", "array": False}
    assert vartype.element_of(scalar) is scalar


def test_node_var_type_scalar_and_struct() -> None:
    t = vartype.node_var_type({"data_type": "Integer", "is_array": True, "array_length": 6})
    assert t == {"kind": "scalar", "base": "Integer", "array": True, "length": 6}

    s = vartype.node_var_type({"data_type": "struct", "fields": {"id": "Integer", "label": "String"}})
    assert s == {"kind": "struct", "name": "struct", "array": False, "fields": ["id", "label"]}
