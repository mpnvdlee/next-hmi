"""
ads.protocol — the AMS/TCP wire format: frames, ADS command payloads, errors.

Beckhoff ADS over TCP (port 48898). Every integer is little-endian. Pure
encode/decode with no I/O; ``ads.connection`` owns the socket.

A frame is a 6-byte AMS/TCP header (command, length) followed by the 32-byte
AMS header and the command payload. Requests carry state flag 0x0004, the
device answers with 0x0005 and the same invoke id. An AMS/TCP command other
than 0 is addressed to the router itself, not to a device: a client of a
local TwinCAT router registers an AMS port with PORT_CONNECT first.
"""

from __future__ import annotations

import struct
from collections.abc import Iterator
from dataclasses import dataclass
from enum import IntEnum

AMS_TCP_PORT = 48898
TC3_PLC_PORT = 851
# Direct-connect clients pick their own source AMS port; AdsLib starts at 30000.
DEFAULT_SOURCE_PORT = 30000

STATE_FLAGS_REQUEST = 0x0004
STATE_FLAGS_RESPONSE = 0x0005

# Beckhoff caps a sum command at 500 sub-commands.
MAX_SUM_ITEMS = 500

# AMS/TCP header commands: 0 carries an AMS packet, the rest talk to the router.
AMS_TCP_PACKET = 0x0000
AMS_TCP_PORT_CONNECT = 0x1000


class Command(IntEnum):
    READ_DEVICE_INFO = 1
    READ = 2
    WRITE = 3
    READ_STATE = 4
    WRITE_CONTROL = 5
    ADD_NOTIFICATION = 6
    DELETE_NOTIFICATION = 7
    NOTIFICATION = 8
    READ_WRITE = 9


class IndexGroup(IntEnum):
    SYM_VERSION = 0xF008
    SYM_UPLOAD = 0xF00B
    SYM_DT_UPLOAD = 0xF00E
    SYM_UPLOAD_INFO2 = 0xF00F
    SUM_READ = 0xF080
    SUM_WRITE = 0xF081


class TransMode(IntEnum):
    SERVER_CYCLE = 3
    SERVER_ON_CHANGE = 4


class AdsState(IntEnum):
    RUN = 5
    STOP = 6


_ERROR_TEXTS: dict[int, str] = {
    0x0006: "target port not found (ADS server not running)",
    0x0007: "target machine not found (no AMS route to this client)",
    0x0700: "general device error",
    0x0701: "service not supported by the server",
    0x0702: "invalid index group",
    0x0703: "invalid index offset",
    0x0704: "reading or writing not permitted",
    0x0705: "parameter size not correct",
    0x0706: "invalid parameter value",
    0x0707: "device not in a ready state",
    0x0708: "device busy",
    0x070A: "out of memory",
    0x0710: "symbol not found",
    0x0711: "symbol version invalid",
    0x0712: "server is in an invalid state",
    0x0713: "transmission mode not supported",
    0x0714: "notification handle invalid",
}


class AdsError(Exception):
    """An ADS error code returned by the device (AMS header or command result)."""

    def __init__(self, code: int) -> None:
        self.code = code
        text = _ERROR_TEXTS.get(code, "unknown error")
        super().__init__(f"ADS error 0x{code:04X}: {text}")


# ── AMS addressing ───────────────────────────────────────────────────────────


def parse_net_id(text: str) -> bytes:
    """``"5.12.82.20.1.1"`` → its six bytes; ValueError for anything else."""
    parts = text.strip().split(".")
    if len(parts) != 6:
        raise ValueError(f"AMS NetID must have six parts: {text!r}")
    try:
        octets = [int(p) for p in parts]
    except ValueError as exc:
        raise ValueError(f"AMS NetID parts must be numbers: {text!r}") from exc
    if any(not 0 <= o <= 255 for o in octets):
        raise ValueError(f"AMS NetID parts must be 0-255: {text!r}")
    return bytes(octets)


def format_net_id(raw: bytes) -> str:
    return ".".join(str(b) for b in raw)


@dataclass(frozen=True, slots=True)
class AmsAddress:
    net_id: bytes
    port: int


# ── Frames ───────────────────────────────────────────────────────────────────

_TCP_HEADER = struct.Struct("<HI")
_AMS_HEADER = struct.Struct("<6sH6sHHHIII")
TCP_HEADER_SIZE = _TCP_HEADER.size
AMS_HEADER_SIZE = _AMS_HEADER.size


@dataclass(frozen=True, slots=True)
class AmsPacket:
    target: AmsAddress
    source: AmsAddress
    command: int
    state_flags: int
    error: int
    invoke_id: int
    data: bytes


def encode_frame(
    target: AmsAddress,
    source: AmsAddress,
    command: int,
    invoke_id: int,
    data: bytes,
    *,
    state_flags: int = STATE_FLAGS_REQUEST,
    error: int = 0,
) -> bytes:
    ams = _AMS_HEADER.pack(
        target.net_id, target.port, source.net_id, source.port,
        command, state_flags, len(data), error, invoke_id,
    )
    return _TCP_HEADER.pack(0, len(ams) + len(data)) + ams + data


def frame_length(tcp_header: bytes) -> int:
    """Bytes following the 6-byte AMS/TCP header."""
    return _TCP_HEADER.unpack(tcp_header)[1]


def decode_tcp_header(tcp_header: bytes) -> tuple[int, int]:
    """``(AMS/TCP command, bytes following)``."""
    return _TCP_HEADER.unpack(tcp_header)


def encode_port_connect(port: int = 0) -> bytes:
    """Ask a local router for an AMS port (0: any free one). It answers with
    the same command and this client's NetID and port."""
    return _TCP_HEADER.pack(AMS_TCP_PORT_CONNECT, 2) + struct.pack("<H", port)


def decode_port_connect(data: bytes) -> AmsAddress:
    if len(data) < 8:
        raise ValueError("router answered the port registration without an address")
    return AmsAddress(data[:6], struct.unpack_from("<H", data, 6)[0])


def decode_packet(body: bytes) -> AmsPacket:
    """The AMS header and payload that follow an AMS/TCP header."""
    if len(body) < AMS_HEADER_SIZE:
        raise ValueError("AMS frame shorter than its header")
    t_net, t_port, s_net, s_port, command, flags, length, error, invoke_id = (
        _AMS_HEADER.unpack_from(body)
    )
    data = body[AMS_HEADER_SIZE:AMS_HEADER_SIZE + length]
    return AmsPacket(
        AmsAddress(t_net, t_port), AmsAddress(s_net, s_port),
        command, flags, error, invoke_id, data,
    )


# ── Command payloads ─────────────────────────────────────────────────────────


def _check_result(data: bytes) -> None:
    if len(data) < 4:
        raise ValueError("ADS response without a result code")
    (result,) = struct.unpack_from("<I", data)
    if result:
        raise AdsError(result)


def encode_read(index_group: int, index_offset: int, length: int) -> bytes:
    return struct.pack("<III", index_group, index_offset, length)


def encode_write(index_group: int, index_offset: int, payload: bytes) -> bytes:
    return struct.pack("<III", index_group, index_offset, len(payload)) + payload


def encode_read_write(index_group: int, index_offset: int, read_length: int, payload: bytes) -> bytes:
    return struct.pack("<IIII", index_group, index_offset, read_length, len(payload)) + payload


def decode_data_response(data: bytes) -> bytes:
    """Read and ReadWrite answer with result, length, data."""
    _check_result(data)
    (length,) = struct.unpack_from("<I", data, 4)
    return data[8:8 + length]


def decode_result_response(data: bytes) -> None:
    """Write, WriteControl and DeleteNotification answer with the result alone."""
    _check_result(data)


@dataclass(frozen=True, slots=True)
class DeviceInfo:
    name: str
    version: str


def decode_device_info(data: bytes) -> DeviceInfo:
    _check_result(data)
    major, minor, build = struct.unpack_from("<BBH", data, 4)
    name = data[8:24].split(b"\0", 1)[0].decode("latin-1")
    return DeviceInfo(name, f"{major}.{minor}.{build}")


def decode_read_state(data: bytes) -> tuple[int, int]:
    """``(ads_state, device_state)``."""
    _check_result(data)
    return struct.unpack_from("<HH", data, 4)


def encode_add_notification(
    index_group: int,
    index_offset: int,
    length: int,
    mode: TransMode,
    max_delay_ms: float,
    cycle_time_ms: float,
) -> bytes:
    # Both times travel in 100 ns units (the AdsNotificationAttrib layout).
    return struct.pack(
        "<IIIIII16x", index_group, index_offset, length, int(mode),
        round(max_delay_ms * 10_000), round(cycle_time_ms * 10_000),
    )


def decode_add_notification(data: bytes) -> int:
    """The notification handle."""
    _check_result(data)
    return struct.unpack_from("<I", data, 4)[0]


def encode_delete_notification(handle: int) -> bytes:
    return struct.pack("<I", handle)


def iter_notification_samples(data: bytes) -> Iterator[tuple[int, bytes]]:
    """``(handle, payload)`` for every sample of a DeviceNotification.

    Layout: length, stamp count, then per stamp a FILETIME and a sample count
    followed by ``(handle, size, data)`` samples.
    """
    _length, stamps = struct.unpack_from("<II", data)
    pos = 8
    for _ in range(stamps):
        _timestamp, samples = struct.unpack_from("<QI", data, pos)
        pos += 12
        for _ in range(samples):
            handle, size = struct.unpack_from("<II", data, pos)
            pos += 8
            yield handle, data[pos:pos + size]
            pos += size


# ── Sum commands ─────────────────────────────────────────────────────────────


def encode_sum_read(items: list[tuple[int, int, int]]) -> tuple[bytes, int]:
    """Payload and read length for one SUM_READ of ``(group, offset, length)`` items."""
    payload = b"".join(struct.pack("<III", g, o, n) for g, o, n in items)
    read_length = 4 * len(items) + sum(n for _, _, n in items)
    return payload, read_length


def decode_sum_read(data: bytes, lengths: list[int]) -> list[tuple[int, bytes]]:
    """``(error, data)`` per item: every error code first, then each item's
    data at its requested length, present even for an item that failed."""
    count = len(lengths)
    errors = struct.unpack_from(f"<{count}I", data)
    pos = 4 * count
    results: list[tuple[int, bytes]] = []
    for error, length in zip(errors, lengths, strict=True):
        results.append((error, data[pos:pos + length]))
        pos += length
    return results


def encode_sum_write(items: list[tuple[int, int, bytes]]) -> tuple[bytes, int]:
    """Payload and read length for one SUM_WRITE of ``(group, offset, data)`` items."""
    headers = b"".join(struct.pack("<III", g, o, len(d)) for g, o, d in items)
    return headers + b"".join(d for _, _, d in items), 4 * len(items)


def decode_sum_write(data: bytes, count: int) -> list[int]:
    return list(struct.unpack_from(f"<{count}I", data))
