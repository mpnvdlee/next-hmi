"""
ads.engine — one ADS connection per ads-client datasource.

Exposes the same surface as ``opcua.engine.DatasourceOpcuaEngine`` (connect,
browse, read_current_values, write_node, the background/priority split) so
the pool, the write path and the WebSocket manager drive either one alike.

ADS has no server-side subscriptions to lean on, so the split is built from
two mechanisms:

- **Background**: every enabled variable is read with sum commands each
  ``bg_publish_interval_ms`` and published when its bytes changed.
- **Priority**: variables on screen, alarm triggers and historized variables
  get an on-change device notification each, sampled every
  ``priority_sampling_interval_ms``. The PLC caps notifications per port,
  which is why the background set is polled instead.

A PLC download or online change moves symbols in memory. The symbol version
is watched with a notification of its own; when it changes the symbol and
data-type tables are uploaded again and every address re-resolved. The
connection health check also compares the version each interval, which
catches a notification lost in transit or dropped with its handle.
"""

import asyncio
import contextlib
import ipaddress
import logging
from typing import Any

from asyncua import ua
from core import telemetry
from core.number_utils import get_config_float
from models.datasource import build_var_key, is_present_on_server, is_subscribable
from opcua.browse import _node_ids_in
from opcua.engine import DatasourceOpcuaEngine
from opcua.routing import _collect_struct_leaf_paths, _struct_field_routes

from . import protocol as p
from .codecs import WIRE_VARIANT_NAMES
from .connection import AdsConnection
from .symbols import Address, SymbolTable, parse_upload_info

logger = logging.getLogger(__name__)

_UPLOAD_INFO2_SIZE = 24


def _short_error(exc: BaseException) -> str:
    if isinstance(exc, TimeoutError):
        return "Connection timed out"
    msg = str(exc).strip() or exc.__class__.__name__
    return msg[:300]


def _set_member(target: dict, member_path: str, value: Any) -> None:
    """Set ``a/b/c`` inside nested dicts, creating the dicts on the way."""
    parts = member_path.split("/")
    for part in parts[:-1]:
        if not isinstance(target.get(part), dict):
            target[part] = {}
        target = target[part]
    target[parts[-1]] = value


class DatasourceAdsEngine:
    """ADS engine for a single datasource, using path-based variable keys."""

    def __init__(self, datasource_name: str) -> None:
        self.datasource_name = datasource_name
        self._conn: AdsConnection | None = None
        self._connected = False
        self._error: str | None = None
        self._config: dict = {}
        self._shutdown = False
        self._reconnect_task: asyncio.Task | None = None
        self._poll_task: asyncio.Task | None = None
        self._reload_task: asyncio.Task | None = None
        self._datasource_manager = None
        self._status_callback = None
        self._priority_recompute_callback = None
        self._symbols: SymbolTable | None = None
        self._device_name = ""
        self._symbol_version: bytes | None = None
        self._symbol_version_handle: int | None = None
        # Enabled variables this engine reads, by path.
        self._addresses: dict[str, Address] = {}
        # Struct/array-of-struct leaf → (root folder path, field), as for OPC-UA.
        self._routes: dict[str, tuple[str, str]] = {}
        # Last bytes published per path: a poll only publishes changes.
        self._last_raw: dict[str, bytes] = {}
        self._priority_handles: dict[str, int] = {}
        self._handle_targets: dict[int, tuple[str, Address]] = {}
        self._requested_priority_paths: set[str] = set()
        # Paths already reported missing or unreadable, so a poll every
        # second does not repeat the same warning.
        self._reported_paths: set[str] = set()
        self._poll_error: str | None = None
        # Serialises priority transitions, dynamic add/remove and reloads.
        self._lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def error(self) -> str | None:
        """Reason the last connect attempt failed, or ``None`` while healthy."""
        return self._error

    def set_datasource_manager(self, dm: Any) -> None:
        self._datasource_manager = dm

    def set_status_callback(self, cb: Any) -> None:
        self._status_callback = cb

    def set_priority_recompute_callback(self, cb: Any) -> None:
        self._priority_recompute_callback = cb

    # ── Settings ─────────────────────────────────────────────────────────────

    def _bg_interval_ms(self) -> float:
        return get_config_float(self._config, "bg_publish_interval_ms", 1000.0, minimum=50.0, maximum=60_000.0)

    def _priority_max_delay_ms(self) -> float:
        return get_config_float(self._config, "priority_publish_interval_ms", 50.0, minimum=0.0, maximum=5_000.0)

    def _priority_cycle_ms(self) -> float:
        return get_config_float(self._config, "priority_sampling_interval_ms", 20.0, minimum=1.0, maximum=5_000.0)

    def _browse_attributes(self) -> tuple[str, ...]:
        """Attribute names a marked browse looks for (``browse_attributes``:
        a list or comma-separated text)."""
        configured = self._config.get("browse_attributes") or "OPC.UA.DA"
        names = configured.split(",") if isinstance(configured, str) else configured
        return tuple(str(n).strip() for n in names if str(n).strip())

    def _background_enabled(self) -> bool:
        return not self._config.get("disable_background_sync", False)

    def _new_connection(self) -> AdsConnection:
        host = str(self._config.get("host", "")).strip()
        if not host:
            raise ValueError("No host configured")
        net_id = str(self._config.get("ams_net_id", "")).strip()
        if not net_id:
            # TwinCAT's own default NetID is its IPv4 address plus ".1.1";
            # a host name says nothing about it.
            try:
                net_id = f"{ipaddress.IPv4Address(host)}.1.1"
            except ValueError:
                raise ValueError("No AMS NetID configured") from None
        local_net_id = str(self._config.get("local_ams_net_id", "")).strip()
        via_router = bool(self._config.get("local_router", False))
        return AdsConnection(
            "127.0.0.1" if via_router else host,
            p.AmsAddress(p.parse_net_id(net_id), int(self._config.get("ams_port") or p.TC3_PLC_PORT)),
            source_net_id=p.parse_net_id(local_net_id) if local_net_id else None,
            tcp_port=int(self._config.get("tcp_port") or p.AMS_TCP_PORT),
            timeout_s=get_config_float(self._config, "request_timeout_s", 5.0, minimum=0.5, maximum=60.0),
            on_notification=self._on_notification,
            via_router=via_router,
        )

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def connect(self, config: dict) -> None:
        self._config = config
        self._shutdown = False
        self._reconnect_task = asyncio.create_task(self._reconnect_loop())

    async def disconnect(self) -> None:
        self._shutdown = True
        if self._reconnect_task is not None:
            self._reconnect_task.cancel()
            with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(self._reconnect_task, timeout=5.0)
            self._reconnect_task = None
        await self._close_client()

    async def _close_client(self) -> None:
        conn, self._conn = self._conn, None
        was_connected, self._connected = self._connected, False
        for task in (self._poll_task, self._reload_task):
            if task is not None and task is not asyncio.current_task():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        self._poll_task = self._reload_task = None
        self._priority_handles.clear()
        self._handle_targets.clear()
        self._last_raw.clear()
        self._symbol_version_handle = None
        if conn is not None:
            await conn.close()
        if was_connected and self._status_callback is not None:
            await self._status_callback(self.datasource_name, False)

    async def _reconnect_loop(self) -> None:
        interval = get_config_float(self._config, "reconnect_interval_s", 5.0, minimum=1.0, maximum=300.0)
        while not self._shutdown:
            if not self._connected:
                try:
                    await self._do_connect()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self._error = _short_error(exc)
                    logger.warning("ADS connect failed for %s: %s", self.datasource_name, exc)
                    await asyncio.sleep(interval)
                    continue
            await asyncio.sleep(interval)
            if self._connected and not self._shutdown:
                conn = self._conn
                try:
                    if conn is None or not conn.is_open:
                        raise ConnectionError("connection closed")
                    version = await conn.read(p.IndexGroup.SYM_VERSION, 0, 1)
                    if version != self._symbol_version:
                        self._request_reload()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("ADS connection lost for %s (%s) — retrying", self.datasource_name, exc)
                    self._error = _short_error(exc)
                    await self._close_client()

    async def _do_connect(self) -> None:
        conn = self._new_connection()
        await conn.open(get_config_float(self._config, "connect_timeout_s", 10.0, minimum=1.0, maximum=120.0))
        try:
            info = await conn.read_device_info()
            ads_state, _device_state = await conn.read_state()
            self._conn = conn
            await self._load_symbols()
            await self._watch_symbol_version()
        except BaseException:
            self._conn = None
            await conn.close()
            raise
        self._device_name = info.name
        self._connected = True
        self._error = None
        if ads_state != p.AdsState.RUN:
            logger.warning("ADS device %s for %s is not in RUN (state %d)", conn.host, self.datasource_name, ads_state)
        logger.info(
            "ADS connected: %s → %s %s (%s v%s, %d symbols)",
            self.datasource_name, conn.host, p.format_net_id(conn.target.net_id),
            info.name, info.version, len(self._symbols.symbols) if self._symbols else 0,
        )
        telemetry.mark("connected")
        if self._status_callback is not None:
            await self._status_callback(self.datasource_name, True)
        try:
            async with self._lock:
                self._setup_reads_locked()
            # Re-apply priority paths requested before the connection was up.
            if self._priority_recompute_callback is not None:
                await self._priority_recompute_callback()
            elif self._requested_priority_paths:
                await self.set_priority_paths(self._requested_priority_paths)
        except Exception:
            await self._close_client()
            raise

    @staticmethod
    async def _upload_symbols(conn: AdsConnection) -> tuple[bytes, SymbolTable]:
        """The symbol version and the tables it belongs to (read first, so a
        change during the upload shows as a newer version afterwards)."""
        version = await conn.read(p.IndexGroup.SYM_VERSION, 0, 1)
        info = parse_upload_info(await conn.read(p.IndexGroup.SYM_UPLOAD_INFO2, 0, _UPLOAD_INFO2_SIZE))
        symbol_data = await conn.read(p.IndexGroup.SYM_UPLOAD, 0, info.symbol_size)
        datatype_data = await conn.read(p.IndexGroup.SYM_DT_UPLOAD, 0, info.datatype_size)
        return version, SymbolTable.from_upload(symbol_data, datatype_data)

    async def _load_symbols(self) -> None:
        conn = self._conn
        if conn is None:
            raise ConnectionError("not connected")
        self._symbol_version, self._symbols = await self._upload_symbols(conn)

    async def _watch_symbol_version(self) -> None:
        """(Re)register the version notification: a download can drop handles."""
        conn = self._conn
        if conn is None:
            raise ConnectionError("not connected")
        old, self._symbol_version_handle = self._symbol_version_handle, None
        if old is not None:
            with contextlib.suppress(p.AdsError):
                await conn.delete_notification(old)
        self._symbol_version_handle = await conn.add_notification(
            p.IndexGroup.SYM_VERSION, 0, 1, mode=p.TransMode.SERVER_ON_CHANGE,
        )

    # ── Reads ────────────────────────────────────────────────────────────────

    def _resolve(self, path: str, var_entry: dict) -> Address | None:
        node_id = var_entry.get("node_id", "")
        if not node_id or self._symbols is None:
            return None
        address = self._symbols.resolve(node_id)
        if address is None and path not in self._reported_paths:
            self._reported_paths.add(path)
            logger.warning("ADS symbol %s for %s/%s not found on the PLC", node_id, self.datasource_name, path)
        return address

    def _ds_entry(self) -> Any:
        dm = self._datasource_manager
        return dm.get(self.datasource_name) if dm is not None else None

    def _setup_reads_locked(self) -> None:
        """Resolve every enabled variable and (re)start the background poll."""
        self._addresses.clear()
        self._last_raw.clear()
        self._reported_paths.clear()
        ds_entry = self._ds_entry()
        if ds_entry is not None:
            self._routes = _struct_field_routes(ds_entry)
            for path, var_entry in ds_entry.registry.items():
                if is_subscribable(var_entry) and (address := self._resolve(path, var_entry)):
                    self._addresses[path] = address
        if self._background_enabled() and self._poll_task is None:
            self._poll_task = asyncio.create_task(self._poll_loop())

    async def _poll_loop(self) -> None:
        while True:
            try:
                await self._poll_once()
                self._poll_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # A dead connection is the reconnect loop's to handle; a device
                # refusing the sum read (TwinCAT 2, a BC controller) leaves the
                # connection healthy, so say so — once per distinct error.
                error = _short_error(exc)
                if error != self._poll_error:
                    self._poll_error = error
                    logger.warning("ADS background read failed for %s: %s", self.datasource_name, error)
            await asyncio.sleep(self._bg_interval_ms() / 1000.0)

    async def _poll_once(self) -> None:
        conn = self._conn
        if conn is None:
            return
        items = [(path, a) for path, a in self._addresses.items() if path not in self._priority_handles]
        if not items:
            return
        results = await conn.sum_read([(a.index_group, a.index_offset, a.size) for _, a in items])
        for (path, address), (error, data) in zip(items, results, strict=True):
            if error:
                if path not in self._reported_paths:
                    self._reported_paths.add(path)
                    logger.warning("ADS read of %s/%s failed: %s", self.datasource_name, path, p.AdsError(error))
                continue
            self._publish(path, address, data, priority=False)

    def _publish(self, path: str, address: Address, data: bytes, *, priority: bool) -> None:
        if self._last_raw.get(path) == data:
            return
        try:
            value = address.decode(data)
        except Exception as exc:
            logger.debug("ADS value of %s/%s did not decode: %s", self.datasource_name, path, exc)
            return
        self._last_raw[path] = data
        dm = self._datasource_manager
        if dm is None:
            return
        route = self._routes.get(path)
        if route is not None:
            folder_path, field_name = route
            dm.update_struct_field(
                self.datasource_name, folder_path, field_name, value, leaf_path=path, priority=priority,
            )
        else:
            dm.update(self.datasource_name, path, value, priority=priority)

    def _on_notification(self, handle: int, data: bytes) -> None:
        if handle == self._symbol_version_handle:
            if data != self._symbol_version:
                self._request_reload()
            return
        target = self._handle_targets.get(handle)
        if target is not None:
            path, address = target
            self._publish(path, address, data, priority=True)

    def _request_reload(self) -> None:
        # A change arriving while a reload runs needs no second task: the
        # running one re-checks the version before it finishes.
        if self._reload_task is None or self._reload_task.done():
            self._reload_task = asyncio.create_task(self._reload_symbols())

    async def _reload_symbols(self) -> None:
        """Re-upload the tables after a PLC download or online change, until
        the version stays put across a whole reload."""
        logger.info("ADS symbols of %s changed on the PLC — reloading", self.datasource_name)
        try:
            async with self._lock:
                while True:
                    await self._load_symbols()
                    await self._watch_symbol_version()
                    await self._drop_priority_locked(set(self._priority_handles))
                    self._setup_reads_locked()
                    await self._set_priority_paths_locked(self._requested_priority_paths)
                    conn = self._conn
                    if conn is None or await conn.read(p.IndexGroup.SYM_VERSION, 0, 1) == self._symbol_version:
                        break
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("ADS symbol reload failed for %s: %s — reconnecting", self.datasource_name, exc)
            self._error = _short_error(exc)
            await self._close_client()

    async def read_current_values(self, paths: set[str], *, raw: bool = False) -> dict[str, Any]:
        """Bulk-read current values for requested paths and folder structs.

        *raw* exists for parity with the OPC-UA engine: an ADS value's cache
        form already encodes back unchanged, so both forms are the same here.
        """
        conn = self._conn
        ds_entry = self._ds_entry()
        if not paths or not self._connected or conn is None or ds_entry is None:
            return {}

        # (kind, binding path, member, address); kind is scalar/struct/array_elem.
        requests: list[tuple[str, str, str | None, Address]] = []

        def add(kind: str, path: str, member: str | None, leaf_path: str) -> None:
            var_entry = ds_entry.registry.get(leaf_path)
            if var_entry and is_subscribable(var_entry):
                address = self._addresses.get(leaf_path) or self._resolve(leaf_path, var_entry)
                if address is not None:
                    requests.append((kind, path, member, address))

        for path in sorted(paths):
            folder = ds_entry.folder_registry.get(path)
            if folder is None:
                add("scalar", path, None, path)
            elif folder.get("_is_array"):
                for index, element_path in enumerate(folder.get("_element_paths", [])):
                    element = ds_entry.folder_registry.get(element_path)
                    if element is not None:
                        for member, child in _collect_struct_leaf_paths(element, ds_entry.folder_registry):
                            add("array_elem", path, f"{index}:{member}", child)
            else:
                for member, child in _collect_struct_leaf_paths(folder, ds_entry.folder_registry):
                    add("struct", path, member, child)
        if not requests:
            return {}

        reads = await conn.sum_read([(a.index_group, a.index_offset, a.size) for *_, a in requests])
        result: dict[str, Any] = {}
        for (kind, path, member, address), (error, data) in zip(requests, reads, strict=True):
            if error:
                continue
            try:
                value = address.decode(data)
            except Exception:
                continue
            key = build_var_key(self.datasource_name, path)
            if kind == "scalar":
                result[key] = value
            elif kind == "struct" and member is not None:
                fields = result.setdefault(key, {})
                _set_member(fields, member, value)
            elif member is not None:
                index_text, _, element_member = member.partition(":")
                elements = result.setdefault(key, [])
                while len(elements) <= int(index_text):
                    elements.append({})
                _set_member(elements[int(index_text)], element_member, value)

        # An indexed struct[] binding reads a concrete element key; include it
        # so a prefetch covers it as the OPC-UA engine does.
        for path in paths:
            folder = ds_entry.folder_registry.get(path)
            aggregate = result.get(build_var_key(self.datasource_name, path))
            if folder is None or not folder.get("_is_array") or not isinstance(aggregate, list):
                continue
            for index, element_path in enumerate(folder.get("_element_paths", [])[:len(aggregate)]):
                result[build_var_key(self.datasource_name, element_path)] = dict(aggregate[index])
        return result

    # ── Writes ───────────────────────────────────────────────────────────────

    def _address_for(self, node_id: str) -> Address:
        address = self._symbols.resolve(node_id) if self._symbols is not None else None
        if address is None:
            raise ValueError(f"ADS symbol not found: {node_id}")
        return address

    async def wire_variant_type(self, node_id: str) -> ua.VariantType | None:
        """The VariantType the PLC's own type maps to, for the write path's
        type check; None when the symbol is unknown."""
        address = self._symbols.resolve(node_id) if self._symbols is not None else None
        if address is None:
            return None
        type_name = address.codec.type_name
        return getattr(ua.VariantType, WIRE_VARIANT_NAMES.get(type_name, type_name), None)

    async def write_node(self, node_id: str, value: Any, variant_type: Any = None) -> None:
        """Write *value* to the symbol at *node_id*.

        *variant_type* is ignored: the PLC's symbol table decides the encoding.
        Held behind a running reload, so a write never lands on an offset an
        online change just gave to another variable.
        """
        async with self._lock:
            conn = self._conn
            if not self._connected or conn is None:
                raise RuntimeError(f"Not connected: {self.datasource_name}")
            address = self._address_for(node_id)
            await conn.write(address.index_group, address.index_offset, address.encode(value))

    # ── Dynamic subscribe/unsubscribe (for variable enable/disable) ──────────

    async def add_subscription_by_path(self, path: str, ds_entry: Any) -> None:
        async with self._lock:
            if not self._connected:
                return
            var_entry = ds_entry.registry.get(path)
            if not var_entry or not is_subscribable(var_entry):
                return
            self._routes = _struct_field_routes(ds_entry)
            self._reported_paths.discard(path)
            address = self._resolve(path, var_entry)
            if address is not None:
                self._addresses[path] = address
                self._last_raw.pop(path, None)

    async def remove_subscription_by_path(self, ds_name: str, path: str) -> bool:
        """Stop reading *path*; true only when no notification is left behind."""
        async with self._lock:
            self._addresses.pop(path, None)
            self._last_raw.pop(path, None)
            await self._drop_priority_locked({path})
            return path not in self._priority_handles

    # ── Priority management ──────────────────────────────────────────────────

    async def set_priority_paths(self, paths: set[str]) -> None:
        async with self._lock:
            await self._set_priority_paths_locked(paths)

    async def _drop_priority_locked(self, paths: set[str]) -> None:
        conn = self._conn
        for path in paths:
            handle = self._priority_handles.get(path)
            if handle is None:
                continue
            try:
                if conn is not None:
                    await conn.delete_notification(handle)
            except p.AdsError as exc:
                # The PLC no longer knows the handle (a download drops them):
                # nothing is left to delete.
                logger.debug("ADS notification for %s/%s already gone: %s", self.datasource_name, path, exc)
            except Exception as exc:
                logger.warning("ADS notification delete failed for %s/%s: %s", self.datasource_name, path, exc)
                continue
            self._priority_handles.pop(path, None)
            self._handle_targets.pop(handle, None)
            # Back on the poll, which must publish it again from scratch.
            self._last_raw.pop(path, None)

    async def _set_priority_paths_locked(self, paths: set[str]) -> None:
        """Give each leaf behind *paths* a notification; drop the others."""
        self._requested_priority_paths = set(paths)
        conn = self._conn
        ds_entry = self._ds_entry()
        if not self._connected or conn is None or ds_entry is None:
            return
        desired = DatasourceOpcuaEngine._expand_priority_paths(paths, ds_entry)
        await self._drop_priority_locked(set(self._priority_handles) - desired)

        promote: list[tuple[str, Address]] = []
        for path in desired - set(self._priority_handles):
            var_entry = ds_entry.registry.get(path)
            if not var_entry or not is_present_on_server(var_entry):
                continue
            address = self._addresses.get(path) or self._resolve(path, var_entry)
            if address is not None:
                promote.append((path, address))
        if not promote:
            return

        max_delay, cycle = self._priority_max_delay_ms(), self._priority_cycle_ms()
        handles = await asyncio.gather(
            *(
                conn.add_notification(
                    a.index_group, a.index_offset, a.size,
                    mode=p.TransMode.SERVER_ON_CHANGE, max_delay_ms=max_delay, cycle_time_ms=cycle,
                )
                for _, a in promote
            ),
            return_exceptions=True,
        )
        added: list[tuple[str, Address]] = []
        for (path, address), handle in zip(promote, handles, strict=True):
            if isinstance(handle, BaseException):
                logger.warning("ADS notification for %s/%s refused: %s", self.datasource_name, path, handle)
                continue
            self._priority_handles[path] = handle
            self._handle_targets[handle] = (path, address)
            added.append((path, address))

        # The first notification can arrive before its handle is known and be
        # dropped, so read each promoted value once to put it on screen now.
        if added:
            results = await conn.sum_read([(a.index_group, a.index_offset, a.size) for _, a in added])
            for (path, address), (error, data) in zip(added, results, strict=True):
                if not error:
                    self._last_raw.pop(path, None)
                    self._publish(path, address, data, priority=True)

    def subscription_status(self) -> dict[str, Any]:
        """Diagnostics in the shape the OPC-UA engine reports. ADS revises
        nothing, so each "revised" value is the requested one."""
        bg = self._bg_interval_ms()
        max_delay, cycle = self._priority_max_delay_ms(), self._priority_cycle_ms()
        return {
            "priority_paths": sorted(self._requested_priority_paths),
            "priority_leaf_paths": sorted(p for p in self._priority_handles if p not in self._requested_priority_paths),
            "connected": self.connected,
            "bg_enabled": self._poll_task is not None,
            "bg_publish_interval_ms": bg,
            "bg_publish_interval_revised_ms": bg,
            "priority_publish_interval_ms": max_delay,
            "priority_publish_interval_revised_ms": max_delay,
            "priority_sampling_interval_ms": cycle,
            "priority_sampling_interval_revised_avg_ms": cycle if self._priority_handles else None,
            "priority_sampling_interval_revised_min_ms": cycle if self._priority_handles else None,
            "priority_sampling_interval_revised_max_ms": cycle if self._priority_handles else None,
            "priority_ws_batch_ms": get_config_float(
                self._config, "priority_ws_batch_ms", 10.0, minimum=0.0, maximum=1_000.0,
            ),
        }

    # ── Browse ───────────────────────────────────────────────────────────────

    async def browse(self, node_id: str | None = None, *, on_progress: Any = None) -> dict:
        """The PLC's symbols below *node_id* (or the configured ``browse_root``),
        in the OPC-UA browse shape. The tables are uploaded again first, so a
        browse always shows the program running now; the engine's own table is
        left to the reload a newer version starts, which re-resolves with it.

        ``browse_mode`` picks what comes back (see ``ads.symbols``): ``marked``
        (default) only what a ``browse_attributes`` attribute marks, ``lazy``
        the one level below *node_id*, ``all`` everything.
        """
        conn = self._conn
        if not self._connected or conn is None:
            raise RuntimeError(f"Not connected: {self.datasource_name}")
        if on_progress is not None:
            on_progress({"done": 0, "total": 1, "nodes": 0, "level": 0})
        version, table = await self._upload_symbols(conn)
        if version != self._symbol_version:
            self._request_reload()
        root = (node_id or self._config.get("browse_root") or "").strip()
        mode = str(self._config.get("browse_mode") or "marked").strip().lower()
        if mode == "lazy":
            children = table.browse_level(root)
        elif mode == "all":
            children = table.browse(root)
        else:
            mode = "marked"
            children = table.browse(root, attributes=self._browse_attributes())
        tree: dict[str, Any] = {
            "node_id": root,
            "display_name": root or self._device_name or self.datasource_name,
            "data_type": None,
            "children": children,
        }
        walked = _node_ids_in(tree)
        ds_entry = self._ds_entry()
        if ds_entry is not None:
            outside = [
                entry["node_id"]
                for entry in ds_entry.registry.values()
                if entry.get("node_id") and entry["node_id"] not in walked
                and table.resolve(entry["node_id"]) is not None
            ]
            if outside:
                tree["present_outside_browse"] = list(dict.fromkeys(outside))
        tree["show_root"] = bool(root)
        tree["browse_mode"] = mode
        if on_progress is not None:
            on_progress({"done": 1, "total": 1, "nodes": len(walked), "level": 0})
        return tree
