"""Value-type vocabulary and conversion helpers.

The HMI config, widget schemas, and everything the *user* sees speak a small set
of value types (``Boolean``, ``Integer``, ``Float``, ``String``,
``DateTime``, their arrays, and named structs).  Real OPC-UA datatypes live only
inside the OPC layer (the datasource config, the write path, the simulated
server).  Conversion real → simple happens at the HMI boundaries.
"""

import base64
from datetime import UTC, datetime
from typing import Any

# Lower-cased real OPC-UA type -> simple type. Parity: opcuaBuiltinTypes.json.
OPCUA_TO_SIMPLE: dict[str, str] = {
    "boolean": "Boolean",
    "bool": "Boolean",
    "sbyte": "Integer",
    "byte": "Integer",
    "int8": "Integer",
    "int16": "Integer",
    "int32": "Integer",
    "int64": "Integer",
    "uint8": "Integer",
    "uint16": "Integer",
    "uint32": "Integer",
    "uint64": "Integer",
    "int": "Integer",
    "enumeration": "Integer",
    "float": "Float",
    "single": "Float",
    "double": "Float",
    "decimal": "Float",
    "string": "String",
    "bytestring": "String",
    "guid": "String",
    "nodeid": "String",
    "datetime": "DateTime",
    "date": "Date",
    "time": "Time",
    "duration": "Duration",
    "timespan": "Duration",
}

# Number.MAX_SAFE_INTEGER: the largest integer a browser's JSON number holds exactly.
MAX_SAFE_INTEGER = 2**53 - 1

# Simple scalar types (no struct names, no arrays).
VALUE_TYPES: frozenset[str] = frozenset(
    {"Boolean", "Integer", "Float", "String", "DateTime", "Date", "Time", "Duration"}
)

# Case-insensitive lookup: lower-cased value type -> canonical (capitalised) form.
_CANONICAL_BY_LOWER: dict[str, str] = {t.lower(): t for t in VALUE_TYPES}

# Simple type -> representative OPC-UA type written back when a simple type is
# picked on the static/sim datasource.
SIMPLE_TO_REPRESENTATIVE: dict[str, str] = {
    "integer": "Int32",
    "float": "Double",
    "boolean": "Boolean",
    "string": "String",
    "datetime": "DateTime",
    "date": "DateTime",
    "time": "DateTime",
    "duration": "Double",
}


def is_array_shape(entry: dict) -> bool:
    """True when *entry* (a variable/struct/folder node) represents an array."""
    return bool(entry.get("is_array"))


def is_fixed_array(entry: dict) -> bool:
    """True when *entry* is an array with a positive, fixed ``array_length``."""
    if not is_array_shape(entry):
        return False
    length = entry.get("array_length")
    return isinstance(length, int) and length > 0


def is_dynamic_array(entry: dict) -> bool:
    """True when *entry* is an array with no fixed length (unknown/dynamic size)."""
    return is_array_shape(entry) and not is_fixed_array(entry)


def array_index_out_of_bounds(entry: dict, index: int) -> bool:
    """True when *index* exceeds a fixed array's declared length.

    Dynamic arrays have no declared metadata bound. The write service separately
    requires the indexed element to exist in the current authoritative value.
    """
    return is_fixed_array(entry) and index >= entry.get("array_length", 0)


def to_simple_type(
    opcua_type: Any,
    *,
    is_array: bool = False,
    as_array_suffix: bool = True,
) -> str:
    """Map a real OPC-UA type to its simple type.

    Case-insensitive. Already-simple input is a no-op (idempotent). Unknown
    types fall back to ``String``. When *is_array* and *as_array_suffix* are
    both true, a ``[]`` suffix is appended.
    """
    raw = opcua_type if isinstance(opcua_type, str) else ""
    key = raw.strip().lower()
    if key in _CANONICAL_BY_LOWER:
        simple = _CANONICAL_BY_LOWER[key]
    else:
        simple = OPCUA_TO_SIMPLE.get(key, "String")
    if as_array_suffix and is_array:
        return f"{simple}[]"
    return simple


def representative_opcua_type(simple_type: Any) -> str:
    """Map a simple type to its representative OPC-UA type (for synthesis)."""
    key = simple_type if isinstance(simple_type, str) else ""
    return SIMPLE_TO_REPRESENTATIVE.get(key.strip().lower(), "String")


def simplify_variable_tree(nodes: Any) -> list:
    """Recursively convert a datasource variable tree to simple types.

    For each non-folder node (``kind`` is optional on variables), ``data_type`` is converted to the
    element simple type (no ``[]`` suffix); ``is_array``/``array_length`` are
    preserved as sibling fields (via the shallow node copy). Folders pass
    through. Does not mutate the input.
    """
    if not isinstance(nodes, list):
        return []
    out: list = []
    for node in nodes:
        if not isinstance(node, dict):
            out.append(node)
            continue
        new_node = dict(node)
        if node.get("kind") != "folder":
            new_node["data_type"] = to_simple_type(
                node.get("data_type", ""),
                as_array_suffix=False,
            )
        children = node.get("children")
        if isinstance(children, list):
            new_node["children"] = simplify_variable_tree(children)
        out.append(new_node)
    return out


def datetime_to_iso(value: datetime) -> str:
    """ISO 8601 UTC with milliseconds and ``Z``: ``2026-01-02T03:04:05.678Z``.

    A naive datetime is taken as UTC — OPC-UA DateTime is UTC by definition,
    and the write path hands a naive one to the server as UTC as well.
    """
    utc = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return utc.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def json_ready_scalar(value: Any) -> Any:
    """One non-container value in the form the value cache and ``/ws`` carry.

    An integer beyond ``MAX_SAFE_INTEGER`` becomes its decimal string — the form
    the write path takes it back in — because a browser would round the number.
    """
    if value is None or isinstance(value, (bool, float, str)):
        return value
    if isinstance(value, int):
        return value if -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER else str(value)
    if isinstance(value, datetime):
        return datetime_to_iso(value)
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(value).decode()
    return str(value)


def json_ready(value: Any) -> Any:
    """*value* with every leaf made JSON-ready (``json_ready_scalar``) and every
    dict/list/tuple rebuilt; datasource-agnostic, so safe on a value already
    normalized at its source."""
    if isinstance(value, dict):
        return {k: json_ready(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_ready(v) for v in value]
    return json_ready_scalar(value)
