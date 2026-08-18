"""Tests for the shared write_service (extracted from websocket_manager)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC
from typing import Any

import pytest
from models.datasource import build_var_key
from services import write_service


def test_coerce_int32_out_of_range_raises() -> None:
    with pytest.raises(ValueError):
        write_service.coerce_write_value(2147483648, "int32")


def test_coerce_integer_rejects_lossy_float() -> None:
    with pytest.raises(write_service.WriteCoercionError) as exc_info:
        write_service.coerce_write_value(1.5, "Integer")
    assert exc_info.value.reason == write_service.COERCION_LOSSY


def test_coerce_int64_requires_decimal_string_outside_json_safe_range() -> None:
    with pytest.raises(write_service.WriteCoercionError) as exc_info:
        write_service.coerce_write_value(9007199254740992, "Int64")
    assert exc_info.value.reason == write_service.COERCION_LOSSY
    assert write_service.coerce_write_value("9223372036854775807", "Int64") == 9223372036854775807


def test_pathological_integer_string_is_bounded_before_int_parsing() -> None:
    with pytest.raises(write_service.WriteCoercionError) as exc_info:
        write_service.coerce_write_value("9" * 5001, "UInt64")
    assert exc_info.value.reason == write_service.COERCION_INTEGER_RANGE


def test_coerce_uint8_negative_raises() -> None:
    with pytest.raises(ValueError):
        write_service.coerce_write_value(-1, "uint8")


def test_coerce_float_nan_raises() -> None:
    with pytest.raises(ValueError):
        write_service.coerce_write_value("nan", "float")


def test_coerce_bool_ambiguous_string_raises() -> None:
    with pytest.raises(ValueError):
        write_service.coerce_write_value("maybe", "bool")


def test_coerce_bool_accepts_true_false() -> None:
    assert write_service.coerce_write_value("true", "bool") is True
    assert write_service.coerce_write_value("false", "bool") is False


def test_coerce_datetime_parses_iso8601() -> None:
    from datetime import datetime

    result = write_service.coerce_write_value("2026-06-15T12:00:00Z", "datetime")
    assert result == datetime(2026, 6, 15, 12, 0, 0, tzinfo=UTC)

    naive = write_service.coerce_write_value("2026-06-15T12:00:00", "datetime")
    assert naive == datetime(2026, 6, 15, 12, 0, 0)


def test_coerce_datetime_rejects_garbage() -> None:
    with pytest.raises(ValueError):
        write_service.coerce_write_value("not-a-date", "datetime")


def test_coerce_rejects_null_and_unknown_type() -> None:
    with pytest.raises(write_service.WriteCoercionError) as null_error:
        write_service.coerce_write_value(None, "String")
    assert null_error.value.reason == write_service.COERCION_NULL_NOT_ALLOWED
    with pytest.raises(write_service.WriteCoercionError) as unknown_error:
        write_service.coerce_write_value("x", "LocalizedText")
    assert unknown_error.value.reason == write_service.COERCION_UNKNOWN_TYPE


def test_variant_types_cover_canonical_write_aliases() -> None:
    from asyncua import ua

    assert write_service.variant_type_for_data_type("Integer") == ua.VariantType.Int32
    assert write_service.variant_type_for_data_type("Enumeration") == ua.VariantType.Int32
    assert write_service.variant_type_for_data_type("Duration") == ua.VariantType.Double
    assert write_service.variant_type_for_data_type("Date") == ua.VariantType.String


def test_float32_contract_serializes_only_exact_values() -> None:
    from asyncua import ua
    from asyncua.ua.ua_binary import variant_to_binary

    maximum = 3.4028234663852886e38
    coerced = write_service.coerce_write_value(maximum, "Float")
    assert variant_to_binary(ua.Variant(coerced, ua.VariantType.Float))
    with pytest.raises(write_service.WriteCoercionError) as rounding:
        write_service.coerce_write_value(0.1, "Float")
    assert rounding.value.reason == write_service.COERCION_LOSSY
    with pytest.raises(write_service.WriteCoercionError) as overflow:
        write_service.coerce_write_value("3.5e38", "Single")
    assert overflow.value.reason == write_service.COERCION_FLOAT_RANGE


def test_shared_write_permission_defaults_to_guest_and_matches_groups() -> None:
    entry = {"interactableByGroups": ["operator"]}
    assert not write_service.write_permitted(None, entry)
    assert write_service.write_permitted({"groups": ["operator"]}, entry)
    assert not write_service.write_permitted({"groups": ["guest"]}, entry)
    assert write_service.write_permitted(None, {"interactableByGroups": []})


@dataclass
class FakeEntry:
    ds_type: str = "static"
    cache: dict[str, Any] = field(default_factory=dict)


class FakeStaticDM:
    """Static datasource manager: writes update an in-memory cache."""

    def __init__(self, registry: dict[str, dict[str, Any]]):
        self._registry = registry  # path -> entry_data
        self._entry = FakeEntry(ds_type="static")

    def get_entry(self, ds_name: str, path: str) -> dict[str, Any] | None:
        return self._registry.get(path)

    def get(self, name: str) -> FakeEntry:
        return self._entry

    def update_static_value(self, ds_name: str, path: str, value: Any) -> None:
        # Mirror the real manager: array-element path patches element N.
        base, _, idx = path.partition("[")
        key = build_var_key(ds_name, base)
        if idx:
            n = int(idx.rstrip("]"))
            cur = self._entry.cache.get(key)
            cur = list(cur) if isinstance(cur, list) else []
            while len(cur) <= n:
                cur.append(0)
            cur[n] = value
            self._entry.cache[key] = cur
        else:
            self._entry.cache[key] = value

    def get_cached_values(self, keys: set[str]) -> dict[str, Any]:
        return {k: self._entry.cache[k] for k in keys if k in self._entry.cache}


class FakeEngine:
    def __init__(self) -> None:
        self.writes: list[tuple[str, Any]] = []
        self._store: dict[str, Any] = {}
        self.fail = False

    async def write_node(self, node_id: str, value: Any, variant: Any) -> None:
        if self.fail:
            raise RuntimeError("boom")
        self.writes.append((node_id, value))
        self._store[node_id] = value

    async def read_current_values(self, paths: set[str]) -> dict[str, Any]:
        # Map back registry path -> composite key using the entry's node_id.
        out = {}
        for path in paths:
            node_id = f"ns=2;s={path}"
            if node_id in self._store:
                out[build_var_key("PLC", path)] = self._store[node_id]
        return out


class FakeOpcuaPool:
    def __init__(self, engine: FakeEngine):
        self._engine = engine

    def get(self, name: str) -> FakeEngine:
        return self._engine


class FakeOpcuaDM:
    def __init__(self, registry: dict[str, dict[str, Any]]):
        self._registry = registry
        self._entry = FakeEntry(ds_type="opcua-client")

    def get_entry(self, ds_name: str, path: str) -> dict[str, Any] | None:
        return self._registry.get(path)

    def get(self, name: str) -> FakeEntry:
        return self._entry

    def get_cached_values(self, keys: set[str]) -> dict[str, Any]:
        return {}


@pytest.mark.asyncio
async def test_static_write_and_verify_match():
    dm = FakeStaticDM({"Temp": {"data_type": "float"}})
    outcome = await write_service.write_value(dm, None, "DS", "Temp", "92", verify=True)
    assert outcome.ok
    assert outcome.reason is None
    assert dm._entry.cache[build_var_key("DS", "Temp")] == 92.0


@pytest.mark.asyncio
async def test_static_write_bad_path():
    dm = FakeStaticDM({})
    outcome = await write_service.write_value(dm, None, "DS", "Nope", 1)
    assert not outcome.ok
    assert outcome.reason == write_service.REASON_BAD_PATH


@pytest.mark.asyncio
async def test_static_field_write_targets_the_child_variable():
    # A field write names the struct folder, but the value belongs to the child.
    # Addressing the folder made the real manager return silently while the
    # outcome still reported ok — an accepted write that went nowhere.
    dm = FakeStaticDM(
        {
            "Trial": {"_child_paths": {"Trial/fValue": "fValue"}},
            "Trial/fValue": {"data_type": "float"},
        }
    )
    outcome = await write_service.write_value(dm, None, "DS", "Trial", 42, field="fValue")
    assert outcome.ok
    assert dm._entry.cache[build_var_key("DS", "Trial/fValue")] == 42.0
    assert build_var_key("DS", "Trial") not in dm._entry.cache


@pytest.mark.asyncio
async def test_static_field_write_unknown_field_is_rejected():
    dm = FakeStaticDM({"Trial": {"_child_paths": {"Trial/fValue": "fValue"}}})
    outcome = await write_service.write_value(dm, None, "DS", "Trial", 1, field="nope")
    assert not outcome.ok
    assert outcome.reason == write_service.REASON_BAD_FIELD


@pytest.mark.asyncio
async def test_invalid_value_reason():
    dm = FakeStaticDM({"Count": {"data_type": "int32"}})
    outcome = await write_service.write_value(dm, None, "DS", "Count", "not-a-number")
    assert not outcome.ok
    assert outcome.reason == write_service.REASON_INVALID_VALUE


@pytest.mark.asyncio
async def test_write_within_configured_range_ok():
    dm = FakeStaticDM({"Temp": {"data_type": "float", "min": -20, "max": 10}})
    outcome = await write_service.write_value(dm, None, "DS", "Temp", 5)
    assert outcome.ok


@pytest.mark.asyncio
async def test_write_below_min_rejected():
    dm = FakeStaticDM({"Temp": {"data_type": "float", "min": -20, "max": 10}})
    outcome = await write_service.write_value(dm, None, "DS", "Temp", -21)
    assert not outcome.ok
    assert outcome.reason == write_service.REASON_VALUE_OUT_OF_RANGE


@pytest.mark.asyncio
async def test_write_above_max_rejected():
    dm = FakeStaticDM({"Temp": {"data_type": "float", "min": -20, "max": 10}})
    outcome = await write_service.write_value(dm, None, "DS", "Temp", 11)
    assert not outcome.ok
    assert outcome.reason == write_service.REASON_VALUE_OUT_OF_RANGE


@pytest.mark.asyncio
async def test_write_boundary_values_are_inclusive():
    dm = FakeStaticDM({"Temp": {"data_type": "float", "min": -20, "max": 10}})
    assert (await write_service.write_value(dm, None, "DS", "Temp", -20)).ok
    assert (await write_service.write_value(dm, None, "DS", "Temp", 10)).ok


@pytest.mark.asyncio
async def test_write_without_configured_range_is_unaffected():
    dm = FakeStaticDM({"Temp": {"data_type": "float"}})
    outcome = await write_service.write_value(dm, None, "DS", "Temp", 1_000_000)
    assert outcome.ok


@pytest.mark.asyncio
async def test_write_with_only_min_configured_enforces_lower_bound_only():
    dm = FakeStaticDM({"Temp": {"data_type": "float", "min": 0}})
    assert (await write_service.write_value(dm, None, "DS", "Temp", -1)).reason == (
        write_service.REASON_VALUE_OUT_OF_RANGE
    )
    assert (await write_service.write_value(dm, None, "DS", "Temp", 1_000_000)).ok


@pytest.mark.asyncio
async def test_write_with_invalid_persisted_range_is_unenforced():
    """min > max is a contract violation (see _log_invalid_ranges); until an
    author corrects it, writes are not blocked by the broken bound."""
    dm = FakeStaticDM({"Temp": {"data_type": "float", "min": 10, "max": -20}})
    outcome = await write_service.write_value(dm, None, "DS", "Temp", 1_000_000)
    assert outcome.ok


@pytest.mark.asyncio
async def test_array_write_rejects_any_out_of_range_element():
    dm = FakeStaticDM({"Steps": {"data_type": "int32", "is_array": True, "min": 0, "max": 100}})
    outcome = await write_service.write_value(dm, None, "DS", "Steps", [1, 2, 101])
    assert not outcome.ok
    assert outcome.reason == write_service.REASON_VALUE_OUT_OF_RANGE


@pytest.mark.asyncio
async def test_indexed_array_element_write_rejected_out_of_range():
    dm = FakeStaticDM({"Steps": {"data_type": "int32", "is_array": True, "min": 0, "max": 100}})
    dm._entry.cache[build_var_key("DS", "Steps")] = [1, 2, 3]
    outcome = await write_service.write_value(dm, None, "DS", "Steps[1]", 101)
    assert not outcome.ok
    assert outcome.reason == write_service.REASON_VALUE_OUT_OF_RANGE


@pytest.mark.asyncio
async def test_static_array_write():
    dm = FakeStaticDM({"Steps": {"data_type": "integer", "is_array": True, "array_length": 3}})
    outcome = await write_service.write_value(dm, None, "DS", "Steps", [1, 2, 3])
    assert outcome.ok
    assert dm._entry.cache[build_var_key("DS", "Steps")] == [1, 2, 3]


@pytest.mark.asyncio
async def test_static_fixed_array_rejects_wrong_length():
    dm = FakeStaticDM({"Steps": {"data_type": "integer", "is_array": True, "array_length": 3}})
    outcome = await write_service.write_value(dm, None, "DS", "Steps", [1, 2])
    assert outcome == write_service.WriteOutcome(False, write_service.REASON_INVALID_VALUE)


@pytest.mark.asyncio
async def test_static_indexed_write_rejected_out_of_bounds():
    """§1.9: write_value rejects an out-of-bounds indexed write upstream,
    without ever reaching update_static_value."""
    dm = FakeStaticDM({"Steps": {"data_type": "integer", "is_array": True, "array_length": 3}})
    outcome = await write_service.write_value(dm, None, "DS", "Steps[5]", 9)
    assert not outcome.ok
    assert outcome.reason == write_service.REASON_ARRAY_INDEX_OUT_OF_BOUNDS
    assert build_var_key("DS", "Steps") not in dm._entry.cache


@pytest.mark.asyncio
async def test_opcua_indexed_write_rejected_out_of_bounds():
    engine = FakeEngine()
    dm = FakeOpcuaDM({
        "Steps": {"data_type": "int32", "is_array": True, "array_length": 3, "node_id": "ns=2;s=Steps"},
    })
    pool = FakeOpcuaPool(engine)
    outcome = await write_service.write_value(dm, pool, "PLC", "Steps[5]", 9)
    assert not outcome.ok
    assert outcome.reason == write_service.REASON_ARRAY_INDEX_OUT_OF_BOUNDS
    assert engine.writes == []


@pytest.mark.asyncio
async def test_dynamic_array_index_has_allocation_cap():
    engine = FakeEngine()
    dm = FakeOpcuaDM({
        "Steps": {"data_type": "int32", "is_array": True, "node_id": "ns=2;s=Steps"},
    })
    outcome = await write_service.write_value(
        dm, FakeOpcuaPool(engine), "PLC", "Steps[10001]", 9
    )
    assert outcome.reason == write_service.REASON_ARRAY_INDEX_OUT_OF_BOUNDS
    assert engine.writes == []


@pytest.mark.asyncio
async def test_negative_array_index_is_rejected_without_dispatch():
    engine = FakeEngine()
    dm = FakeOpcuaDM({
        "Steps": {"data_type": "int32", "is_array": True, "node_id": "ns=2;s=Steps"},
    })
    outcome = await write_service.write_value(
        dm, FakeOpcuaPool(engine), "PLC", "Steps[-1]", 9
    )
    assert outcome.reason == write_service.REASON_ARRAY_INDEX_OUT_OF_BOUNDS
    assert engine.writes == []


@pytest.mark.asyncio
async def test_pathological_array_index_is_bounded_before_int_parsing():
    engine = FakeEngine()
    dm = FakeOpcuaDM({
        "Steps": {"data_type": "int32", "is_array": True, "node_id": "ns=2;s=Steps"},
    })
    path = f"Steps[{'9' * 5001}]"
    outcome = await write_service.write_value(dm, FakeOpcuaPool(engine), "PLC", path, 9)
    assert outcome.reason == write_service.REASON_ARRAY_INDEX_OUT_OF_BOUNDS
    assert engine.writes == []


@pytest.mark.asyncio
async def test_indexed_fixed_array_rejects_short_authoritative_state_without_synthesizing():
    engine = FakeEngine()
    dm = FakeOpcuaDM({
        "Steps": {
            "data_type": "int32",
            "is_array": True,
            "array_length": 3,
            "node_id": "ns=2;s=Steps",
        },
    })
    dm._entry.cache[build_var_key("PLC", "Steps")] = [1, 2, 3]
    engine._store["ns=2;s=Steps"] = [99]
    outcome = await write_service.write_value(
        dm, FakeOpcuaPool(engine), "PLC", "Steps[1]", 7
    )
    assert outcome.reason == write_service.REASON_ARRAY_STATE_UNAVAILABLE
    assert engine.writes == []


@pytest.mark.asyncio
@pytest.mark.parametrize("current", [None, [1, 2], [1, 2, 3, 4]])
async def test_indexed_fixed_array_rejects_missing_or_wrong_length_current_state(current):
    engine = FakeEngine()
    dm = FakeOpcuaDM({
        "Steps": {
            "data_type": "int32",
            "is_array": True,
            "array_length": 3,
            "node_id": "ns=2;s=Steps",
        },
    })
    if current is not None:
        engine._store["ns=2;s=Steps"] = current
    outcome = await write_service.write_value(
        dm, FakeOpcuaPool(engine), "PLC", "Steps[1]", 7
    )
    assert outcome.reason == write_service.REASON_ARRAY_STATE_UNAVAILABLE
    assert engine.writes == []


@pytest.mark.asyncio
async def test_indexed_array_reads_authoritative_state_and_preserves_siblings():
    engine = FakeEngine()
    dm = FakeOpcuaDM({
        "Steps": {
            "data_type": "int32",
            "is_array": True,
            "array_length": 3,
            "node_id": "ns=2;s=Steps",
        },
    })
    dm._entry.cache[build_var_key("PLC", "Steps")] = [91, 92, 93]
    engine._store["ns=2;s=Steps"] = [11, 22, 33]
    outcome = await write_service.write_value(
        dm, FakeOpcuaPool(engine), "PLC", "Steps[1]", 7
    )
    assert outcome.ok
    assert engine.writes == [("ns=2;s=Steps", [11, 7, 33])]


@pytest.mark.asyncio
async def test_indexed_dynamic_array_requires_existing_element():
    engine = FakeEngine()
    dm = FakeOpcuaDM({
        "Steps": {"data_type": "int32", "is_array": True, "node_id": "ns=2;s=Steps"},
    })
    pool = FakeOpcuaPool(engine)
    missing = await write_service.write_value(dm, pool, "PLC", "Steps[0]", 7)
    assert missing.reason == write_service.REASON_ARRAY_STATE_UNAVAILABLE
    engine._store["ns=2;s=Steps"] = [11, 22]
    beyond = await write_service.write_value(dm, pool, "PLC", "Steps[2]", 7)
    assert beyond.reason == write_service.REASON_ARRAY_STATE_UNAVAILABLE
    valid = await write_service.write_value(dm, pool, "PLC", "Steps[1]", 7)
    assert valid.ok
    assert engine.writes == [("ns=2;s=Steps", [11, 7])]


@pytest.mark.asyncio
async def test_opcua_write_and_verify_match():
    engine = FakeEngine()
    dm = FakeOpcuaDM({"Temp": {"data_type": "float", "node_id": "ns=2;s=Temp"}})
    pool = FakeOpcuaPool(engine)
    outcome = await write_service.write_value(dm, pool, "PLC", "Temp", 3.5, verify=True)
    assert outcome.ok
    assert engine.writes == [("ns=2;s=Temp", 3.5)]


@pytest.mark.asyncio
async def test_opcua_verify_mismatch():
    engine = FakeEngine()
    # read_current_values won't return the written value if node_id differs
    dm = FakeOpcuaDM({"Temp": {"data_type": "float", "node_id": "other"}})
    pool = FakeOpcuaPool(engine)
    outcome = await write_service.write_value(dm, pool, "PLC", "Temp", 3.5, verify=True)
    assert not outcome.ok
    assert outcome.reason == write_service.REASON_VERIFY_MISMATCH


@pytest.mark.asyncio
async def test_opcua_write_failed():
    engine = FakeEngine()
    engine.fail = True
    dm = FakeOpcuaDM({"Temp": {"data_type": "float", "node_id": "ns=2;s=Temp"}})
    pool = FakeOpcuaPool(engine)
    outcome = await write_service.write_value(dm, pool, "PLC", "Temp", 3.5)
    assert not outcome.ok
    assert outcome.reason == write_service.REASON_WRITE_FAILED


@pytest.mark.asyncio
async def test_read_value_static_array_index():
    dm = FakeStaticDM({"Steps": {"data_type": "integer", "is_array": True, "array_length": 3}})
    await write_service.write_value(dm, None, "DS", "Steps", [5, 6, 7])
    assert await write_service.read_value(dm, None, "DS", "Steps[1]") == 6
