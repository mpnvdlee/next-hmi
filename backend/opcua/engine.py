"""
opcua.engine — one OPC-UA connection per opcua-client datasource.

Connection lifecycle, the background and priority subscriptions, reads and
writes. Each engine routes datachange notifications through the
DatasourceManager using composite keys.
"""

import asyncio
import contextlib
import logging
from typing import Any

from asyncua import Client, ua
from asyncua.common.node import Node
from core.number_utils import get_config_float
from models.datasource import build_var_key, is_present_on_server, is_subscribable

from .browse import SERVER_OBJECT_NODE_ID, AddressSpaceBrowser, BrowseProgressSink
from .compat import apply_asyncua_watchdog_log_patch
from .discovery import _short_probe_error
from .limits import OperationLimits, read_operation_limits
from .routing import _collect_struct_leaf_paths, _struct_field_routes
from .security import apply_client_security
from .values import normalize_value

apply_asyncua_watchdog_log_patch()

logger = logging.getLogger(__name__)


class _DsSubHandler:
    """Datachange handler that routes updates through DatasourceManager."""

    def __init__(self, engine: "DatasourceOpcuaEngine") -> None:  # noqa: UP037 -- forward ref; file has no `from __future__ import annotations` and DatasourceOpcuaEngine is defined later, so unquoting NameErrors at import time under eager (pre-3.14) annotation evaluation
        self._engine = engine

    def datachange_notification(self, node, val, data) -> None:
        try:
            # Use the NodeId object directly as the dict key — NodeId implements __hash__
            # and __eq__, so this avoids the to_string() serialisation on every notification.
            node_id = node.nodeid
            # What the server actually encodes is the type a write must use;
            # recording it here makes it free for every subscribed tag.
            variant = getattr(getattr(data, "monitored_item", None), "Value", None)
            variant = getattr(variant, "Value", None)
            if variant is not None and variant.VariantType != ua.VariantType.Null:
                self._engine._wire_types[node_id] = variant.VariantType
            dm = self._engine._datasource_manager
            if dm is None:
                return
            ds_name = self._engine.datasource_name
            if node_id in self._engine._node_to_path:
                path = self._engine._node_to_path[node_id]
                dm.update(
                    ds_name, path, normalize_value(val),
                    priority=self._engine._is_priority_path(path),
                )
            elif node_id in self._engine._node_to_field:
                path, field_name, leaf_path = self._engine._node_to_field[node_id]
                dm.update_struct_field(
                    ds_name,
                    path,
                    field_name,
                    normalize_value(val),
                    leaf_path=leaf_path,
                    # Priority handles are tracked by their concrete monitored
                    # leaf paths, even when the user-facing binding targets a
                    # struct/folder aggregate.
                    priority=self._engine._is_priority_path(leaf_path),
                )
        except Exception as exc:
            logger.exception("Datachange callback failed for %s: %s", self._engine.datasource_name, exc)

    async def status_change_notification(self, status) -> None:
        sc = getattr(status, "Status", None)
        if sc is not None and not sc.is_good():
            logger.debug(
                "Subscription status change for %s: %s — scheduling reconnect",
                self._engine.datasource_name,
                sc,
            )
            # Tracked (not pure fire-and-forget) so disconnect() can cancel it
            # instead of leaving it to run against a torn-down engine.
            self._engine._status_close_task = asyncio.create_task(self._engine._close_client())


class DatasourceOpcuaEngine:
    """OPC-UA engine for a single datasource, using path-based variable keys."""

    def __init__(self, datasource_name: str) -> None:
        self.datasource_name = datasource_name
        self._client: Client | None = None
        self._connected = False
        self._error: str | None = None
        self._reconnect_task: asyncio.Task | None = None
        self._shutdown = False
        # In-flight close, so a status-change-triggered close and the
        # reconnect loop's own close coalesce into one execution instead of
        # racing.
        self._close_task: asyncio.Task | None = None
        # The fire-and-forget task status_change_notification schedules —
        # tracked so disconnect() can cancel it instead of leaving it to run
        # against a torn-down engine after shutdown.
        self._status_close_task: asyncio.Task | None = None
        self._config: dict = {}
        # Server OperationLimits, read on connect. Owned here rather than by
        # the browser: reads and monitored-item creation are batched too.
        self._operation_limits = OperationLimits()
        # The VariantType each node arrives in, from datachange or a one-off
        # read. Cleared on connect: a PLC download can retype a tag.
        self._wire_types: dict[ua.NodeId, ua.VariantType] = {}
        self._datasource_manager = None
        self._status_callback = None
        self._priority_recompute_callback = None
        # Subscriptions
        self._background_sub = None
        self._priority_sub = None
        self._sub_handler: _DsSubHandler | None = None
        # Maps for routing datachange callbacks (keyed by NodeId object, not string)
        self._node_to_path: dict = {}       # NodeId → path
        self._node_to_field: dict = {}      # NodeId → (folder_path, field_name, leaf_path)
        # Reverse map: path → set[NodeId] for O(1) cleanup in remove_subscription_by_path
        self._path_to_node_ids: dict[str, set] = {}
        # Subscription handles per path
        self._bg_path_handles: dict[str, list] = {}
        self._priority_path_handles: dict[str, list] = {}
        # Serialises page-context recomputes (which can arrive concurrently from
        # different WebSocket clients) with dynamic add/remove transitions.
        self._subscription_transition_lock = asyncio.Lock()
        # Logical paths requested by clients (may include folder aggregates).
        # `_current_priority_paths` below contains only concrete leaf paths that
        # are actually live on the priority subscription.
        self._requested_priority_paths: set[str] = set()
        self._current_priority_paths: set[str] = set()
        self._requested_bg_publish_interval_ms = 1000.0
        self._requested_priority_publish_interval_ms = 50.0
        self._requested_priority_sampling_interval_ms = 20.0
        self._requested_priority_ws_batch_ms = 10.0
        self._revised_bg_publish_interval_ms: float | None = None
        self._revised_priority_publish_interval_ms: float | None = None
        self._priority_revised_sampling_count = 0
        self._priority_revised_sampling_sum_ms = 0.0
        self._priority_revised_sampling_min_ms: float | None = None
        self._priority_revised_sampling_max_ms: float | None = None

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def error(self) -> str | None:
        """Reason the last connect attempt failed, or ``None`` while healthy."""
        return self._error

    @property
    def operation_limits(self) -> OperationLimits:
        """The server's OperationLimits as read on connect."""
        return self._operation_limits

    def attach_client(
        self,
        client: Client,
        config: dict | None = None,
        *,
        operation_limits: OperationLimits | None = None,
    ) -> None:
        """Adopt an already-connected asyncua client as if connect() had made it.

        The supported seam for tests and tools that own the client's
        lifetime: no reconnect loop is started, no subscriptions are created
        and no OperationLimits are read — pass ``operation_limits`` (e.g. from
        ``opcua.limits.read_operation_limits(client)``) to batch the way a
        live connection would.
        """
        self._client = client
        self._connected = True
        self._error = None
        self._config = config if config is not None else {}
        self._operation_limits = operation_limits or OperationLimits()
        self._wire_types = {}

    def set_datasource_manager(self, dm: Any) -> None:
        self._datasource_manager = dm

    def set_status_callback(self, cb: Any) -> None:
        self._status_callback = cb

    def set_priority_recompute_callback(self, cb: Any) -> None:
        self._priority_recompute_callback = cb

    def _background_publish_interval_ms(self) -> float:
        return get_config_float(self._config, "bg_publish_interval_ms", 1000.0, minimum=250.0, maximum=60_000.0)

    def _priority_publish_interval_ms(self) -> float:
        return get_config_float(self._config, "priority_publish_interval_ms", 50.0, minimum=10.0, maximum=5_000.0)

    def _priority_sampling_interval_ms(self) -> float:
        return get_config_float(self._config, "priority_sampling_interval_ms", 20.0, minimum=0.0, maximum=5_000.0)

    def _priority_ws_batch_ms(self) -> float:
        return get_config_float(self._config, "priority_ws_batch_ms", 10.0, minimum=0.0, maximum=1_000.0)

    def _is_priority_path(self, path: str) -> bool:
        return path in self._priority_path_handles or path in self._current_priority_paths

    def _register_node_route(
        self, path: str, node_id: Any, field_routes: dict[str, tuple[str, str]],
    ) -> None:
        """Route *node_id*'s datachange notifications to the struct-field O(1)
        patch path (_node_to_field) when *path* is a struct/array-of-struct
        leaf, else the plain per-path scalar path (_node_to_path)."""
        route = field_routes.get(path)
        if route is not None:
            folder_path, field_name = route
            self._node_to_field[node_id] = (folder_path, field_name, path)
        else:
            self._node_to_path[node_id] = path

    @staticmethod
    def _expand_priority_paths(paths: set[str], ds_entry: Any) -> set[str]:
        """Resolve logical variable/folder bindings to monitored leaf paths.

        Keeping the transition state in this concrete namespace makes promote
        and demote symmetric: a struct folder that expands to ten monitored
        leaves is later demoted through those same ten keys instead of being
        skipped because the folder itself is not in ``registry``.
        """
        expanded: set[str] = set()
        for path in paths:
            if path in ds_entry.registry:
                expanded.add(path)
                continue
            folder_entry = ds_entry.folder_registry.get(path)
            if folder_entry is None:
                continue
            element_paths = folder_entry.get("_element_paths", [])
            sources = (
                [
                    ds_entry.folder_registry[element_path]
                    for element_path in element_paths
                    if element_path in ds_entry.folder_registry
                ]
                if element_paths
                else [folder_entry]
            )
            for source in sources:
                for _field_path, child_path in _collect_struct_leaf_paths(
                    source, ds_entry.folder_registry,
                ):
                    expanded.add(child_path)
        return expanded

    def _record_priority_revised_sampling(self, samples_ms: list[float]) -> None:
        """Track revised sampling intervals returned by server for priority monitored items."""
        for sample in samples_ms:
            try:
                value = float(sample)
            except (TypeError, ValueError):
                continue
            self._priority_revised_sampling_count += 1
            self._priority_revised_sampling_sum_ms += value
            if self._priority_revised_sampling_min_ms is None or value < self._priority_revised_sampling_min_ms:
                self._priority_revised_sampling_min_ms = value
            if self._priority_revised_sampling_max_ms is None or value > self._priority_revised_sampling_max_ms:
                self._priority_revised_sampling_max_ms = value

    def _priority_revised_sampling_avg_ms(self) -> float | None:
        if self._priority_revised_sampling_count <= 0:
            return None
        return self._priority_revised_sampling_sum_ms / self._priority_revised_sampling_count

    def subscription_status(self) -> dict[str, Any]:
        """Subscription diagnostics: requested vs. server-revised tuning and
        the paths live on the priority subscription."""
        return {
            "priority_paths": sorted(self._requested_priority_paths),
            "priority_leaf_paths": sorted(
                path
                for path in self._priority_path_handles
                if path not in self._requested_priority_paths
            ),
            "connected": self.connected,
            "bg_enabled": self._background_sub is not None,
            "bg_publish_interval_ms": self._requested_bg_publish_interval_ms,
            "bg_publish_interval_revised_ms": self._revised_bg_publish_interval_ms,
            "priority_publish_interval_ms": self._requested_priority_publish_interval_ms,
            "priority_publish_interval_revised_ms": self._revised_priority_publish_interval_ms,
            "priority_sampling_interval_ms": self._requested_priority_sampling_interval_ms,
            "priority_sampling_interval_revised_avg_ms": self._priority_revised_sampling_avg_ms(),
            "priority_sampling_interval_revised_min_ms": self._priority_revised_sampling_min_ms,
            "priority_sampling_interval_revised_max_ms": self._priority_revised_sampling_max_ms,
            "priority_ws_batch_ms": self._requested_priority_ws_batch_ms,
        }

    async def _subscribe_priority_nodes_with_revised_sampling(
        self,
        nodes: list[Node],
    ) -> tuple[list[Any], list[float]]:
        """Subscribe nodes on priority subscription and return handles + revised sampling."""
        sub = self._priority_sub
        if sub is None:
            return [], []

        handles = await sub.subscribe_data_change(
            nodes,
            sampling_interval=self._requested_priority_sampling_interval_ms,
        )

        revised_samples: list[float] = []
        for handle in handles:
            if isinstance(handle, ua.StatusCode):
                continue
            try:
                result = await sub.modify_monitored_item(
                    handle,
                    self._requested_priority_sampling_interval_ms,
                    new_queuesize=0,
                    mod_filter_val=-1,
                )
                if result and result[0].StatusCode.is_good():
                    revised_samples.append(float(result[0].RevisedSamplingInterval))
            except Exception as exc:
                logger.debug(
                    "Could not read revised sampling for %s/%s: %s",
                    self.datasource_name,
                    handle,
                    exc,
                )
        return handles, revised_samples

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def connect(self, config: dict) -> None:
        self._config = config
        self._shutdown = False
        self._reconnect_task = asyncio.create_task(self._reconnect_loop())

    async def disconnect(self) -> None:
        self._shutdown = True
        if self._reconnect_task:
            self._reconnect_task.cancel()
            with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(self._reconnect_task, timeout=5.0)
        if self._status_close_task is not None:
            self._status_close_task.cancel()
            with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(self._status_close_task, timeout=5.0)
            self._status_close_task = None
        await self._close_client()

    async def _close_client(self) -> None:
        """Close the current client, coalescing concurrent close requests.

        Both the reconnect loop's own health-check close and the
        subscription status-change callback's close route through here — if
        one is already in flight, later callers await that same task instead
        of each independently racing through teardown.
        """
        if self._close_task is not None and not self._close_task.done():
            await self._close_task
            return
        self._close_task = asyncio.ensure_future(self._close_client_impl())
        try:
            await self._close_task
        finally:
            self._close_task = None

    async def _close_client_impl(self) -> None:
        await self._teardown_subscriptions()
        client = self._client
        self._client = None
        if client is not None:
            try:
                await client.disconnect()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("OPC-UA disconnect failed for %s: %s", self.datasource_name, exc)
        was_connected = self._connected
        self._connected = False
        if was_connected and self._status_callback is not None:
            await self._status_callback(self.datasource_name, False)

    async def _reconnect_loop(self) -> None:
        # Route through the same safe-fallback/clamp helper as the other
        # intervals — a blank/non-numeric value must not kill the reconnect
        # task, and 0/negative must not spin the loop without backoff.
        interval = get_config_float(self._config, "reconnect_interval_s", 5.0, minimum=1.0, maximum=300.0)
        while not self._shutdown:
            if not self._connected:
                try:
                    await self._do_connect()
                except Exception as exc:
                    self._error = _short_probe_error(exc)
                    logger.warning(
                        "OPC-UA connect failed for %s: %s", self.datasource_name, exc
                    )
                    await asyncio.sleep(interval)
                    continue
            await asyncio.sleep(interval)
            if self._connected and not self._shutdown:
                client = self._client
                if client is None:
                    await self._close_client()
                    continue
                try:
                    await client.get_namespace_array()
                except Exception:
                    logger.warning(
                        "OPC-UA connection lost for %s — retrying",
                        self.datasource_name,
                    )
                    await self._close_client()

    async def _do_connect(self) -> None:
        url = self._config.get("server_url", "opc.tcp://localhost:4840")
        username = self._config.get("username", "")
        password = self._config.get("password", "")
        client = Client(url)

        await apply_client_security(client, self._config)

        if username:
            client.set_user(username)
            client.set_password(password)
        connect_timeout_s = float(self._config.get("connect_timeout_s", 10.0))
        await asyncio.wait_for(client.connect(), timeout=connect_timeout_s)
        self._client = client
        self._connected = True
        self._error = None
        logger.info("OPC-UA connected: %s → %s", self.datasource_name, url)
        self._wire_types = {}
        await self._discover_operation_limits()
        if self._status_callback is not None:
            await self._status_callback(self.datasource_name, True)
        try:
            await self._setup_subscriptions()
            # Re-apply priority paths that were requested before the OPC-UA connection
            # was ready.  set_priority_paths() is a no-op when not connected, so those
            # requests were silently dropped.  Apply them now.  Prefer the full
            # recompute (page-driven + alarm triggers + historized variables) so a
            # reconnect doesn't drop alarm/historian subscriptions until the next
            # browser navigation; fall back to the page-driven keys we can derive
            # locally when no recompute callback is wired (e.g. in tests).
            if self._priority_recompute_callback is not None:
                await self._priority_recompute_callback()
            else:
                dm = self._datasource_manager
                if dm is not None:
                    priority_paths: set[str] = set()
                    for key in dm.get_priority_keys():
                        sep = key.find(":")
                        if sep > 0 and key[:sep] == self.datasource_name:
                            path = key[sep + 1:]
                            if path:
                                priority_paths.add(path)
                    if priority_paths:
                        await self.set_priority_paths(priority_paths)
        except Exception:
            # Subscription setup failed after a successful TCP connect. Reset
            # state so the reconnect loop's `if not self._connected` check
            # actually retries next iteration, instead of reporting a healthy
            # connection with zero working subscriptions forever.
            await self._close_client()
            raise

    # ── Server operation limits ───────────────────────────────────────────────

    async def _discover_operation_limits(self) -> None:
        """Read the server's OperationLimits; see read_operation_limits()."""
        self._operation_limits = OperationLimits()
        client = self._client
        if client is None:
            return
        self._operation_limits = await read_operation_limits(client, self.datasource_name)

    # ── Browse ────────────────────────────────────────────────────────────────

    async def browse(
        self,
        node_id: str | None = None,
        *,
        on_progress: BrowseProgressSink | None = None,
    ) -> dict:
        """Walk the address space below *node_id* (or the configured root).

        *on_progress* receives ``{done, total, nodes, level}`` after every
        Browse and attribute-Read chunk; see AddressSpaceBrowser.
        """
        client = self._client
        if not self._connected or client is None:
            raise RuntimeError(f"Not connected: {self.datasource_name}")
        configured_root = node_id or self._config.get("browse_root_node") or None
        node: Node = (
            client.get_node(configured_root) if configured_root
            else client.get_objects_node()
        )
        browser = AddressSpaceBrowser(
            client, self._operation_limits, datasource_name=self.datasource_name
        )
        result = await browser.browse(
            node,
            on_progress=on_progress,
            # Browsing Server itself, or anything inside it, as the root still
            # walks it: then it was asked for.
            skip_children=() if configured_root else (SERVER_OBJECT_NODE_ID,),
            saved_node_ids=self._saved_node_ids(),
        )
        result["show_root"] = configured_root is not None
        return result

    def _saved_node_ids(self) -> list[str]:
        dm = self._datasource_manager
        ds_entry = dm.get(self.datasource_name) if dm is not None else None
        if ds_entry is None:
            return []
        return [
            entry["node_id"]
            for entry in list(ds_entry.registry.values())
            if entry.get("node_id")
        ]

    # ── Subscriptions ─────────────────────────────────────────────────────────

    def _make_sub_params(
        self, interval_ms: float, priority: int
    ) -> ua.CreateSubscriptionParameters:
        """Build CreateSubscriptionParameters with explicit priority.

        Priority 0   = background (lowest).
        Priority 200 = active-page fast subscription (server sends these first
        during backpressure, reducing display latency for operator-facing values).

        MaxNotificationsPerPublish = 0 means unlimited per OPC-UA spec § 5.13.2.
        asyncua's default of 10000 can silently truncate when many variables
        change simultaneously.
        """
        params = ua.CreateSubscriptionParameters()
        params.RequestedPublishingInterval = interval_ms
        params.RequestedLifetimeCount = 10000
        # Keep-alive: send a heartbeat after ~30 s of silence
        params.RequestedMaxKeepAliveCount = max(3, int(30_000 / max(interval_ms, 1)))
        params.MaxNotificationsPerPublish = 0  # 0 = unlimited
        params.PublishingEnabled = True
        params.Priority = priority
        return params

    async def _setup_subscriptions(self) -> None:
        async with self._subscription_transition_lock:
            await self._setup_subscriptions_locked()

    async def _setup_subscriptions_locked(self) -> None:
        dm = self._datasource_manager
        if dm is None or self._client is None:
            return
        self._sub_handler = _DsSubHandler(self)
        disable_bg = bool(self._config.get("disable_background_sync", False))
        bg_interval = self._background_publish_interval_ms()
        priority_interval = self._priority_publish_interval_ms()
        priority_sampling = self._priority_sampling_interval_ms()
        self._requested_bg_publish_interval_ms = bg_interval
        self._requested_priority_publish_interval_ms = priority_interval
        self._requested_priority_sampling_interval_ms = priority_sampling
        self._requested_priority_ws_batch_ms = self._priority_ws_batch_ms()
        self._priority_revised_sampling_count = 0
        self._priority_revised_sampling_sum_ms = 0.0
        self._priority_revised_sampling_min_ms = None
        self._priority_revised_sampling_max_ms = None
        if not disable_bg:
            self._background_sub = await self._client.create_subscription(
                self._make_sub_params(bg_interval, priority=0), self._sub_handler,
            )
            self._revised_bg_publish_interval_ms = float(
                self._background_sub.parameters.RequestedPublishingInterval,
            )
        self._priority_sub = await self._client.create_subscription(
            self._make_sub_params(priority_interval, priority=200), self._sub_handler,
        )
        self._revised_priority_publish_interval_ms = float(
            self._priority_sub.parameters.RequestedPublishingInterval,
        )
        self._node_to_path.clear()
        self._node_to_field.clear()
        self._path_to_node_ids.clear()
        self._bg_path_handles.clear()
        self._priority_path_handles.clear()
        self._current_priority_paths.clear()

        ds_entry = dm.get(self.datasource_name)
        if ds_entry is None:
            return

        field_routes = _struct_field_routes(ds_entry)

        if not disable_bg:
            # Collect all enabled (path, node) pairs first, then batch-subscribe
            # in chunks so we send one CreateMonitoredItems request per chunk
            # instead of one per variable — much faster for large variable trees.
            enabled_items: list[tuple[str, Any]] = []
            for path, var_entry in ds_entry.registry.items():
                if not is_subscribable(var_entry):
                    continue
                node_id = var_entry.get("node_id", "")
                if not node_id:
                    continue
                enabled_items.append((path, self._client.get_node(node_id)))

            chunk_size = self._operation_limits.monitored_items_budget()
            for i in range(0, len(enabled_items), chunk_size):
                chunk = enabled_items[i : i + chunk_size]
                nodes = [node for _, node in chunk]
                try:
                    # sampling_interval=-1 → server samples at the publishing interval,
                    # not the asyncua default of 50 ms.  For 500 variables at 1000 ms
                    # this saves the server ~20x unnecessary sampling work.
                    handles = await self._background_sub.subscribe_data_change(
                        nodes, sampling_interval=-1,
                    )
                    if not isinstance(handles, list):
                        handles = [handles]
                    for (path, node), handle in zip(chunk, handles, strict=False):
                        # handle may be ua.StatusCode when the server refuses a node
                        if isinstance(handle, ua.StatusCode):
                            logger.warning(
                                "Subscribe rejected for %s/%s: %s",
                                self.datasource_name, path, handle,
                            )
                            continue
                        self._bg_path_handles[path] = [handle]
                        nid = node.nodeid
                        self._register_node_route(path, nid, field_routes)
                        self._path_to_node_ids.setdefault(path, set()).add(nid)
                except Exception as exc:
                    logger.warning(
                        "Batch subscribe failed for %s (chunk %d): %s — falling back to per-path",
                        self.datasource_name, i // chunk_size, exc,
                    )
                    for path, _node in chunk:
                        var_entry = ds_entry.registry.get(path, {})
                        await self._subscribe_path(path, var_entry, ds_entry, field_routes)

        logger.info(
            "Subscriptions set up for %s: bg requested=%sms revised=%sms enabled=%s, "
            "priority requested=%sms revised=%sms sampling requested=%sms revised avg/min/max=%s/%s/%s, bg paths=%d",
            self.datasource_name,
            self._requested_bg_publish_interval_ms,
            self._revised_bg_publish_interval_ms,
            not disable_bg,
            self._requested_priority_publish_interval_ms,
            self._revised_priority_publish_interval_ms,
            self._requested_priority_sampling_interval_ms,
            self._priority_revised_sampling_avg_ms(),
            self._priority_revised_sampling_min_ms,
            self._priority_revised_sampling_max_ms,
            len(self._bg_path_handles),
        )

    async def _subscribe_path(
        self,
        path: str,
        var_entry: dict,
        ds_entry: Any,
        field_routes: dict[str, tuple[str, str]] | None = None,
    ) -> None:
        """Subscribe a single variable path to the background subscription (fallback/dynamic)."""
        if path in self._bg_path_handles:
            # Already tracked (e.g. a reconnect's full resync racing an
            # independent enable-variable call) — reuse it instead of
            # creating a duplicate monitored item and leaking the existing
            # handle, which would double-deliver every datachange.
            return
        try:
            node_id = var_entry.get("node_id", "")
            if not node_id:
                return
            node = self._client.get_node(node_id)
            handles = await self._background_sub.subscribe_data_change(
                [node], sampling_interval=-1,
            )
            if not isinstance(handles, list):
                handles = [handles]
            valid = [h for h in handles if not isinstance(h, ua.StatusCode)]
            if not valid:
                return
            self._bg_path_handles[path] = valid
            nid = node.nodeid
            routes = field_routes if field_routes is not None else _struct_field_routes(ds_entry)
            self._register_node_route(path, nid, routes)
            self._path_to_node_ids.setdefault(path, set()).add(nid)
        except Exception as exc:
            logger.warning(
                "Failed to subscribe %s/%s: %s", self.datasource_name, path, exc,
            )

    async def _teardown_subscriptions(self) -> None:
        async with self._subscription_transition_lock:
            await self._teardown_subscriptions_locked()

    async def _teardown_subscriptions_locked(self) -> None:
        for sub in (self._background_sub, self._priority_sub):
            if sub is not None:
                with contextlib.suppress(Exception):
                    await sub.delete()
        self._background_sub = None
        self._priority_sub = None
        self._sub_handler = None
        self._node_to_path.clear()
        self._node_to_field.clear()
        self._path_to_node_ids.clear()
        self._bg_path_handles.clear()
        self._priority_path_handles.clear()
        self._current_priority_paths.clear()

    # ── Write ─────────────────────────────────────────────────────────────────

    async def wire_variant_type(self, node_id: str) -> ua.VariantType | None:
        """The VariantType the server sends for *node_id*, or None if unknown.

        Free for a subscribed tag (recorded on datachange); one Read otherwise,
        cached. A null or unreadable value says nothing, so it is not cached.
        """
        try:
            nid = ua.NodeId.from_string(node_id)
        except Exception:
            return None
        cached = self._wire_types.get(nid)
        if cached is not None:
            return cached
        if not self._connected or self._client is None:
            return None
        try:
            data_value = await self._client.get_node(nid).read_data_value()
        except asyncio.CancelledError:
            raise
        except Exception:
            return None
        variant = data_value.Value
        if variant is None or variant.VariantType == ua.VariantType.Null:
            return None
        self._wire_types[nid] = variant.VariantType
        return variant.VariantType

    async def write_node(self, node_id: str, value: Any, variant_type: ua.VariantType | None = None) -> None:
        if not self._connected or self._client is None:
            raise RuntimeError(f"Not connected: {self.datasource_name}")
        node = self._client.get_node(node_id)
        if variant_type is not None:
            await node.write_value(ua.Variant(value, variant_type))
            return
        await node.write_value(value)

    async def read_current_values(self, paths: set[str], *, raw: bool = False) -> dict[str, Any]:
        """Bulk-read current values for requested paths and folder structs.

        Values come back in their cache form (``normalize_value``); *raw* keeps
        the asyncua values instead, for a caller that writes them back to the
        server — a patched array element write.
        """
        if not paths or not self._connected or self._client is None:
            return {}
        dm = self._datasource_manager
        if dm is None:
            return {}
        ds_entry = dm.get(self.datasource_name)
        if ds_entry is None:
            return {}

        requests: list[tuple[str, str, str | None, Node]] = []
        for path in sorted(paths):
            folder_entry = ds_entry.folder_registry.get(path)
            if folder_entry is not None:
                if folder_entry.get("_is_array"):
                    # Array-of-struct: collect leaves from every element subfolder.
                    # Each element is tracked as ("array_elem", array_folder_path,
                    # elem_index, elem_path, field_name, node).
                    for elem_idx, elem_path in enumerate(folder_entry.get("_element_paths", [])):
                        elem_entry = ds_entry.folder_registry.get(elem_path)
                        if elem_entry is None:
                            continue
                        for field_name, child_path in _collect_struct_leaf_paths(
                            elem_entry, ds_entry.folder_registry,
                        ):
                            child_entry = ds_entry.registry.get(child_path)
                            if not child_entry or not is_subscribable(child_entry):
                                continue
                            node_id = child_entry.get("node_id", "")
                            if not node_id:
                                continue
                            requests.append(
                                ("array_elem", path, f"{elem_idx}:{field_name}", self._client.get_node(node_id))
                            )
                else:
                    for field_path, child_path in _collect_struct_leaf_paths(folder_entry, ds_entry.folder_registry):
                        child_entry = ds_entry.registry.get(child_path)
                        if not child_entry or not is_subscribable(child_entry):
                            continue
                        node_id = child_entry.get("node_id", "")
                        if not node_id:
                            continue
                        requests.append(("struct", path, field_path, self._client.get_node(node_id)))
                continue

            entry = ds_entry.registry.get(path)
            if not entry or not is_subscribable(entry):
                continue
            node_id = entry.get("node_id", "")
            if not node_id:
                continue
            requests.append(("scalar", path, None, self._client.get_node(node_id)))

        if not requests:
            return {}

        # One Read operation per node, chunked to MaxNodesPerRead: a server that
        # enforces it fails the whole request, so an over-limit page context
        # would leave every variable on the page without a value.
        nodes_to_read = [node for _, _, _, node in requests]
        read_budget = self._operation_limits.read_ops_budget()
        values: list[Any] = []
        for start in range(0, len(nodes_to_read), read_budget):
            values.extend(
                await self._client.read_values(nodes_to_read[start : start + read_budget])
            )
        result: dict[str, Any] = {}
        for (kind, path, field_name, _node), value in zip(requests, values, strict=False):
            coerced = value if raw else normalize_value(value)
            key = build_var_key(self.datasource_name, path)
            if kind == "struct" and field_name is not None:
                fields = result.get(key)
                if not isinstance(fields, dict):
                    fields = {}
                    result[key] = fields
                # field_name may be a '/'-separated path for nested structs
                # (e.g. "stSignalRaw/bVisible"); build the nested dict accordingly.
                parts = field_name.split("/")
                d: dict = fields
                for part in parts[:-1]:
                    if not isinstance(d.get(part), dict):
                        d[part] = {}
                    d = d[part]
                d[parts[-1]] = coerced
                continue
            if kind == "array_elem" and field_name is not None:
                # field_name is encoded as "elem_idx:field_name"
                sep = field_name.index(":")
                elem_idx = int(field_name[:sep])
                actual_field = field_name[sep + 1:]
                arr = result.get(key)
                if not isinstance(arr, list):
                    arr = []
                    result[key] = arr
                while len(arr) <= elem_idx:
                    arr.append({})
                parts = actual_field.split("/")
                target = arr[elem_idx]
                for part in parts[:-1]:
                    if not isinstance(target.get(part), dict):
                        target[part] = {}
                    target = target[part]
                target[parts[-1]] = coerced
                continue
            result[key] = coerced

        # Indexed struct[] bindings read a concrete element key. Include those
        # keys in bulk reads/prefetches, not only in later subscription updates,
        # so context_ready genuinely means the indexed value is available.
        for path in paths:
            folder_entry = ds_entry.folder_registry.get(path)
            if folder_entry is None or not folder_entry.get("_is_array"):
                continue
            aggregate = result.get(build_var_key(self.datasource_name, path))
            if not isinstance(aggregate, list):
                continue
            for index, elem_path in enumerate(folder_entry.get("_element_paths", [])):
                if index >= len(aggregate):
                    break
                result[build_var_key(self.datasource_name, elem_path)] = dm._snapshot_copy(
                    aggregate[index]
                )
        return result

    # ── Dynamic subscribe/unsubscribe (for variable enable/disable) ───────────

    async def add_subscription_by_path(
        self, path: str, ds_entry: Any,
    ) -> None:
        async with self._subscription_transition_lock:
            if not self._connected or self._background_sub is None:
                return
            var_entry = ds_entry.registry.get(path)
            if not var_entry:
                return
            await self._subscribe_path(path, var_entry, ds_entry)

    async def remove_subscription_by_path(self, ds_name: str, path: str) -> bool:
        """Remove every monitored item for *path* without losing failed handles.

        Returns true only when no background/priority handle remains. Callers
        changing a node identity use this to avoid subscribing the replacement
        alongside an old item whose unsubscribe RPC failed.
        """
        async with self._subscription_transition_lock:
            return await self._remove_subscription_by_path_locked(ds_name, path)

    async def _remove_subscription_by_path_locked(self, ds_name: str, path: str) -> bool:
        bg_handles = self._bg_path_handles.get(path)
        if bg_handles:
            try:
                if self._background_sub is not None:
                    await self._background_sub.unsubscribe(bg_handles)
                    self._bg_path_handles.pop(path, None)
            except Exception as exc:
                logger.warning("remove_subscription failed for %s/%s: %s", ds_name, path, exc)
        priority_handles = self._priority_path_handles.get(path)
        if priority_handles:
            try:
                if self._priority_sub is not None:
                    await self._priority_sub.unsubscribe(priority_handles)
                    self._priority_path_handles.pop(path, None)
            except Exception as exc:
                logger.warning("remove priority sub failed for %s/%s: %s", ds_name, path, exc)
        if path in self._bg_path_handles or path in self._priority_path_handles:
            self._current_priority_paths = set(self._priority_path_handles)
            return False
        # Clean up node routing maps — only remove NodeIds not referenced by other paths
        for nid in self._path_to_node_ids.pop(path, ()):
            still_referenced = any(
                nid in nids
                for p, nids in self._path_to_node_ids.items()
                if p != path
            )
            if not still_referenced:
                self._node_to_path.pop(nid, None)
                self._node_to_field.pop(nid, None)
        self._current_priority_paths = set(self._priority_path_handles)
        return True

    # ── Priority management ───────────────────────────────────────────────────

    async def set_priority_paths(self, paths: set[str]) -> None:
        """Serialise priority transitions for this datasource."""
        async with self._subscription_transition_lock:
            await self._set_priority_paths_locked(paths)

    async def _set_priority_paths_locked(self, paths: set[str]) -> None:
        """Promote paths to priority subscription, demote the rest.

        Uses bulk OPC-UA calls (one DeleteMonitoredItems + one CreateMonitoredItems
        per direction) instead of one call per variable, so a page switch with
        N active variables costs 4 round-trips regardless of N.
        """
        if not self._connected or self._priority_sub is None:
            return
        dm = self._datasource_manager
        if dm is None:
            return
        ds_entry = dm.get(self.datasource_name)
        if ds_entry is None:
            return

        self._requested_priority_paths = set(paths)
        desired_leaf_paths = self._expand_priority_paths(paths, ds_entry)
        field_routes = _struct_field_routes(ds_entry)

        # Handle tracking is the authoritative actual state. Failed operations
        # therefore remain a delta and are retried by the next recompute.
        actual_priority_paths = set(self._priority_path_handles)
        to_promote = desired_leaf_paths - actual_priority_paths
        to_demote = actual_priority_paths - desired_leaf_paths

        # ── Batch promote: bg → priority ──────────────────────────────────────
        # Visible page bindings should be promotable even when they are not part of
        # the datasource's background-enabled set. Stale vars (present_on_server=False)
        # are skipped: subscribing to them only generates "Subscribe rejected" warnings.
        promote_items: list[tuple[str, Any]] = []   # (path, node)
        for path in to_promote:
            entry = ds_entry.registry.get(path)
            if not entry:
                continue
            if not is_present_on_server(entry):
                continue
            node_id = entry.get("node_id", "")
            if not node_id:
                continue
            promote_items.append((path, self._client.get_node(node_id)))

        if promote_items:
            # 1. Bulk-unsubscribe from background (one DeleteMonitoredItems call)
            bg_handles_to_remove: list[Any] = []
            for path, _ in promote_items:
                bg_handles_to_remove.extend(self._bg_path_handles.get(path, []))
            bg_unsubscribe_ok = True
            if bg_handles_to_remove and self._background_sub is not None:
                try:
                    await self._background_sub.unsubscribe(bg_handles_to_remove)
                    for path, _ in promote_items:
                        self._bg_path_handles.pop(path, None)
                except Exception as exc:
                    logger.warning("Bulk bg-unsubscribe failed for %s: %s", self.datasource_name, exc)
                    bg_unsubscribe_ok = False

            # 2. Bulk-subscribe to priority (one CreateMonitoredItems call) —
            # only once the background side is actually cleared, so a node is
            # never live on both subscriptions at once. On failure the
            # nodes simply stay on the background sub (no data loss) instead
            # of also landing on the priority sub.
            if bg_unsubscribe_ok:
                nodes = [node for _, node in promote_items]
                try:
                    handles, revised_samples = await self._subscribe_priority_nodes_with_revised_sampling(
                        nodes,
                    )
                    self._record_priority_revised_sampling(revised_samples)
                    for (path, node), handle in zip(promote_items, handles, strict=False):
                        if isinstance(handle, ua.StatusCode):
                            logger.warning("Promote rejected for %s/%s: %s", self.datasource_name, path, handle)
                            continue
                        self._priority_path_handles[path] = [handle]
                        # Always register NodeId routing here — when disable_background_sync=True
                        # _setup_subscriptions never populates _node_to_path/_node_to_field, so
                        # without this the datachange_notification callback silently drops every
                        # priority-sub value.
                        nid = node.nodeid
                        self._register_node_route(path, nid, field_routes)
                        self._path_to_node_ids.setdefault(path, set()).add(nid)
                except Exception as exc:
                    logger.warning("Bulk promote failed for %s: %s — retrying per-path", self.datasource_name, exc)
                    for path, node in promote_items:
                        try:
                            handles, revised_samples = await self._subscribe_priority_nodes_with_revised_sampling(
                                [node],
                            )
                            self._record_priority_revised_sampling(revised_samples)
                            handles_list = [x for x in handles if isinstance(x, int)]
                            if not handles_list:
                                continue
                            self._priority_path_handles[path] = handles_list
                            nid = node.nodeid
                            self._register_node_route(path, nid, field_routes)
                            self._path_to_node_ids.setdefault(path, set()).add(nid)
                        except Exception as e2:
                            logger.warning("Per-path promote failed %s/%s: %s", self.datasource_name, path, e2)
            else:
                logger.warning(
                    "Skipping priority promote for %s (bg-unsubscribe failed) — nodes stay on background sub",
                    self.datasource_name,
                )

            # A successful bg-unsubscribe followed by rejected/failed priority
            # creation must not leave an enabled variable with no monitored item.
            for path, _node in promote_items:
                if path in self._priority_path_handles or path in self._bg_path_handles:
                    continue
                entry = ds_entry.registry.get(path)
                if entry is not None and is_subscribable(entry) and self._background_sub is not None:
                    await self._subscribe_path(path, entry, ds_entry, field_routes)

        # ── Batch demote: priority → bg ───────────────────────────────────────
        demote_items: list[tuple[str, Any]] = []   # (path, node) — only enabled vars
        demote_paths_no_bg: list[str] = []          # disabled — just remove handles
        for path in to_demote:
            entry = ds_entry.registry.get(path)
            if not entry:
                continue
            if is_subscribable(entry) and self._background_sub is not None:
                node_id = entry.get("node_id", "")
                if node_id:
                    demote_items.append((path, self._client.get_node(node_id)))
                    continue
            demote_paths_no_bg.append(path)

        if demote_items or demote_paths_no_bg:
            # 1. Bulk-unsubscribe from priority. Don't discard tracking until
            # the RPC actually succeeds — on failure the items stay
            # tracked as priority (retryable/cleanable later) and step 2 is
            # skipped so a node is never live on both subscriptions at once.
            demote_paths_all = [p for p, _ in demote_items] + list(demote_paths_no_bg)
            prio_handles_to_remove: list[Any] = []
            for path in demote_paths_all:
                prio_handles_to_remove.extend(self._priority_path_handles.get(path, []))
            prio_unsubscribe_ok = True
            if prio_handles_to_remove:
                try:
                    await self._priority_sub.unsubscribe(prio_handles_to_remove)
                    for path in demote_paths_all:
                        self._priority_path_handles.pop(path, None)
                except Exception as exc:
                    logger.warning("Bulk prio-unsubscribe failed for %s: %s", self.datasource_name, exc)
                    prio_unsubscribe_ok = False

            # 2. Bulk-resubscribe to background — only after the priority
            # side was actually cleared.
            if demote_items and prio_unsubscribe_ok:
                nodes = [node for _, node in demote_items]
                try:
                    handles = await self._background_sub.subscribe_data_change(
                        nodes, sampling_interval=-1,
                    )
                    if not isinstance(handles, list):
                        handles = [handles]
                    for (path, _), handle in zip(demote_items, handles, strict=False):
                        if isinstance(handle, ua.StatusCode):
                            logger.warning("Demote-resub rejected for %s/%s: %s", self.datasource_name, path, handle)
                            continue
                        self._bg_path_handles[path] = [handle]
                except Exception as exc:
                    logger.warning("Bulk demote failed for %s: %s — retrying per-path", self.datasource_name, exc)
                    for path, node in demote_items:
                        try:
                            h = await self._background_sub.subscribe_data_change([node], sampling_interval=-1)
                            self._bg_path_handles[path] = [h] if isinstance(h, int) else [x for x in h if isinstance(x, int)]
                        except Exception as e2:
                            logger.warning("Per-path demote failed %s/%s: %s", self.datasource_name, path, e2)
            elif demote_items:
                logger.warning(
                    "Skipping background resubscribe for %s (priority-unsubscribe failed) — "
                    "nodes stay on priority sub",
                    self.datasource_name,
                )

            if prio_unsubscribe_ok:
                for path, _node in demote_items:
                    if path in self._bg_path_handles:
                        continue
                    entry = ds_entry.registry.get(path)
                    if entry is not None and self._background_sub is not None:
                        await self._subscribe_path(path, entry, ds_entry, field_routes)

            # Disabled/dropped paths must remove stale routing so callback map
            # stays consistent — only once their priority unsubscribe actually
            # succeeded (otherwise the subscription is still live).
            if prio_unsubscribe_ok:
                for path in demote_paths_no_bg:
                    for nid in self._path_to_node_ids.pop(path, set()):
                        self._node_to_path.pop(nid, None)
                        self._node_to_field.pop(nid, None)

        # Actual state, deliberately distinct from `_requested_priority_paths`.
        self._current_priority_paths = set(self._priority_path_handles)
