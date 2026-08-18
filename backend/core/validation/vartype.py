"""Canonical variable-type model + compatibility predicate.

Faithful Python port of ``frontend/src/shared/types/varType.ts`` — kept honest
against the TS original by the shared parity fixture
``frontend/src/shared/types/__fixtures__/varTypeAccepts.json``, exercised by
both the TS ``accepts`` test and ``backend/tests/test_vartype.py``.

A VarType/AcceptType is a plain dict here (no dataclass) so it round-trips
exactly like the JSON the frontend already produces (`datasource_manager.
variable_metadata()` emits this same shape) — no extra (de)serialization step.

    VarType (scalar): {"kind": "scalar", "base": <SimpleBase>, "array": bool, "length"?: int}
    VarType (struct):  {"kind": "struct", "name": str, "array": bool, "fields": list[str]}
    AcceptType (scalar): {"kind": "scalar", "base": <SimpleBase>, "array": bool}
    AcceptType (struct):  {"kind": "struct", "array": bool}
"""
from __future__ import annotations

from typing import Any

SimpleBase = str  # 'Boolean' | 'Integer' | 'Float' | 'String' | 'DateTime' | 'Date' | 'Time' | 'Duration'

BASES: list[SimpleBase] = [
    "Boolean",
    "Integer",
    "Float",
    "String",
    "DateTime",
    "Date",
    "Time",
    "Duration",
]
_BASE_BY_LOWER: dict[str, SimpleBase] = {b.lower(): b for b in BASES}


def canonical_base(name: str) -> SimpleBase:
    """Canonicalise a simple-type name (case-insensitive); unknown -> 'String'."""
    return _BASE_BY_LOWER.get((name or "").strip().lower(), "String")


def parse_type_token(token: str) -> dict[str, Any]:
    """Parse one authored schema token ('float', 'string[]', a struct name, or
    a struct name + '[]') into a structured accept spec."""
    array = token.endswith("[]")
    bare = token[:-2] if array else token
    base = _BASE_BY_LOWER.get(bare.strip().lower())
    if base:
        return {"kind": "scalar", "base": base, "array": array}
    return {"kind": "struct", "array": array}


def element_of(t: dict[str, Any]) -> dict[str, Any]:
    """The element type of an array (drops array-ness); identity for scalars."""
    if not t.get("array"):
        return t
    if t.get("kind") == "scalar":
        return {"kind": "scalar", "base": t.get("base"), "array": False}
    return {**t, "array": False}


def _field_name(f: Any) -> str:
    return f if isinstance(f, str) else f.get("name", "")


def accepts(a: dict[str, Any], v: dict[str, Any], required_fields: list | None = None) -> bool:
    """Strict compatibility: does a variable of type `v` satisfy a slot that
    accepts `a`? Array-ness must match exactly — an indexed binding must be
    resolved with `element_of` before calling this."""
    if a.get("array") != v.get("array"):
        return False
    if a.get("kind") == "scalar":
        return v.get("kind") == "scalar" and a.get("base") == v.get("base")
    if v.get("kind") != "struct":
        return False
    fields = v.get("fields") or []
    if required_fields and fields:
        names = {_field_name(f) for f in required_fields}
        return names.issubset(set(fields))
    return True


def node_var_type(n: dict[str, Any]) -> dict[str, Any]:
    """Derive a VarType from a datasource tree/registry node (bare `data_type` +
    flags). Mirrors `nodeVarType` — expects `data_type` already simplified to a
    canonical or struct-marker string by the caller."""
    array = n.get("is_array") is True
    if n.get("data_type") == "struct":
        raw_fields = n.get("fields")
        if isinstance(raw_fields, dict):
            field_names = list(raw_fields.keys())
        elif isinstance(raw_fields, list):
            field_names = [f for f in raw_fields if isinstance(f, str)]
        else:
            field_names = []
        return {"kind": "struct", "name": "struct", "array": array, "fields": field_names}
    result: dict[str, Any] = {
        "kind": "scalar",
        "base": canonical_base(n.get("data_type") or ""),
        "array": array,
    }
    length = n.get("array_length")
    if array and isinstance(length, int) and length > 0:
        result["length"] = length
    return result
