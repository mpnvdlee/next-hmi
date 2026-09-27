"""Canonical variable-type model + compatibility predicate.

Faithful Python port of ``frontend/src/shared/types/varType.ts`` — kept honest
against the TS original by the shared parity fixtures
``frontend/src/shared/types/__fixtures__/varTypeAccepts.json`` and
``structSatisfies.json``, exercised by both the TS varType test and
``backend/tests/test_vartype.py``.

A VarType/AcceptType is a plain dict here (no dataclass) so it round-trips
exactly like the JSON the frontend already produces (`datasource_manager.
variable_metadata()` emits this same shape) — no extra (de)serialization step.

    VarType (scalar): {"kind": "scalar", "base": <SimpleBase>, "array": bool, "length"?: int}
    VarType (struct):  {"kind": "struct", "name": str, "array": bool, "fields": list[str]}
    AcceptType (scalar): {"kind": "scalar", "base": <SimpleBase>, "array": bool}
    AcceptType (struct):  {"kind": "struct", "array": bool}
"""
from __future__ import annotations

from collections.abc import Callable
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


def known_base(name: str) -> SimpleBase | None:
    """The canonical spelling of a simple-type name (case-insensitive); None when unknown."""
    return _BASE_BY_LOWER.get((name or "").strip().lower())


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


# Editor-kind schema tokens — never a binding-filter type of their own.
# Mirrors EDITOR_KINDS in frontend/src/shared/utils/valueTypes.ts — parity is
# enforced by test_structure_parity.py / valueTypes.test.ts against the shared
# frontend/src/shared/types/__fixtures__/editorKinds.json fixture.
EDITOR_KINDS: frozenset[str] = frozenset({
    "color", "icon", "image", "video", "option-list", "item-list", "actions", "groups",
    "image-indicators", "child-positions", "menu-items", "page-group", "slot",
    "widgets", "_action",
})

# What an `item-list` field binds to: any array. Mirrors ITEM_LIST_ACCEPTS in
# frontend/src/shared/utils/valueTypes.ts (parity: itemListAccepts.json).
ITEM_LIST_ACCEPTS: tuple[str, ...] = (*(f"{b}[]" for b in BASES), "Struct[]")

# Editor kinds whose value is a string, so a String variable can drive them.
# Mirrors STRING_BOUND_KINDS in frontend/src/shared/utils/valueTypes.ts.
STRING_BOUND_KINDS: frozenset[str] = frozenset({"color", "icon", "image", "video"})


def accepted_value_types(field_type: Any) -> list[str]:
    """A field type's binding-filter tokens: its non-editor types plus what its
    editor kinds bind to. Empty = no constraint. Mirrors `acceptedValueTypes`
    (parity: editorKindAccepts.json). Editor kinds match case-insensitively."""
    if field_type is None:
        return []
    listed = field_type if isinstance(field_type, list) else [field_type]
    tokens = [t for t in listed if isinstance(t, str)]
    kinds = {t.lower() for t in tokens if t.lower() in EDITOR_KINDS}
    accepted = [t for t in tokens if t.lower() not in EDITOR_KINDS]
    has_scalar = any(known_base(t.removesuffix("[]")) for t in accepted)
    if kinds & STRING_BOUND_KINDS and not has_scalar:
        accepted.append("String")
    if "item-list" in kinds:
        accepted += [t for t in ITEM_LIST_ACCEPTS if t not in accepted]
    return accepted


def accept_types(field_type: Any) -> list[dict[str, Any]]:
    """`accepted_value_types`, parsed into AcceptType specs."""
    return [parse_type_token(t) for t in accepted_value_types(field_type)]


def element_of(t: dict[str, Any]) -> dict[str, Any]:
    """The element type of an array (drops array-ness); identity for scalars."""
    if not t.get("array"):
        return t
    if t.get("kind") == "scalar":
        return {"kind": "scalar", "base": t.get("base"), "array": False}
    return {**t, "array": False}


def _field_name(f: Any) -> str:
    return f if isinstance(f, str) else f.get("name", "")


def accepts(
    a: dict[str, Any],
    v: dict[str, Any],
    required_fields: list | None = None,
) -> bool:
    """Strict compatibility: does a variable of type `v` satisfy a slot that
    accepts `a`? Array-ness must match exactly — an indexed binding must be
    resolved with `element_of` before calling this.

    Struct required fields are checked by name only — `struct_satisfies` checks
    each member's type and access."""
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


# (member path below the struct, e.g. "limits/fMax") -> {"type"?: VarType,
# "writable"?: bool}, or None when the struct has no such member.
StructMemberLookup = Callable[[str], dict[str, Any] | None]


def struct_mismatches(
    required_fields: list, member: StructMemberLookup, prefix: str = ""
) -> list[tuple[str, str]]:
    """Every required field a struct fails, as (member path, reason) — reason
    'missing', 'type' or 'read-only'. Empty when the struct satisfies them all.

    Each field must exist; one with nested `requiredFields` must be a struct
    itself and satisfy them in turn; one with a `type` must hold a type that
    type would accept as a field's (`accepted_value_types`, so an editor kind
    like `color` means String); one with `write` must be writable. A member
    whose type is unknown is taken on trust for its type, never for access."""
    failures: list[tuple[str, str]] = []
    for f in required_fields:
        path = f"{prefix}{_field_name(f)}"
        found = member(path)
        if found is None:
            failures.append((path, "missing"))
            continue
        if not isinstance(f, dict):
            continue
        member_type = found.get("type")
        nested = f.get("requiredFields")
        if nested:
            if isinstance(member_type, dict) and member_type.get("kind") != "struct":
                failures.append((path, "type"))
            else:
                failures += struct_mismatches(nested, member, f"{path}/")
            continue
        write = f.get("write") is True
        accept = accept_types(f.get("type"))
        if (
            accept
            and isinstance(member_type, dict)
            and not any(accepts(a, member_type) for a in accept)
        ):
            failures.append((path, "type"))
        elif write and found.get("writable") is not True:
            failures.append((path, "read-only"))
    return failures


def struct_satisfies(required_fields: list, member: StructMemberLookup) -> bool:
    """Whether a struct offers every required field with the type and access it
    asks for — `struct_mismatches` finds none. Mirrors `structSatisfies`."""
    return not struct_mismatches(required_fields, member)


def _literal_base(value: Any) -> SimpleBase | None:
    if isinstance(value, bool):
        return "Boolean"
    if isinstance(value, str):
        return "String"
    if isinstance(value, int):
        return "Integer"
    # JSON cannot tell 2.0 from 2 once the frontend has parsed it, so a whole
    # number is an Integer on both sides.
    if isinstance(value, float):
        return "Integer" if value.is_integer() else "Float"
    return None


def _common_base(values: list) -> SimpleBase | None:
    bases = {_literal_base(v) for v in values}
    if bases == {"Integer", "Float"}:
        return "Float"
    return next(iter(bases)) if len(bases) == 1 else None


def list_item_types(items: Any) -> tuple[dict[str, Any] | None, dict[str, dict[str, Any]]]:
    """What one element of a literal list is, as far as its values say:
    (element VarType, member VarType by name). A list of records is a struct
    whose fields are every key any record has; a member — or a list of
    scalars — is typed when all its values share one simple type (whole and
    fractional numbers together make a Float). Anything else is unknown: None,
    or a member left out — records with no keys at all too. Mirrors
    `listItemTypes` (parity: listItemTypes.json)."""
    if not isinstance(items, list) or not items:
        return None, {}
    if all(isinstance(item, dict) for item in items):
        fields: list[str] = []
        for item in items:
            fields += [key for key in item if key not in fields]
        if not fields:
            return None, {}
        members: dict[str, dict[str, Any]] = {}
        for name in fields:
            base = _common_base([item[name] for item in items if name in item])
            if base is not None:
                members[name] = {"kind": "scalar", "base": base, "array": False}
        return {"kind": "struct", "name": "Struct", "array": False, "fields": fields}, members
    base = _common_base(items)
    if base is None:
        return None, {}
    return {"kind": "scalar", "base": base, "array": False}, {}


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
