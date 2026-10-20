"""Every OPC-UA type table in the backend, held to opcuaBuiltinTypes.json.

The same fixture drives the "OPC-UA builtin type table" block of
frontend/src/shared/utils/valueTypes.test.ts, so a type name added to one
table — browse, the write path, the simple-type mapping, the test server or
the test-server editor — fails a test until the fixture and the other side
learn it too. The fixture is maintained by hand.

A ``writeVariantType`` of null is a type the write path refuses
(``unknown_type``); a ``testServerType`` of null is one the test server
refuses to build.
"""

import json
from pathlib import Path

import pytest
from asyncua import ua
from core.exceptions import DatasourceValidationError
from core.value_types import (
    OPCUA_TO_SIMPLE,
    VALUE_TYPES,
    representative_opcua_type,
    to_simple_type,
)
from opcua import browse, test_server
from services import write_service

FIXTURES_DIR = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "shared"
    / "types"
    / "__fixtures__"
)
FIXTURE = json.loads(
    (FIXTURES_DIR / "opcuaBuiltinTypes.json").read_text(encoding="utf-8")
)
TYPES = FIXTURE["types"]
_IDS = [t["name"] for t in TYPES]


def _lower_names(field: str) -> set[str]:
    return {t["name"].lower() for t in TYPES if t[field] is not None}


def test_fixture_names_are_unique_case_insensitively() -> None:
    assert len({name.lower() for name in _IDS}) == len(_IDS)


def test_fixture_test_server_types_are_written_as_they_are_built() -> None:
    """A test-server node is written back through the write path, so the
    VariantType it is built with must be the one a write sends."""
    for t in TYPES:
        assert t["inOpcuaTypes"] == (t["testServerType"] == t["name"]), t["name"]
        if t["testServerType"] is not None:
            assert t["writeVariantType"] == t["testServerType"], t["name"]


def test_fixture_covers_every_browse_name() -> None:
    names = set(_IDS)
    browse_names = {
        *FIXTURE["browse"]["dataTypeIds"].values(),
        FIXTURE["browse"]["otherDataType"],
        FIXTURE["browse"]["unread"],
    }
    assert browse_names <= names
    # What the test server builds must browse back as the same name.
    assert {t["name"] for t in TYPES if t["inOpcuaTypes"]} <= browse_names


def test_browse_names_namespace_zero_data_types_from_fixture() -> None:
    ids = FIXTURE["browse"]["dataTypeIds"]
    other = FIXTURE["browse"]["otherDataType"]
    for ident in range(1024):
        assert browse._builtin_data_type_name(ident) == ids.get(str(ident), other), (
            ident
        )
    assert browse._UNKNOWN_VAR_ATTRS[0] == FIXTURE["browse"]["unread"]


@pytest.mark.parametrize("entry", TYPES, ids=_IDS)
def test_simple_type(entry: dict) -> None:
    assert to_simple_type(entry["name"]) == entry["simpleType"]


def test_opcua_to_simple_has_no_name_outside_fixture() -> None:
    assert set(OPCUA_TO_SIMPLE) <= {name.lower() for name in _IDS}


@pytest.mark.parametrize("entry", TYPES, ids=_IDS)
def test_write_variant_type(entry: dict) -> None:
    variant = write_service.variant_type_for_data_type(entry["name"])
    assert (variant.name if variant is not None else None) == entry["writeVariantType"]


def test_write_path_accepts_exactly_the_writable_names() -> None:
    assert set(write_service._CANONICAL_TYPE_ALIASES) == _lower_names(
        "writeVariantType"
    )
    raw_types = json.loads(
        (FIXTURES_DIR / "opcuaWriteTypes.json").read_text(encoding="utf-8")
    )
    assert {raw for names in raw_types.values() for raw in names} == _lower_names(
        "writeVariantType"
    )


@pytest.mark.parametrize("entry", TYPES, ids=_IDS)
def test_test_server_variant_type(entry: dict) -> None:
    if entry["testServerType"] is None:
        with pytest.raises(DatasourceValidationError):
            test_server._variant_type(entry["name"], "Var")
        return
    expected = ua.VariantType[entry["testServerType"]]
    assert test_server._variant_type(entry["name"], "Var") == expected
    assert test_server._variant_type(f" {entry['name'].upper()} ", "Var") == expected


def test_test_server_builds_exactly_the_test_server_names() -> None:
    assert set(test_server._VARIANT_MAP) == _lower_names("testServerType")


@pytest.mark.parametrize("data_type", [None, "", 3, "Mystery"])
def test_test_server_refuses_what_it_cannot_name(data_type) -> None:
    with pytest.raises(DatasourceValidationError, match="Var"):
        test_server._variant_type(data_type, "Var")


def test_representative_types_match_fixture() -> None:
    representative = FIXTURE["representative"]
    assert set(representative) == VALUE_TYPES
    by_name = {t["name"]: t for t in TYPES}
    for simple, opcua_type in representative.items():
        assert representative_opcua_type(simple) == opcua_type
        # MCP's add_variable stores the representative on any datasource,
        # a test server included.
        assert by_name[opcua_type]["testServerType"] == opcua_type
