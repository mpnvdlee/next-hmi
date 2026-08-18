"""Shared variable-write path.

Extracted from ``websocket_manager._handle_write_field`` so both client writes
(over the WebSocket) and server-initiated writes (recipe downloads) share one
coerce → dispatch → write implementation. Handles scalars *and* whole-array
values, static and OPC-UA datasources, optional verify read-back, and returns a
structured :class:`WriteOutcome` with an error reason on failure.

Permission checks are intentionally *not* here — they depend on per-client
identity and stay with the caller (the WebSocket handler / recipe WS handler).
Auditing sits with them for the same reason, and one more: a recipe download
reaches this module with no operator behind it, so a record emitted here could
not say who to attribute the write to.
"""

from __future__ import annotations

import math
import re
import struct
from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any

from asyncua import ua
from core.value_types import array_index_out_of_bounds
from models.datasource import build_var_key

# ── Failure reasons (string values match the WebSocket write_error contract) ──

REASON_BAD_PATH = "bad_path"
REASON_BAD_FIELD = "bad_field"
REASON_INVALID_VALUE = "invalid_value"
REASON_OPCUA_UNREACHABLE = "opcua_unreachable"
REASON_WRITE_FAILED = "write_failed"
REASON_VERIFY_MISMATCH = "verify_mismatch"
REASON_ARRAY_INDEX_OUT_OF_BOUNDS = "array_index_out_of_bounds"
REASON_ARRAY_STATE_UNAVAILABLE = "array_state_unavailable"
REASON_VALUE_OUT_OF_RANGE = "value_out_of_range"


@dataclass
class WriteOutcome:
    """Result of a single variable write. ``reason`` is None on success."""

    ok: bool
    reason: str | None = None


def parse_write_request(payload: Any) -> tuple[str, str, str | None, Any] | None:
    """Validate the transport-neutral write envelope, preserving present null."""
    if not isinstance(payload, dict) or "value" not in payload:
        return None
    datasource = payload.get("datasource")
    path = payload.get("path")
    field = payload.get("field")
    if (
        not isinstance(datasource, str)
        or not datasource.strip()
        or datasource != datasource.strip()
        or not isinstance(path, str)
        or not path.strip()
        or path != path.strip()
        or (field is not None and (not isinstance(field, str) or not field.strip()))
    ):
        return None
    return datasource, path, field, payload["value"]


def write_permitted(identity: Any, entry_data: Any) -> bool:
    """Apply the one identity/group rule used by every operator write caller."""
    if not isinstance(entry_data, dict):
        return True
    interactable_groups = entry_data.get("interactableByGroups")
    if not isinstance(interactable_groups, list) or not interactable_groups:
        return True
    groups = identity.get("groups", []) if isinstance(identity, dict) else ["guest"]
    user_groups = {group for group in groups if isinstance(group, str)}
    allowed_groups = {group for group in interactable_groups if isinstance(group, str)}
    return bool(user_groups & allowed_groups)


def array_registry_path(path: str) -> str:
    return _ARRAY_INDEX_RE.sub("", path)


# ── Type coercion tables ──────────────────────────────────────────────────────

_ARRAY_INDEX_RE = re.compile(r"\[(-?\d+)\]$")
_JSON_SAFE_INTEGER = 9007199254740991
_MAX_DYNAMIC_ARRAY_INDEX = 10000
_FLOAT32_MAX = 3.4028234663852886e38
_DECIMAL_NUMBER_RE = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")

_INT_TYPES: frozenset[str] = frozenset({
    "sbyte", "byte", "int8", "int16", "int32", "int64",
    "uint8", "uint16", "uint32", "uint64",
})
_INT_RANGES: dict[str, tuple[int, int]] = {
    "sbyte":  (-128, 127),
    "int8":   (-128, 127),
    "byte":   (0, 255),
    "uint8":  (0, 255),
    "int16":  (-32768, 32767),
    "uint16": (0, 65535),
    "int32":  (-2147483648, 2147483647),
    "uint32": (0, 4294967295),
    "int64":  (-9223372036854775808, 9223372036854775807),
    "uint64": (0, 18446744073709551615),
}
_FLOAT_TYPES: frozenset[str] = frozenset({"float", "double", "single"})
_FLOAT32_TYPES: frozenset[str] = frozenset({"float"})
_STRING_TYPES: frozenset[str] = frozenset({"string"})
_DATETIME_TYPES: frozenset[str] = frozenset({"datetime"})
_DATE_TYPES: frozenset[str] = frozenset({"date"})
_TIME_TYPES: frozenset[str] = frozenset({"time"})
_DURATION_TYPES: frozenset[str] = frozenset({"duration", "timespan"})
# The hour bound is matched here rather than left to ``fromisoformat``: since
# CPython 3.14 that parser accepts the ISO 8601 end-of-day hour 24, returning
# 00:00 for a Time and rolling a DateTime to the next day. Both would silently
# reinterpret an operator write, and neither is accepted by the TypeScript
# validator in shared/utils/opcuaWriteCoercion.ts.
_HOUR_PATTERN = r"(?:[01]\d|2[0-3])"
_CANONICAL_TYPE_ALIASES: dict[str, str] = {
    "boolean": "boolean",
    "bool": "boolean",
    "integer": "int32",
    "int": "int32",
    "enumeration": "int32",
    "float": "float",
    "single": "float",
    "double": "double",
    "string": "string",
    "datetime": "datetime",
    "date": "date",
    "time": "time",
    "duration": "duration",
    "timespan": "duration",
}
for _integer_type in _INT_TYPES:
    _CANONICAL_TYPE_ALIASES[_integer_type] = _integer_type

COERCION_NULL_NOT_ALLOWED = "null_not_allowed"
COERCION_UNKNOWN_TYPE = "unknown_type"
COERCION_SCALAR_REQUIRED = "scalar_required"
COERCION_ARRAY_REQUIRED = "array_required"
COERCION_ARRAY_LENGTH = "array_length_mismatch"
COERCION_INVALID_BOOLEAN = "invalid_boolean"
COERCION_INVALID_INTEGER = "invalid_integer"
COERCION_INTEGER_RANGE = "integer_out_of_range"
COERCION_LOSSY = "lossy_conversion"
COERCION_INVALID_FLOAT = "invalid_float"
COERCION_NON_FINITE = "non_finite_float"
COERCION_INVALID_STRING = "invalid_string"
COERCION_INVALID_TEMPORAL = "invalid_temporal"
COERCION_FLOAT_RANGE = "float_out_of_range"
COERCION_INVALID_DESCRIPTOR = "invalid_descriptor"


class WriteCoercionError(ValueError):
    """A deterministic matrix rejection; ``reason`` is shared with the frontend."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


_VARIANT_TYPE_MAP: dict[str, ua.VariantType] = {
    k: v for k, v in [
        ("boolean", ua.VariantType.Boolean),
        ("bool",    ua.VariantType.Boolean),
        ("sbyte",   ua.VariantType.SByte),
        ("byte",    ua.VariantType.Byte),
        ("int8",    ua.VariantType.SByte),
        ("uint8",   ua.VariantType.Byte),
        ("int16",   ua.VariantType.Int16),
        ("uint16",  ua.VariantType.UInt16),
        ("int32",   ua.VariantType.Int32),
        ("uint32",  ua.VariantType.UInt32),
        ("int64",   ua.VariantType.Int64),
        ("uint64",  ua.VariantType.UInt64),
        ("float",   ua.VariantType.Float),
        ("single",  ua.VariantType.Float),
        ("double",  ua.VariantType.Double),
        ("string",  ua.VariantType.String),
        ("datetime", ua.VariantType.DateTime),
        ("date", ua.VariantType.String),
        ("time", ua.VariantType.String),
        ("duration", ua.VariantType.Double),
    ]
}


def coerce_write_value(value: Any, data_type: Any) -> Any:
    """Best-effort coercion of a write payload to the target node datatype.

    Whole-array values (a ``list``) coerce every element to *data_type*.
    Raises ``ValueError`` when a value cannot be coerced.
    """
    if value is None:
        raise WriteCoercionError(COERCION_NULL_NOT_ALLOWED)
    if isinstance(value, list):
        return [_coerce_scalar(v, data_type) for v in value]
    return _coerce_scalar(value, data_type)


def coerce_entry_write_value(value: Any, entry_data: dict[str, Any], *, indexed: bool = False) -> Any:
    """Apply the scalar/array shape contract before element coercion."""
    data_type = entry_data.get("data_type")
    if not isinstance(data_type, str) or data_type.strip().lower() not in _CANONICAL_TYPE_ALIASES:
        raise WriteCoercionError(COERCION_UNKNOWN_TYPE)
    raw_is_array = entry_data.get("is_array", False)
    if not isinstance(raw_is_array, bool):
        raise WriteCoercionError(COERCION_INVALID_DESCRIPTOR)
    is_array = raw_is_array
    length = entry_data.get("array_length")
    if length is not None and (
        not is_array or isinstance(length, bool) or not isinstance(length, int)
    ):
        raise WriteCoercionError(COERCION_INVALID_DESCRIPTOR)
    fixed_length = length if isinstance(length, int) and length > 0 else None
    if indexed:
        if not is_array:
            raise WriteCoercionError(COERCION_INVALID_DESCRIPTOR)
        if isinstance(value, (list, dict)):
            raise WriteCoercionError(COERCION_SCALAR_REQUIRED)
        return coerce_write_value(value, data_type)
    if is_array:
        if not isinstance(value, list):
            raise WriteCoercionError(COERCION_ARRAY_REQUIRED)
        if fixed_length is not None and len(value) != fixed_length:
            raise WriteCoercionError(COERCION_ARRAY_LENGTH)
        return coerce_write_value(value, data_type)
    if isinstance(value, (list, dict)):
        raise WriteCoercionError(COERCION_SCALAR_REQUIRED)
    return coerce_write_value(value, data_type)


def _range_bounds(entry_data: dict[str, Any]) -> tuple[float | None, float | None] | None:
    """Return the entry's configured (min, max), or None when unenforceable.

    A persisted ``min > max`` is a contract violation left in place by the
    author rather than corrected here; it is surfaced as a load-time
    diagnostic (see ``datasource_manager``) and simply unenforced until fixed.
    """
    lo = entry_data.get("min")
    hi = entry_data.get("max")
    lo = lo if isinstance(lo, (int, float)) and not isinstance(lo, bool) else None
    hi = hi if isinstance(hi, (int, float)) and not isinstance(hi, bool) else None
    if lo is None and hi is None:
        return None
    if lo is not None and hi is not None and lo > hi:
        return None
    return (lo, hi)


def _in_range(value: Any, bounds: tuple[float | None, float | None]) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return True
    lo, hi = bounds
    if lo is not None and value < lo:
        return False
    return not (hi is not None and value > hi)


def _coerce_scalar(value: Any, data_type: Any) -> Any:
    if value is None:
        raise WriteCoercionError(COERCION_NULL_NOT_ALLOWED)
    if not isinstance(data_type, str):
        raise WriteCoercionError(COERCION_UNKNOWN_TYPE)
    dt = _CANONICAL_TYPE_ALIASES.get(data_type.strip().lower())
    if dt is None:
        raise WriteCoercionError(COERCION_UNKNOWN_TYPE)
    if isinstance(value, (list, dict, tuple)):
        raise WriteCoercionError(COERCION_SCALAR_REQUIRED)

    if dt in _STRING_TYPES:
        if isinstance(value, str):
            return value
        if dt == "string" and isinstance(value, bool):
            return "True" if value else "False"
        if dt == "string" and isinstance(value, (int, float)) and not isinstance(value, bool):
            if isinstance(value, float) and not math.isfinite(value):
                raise WriteCoercionError(COERCION_INVALID_STRING)
            return _javascript_number_string(value)
        raise WriteCoercionError(COERCION_INVALID_STRING)

    if dt in _DATETIME_TYPES:
        if isinstance(value, datetime):
            return value
        if isinstance(value, str):
            iso = value.strip()
            if not re.fullmatch(
                r"\d{4}-\d{2}-\d{2}[T ]"
                rf"{_HOUR_PATTERN}:\d{{2}}(?::\d{{2}}(?:\.\d{{1,6}})?)?"
                r"(?:Z|[+-]\d{2}:\d{2})?",
                iso,
            ):
                raise WriteCoercionError(COERCION_INVALID_TEMPORAL)
            if iso.endswith("Z"):
                iso = iso[:-1] + "+00:00"
            try:
                return datetime.fromisoformat(iso)
            except ValueError as exc:
                raise WriteCoercionError(COERCION_INVALID_TEMPORAL) from exc
        raise WriteCoercionError(COERCION_INVALID_TEMPORAL)

    if dt in _DATE_TYPES:
        if isinstance(value, datetime):
            raise WriteCoercionError(COERCION_INVALID_TEMPORAL)
        if isinstance(value, date):
            return value.isoformat()
        if isinstance(value, str):
            raw_date = value.strip()
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw_date):
                raise WriteCoercionError(COERCION_INVALID_TEMPORAL)
            try:
                return date.fromisoformat(raw_date).isoformat()
            except ValueError as exc:
                raise WriteCoercionError(COERCION_INVALID_TEMPORAL) from exc
        raise WriteCoercionError(COERCION_INVALID_TEMPORAL)

    if dt in _TIME_TYPES:
        if isinstance(value, time):
            return value.isoformat()
        if isinstance(value, str):
            raw_time = value.strip()
            if not re.fullmatch(rf"{_HOUR_PATTERN}:\d{{2}}(?::\d{{2}}(?:\.\d{{1,6}})?)?", raw_time):
                raise WriteCoercionError(COERCION_INVALID_TEMPORAL)
            try:
                return time.fromisoformat(raw_time).isoformat()
            except ValueError as exc:
                raise WriteCoercionError(COERCION_INVALID_TEMPORAL) from exc
        raise WriteCoercionError(COERCION_INVALID_TEMPORAL)

    if dt in {"boolean", "bool"}:
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            s = value.strip().lower()
            if s in {"true", "1", "on", "yes"}:
                return True
            if s in {"false", "0", "off", "no"}:
                return False
            raise WriteCoercionError(COERCION_INVALID_BOOLEAN)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value in {0, 1}:
            return bool(value)
        raise WriteCoercionError(COERCION_INVALID_BOOLEAN)

    if dt in _INT_TYPES:
        if isinstance(value, bool):
            raise WriteCoercionError(COERCION_INVALID_INTEGER)
        if isinstance(value, int):
            if abs(value) > _JSON_SAFE_INTEGER:
                raise WriteCoercionError(COERCION_LOSSY)
            ivalue = value
        elif isinstance(value, float):
            if (
                not math.isfinite(value)
                or not value.is_integer()
                or abs(value) > _JSON_SAFE_INTEGER
            ):
                raise WriteCoercionError(COERCION_LOSSY)
            ivalue = int(value)
        elif isinstance(value, str) and re.fullmatch(r"[+-]?\d+", value.strip()):
            integer_text = value.strip()
            if len(integer_text.lstrip("+-")) > 21:
                raise WriteCoercionError(COERCION_INTEGER_RANGE)
            ivalue = int(integer_text)
        else:
            raise WriteCoercionError(COERCION_INVALID_INTEGER)
        bounds = _INT_RANGES.get(dt)
        if bounds is not None and (ivalue < bounds[0] or ivalue > bounds[1]):
            raise WriteCoercionError(COERCION_INTEGER_RANGE)
        return ivalue

    if dt in _FLOAT_TYPES or dt in _DURATION_TYPES:
        if isinstance(value, bool):
            raise WriteCoercionError(COERCION_INVALID_FLOAT)
        if isinstance(value, str) and not _DECIMAL_NUMBER_RE.fullmatch(value.strip()):
            raise WriteCoercionError(COERCION_INVALID_FLOAT)
        try:
            fvalue = float(value)
        except OverflowError as exc:
            raise WriteCoercionError(COERCION_NON_FINITE) from exc
        except (TypeError, ValueError) as exc:
            raise WriteCoercionError(COERCION_INVALID_FLOAT) from exc
        if not math.isfinite(fvalue):
            raise WriteCoercionError(COERCION_NON_FINITE)
        if dt in _FLOAT32_TYPES:
            if abs(fvalue) > _FLOAT32_MAX:
                raise WriteCoercionError(COERCION_FLOAT_RANGE)
            narrowed = struct.unpack("!f", struct.pack("!f", fvalue))[0]
            if narrowed != fvalue:
                raise WriteCoercionError(COERCION_LOSSY)
        return fvalue

    raise WriteCoercionError(COERCION_UNKNOWN_TYPE)


def _javascript_number_string(value: int | float) -> str:
    """Match ECMAScript Number string thresholds for JSON-originated numbers."""
    if isinstance(value, int):
        return str(value)
    if value == 0:
        return "0"
    absolute = abs(value)
    rendered = repr(value).lower()
    if 1e-6 <= absolute < 1e21:
        return format(Decimal(rendered), "f").rstrip("0").rstrip(".")
    if "e" not in rendered:
        rendered = format(value, ".15e")
    mantissa, exponent = rendered.split("e", 1)
    mantissa = mantissa.rstrip("0").rstrip(".")
    exponent_value = int(exponent)
    sign = "+" if exponent_value >= 0 else ""
    return f"{mantissa}e{sign}{exponent_value}"


def variant_type_for_data_type(data_type: Any) -> ua.VariantType | None:
    if not isinstance(data_type, str) or not data_type:
        return None
    canonical = _CANONICAL_TYPE_ALIASES.get(data_type.strip().lower())
    return _VARIANT_TYPE_MAP.get(canonical or "")


def _field_path(entry_data: dict[str, Any], field: str | None) -> str | None:
    """Resolve a struct field name to the child variable's own path.

    A field write addresses the struct *folder*, which lives in the manager's
    ``folder_registry`` — lookups keyed on the plain registry miss it entirely.
    """
    if field is None or entry_data.get("data_type") is not None:
        return None
    child_paths = entry_data.get("_child_paths", {})
    if not isinstance(child_paths, dict):
        return None
    return next((path for path, name in child_paths.items() if name == field), None)


def _field_entry(
    datasource_manager: Any,
    ds_name: str,
    entry_data: dict[str, Any],
    field: str | None,
) -> dict[str, Any] | None:
    if field is None or entry_data.get("data_type") is not None:
        return entry_data
    child_path = _field_path(entry_data, field)
    return datasource_manager.get_entry(ds_name, child_path) if child_path else None


def _resolve_node_id(entry_data: dict, field: str | None) -> str | None:
    if field is not None:
        node_id = entry_data.get("fields", {}).get(field)
        if node_id:
            return node_id
    return entry_data.get("node_id")


def _prepare_array_write_value(
    current: Any,
    entry_data: dict,
    path: str,
    value: Any,
) -> Any:
    """If *path* ends with ``[N]``, read the current array, patch element N,
    and return the full patched array. Otherwise return *value* unchanged."""
    array_index_match = _ARRAY_INDEX_RE.search(path)
    if not array_index_match:
        return value
    array_index = int(array_index_match.group(1))
    expected_length = entry_data.get("array_length")
    if (
        not isinstance(current, list)
        or array_index < 0
        or array_index >= len(current)
        or (
            isinstance(expected_length, int)
            and expected_length > 0
            and len(current) != expected_length
        )
    ):
        raise RuntimeError(REASON_ARRAY_STATE_UNAVAILABLE)
    patched = list(current)
    patched[array_index] = value
    return patched


def _values_equal(a: Any, b: Any) -> bool:
    """Exact-match compare for verify read-back (arrays compared element-wise)."""
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_values_equal(x, y) for x, y in zip(a, b, strict=False))
    if isinstance(a, list) or isinstance(b, list):
        return False
    return a == b


# ── Public write / read entry points ──────────────────────────────────────────


async def write_value(
    datasource_manager: Any,
    opcua_pool: Any,
    ds_name: str,
    path: str,
    value: Any,
    *,
    field: str | None = None,
    verify: bool = False,
) -> WriteOutcome:
    """Coerce and write *value* to ``ds_name:path``.

    Static datasources are updated in memory; OPC-UA datasources are written via
    the pool engine. When *verify* is set, the value is read back and compared
    for exact equality (per-element for arrays).
    """
    if datasource_manager is None:
        return WriteOutcome(False, REASON_OPCUA_UNREACHABLE)

    registry_path = _ARRAY_INDEX_RE.sub("", path)
    entry_data = datasource_manager.get_entry(ds_name, registry_path)
    if entry_data is None:
        return WriteOutcome(False, REASON_BAD_PATH)

    index_match = _ARRAY_INDEX_RE.search(path)
    if index_match is not None:
        index_text = index_match.group(1)
        if len(index_text.lstrip("-")) > 5:
            return WriteOutcome(False, REASON_ARRAY_INDEX_OUT_OF_BOUNDS)
        index = int(index_text)
        if index < 0 or index > _MAX_DYNAMIC_ARRAY_INDEX or array_index_out_of_bounds(entry_data, index):
            return WriteOutcome(False, REASON_ARRAY_INDEX_OUT_OF_BOUNDS)

    coercion_entry = _field_entry(datasource_manager, ds_name, entry_data, field)
    if coercion_entry is None:
        return WriteOutcome(False, REASON_BAD_FIELD)
    data_type = coercion_entry.get("data_type")
    try:
        coerced = coerce_entry_write_value(
            value, coercion_entry, indexed=index_match is not None,
        )
    except ValueError:
        return WriteOutcome(False, REASON_INVALID_VALUE)

    bounds = _range_bounds(coercion_entry)
    if bounds is not None:
        checked_values = coerced if isinstance(coerced, list) else [coerced]
        if not all(_in_range(v, bounds) for v in checked_values):
            return WriteOutcome(False, REASON_VALUE_OUT_OF_RANGE)

    ds_entry = datasource_manager.get(ds_name)
    if index_match is not None and ds_entry is not None and ds_entry.ds_type == "static":
        cached = (
            ds_entry.cache.get(build_var_key(ds_name, registry_path))
            if ds_entry is not None
            else None
        )
        expected_length = entry_data.get("array_length")
        if (
            not isinstance(cached, list)
            or index >= len(cached)
            or (
                isinstance(expected_length, int)
                and expected_length > 0
                and len(cached) != expected_length
            )
        ):
            return WriteOutcome(False, REASON_ARRAY_STATE_UNAVAILABLE)
    if ds_entry is not None and ds_entry.ds_type == "static":
        # A field write names the struct folder; the value lives on the child
        # variable. `update_static_value` returns silently on an unknown path,
        # so resolving here is what keeps the write from being reported ok and
        # then dropped.
        target_path = path
        if field is not None and entry_data.get("data_type") is None:
            child_path = _field_path(entry_data, field)
            if not child_path:
                return WriteOutcome(False, REASON_BAD_FIELD)
            target_path = child_path
        datasource_manager.update_static_value(ds_name, target_path, coerced)
    else:
        if opcua_pool is None:
            return WriteOutcome(False, REASON_OPCUA_UNREACHABLE)
        node_id = _resolve_node_id(entry_data, field)
        if not node_id:
            return WriteOutcome(False, REASON_BAD_FIELD)
        engine = opcua_pool.get(ds_name)
        if engine is None:
            return WriteOutcome(False, REASON_OPCUA_UNREACHABLE)
        current_array: Any = None
        if index_match is not None:
            try:
                current_values = await engine.read_current_values({registry_path})
                current_array = current_values.get(build_var_key(ds_name, registry_path))
            except Exception:
                return WriteOutcome(False, REASON_ARRAY_STATE_UNAVAILABLE)
        try:
            write_val = _prepare_array_write_value(
                current_array, entry_data, path, coerced,
            )
        except RuntimeError:
            return WriteOutcome(False, REASON_ARRAY_STATE_UNAVAILABLE)
        try:
            await engine.write_node(node_id, write_val, variant_type_for_data_type(data_type))
        except Exception:
            return WriteOutcome(False, REASON_WRITE_FAILED)
        if ds_entry is not None and _ARRAY_INDEX_RE.search(path):
            # Reflect the patched array in the cache so a later element write to
            # the same node (e.g. a recipe download touching several elements of
            # one array) starts from the updated array instead of the stale one
            # write_node left behind. The subscription overwrites this with
            # server truth shortly after.
            ds_entry.cache[build_var_key(ds_name, registry_path)] = write_val

    if verify:
        read_back = await read_value(datasource_manager, opcua_pool, ds_name, path)
        if not _values_equal(coerced, read_back):
            return WriteOutcome(False, REASON_VERIFY_MISMATCH)

    return WriteOutcome(True)


async def read_value(
    datasource_manager: Any,
    opcua_pool: Any,
    ds_name: str,
    path: str,
) -> Any:
    """Return the current value of ``ds_name:path``.

    OPC-UA datasources get a fresh node read; static datasources and any read
    failure fall back to the in-memory cache. An array-element path (``[N]``)
    indexes into the resolved array value.
    """
    if datasource_manager is None:
        return None

    registry_path = _ARRAY_INDEX_RE.sub("", path)
    index_match = _ARRAY_INDEX_RE.search(path)
    index = int(index_match.group(1)) if index_match else None
    key = build_var_key(ds_name, registry_path)

    ds_entry = datasource_manager.get(ds_name)
    value: Any = None
    if ds_entry is not None and ds_entry.ds_type == "static":
        value = _cached(datasource_manager, key)
    elif opcua_pool is not None:
        engine = opcua_pool.get(ds_name)
        if engine is not None:
            try:
                values = await engine.read_current_values({registry_path})
                value = values.get(key)
            except Exception:
                value = None
        if value is None:
            value = _cached(datasource_manager, key)
    else:
        value = _cached(datasource_manager, key)

    if index is not None and isinstance(value, list):
        return value[index] if index < len(value) else None
    return value


def _cached(datasource_manager: Any, key: str) -> Any:
    try:
        return datasource_manager.get_cached_values({key}).get(key)
    except Exception:
        return None
