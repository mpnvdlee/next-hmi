"""Input-parameter declarations as the schema fields they are validated as.

Ports ``componentPropertyToSchemaField`` (``frontend/src/shared/types/
componentProperty.ts``) and the fit rules the ``$componentProp`` and
``$widgetProp`` pickers judge a declared value by (``componentPropFits`` /
``structSchemaNodeFits`` in ``VariableBindingPicker/componentPropHelpers.ts``).
Held equal to them by the shared fixtures ``componentPropertySchemaField.json``
and ``componentPropFits.json`` (``test_structure_parity.py``).

A declaration is the raw ``componentProperties`` entry of a component, page or
page group: ``{type, label, structSchema?, optionType?, write?, …}``.
"""
from __future__ import annotations

from typing import Any

from . import vartype

_OPTION_TYPE_BASE = {
    "string": "string",
    "integer": "integer",
    "float": "float",
    "boolean": "boolean",
    "loc": "string",
}


def _required_fields(nodes: list) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if node.get("kind") == "folder":
            children = node.get("children")
            out.append({
                "name": node.get("name"),
                "requiredFields": _required_fields(children) if isinstance(children, list) and children else [],
            })
            continue
        entry: dict[str, Any] = {"name": node.get("name")}
        node_type = node.get("type")
        if node_type:
            entry["type"] = f"{node_type}[]" if node.get("kind") == "array" else node_type
        if node.get("write"):
            entry["write"] = True
        out.append(entry)
    return out


def to_schema_field(prop: dict[str, Any]) -> dict[str, Any]:
    """A declaration as the schema field an editor row and the validator use."""
    rest = {k: v for k, v in prop.items() if k not in ("structSchema", "optionType")}
    if rest.get("type") == "widgets":
        return {k: rest[k] for k in ("type", "label", "description", "group") if k in rest}
    field = dict(rest)
    struct_schema = prop.get("structSchema")
    if isinstance(struct_schema, list) and struct_schema:
        field["requiredFields"] = _required_fields(struct_schema)
    if field.get("type") == "select":
        field["type"] = _OPTION_TYPE_BASE.get(prop.get("optionType") or "string", "string")
        field["format"] = "select"
    return field


def _type_list(t: Any) -> list[str]:
    listed = t if isinstance(t, list) else [t]
    return [x for x in listed if isinstance(x, str)]


def _is_editor_kind(t: str) -> bool:
    return t.lower() in vartype.EDITOR_KINDS


def _is_struct_type(t: str) -> bool:
    return vartype.known_base(t.removesuffix("[]")) is None and not _is_editor_kind(t)


def _declared_var_type(token: str, fields: list[str] | None = None) -> dict[str, Any] | None:
    if _is_editor_kind(token):
        return None
    accept = vartype.parse_type_token(token)
    if accept["kind"] == "scalar":
        return {"kind": "scalar", "base": accept["base"], "array": accept["array"]}
    return {"kind": "struct", "name": token.removesuffix("[]"), "fields": fields or [], "array": accept["array"]}


def node_var_type(node: dict[str, Any]) -> dict[str, Any] | None:
    """A struct-schema node's type: a folder is a struct, an array node an
    array of its `type` (of a struct, when it holds fields), a variable its
    `type`."""
    children = node.get("children") if isinstance(node.get("children"), list) else []
    fields = [c.get("name") for c in children if isinstance(c, dict)]
    kind = node.get("kind")
    if kind == "folder":
        return {"kind": "struct", "name": node.get("name"), "fields": fields, "array": False}
    node_type = node.get("type")
    if kind == "array":
        if fields:
            return {"kind": "struct", "name": node.get("name"), "fields": fields, "array": True}
        element = _declared_var_type(node_type) if isinstance(node_type, str) and node_type else None
        return {**element, "array": True} if element else None
    return _declared_var_type(node_type) if isinstance(node_type, str) and node_type else None


def struct_schema_lookup(nodes: list) -> vartype.StructMemberLookup:
    """A struct-schema tree's members by slash path; only a `variable` node is
    writable, and only when it says so."""

    def lookup(path: str) -> dict[str, Any] | None:
        name, slash, rest = path.partition("/")
        node = next((n for n in nodes if isinstance(n, dict) and n.get("name") == name), None)
        if node is None:
            return None
        if slash:
            children = node.get("children")
            return struct_schema_lookup(children if isinstance(children, list) else [])(rest)
        return {
            "type": node_var_type(node),
            "writable": node.get("kind") == "variable" and node.get("write") is True,
        }

    return lookup


def _declared_fits(
    token: str | None,
    var_type: dict[str, Any] | None,
    members: list | None,
    slot: dict[str, Any],
) -> bool:
    required = slot.get("requiredFields") if isinstance(slot.get("requiredFields"), list) else None
    field_type = slot.get("type")
    if field_type is None and not required:
        return True
    field_type = field_type if field_type is not None else []
    kinds = [k for k in _type_list(field_type) if _is_editor_kind(k)]
    if token is not None and _is_editor_kind(token):
        return any(k.lower() == token.lower() for k in kinds)
    allowed = vartype.accepted_value_types(field_type)
    if not allowed and kinds:
        return False
    if var_type is None:
        return not allowed or not all(_is_struct_type(t) for t in allowed)
    if allowed and not any(
        vartype.accepts(vartype.parse_type_token(t), var_type, required) for t in allowed
    ):
        return False
    return (
        var_type.get("kind") != "struct"
        or not required
        or vartype.struct_satisfies(required, struct_schema_lookup(members or []))
    )


def declaration_fits(prop: dict[str, Any], slot: dict[str, Any]) -> bool:
    """Whether a declared input parameter fits a field (`componentPropFits`)."""
    types = _type_list(to_schema_field(prop).get("type"))
    token = types[0] if types else None
    struct_schema = prop.get("structSchema") if isinstance(prop.get("structSchema"), list) else []
    fields = [n.get("name") for n in struct_schema if isinstance(n, dict)]
    var_type = _declared_var_type(token, fields) if token is not None else None
    return _declared_fits(token, var_type, struct_schema, slot)


def node_fits(node: dict[str, Any], slot: dict[str, Any]) -> bool:
    """Whether one member of a struct declaration fits a field (`structSchemaNodeFits`)."""
    node_type = node.get("type") if node.get("kind") == "variable" else None
    children = node.get("children") if isinstance(node.get("children"), list) else None
    return _declared_fits(
        node_type if isinstance(node_type, str) else None, node_var_type(node), children, slot
    )


def declaration_verdict(prop: dict[str, Any], slot: dict[str, Any]) -> str | None:
    """Why a declared input parameter cannot fill a field — 'type', or
    'read-only' for a writing field it does not say it can be written through —
    or None when it can (`componentPropVerdict`)."""
    if not declaration_fits(prop, slot):
        return "type"
    return "read-only" if slot.get("write") is True and prop.get("write") is not True else None


def node_verdict(node: dict[str, Any], slot: dict[str, Any]) -> str | None:
    """`declaration_verdict` for one member of a struct declaration: only a
    variable row with `write: true` can be written (`structSchemaNodeVerdict`)."""
    if not node_fits(node, slot):
        return "type"
    writable = node.get("kind") == "variable" and node.get("write") is True
    return "read-only" if slot.get("write") is True and not writable else None


def member_node(prop: dict[str, Any], member_path: str) -> tuple[bool, dict[str, Any] | None]:
    """The struct-schema node a slash path below a declaration names.

    ``(True, node)`` when found; ``(False, None)`` when the declared tree has no
    such member; ``(True, None)`` when the path runs below an array row, whose
    elements the declaration does not describe.
    """
    nodes: Any = prop.get("structSchema")
    node: dict[str, Any] | None = None
    for name in member_path.split("/"):
        if node is not None and node.get("kind") == "array":
            return True, None
        if not isinstance(nodes, list):
            return False, None
        node = next((n for n in nodes if isinstance(n, dict) and n.get("name") == name), None)
        if node is None:
            return False, None
        nodes = node.get("children")
    return True, node
