"""A fake TwinCAT 3 PLC on loopback, speaking AMS/TCP, for the ADS client tests.

It serves the commands the client uses — device info, state, read, write,
read-write with sum read/write, add/delete notification — over symbol and
data-type tables encoded here, independently of ``ads.symbols``'s parser,
from a small demo program (``demo_tables``). PLC memory is index group
0x4040; a change to it fires the on-change notifications that cover it.
"""

from __future__ import annotations

import asyncio
import contextlib
import struct
from dataclasses import dataclass

PLC_MEMORY = 0x4040
SYM_VERSION = 0xF008
SYM_UPLOAD = 0xF00B
SYM_DT_UPLOAD = 0xF00E
SYM_UPLOAD_INFO2 = 0xF00F
SUM_READ = 0xF080
SUM_WRITE = 0xF081

ERR_INVALID_GROUP = 0x702
ERR_INVALID_OFFSET = 0x703
ERR_NOTIFICATION_HANDLE = 0x714

SYMBOL_FLAG_BITVALUE = 0x0002
SYMBOL_FLAG_READONLY = 0x0020
DATATYPE_FLAG_DATATYPE = 0x0001
DATATYPE_FLAG_DATAITEM = 0x0002
DATATYPE_FLAG_PROPITEM = 0x0040


# ── Table encoding (the TwinCAT upload format) ───────────────────────────────


def _cstr(text: str) -> bytes:
    return text.encode("cp1252") + b"\0"


def symbol_entry(
    name: str, index_offset: int, size: int, type_name: str, *,
    index_group: int = PLC_MEMORY, flags: int = 0, comment: str = "", extra: bytes = b"",
) -> bytes:
    """One ADS_SYMBOL_ENTRY; *extra* stands in for the optional trailing data
    (GUID, attributes) a parser must skip by entry length."""
    body = _cstr(name) + _cstr(type_name) + _cstr(comment) + extra
    header_size = 30
    return struct.pack(
        "<IIIIIIHHH", header_size + len(body), index_group, index_offset, size,
        65, flags, len(name), len(type_name), len(comment),
    ) + body


def datatype_entry(
    name: str, type_name: str, size: int, *, offset: int = 0,
    flags: int = DATATYPE_FLAG_DATATYPE, array_dims: tuple[tuple[int, int], ...] = (),
    sub_items: tuple[bytes, ...] = (), comment: str = "", extra: bytes = b"",
) -> bytes:
    """One ADS_DATATYPE_ENTRY with its array bounds and encoded sub items."""
    body = _cstr(name) + _cstr(type_name) + _cstr(comment)
    body += b"".join(struct.pack("<iI", lower, count) for lower, count in array_dims)
    body += b"".join(sub_items) + extra
    header_size = 42
    return struct.pack(
        "<IIIIIIIIHHHHH", header_size + len(body), 1, 0, 0, size, offset, 65, flags,
        len(name), len(type_name), len(comment), len(array_dims), len(sub_items),
    ) + body


def member(name: str, type_name: str, size: int, offset: int, *, flags: int = DATATYPE_FLAG_DATAITEM) -> bytes:
    return datatype_entry(name, type_name, size, offset=offset, flags=flags)


# ── The demo program ─────────────────────────────────────────────────────────
#
#   TYPE E_Mode : (Idle, Run) INT;  TYPE T_Speed : LREAL;
#   ST_Limits { fMin, fMax : LREAL }
#   ST_Motor  { fSpeed : LREAL; bRunning : BOOL; eMode : E_Mode; stLimits : ST_Limits;
#               Speed : property (skipped) }
#   ST_Point  { x, y : REAL }

OFFSETS = {
    "MAIN.bStart": 0,
    "MAIN.nCounter": 2,
    "MAIN.fSpeed": 8,
    "MAIN.stMotor": 16,
    "MAIN.aPoints": 48,
    "MAIN.aTemps": 72,
    "MAIN.sName": 88,
    "MAIN.tCycle": 112,
    "MAIN.dtStamp": 116,
    "MAIN.pData": 120,
    "GVL.sVersion": 128,
    "GVL.nBig": 144,
}


def demo_datatypes() -> bytes:
    return b"".join([
        datatype_entry("E_Mode", "INT", 2),
        datatype_entry("T_Speed", "LREAL", 8),
        datatype_entry("ST_Limits", "", 16, sub_items=(
            member("fMin", "LREAL", 8, 0),
            member("fMax", "LREAL", 8, 8),
        )),
        datatype_entry("ST_Motor", "", 32, sub_items=(
            member("fSpeed", "LREAL", 8, 0),
            member("bRunning", "BOOL", 1, 8),
            member("eMode", "E_Mode", 2, 10),
            member("stLimits", "ST_Limits", 16, 16),
            member("Speed", "LREAL", 8, 0, flags=DATATYPE_FLAG_DATAITEM | DATATYPE_FLAG_PROPITEM),
        ), extra=b"\xaa" * 6),
        datatype_entry("ST_Point", "", 8, sub_items=(
            member("x", "REAL", 4, 0),
            member("y", "REAL", 4, 4),
        )),
        datatype_entry("ARRAY [1..3] OF ST_Point", "ST_Point", 24, array_dims=((1, 3),)),
    ])


def demo_symbols() -> bytes:
    o = OFFSETS
    return b"".join([
        symbol_entry("MAIN.bStart", o["MAIN.bStart"], 1, "BOOL"),
        symbol_entry("MAIN.nCounter", o["MAIN.nCounter"], 2, "INT", comment="cycles"),
        symbol_entry("MAIN.fSpeed", o["MAIN.fSpeed"], 8, "T_Speed", extra=b"\0" * 16),
        symbol_entry("MAIN.stMotor", o["MAIN.stMotor"], 32, "ST_Motor"),
        symbol_entry("MAIN.aPoints", o["MAIN.aPoints"], 24, "ARRAY [1..3] OF ST_Point"),
        # Not in the data-type table: the client parses the declaration.
        symbol_entry("MAIN.aTemps", o["MAIN.aTemps"], 16, "ARRAY [0..3] OF REAL"),
        symbol_entry("MAIN.sName", o["MAIN.sName"], 21, "STRING(20)"),
        symbol_entry("MAIN.tCycle", o["MAIN.tCycle"], 4, "TIME"),
        symbol_entry("MAIN.dtStamp", o["MAIN.dtStamp"], 4, "DT"),
        symbol_entry("MAIN.pData", o["MAIN.pData"], 8, "POINTER TO INT"),
        symbol_entry("MAIN.xBit", 3, 1, "BIT", index_group=0xF021, flags=SYMBOL_FLAG_BITVALUE),
        symbol_entry("GVL.sVersion", o["GVL.sVersion"], 11, "STRING(10)", flags=SYMBOL_FLAG_READONLY),
        symbol_entry("GVL.nBig", o["GVL.nBig"], 8, "ULINT"),
    ])


def _count_entries(data: bytes) -> int:
    count = pos = 0
    while pos < len(data):
        pos += struct.unpack_from("<I", data, pos)[0]
        count += 1
    return count


# ── The device ───────────────────────────────────────────────────────────────


@dataclass
class _Notification:
    writer: asyncio.StreamWriter
    target: bytes  # the client's NetID + port, echoed as the frame target
    index_group: int
    index_offset: int
    length: int
    last: bytes


class FakePlc:
    """An ADS device on 127.0.0.1. ``memory`` is index group 0x4040."""

    def __init__(self, *, device_name: str = "Plc30 App", memory_size: int = 4096) -> None:
        self.device_name = device_name
        self.memory = bytearray(memory_size)
        self.symbol_data = demo_symbols()
        self.datatype_data = demo_datatypes()
        self.symbol_version = 1
        self.commands: list[int] = []
        self.sum_reads = 0
        # A device without sum commands (TwinCAT 2, BC controllers).
        self.refuse_sum_reads = False
        self.port = 0
        self._server: asyncio.Server | None = None
        self._writers: set[asyncio.StreamWriter] = set()
        self._notifications: dict[int, _Notification] = {}
        self._next_handle = 1

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._serve, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self.port

    async def stop(self) -> None:
        self.drop_connections()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    def drop_connections(self) -> None:
        for writer in list(self._writers):
            writer.close()
        self._writers.clear()
        self._notifications.clear()

    @property
    def notification_count(self) -> int:
        return sum(1 for n in self._notifications.values() if n.index_group == PLC_MEMORY)

    @property
    def version_watch_count(self) -> int:
        return sum(1 for n in self._notifications.values() if n.index_group == SYM_VERSION)

    # ── Test controls ────────────────────────────────────────────────────────

    def poke(self, symbol: str, fmt: str, *values: object, offset: int = 0) -> None:
        self.write_memory(OFFSETS[symbol] + offset, struct.pack("<" + fmt, *values))

    def peek(self, symbol: str, fmt: str, *, offset: int = 0) -> tuple:
        return struct.unpack_from("<" + fmt, self.memory, OFFSETS[symbol] + offset)

    def write_memory(self, offset: int, data: bytes) -> None:
        self.memory[offset:offset + len(data)] = data
        self._fire_changes()

    def online_change(self, symbol_data: bytes, datatype_data: bytes, *, notify: bool = True) -> None:
        """A new program: new tables, bumped version, memory handles gone.

        ``notify=False`` loses the symbol-version notification, as a dropped
        handle or a sample sent before the client knew its handle would.
        """
        self.symbol_data = symbol_data
        self.datatype_data = datatype_data
        self.symbol_version = (self.symbol_version + 1) & 0xFF
        for handle, n in list(self._notifications.items()):
            if n.index_group == PLC_MEMORY:
                del self._notifications[handle]
            elif not notify:
                n.last = bytes([self.symbol_version])
        self._fire_changes()

    # ── Protocol ─────────────────────────────────────────────────────────────

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._writers.add(writer)
        try:
            while True:
                header = await reader.readexactly(6)
                body = await reader.readexactly(struct.unpack("<HI", header)[1])
                target, source = body[0:8], body[8:16]
                command, _flags, length, _error, invoke_id = struct.unpack_from("<HHIII", body, 16)
                data = body[32:32 + length]
                self.commands.append(command)
                reply, after = self._handle(command, data, writer, source)
                self._send(writer, source, target, command, invoke_id, reply, flags=0x0005)
                if after is not None:
                    after()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            self._writers.discard(writer)
            for handle, n in list(self._notifications.items()):
                if n.writer is writer:
                    del self._notifications[handle]
            writer.close()

    @staticmethod
    def _send(
        writer: asyncio.StreamWriter, target: bytes, source: bytes, command: int,
        invoke_id: int, data: bytes, *, flags: int,
    ) -> None:
        ams = target + source + struct.pack("<HHIII", command, flags, len(data), 0, invoke_id)
        with contextlib.suppress(Exception):
            writer.write(struct.pack("<HI", 0, len(ams) + len(data)) + ams + data)

    def _read(self, group: int, offset: int, length: int) -> tuple[int, bytes]:
        if group == SYM_UPLOAD_INFO2:
            info = struct.pack(
                "<IIIIII", _count_entries(self.symbol_data), len(self.symbol_data),
                _count_entries(self.datatype_data), len(self.datatype_data), 0, 0,
            )
            return 0, info[:length]
        if group == SYM_UPLOAD:
            return 0, self.symbol_data[:length]
        if group == SYM_DT_UPLOAD:
            return 0, self.datatype_data[:length]
        if group == SYM_VERSION:
            return 0, bytes([self.symbol_version])
        if group == PLC_MEMORY:
            if offset + length > len(self.memory):
                return ERR_INVALID_OFFSET, b""
            return 0, bytes(self.memory[offset:offset + length])
        return ERR_INVALID_GROUP, b""

    def _write(self, group: int, offset: int, data: bytes) -> int:
        if group != PLC_MEMORY:
            return ERR_INVALID_GROUP
        if offset + len(data) > len(self.memory):
            return ERR_INVALID_OFFSET
        self.memory[offset:offset + len(data)] = data
        return 0

    def _handle(self, command: int, data: bytes, writer: asyncio.StreamWriter, source: bytes):
        """``(reply payload, callable to run after the reply is sent)``."""
        if command == 1:
            name = self.device_name.encode().ljust(16, b"\0")
            return struct.pack("<IBBH", 0, 3, 1, 4024) + name, None
        if command == 4:
            return struct.pack("<IHH", 0, 5, 0), None
        if command == 2:
            group, offset, length = struct.unpack_from("<III", data)
            error, payload = self._read(group, offset, length)
            return struct.pack("<II", error, len(payload)) + payload, None
        if command == 3:
            group, offset, length = struct.unpack_from("<III", data)
            error = self._write(group, offset, data[12:12 + length])
            return struct.pack("<I", error), self._fire_changes
        if command == 9:
            return self._read_write(data)
        if command == 6:
            group, offset, length, _mode, _delay, _cycle = struct.unpack_from("<IIIIII", data)
            handle = self._next_handle
            self._next_handle += 1
            error, current = self._read(group, offset, length)
            if error:
                return struct.pack("<II", error, 0), None
            self._notifications[handle] = _Notification(writer, source, group, offset, length, current)
            # On-change notifications deliver the current value once at once.
            return struct.pack("<II", 0, handle), lambda: self._notify(handle)
        if command == 7:
            (handle,) = struct.unpack_from("<I", data)
            error = 0 if self._notifications.pop(handle, None) else ERR_NOTIFICATION_HANDLE
            return struct.pack("<I", error), None
        return struct.pack("<I", 0x701), None

    def _read_write(self, data: bytes):
        group, count, _read_length, write_length = struct.unpack_from("<IIII", data)
        payload = data[16:16 + write_length]
        if group == SUM_READ:
            self.sum_reads += 1
            if self.refuse_sum_reads:
                return struct.pack("<II", 0x701, 0), None
            items = [struct.unpack_from("<III", payload, 12 * i) for i in range(count)]
            errors, blocks = b"", b""
            for g, o, n in items:
                error, block = self._read(g, o, n)
                errors += struct.pack("<I", error)
                blocks += block.ljust(n, b"\0")
            out = errors + blocks
            return struct.pack("<II", 0, len(out)) + out, None
        if group == SUM_WRITE:
            items = [struct.unpack_from("<III", payload, 12 * i) for i in range(count)]
            pos, errors = 12 * count, b""
            for g, o, n in items:
                errors += struct.pack("<I", self._write(g, o, payload[pos:pos + n]))
                pos += n
            return struct.pack("<II", 0, len(errors)) + errors, self._fire_changes
        return struct.pack("<II", ERR_INVALID_GROUP, 0), None

    def _notify(self, handle: int) -> None:
        n = self._notifications.get(handle)
        if n is None:
            return
        sample = struct.pack("<II", handle, len(n.last)) + n.last
        stamp = struct.pack("<QI", 0, 1) + sample
        data = struct.pack("<II", len(stamp), 1) + stamp
        self._send(n.writer, n.target, b"\0" * 8, 8, 0, data, flags=0x0004)

    def _fire_changes(self) -> None:
        for handle, n in list(self._notifications.items()):
            _error, current = self._read(n.index_group, n.index_offset, n.length)
            if current != n.last:
                n.last = current
                self._notify(handle)
