"""
ads.connection — one AMS/TCP connection to one ADS device.

Requests are matched to responses by invoke id; a single reader task resolves
them and hands DeviceNotification samples to ``on_notification``.

Two ways to reach a device:

- **Direct** (default): ``host`` is the device. It needs a static AMS route
  for this client's NetID and IP, and accepts one connection per IP — so not
  from a PC whose own TwinCAT router is already connected to it.
- **Local router** (``via_router``): ``host`` is a TwinCAT router on this
  machine (``127.0.0.1``), which assigns this client its NetID and AMS port
  and forwards over the routes it already has.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
from collections.abc import Callable

from . import protocol as p

logger = logging.getLogger(__name__)

NotificationSink = Callable[[int, bytes], None]


class AdsConnection:
    def __init__(
        self,
        host: str,
        target: p.AmsAddress,
        *,
        source_net_id: bytes | None = None,
        source_port: int = p.DEFAULT_SOURCE_PORT,
        tcp_port: int = p.AMS_TCP_PORT,
        timeout_s: float = 5.0,
        on_notification: NotificationSink | None = None,
        via_router: bool = False,
    ) -> None:
        self.host = host
        self.via_router = via_router
        self.target = target
        self.tcp_port = tcp_port
        self.timeout_s = timeout_s
        self._source_net_id = source_net_id
        self._source_port = source_port
        self._on_notification = on_notification
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._reader_task: asyncio.Task | None = None
        self._pending: dict[int, asyncio.Future[p.AmsPacket]] = {}
        self._invoke_ids = itertools.count(1)
        self._closed_reason: str | None = None
        # This side's IP address of the TCP connection, once open.
        self.local_ip: str | None = None

    @property
    def source(self) -> p.AmsAddress:
        assert self._source_net_id is not None
        return p.AmsAddress(self._source_net_id, self._source_port)

    @property
    def is_open(self) -> bool:
        return self._writer is not None and self._closed_reason is None

    async def open(self, connect_timeout_s: float = 10.0) -> None:
        self._reader, self._writer = await asyncio.wait_for(
            asyncio.open_connection(self.host, self.tcp_port), timeout=connect_timeout_s,
        )
        self.local_ip = self._writer.get_extra_info("sockname")[0]
        if self.via_router:
            try:
                source = await asyncio.wait_for(self._register_port(), timeout=connect_timeout_s)
            except BaseException:
                await self.close()
                raise
            self._source_net_id, self._source_port = source.net_id, source.port
        elif self._source_net_id is None:
            # Without a configured NetID, use the convention TwinCAT itself
            # follows: the local IPv4 address of this connection plus ".1.1".
            try:
                self._source_net_id = p.parse_net_id(f"{self.local_ip}.1.1")
            except ValueError:
                await self.close()
                raise ValueError(f"No local AMS NetID configured and {self.local_ip} is not IPv4") from None
        self._closed_reason = None
        self._reader_task = asyncio.create_task(self._read_loop())

    async def _register_port(self) -> p.AmsAddress:
        assert self._reader is not None and self._writer is not None
        self._writer.write(p.encode_port_connect())
        await self._writer.drain()
        command, length = p.decode_tcp_header(await self._reader.readexactly(p.TCP_HEADER_SIZE))
        data = await self._reader.readexactly(length)
        if command != p.AMS_TCP_PORT_CONNECT:
            raise ConnectionError(f"{self.host} is not a TwinCAT router (answered AMS/TCP command 0x{command:04X})")
        return p.decode_port_connect(data)

    async def close(self) -> None:
        self._fail_pending("connection closed")
        task, self._reader_task = self._reader_task, None
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        writer, self._writer = self._writer, None
        if writer is not None:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    def _fail_pending(self, reason: str) -> None:
        self._closed_reason = self._closed_reason or reason
        pending, self._pending = self._pending, {}
        for future in pending.values():
            if not future.done():
                future.set_exception(ConnectionError(reason))

    async def _read_loop(self) -> None:
        reader = self._reader
        assert reader is not None
        try:
            while True:
                command, length = p.decode_tcp_header(await reader.readexactly(p.TCP_HEADER_SIZE))
                body = await reader.readexactly(length)
                if command != p.AMS_TCP_PACKET:
                    # Router housekeeping (state notes), nothing a request awaits.
                    continue
                packet = p.decode_packet(body)
                if packet.command == p.Command.NOTIFICATION:
                    self._dispatch_notification(packet.data)
                    continue
                future = self._pending.pop(packet.invoke_id, None)
                if future is None or future.done():
                    continue
                if packet.error:
                    future.set_exception(p.AdsError(packet.error))
                else:
                    future.set_result(packet)
        except asyncio.CancelledError:
            raise
        except asyncio.IncompleteReadError:
            self._fail_pending("connection closed by the device")
        except Exception as exc:
            logger.debug("ADS read loop for %s ended: %s", self.host, exc)
            self._fail_pending(f"connection lost: {exc}")

    def _dispatch_notification(self, data: bytes) -> None:
        sink = self._on_notification
        if sink is None:
            return
        try:
            for handle, payload in p.iter_notification_samples(data):
                sink(handle, payload)
        except Exception:
            logger.exception("ADS notification from %s could not be handled", self.host)

    async def request(self, command: p.Command, payload: bytes) -> bytes:
        """Send one command and return the response payload."""
        if not self.is_open or self._writer is None:
            raise ConnectionError(self._closed_reason or "not connected")
        invoke_id = next(self._invoke_ids) & 0xFFFFFFFF
        future: asyncio.Future[p.AmsPacket] = asyncio.get_running_loop().create_future()
        self._pending[invoke_id] = future
        self._writer.write(p.encode_frame(self.target, self.source, command, invoke_id, payload))
        try:
            await self._writer.drain()
            packet = await asyncio.wait_for(future, timeout=self.timeout_s)
        finally:
            self._pending.pop(invoke_id, None)
        return packet.data

    # ── Commands ─────────────────────────────────────────────────────────────

    async def read_device_info(self) -> p.DeviceInfo:
        return p.decode_device_info(await self.request(p.Command.READ_DEVICE_INFO, b""))

    async def read_state(self) -> tuple[int, int]:
        return p.decode_read_state(await self.request(p.Command.READ_STATE, b""))

    async def read(self, index_group: int, index_offset: int, length: int) -> bytes:
        data = await self.request(p.Command.READ, p.encode_read(index_group, index_offset, length))
        return p.decode_data_response(data)

    async def write(self, index_group: int, index_offset: int, payload: bytes) -> None:
        data = await self.request(p.Command.WRITE, p.encode_write(index_group, index_offset, payload))
        p.decode_result_response(data)

    async def read_write(
        self, index_group: int, index_offset: int, read_length: int, payload: bytes,
    ) -> bytes:
        data = await self.request(
            p.Command.READ_WRITE,
            p.encode_read_write(index_group, index_offset, read_length, payload),
        )
        return p.decode_data_response(data)

    async def add_notification(
        self,
        index_group: int,
        index_offset: int,
        length: int,
        *,
        mode: p.TransMode = p.TransMode.SERVER_ON_CHANGE,
        max_delay_ms: float = 0.0,
        cycle_time_ms: float = 0.0,
    ) -> int:
        data = await self.request(
            p.Command.ADD_NOTIFICATION,
            p.encode_add_notification(index_group, index_offset, length, mode, max_delay_ms, cycle_time_ms),
        )
        return p.decode_add_notification(data)

    async def delete_notification(self, handle: int) -> None:
        data = await self.request(p.Command.DELETE_NOTIFICATION, p.encode_delete_notification(handle))
        p.decode_result_response(data)

    async def sum_read(self, items: list[tuple[int, int, int]]) -> list[tuple[int, bytes]]:
        """``(error, data)`` per ``(group, offset, length)``, in sum commands of
        at most MAX_SUM_ITEMS."""
        results: list[tuple[int, bytes]] = []
        for start in range(0, len(items), p.MAX_SUM_ITEMS):
            chunk = items[start:start + p.MAX_SUM_ITEMS]
            payload, read_length = p.encode_sum_read(chunk)
            data = await self.read_write(p.IndexGroup.SUM_READ, len(chunk), read_length, payload)
            results.extend(p.decode_sum_read(data, [n for _, _, n in chunk]))
        return results

    async def sum_write(self, items: list[tuple[int, int, bytes]]) -> list[int]:
        """The error code per ``(group, offset, data)``."""
        errors: list[int] = []
        for start in range(0, len(items), p.MAX_SUM_ITEMS):
            chunk = items[start:start + p.MAX_SUM_ITEMS]
            payload, read_length = p.encode_sum_write(chunk)
            data = await self.read_write(p.IndexGroup.SUM_WRITE, len(chunk), read_length, payload)
            errors.extend(p.decode_sum_write(data, len(chunk)))
        return errors
