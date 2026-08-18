import json
from datetime import datetime, time
from pathlib import Path

import pytest
from services.write_service import WriteCoercionError, coerce_entry_write_value

FIXTURES_DIR = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "shared"
    / "types"
    / "__fixtures__"
)


def _load(name: str):
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


def _normalize(value):
    if isinstance(value, datetime):
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, time):
        rendered = value.isoformat()
        return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered
    if isinstance(value, int) and abs(value) > 9007199254740991:
        return str(value)
    if isinstance(value, str) and "." in value and ":" in value:
        return value.rstrip("0").rstrip(".")
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    return value


@pytest.mark.parametrize("case", _load("opcuaWriteCoercion.json"), ids=lambda case: case["name"])
def test_cross_language_coercion_cases(case: dict) -> None:
    entry = {
        "data_type": case["dataType"],
        "is_array": case.get("isArray", False),
        "array_length": case.get("arrayLength"),
    }
    if case["ok"]:
        assert _normalize(coerce_entry_write_value(case["value"], entry)) == case["output"]
        return
    with pytest.raises(WriteCoercionError) as exc_info:
        coerce_entry_write_value(case["value"], entry)
    assert exc_info.value.reason == case["reason"]


def test_every_raw_type_in_shared_mapping_is_accepted() -> None:
    samples = {
        "Boolean": False,
        "Integer": 0,
        "Float": 0,
        "String": "x",
        "DateTime": "2026-06-15T12:00:00Z",
        "Date": "2026-06-15",
        "Time": "12:00:00",
        "Duration": 0,
    }
    for canonical, raw_types in _load("opcuaWriteTypes.json").items():
        for raw_type in raw_types:
            coerce_entry_write_value(samples[canonical], {"data_type": raw_type})
