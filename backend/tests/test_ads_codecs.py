"""IEC 61131-3 base types: OPC-UA type names and byte codecs (ads.codecs)."""

import json
import struct
from datetime import UTC, datetime
from pathlib import Path

import pytest
from ads.codecs import _BASE_CODECS, base_codec

_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "frontend/src/shared/types/__fixtures__/opcuaBuiltinTypes.json"
)


@pytest.mark.parametrize(
    ("type_name", "raw", "value", "opcua"),
    [
        ("BOOL", b"\x01", True, "Boolean"),
        ("SINT", struct.pack("<b", -5), -5, "SByte"),
        ("BYTE", b"\xc8", 200, "Byte"),
        ("INT", struct.pack("<h", -1234), -1234, "Int16"),
        ("WORD", struct.pack("<H", 65535), 65535, "UInt16"),
        ("DINT", struct.pack("<i", -70000), -70000, "Int32"),
        ("UDINT", struct.pack("<I", 4_000_000_000), 4_000_000_000, "UInt32"),
        ("LINT", struct.pack("<q", -(2**40)), -(2**40), "Int64"),
        ("ULINT", struct.pack("<Q", 2**63), str(2**63), "UInt64"),
        ("REAL", struct.pack("<f", 1.5), 1.5, "Float"),
        ("LREAL", struct.pack("<d", -0.25), -0.25, "Double"),
        ("TIME", struct.pack("<I", 1500), 1.5, "Duration"),
        ("LTIME", struct.pack("<Q", 2_500_000_000), 2.5, "Duration"),
        ("TOD", struct.pack("<I", ((13 * 60 + 45) * 60 + 30) * 1000 + 250), "13:45:30.250000", "Time"),
        ("DATE", struct.pack("<I", 1_793_059_200), "2026-10-27", "Date"),
        ("DT", struct.pack("<I", 1_793_089_800), "2026-10-27T08:30:00.000Z", "DateTime"),
        ("LDT", struct.pack("<Q", 1_793_089_800_123_000_000), "2026-10-27T08:30:00.123Z", "DateTime"),
        ("STRING(5)", "héllo".encode("cp1252") + b"\0", "héllo", "String"),
        ("STRING(5)", b"ab\0zz\0", "ab", "String"),
        ("WSTRING(3)", "Ωx".encode("utf-16-le") + b"\0" * 4, "Ωx", "String"),
    ],
)
def test_decodes_to_cache_form_and_encodes_back(type_name: str, raw: bytes, value: object, opcua: str) -> None:
    codec = base_codec(type_name)
    assert codec is not None
    assert codec.type_name == opcua
    assert codec.size == len(raw)
    assert codec.decode(raw) == value
    # The cache form is accepted back as is: a raw read round-trips. A STRING
    # buffer's bytes after the terminator are not part of its value.
    encoded = codec.encode(value)
    assert codec.decode(encoded) == value
    if type_name != "STRING(5)" or value == "héllo":
        assert encoded == raw


def test_encodes_the_objects_the_write_coercion_produces() -> None:
    dt = base_codec("DT")
    assert dt.encode(datetime(2026, 10, 27, 10, 30, tzinfo=UTC)) == struct.pack("<I", 1_793_089_800 + 7200)
    # An offset is converted to the UTC the PLC value is read as.
    assert dt.decode(dt.encode("2026-10-27T10:30:00+02:00")) == "2026-10-27T08:30:00.000Z"
    assert base_codec("TOD").encode("08:00:00") == struct.pack("<I", 8 * 3600 * 1000)
    assert base_codec("ULINT").encode("18446744073709551615") == b"\xff" * 8
    assert base_codec("BOOL").encode("false") == b"\x00"


@pytest.mark.parametrize(
    ("type_name", "value"),
    [("INT", 40000), ("USINT", -1), ("STRING(3)", "four"), ("DINT", "1.5"), ("TIME", 2**40), ("DATE", "27-10-2026")],
)
def test_out_of_range_or_malformed_values_are_refused(type_name: str, value: object) -> None:
    with pytest.raises(ValueError):
        base_codec(type_name).encode(value)


def test_string_declarations() -> None:
    assert base_codec("STRING").size == 81
    assert base_codec("string(10)").size == 11
    assert base_codec("STRING[10]").size == 11
    assert base_codec("WSTRING(10)").size == 22
    assert base_codec("ST_Motor") is None
    assert base_codec("POINTER TO INT") is None


def test_every_type_name_is_one_the_opcua_tables_know() -> None:
    """The type names feed the same collapse and write coercion as OPC-UA's."""
    known = {entry["name"] for entry in json.loads(_FIXTURE.read_text())["types"]}
    produced = {codec.type_name for codec in _BASE_CODECS.values()} | {"String"}
    assert produced <= known, produced - known
