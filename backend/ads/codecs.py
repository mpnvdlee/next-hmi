"""
ads.codecs — IEC 61131-3 base types: their OPC-UA type name and byte codec.

A TwinCAT type is reported under the OPC-UA builtin type name it maps to
(``INT`` → ``Int16``, ``LREAL`` → ``Double``), so the variable tree, the
simple-type collapse in ``core.value_types`` and the write coercion treat an
ADS variable exactly like an OPC-UA one.

``decode`` returns the value in its cache form (``core.value_types``): a
DateTime as ISO 8601 UTC, a Date ``YYYY-MM-DD``, a Time ``HH:MM:SS``, a
Duration in seconds, an integer beyond 2**53 as its decimal string. ``encode``
accepts that form back as well as the Python objects the write coercion hands
over, so a value read with ``raw=True`` round-trips unchanged.

DT, DATE and TOD carry no time zone on the PLC; they are read and written as
UTC, the way a naive datetime is everywhere else in the backend.
"""

from __future__ import annotations

import re
import struct
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from core.value_types import datetime_to_iso, json_ready_scalar

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
# TwinCAT's default STRING length when none is declared.
DEFAULT_STRING_LENGTH = 80


@dataclass(frozen=True, slots=True)
class ScalarCodec:
    type_name: str  # OPC-UA builtin type name
    size: int
    decode: Callable[[bytes], Any]
    encode: Callable[[Any], bytes]


def _int_value(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and re.fullmatch(r"[+-]?\d+", value.strip()):
        return int(value.strip())
    raise ValueError(f"not an integer: {value!r}")


def _numeric(fmt: str, type_name: str, *, is_float: bool = False) -> ScalarCodec:
    packer = struct.Struct("<" + fmt)

    def decode(data: bytes) -> Any:
        return json_ready_scalar(packer.unpack_from(data)[0])

    def encode(value: Any) -> bytes:
        try:
            return packer.pack(float(value) if is_float else _int_value(value))
        except (struct.error, OverflowError) as exc:
            raise ValueError(f"{value!r} out of range for {type_name}") from exc

    return ScalarCodec(type_name, packer.size, decode, encode)


def _bool_codec() -> ScalarCodec:
    def encode(value: Any) -> bytes:
        if isinstance(value, str):
            value = value.strip().lower() in {"true", "1"}
        return b"\x01" if value else b"\x00"

    return ScalarCodec("Boolean", 1, lambda data: data[0] != 0, encode)


def _string_codec(length: int, *, wide: bool) -> ScalarCodec:
    # STRING is Windows-1252 on the PLC, WSTRING UTF-16; both NUL-terminated
    # inside a fixed buffer of length + 1 characters.
    encoding, unit = ("utf-16-le", 2) if wide else ("cp1252", 1)
    size = (length + 1) * unit
    terminator = b"\0" * unit

    def decode(data: bytes) -> str:
        raw = data[:size]
        for pos in range(0, len(raw), unit):
            if raw[pos:pos + unit] == terminator:
                raw = raw[:pos]
                break
        return raw.decode(encoding, errors="replace")

    def encode(value: Any) -> bytes:
        text = value if isinstance(value, str) else str(value)
        raw = text.encode(encoding)
        if len(raw) > length * unit:
            raise ValueError(f"text longer than {length} characters")
        return raw.ljust(size, b"\0")

    return ScalarCodec("String", size, decode, encode)


def _duration_codec(fmt: str, units_per_second: int) -> ScalarCodec:
    packer = struct.Struct("<" + fmt)

    def decode(data: bytes) -> float:
        return packer.unpack_from(data)[0] / units_per_second

    def encode(value: Any) -> bytes:
        try:
            return packer.pack(round(float(value) * units_per_second))
        except struct.error as exc:
            raise ValueError(f"duration {value!r} out of range") from exc

    return ScalarCodec("Duration", packer.size, decode, encode)


def _as_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        text = value.strip()
        parsed = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    else:
        raise ValueError(f"not a date and time: {value!r}")
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def _as_date(value: Any) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return date.fromisoformat(value.strip())
    raise ValueError(f"not a date: {value!r}")


def _as_time(value: Any) -> time:
    if isinstance(value, time):
        return value
    if isinstance(value, str):
        return time.fromisoformat(value.strip())
    raise ValueError(f"not a time of day: {value!r}")


def _epoch_codec(fmt: str, units_per_second: int, kind: str) -> ScalarCodec:
    """DT/LDT (DateTime) and DATE/LDATE (Date): time since 1970-01-01."""
    packer = struct.Struct("<" + fmt)

    def decode(data: bytes) -> str:
        units = packer.unpack_from(data)[0]
        stamp = _EPOCH + timedelta(microseconds=units * 1_000_000 // units_per_second)
        return stamp.date().isoformat() if kind == "Date" else datetime_to_iso(stamp)

    def encode(value: Any) -> bytes:
        if kind == "Date":
            stamp = datetime.combine(_as_date(value), time(), tzinfo=UTC)
        else:
            stamp = _as_datetime(value)
        delta = stamp - _EPOCH
        units = (delta // timedelta(microseconds=1)) * units_per_second // 1_000_000
        try:
            return packer.pack(units)
        except struct.error as exc:
            raise ValueError(f"{value!r} out of range for the PLC's {kind}") from exc

    return ScalarCodec("DateTime" if kind == "DateTime" else "Date", packer.size, decode, encode)


def _time_of_day_codec(fmt: str, units_per_second: int) -> ScalarCodec:
    """TOD/LTOD: time since midnight."""
    packer = struct.Struct("<" + fmt)

    def decode(data: bytes) -> str:
        units = packer.unpack_from(data)[0]
        micros = units * 1_000_000 // units_per_second
        return (datetime.min + timedelta(microseconds=micros)).time().isoformat()

    def encode(value: Any) -> bytes:
        t = _as_time(value)
        micros = ((t.hour * 60 + t.minute) * 60 + t.second) * 1_000_000 + t.microsecond
        return packer.pack(micros * units_per_second // 1_000_000)

    return ScalarCodec("Time", packer.size, decode, encode)


_BASE_CODECS: dict[str, ScalarCodec] = {}


def _register(names: str, codec: ScalarCodec) -> None:
    for name in names.split():
        _BASE_CODECS[name] = codec


_register("BOOL BIT", _bool_codec())
_register("SINT INT8", _numeric("b", "SByte"))
_register("BYTE USINT UINT8", _numeric("B", "Byte"))
_register("INT INT16", _numeric("h", "Int16"))
_register("WORD UINT UINT16", _numeric("H", "UInt16"))
_register("DINT INT32", _numeric("i", "Int32"))
_register("DWORD UDINT UINT32", _numeric("I", "UInt32"))
_register("LINT INT64", _numeric("q", "Int64"))
_register("LWORD ULINT UINT64", _numeric("Q", "UInt64"))
_register("REAL FLOAT", _numeric("f", "Float", is_float=True))
_register("LREAL DOUBLE", _numeric("d", "Double", is_float=True))
_register("TIME", _duration_codec("I", 1_000))
_register("LTIME", _duration_codec("Q", 1_000_000_000))
_register("TIME_OF_DAY TOD", _time_of_day_codec("I", 1_000))
_register("LTIME_OF_DAY LTOD", _time_of_day_codec("Q", 1_000_000_000))
_register("DATE", _epoch_codec("I", 1, "Date"))
_register("LDATE", _epoch_codec("Q", 1_000_000_000, "Date"))
_register("DATE_AND_TIME DT", _epoch_codec("I", 1, "DateTime"))
_register("LDATE_AND_TIME LDT", _epoch_codec("Q", 1_000_000_000, "DateTime"))

_STRING_RE = re.compile(r"(W?STRING)\s*(?:[(\[]\s*(\d+)\s*[)\]])?")


def base_codec(type_name: str) -> ScalarCodec | None:
    """The codec for an IEC base type name (``INT``, ``STRING(40)``), else None."""
    key = type_name.strip().upper()
    codec = _BASE_CODECS.get(key)
    if codec is not None:
        return codec
    match = _STRING_RE.fullmatch(key)
    if match is None:
        return None
    length = int(match.group(2)) if match.group(2) else DEFAULT_STRING_LENGTH
    return _string_codec(length, wide=match.group(1) == "WSTRING")


# The VariantType name each type travels as on OPC-UA, for the write path's
# wire-type check (``services.write_service._wire_data_type``).
WIRE_VARIANT_NAMES: dict[str, str] = {
    "Date": "String",
    "Time": "String",
    "Duration": "Double",
}
