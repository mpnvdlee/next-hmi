"""
opcua.engine — one OPC-UA connection per opcua-client datasource.

Connection lifecycle, the background and priority subscriptions, reads and
writes. Each engine routes datachange notifications through the
DatasourceManager using composite keys.
"""

import asyncio
import contextlib
import logging
from collections.abc import Awaitable
from typing import Any

from asyncua import Client, ua
from asyncua.common.node import Node
from asyncua.common.subscription import DataChangeEvent, StatusChangeEvent
from core import telemetry
from core.number_utils import get_config_float
from core.value_types import _place, is_array_shape, to_simple_type
from models.datasource import build_var_key, is_subscribable, parse_var_key

from .browse import SERVER_OBJECT_NODE_ID, AddressSpaceBrowser, BrowseProgressSink
from .compat import apply_asyncua_watchdog_log_patch
from .discovery import _short_probe_error
from .limits import OperationLimits, read_operation_limits
from .routing import _composite_leaf_steps, _struct_field_routes
from .security import (
    ServerCertificate,
    ServerCertificateNotTrusted,
    apply_client_security,
)
from .values import normalize_value

apply_asyncua_watchdog_log_patch()

logger = logging.getLogger(__name__)

# Background CreateMonitoredItems batch cap. Larger batches save round trips
# but hold the transition lock (and the server) longer per request.
BG_SUBSCRIBE_CHUNK = 1000
# Wait before reconnecting after a drop or a failed connect, doubled each time
# up to reconnect_interval_s: most outages are a PLC restart or a network
# blip, over in a second or two.
RECONNECT_FIRST_RETRY_S = 0.5
# Datachange notifications handled between event-loop yields.
CONSUME_YIELD_EVERY = 500
# The codes that mean "no deadband filter here"; any other refusal is about
# the item itself (an unknown node, say) and creating it without one would
# fail the same way.
_FILTER_REFUSED = frozenset({
    ua.StatusCodes.BadFilterNotAllowed,
    ua.StatusCodes.BadMonitoredItemFilterUnsupported,
    ua.StatusCodes.BadMonitoredItemFilterInvalid,
    ua.StatusCodes.BadDeadbandFilterInvalid,
})

# Refusals of the node itself, which no retry cures. Any other refused
# background create — a full server, a timed-out or refused request — the
# health check retries.
_NODE_REFUSALS = frozenset({
    ua.StatusCodes.BadNodeIdUnknown,
    ua.StatusCodes.BadNodeIdInvalid,
    ua.StatusCodes.BadAttributeIdInvalid,
    ua.StatusCodes.BadNotReadable,
    ua.StatusCodes.BadUserAccessDenied,
})


def _forget_items(sub: Any, handles: list[Any]) -> None:
    """Drop *handles* from asyncua's own item map, as its ``unsubscribe`` does
    after a clean answer: a first result of BadMonitoredItemIdInvalid raises
    before that step, and the chunk's items stayed there until the
    subscription went."""
    items = getattr(sub, "_monitored_items", None)
    if not items:
        return
    gone = set(handles)
    for key in [key for key, item in items.items() if item.server_handle in gone]:
        del items[key]


def _is_numeric_scalar(var_entry: dict | None) -> bool:
    """A deadband applies to a number, never to an array, string or bool."""
    if not var_entry or is_array_shape(var_entry):
        return False
    return to_simple_type(var_entry.get("data_type", ""), as_array_suffix=False) in ("Float", "Integer", "Byte")


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
                path, steps, leaf_path = self._engine._node_to_field[node_id]
                dm.update_struct_field(
                    ds_name,
                    path,
                    steps,
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
            self._engine._schedule_close()


class DatasourceOpcuaEngine:
    """OPC-UA engine for a single datasource, using path-based variable keys."""

    def __init__(self, datasource_name: str) -> None:
        self.datasource_name = datasource_name
        self._client: Client | None = None
        self._connected = False
        self._error: str | None = None
        self._reconnect_task: asyncio.Task | None = None
        # Set when the client closes, to wake the reconnect loop.
        self._dropped = asyncio.Event()
        self._shutdown = False
        # In-flight close, so a status-change-triggered close and the
        # reconnect loop's own close coalesce into one execution instead of
        # racing.
        self._close_task: asyncio.Task | None = None
        # The close a callback schedules (`_schedule_close`) — tracked so
        # disconnect() can cancel it instead of leaving it to run against a
        # torn-down engine after shutdown.
        self._status_close_task: asyncio.Task | None = None
        self._config: dict = {}
        # What a secured endpoint presented on the last check, kept through a
        # refused connect so the editor can show it for trusting.
        self._server_certificate: ServerCertificate | None = None
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
        # One drain task per subscription (iterator mode): asyncua's handler
        # mode spawns a task per notification, which is what a 100k-variable
        # initial burst or a fast-churning server turns into seconds of pure
        # task-scheduling overhead on the event loop.
        self._sub_consumer_tasks: list[asyncio.Task] = []
        # Set once this server refused a deadband filter; reset per connection.
        self._deadband_refused = False
        # Maps for routing datachange callbacks (keyed by NodeId object, not string)
        self._node_to_path: dict = {}       # NodeId → path
        self._node_to_field: dict = {}      # NodeId → (folder_path, steps, leaf_path)
        # Reverse map: path → set[NodeId] for O(1) cleanup in remove_subscription_by_path
        self._path_to_node_ids: dict[str, set] = {}
        # Subscription handles per path
        self._bg_path_handles: dict[str, list] = {}
        self._priority_path_handles: dict[str, list] = {}
        # Paths a transition left on neither subscription because their
        # background create was refused or timed out, by node id: the health
        # check retries them, as no recompute selects a demoted one again.
        self._bg_retry: dict[str, str] = {}
        # Health checks to let pass before the next retry, and how many the
        # last refusal set: 1, 2, 4 … 16. A server full of monitored items
        # refuses every retry, each one requests under the transition lock.
        self._bg_retry_wait = 0
        self._bg_retry_backoff = 0
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
        self._requested_priority_sampling_interval_ms = 50.0
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
    def server_certificate(self) -> ServerCertificate | None:
        """The secured endpoint's certificate as last checked, or ``None``."""
        return self._server_certificate

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
        return get_config_float(self._config, "priority_sampling_interval_ms", 50.0, minimum=0.0, maximum=5_000.0)

    def _deadband_abs(self) -> float:
        return get_config_float(self._config, "deadband_abs", 0.001, minimum=0.0, maximum=1e12)

    def _priority_ws_batch_ms(self) -> float:
        return get_config_float(self._config, "priority_ws_batch_ms", 10.0, minimum=0.0, maximum=1_000.0)

    def _is_priority_path(self, path: str) -> bool:
        return path in self._priority_path_handles or path in self._current_priority_paths

    async def _create_items(
        self, sub: Any, items: list[tuple[str, Any]], ds_entry: Any, sampling_interval: float,
    ) -> list[Any]:
        """CreateMonitoredItems for *items* (``(path, node)``) on *sub*: one
        handle, or the refusing StatusCode, per item, in order.

        One request per `monitored_item_chunks` slice: a server refuses a
        whole request past its MaxMonitoredItemsPerCall, and TwinCAT drops
        the connection past its message size.

        Each item is routed through the entry's `_field_routes` before its
        request goes out and unrouted again if refused. A server
        publishes an item's first value as soon as it creates it, so that
        notification can be handled before the response: unrouted, it was
        dropped — every value of the first page after a connect. A timed-out
        item keeps its route: the server has often created it all the same.

        Numeric scalars carry an absolute deadband (``deadband_abs``), so a
        value jittering below it is never published — the cheapest
        notification is the one the server does not send. Other types take no
        filter (a server subtracts to apply one). An item the server refuses
        for the filter is created again without it, and from then on this
        connection asks for no filter at all.
        """
        routes = self._field_routes(ds_entry) if ds_entry is not None else {}
        handles: list[Any] = []
        for span in self._operation_limits.monitored_item_chunks([node.nodeid for _, node in items]):
            chunk = items[span]
            self._route_items(chunk, routes)
            created = await self._create_chunk(sub, chunk, ds_entry, sampling_interval)
            self._unroute_items([
                item for item, handle in zip(chunk, created, strict=False)
                if isinstance(handle, ua.StatusCode) and handle.value != ua.StatusCodes.BadTimeout
            ])
            handles.extend(created)
        return handles

    async def _create_chunk(
        self, sub: Any, items: list[tuple[str, Any]], ds_entry: Any, sampling_interval: float,
    ) -> list[Any]:
        """One CreateMonitoredItems request for *items*; see _create_items."""
        nodes = [node for _, node in items]
        deadband = self._deadband_abs()
        filtered = (
            [] if deadband <= 0 or ds_entry is None or self._deadband_refused
            else [_is_numeric_scalar(ds_entry.registry.get(path)) for path, _ in items]
        )
        if not any(filtered):
            return await self._chunk_results(
                sub.subscribe_data_change(nodes, sampling_interval=sampling_interval), len(nodes),
            )
        data_filter = ua.DataChangeFilter(
            Trigger=ua.DataChangeTrigger.StatusValue,
            DeadbandType=ua.DeadbandType.Absolute,
            DeadbandValue=deadband,
        )
        requests = [
            sub._make_monitored_item_request(
                node, ua.AttributeIds.Value, data_filter if numeric else None, 0,
                ua.MonitoringMode.Reporting, sampling_interval,
            )
            for node, numeric in zip(nodes, filtered, strict=True)
        ]
        handles = await self._chunk_results(sub.create_monitored_items(requests), len(requests))
        refused = [
            i for i, h in enumerate(handles)
            if filtered[i] and isinstance(h, ua.StatusCode) and h.value in _FILTER_REFUSED
        ]
        if refused:
            logger.info(
                "%s refuses the deadband filter (%s); creating items without it from now on",
                self.datasource_name, handles[refused[0]].name,
            )
            self._deadband_refused = True
            retried = await self._chunk_results(
                sub.subscribe_data_change([nodes[i] for i in refused], sampling_interval=sampling_interval),
                len(refused),
            )
            for i, handle in zip(refused, retried, strict=False):
                handles[i] = handle
        return handles

    async def _chunk_results(self, request: Awaitable[list[Any]], count: int) -> list[Any]:
        """The results of one CreateMonitoredItems *request* for *count* items.

        A request the server refuses or does not answer in time gives each
        item that error instead of raising: the items earlier chunks created
        keep their handles, and a caller's per-item handling neither loses
        nor re-creates any of them. A lost session (ConnectionError) and
        anything unexpected still raise.
        """
        try:
            return list(await request)
        except ua.UaStatusCodeError as exc:
            code = exc.code
        except TimeoutError:
            code = ua.StatusCodes.BadTimeout
        status = ua.StatusCode(code)
        logger.warning(
            "CreateMonitoredItems failed for %s (%d items): %s", self.datasource_name, count, status.name,
        )
        return [status] * count

    async def _delete_items(self, sub: Any, handles: list[Any]) -> set[Any]:
        """DeleteMonitoredItems for *handles*, `monitored_items_budget()` per
        request, every request tried; returns the handles that may still be
        live (empty: all deleted). Raises like _chunk_results.

        asyncua checks only the first result of a request, so a
        BadMonitoredItemIdInvalid from it means that item was gone already
        and the server processed the rest: the whole request counts as done.
        A request that fails is sent once more — a timed-out one has usually
        been carried out, and the second answer says so unambiguously.
        """
        failed: set[Any] = set()
        budget = self._operation_limits.monitored_items_budget()
        for i in range(0, len(handles), budget):
            chunk = handles[i : i + budget]
            error: Exception | None = None
            for _attempt in range(2):
                try:
                    await sub.unsubscribe(chunk)
                except ua.UaStatusCodeError as exc:
                    error = exc
                    if exc.code == ua.StatusCodes.BadMonitoredItemIdInvalid:
                        error = None
                        _forget_items(sub, chunk)
                except TimeoutError as exc:
                    error = exc
                else:
                    error = None
                if error is None:
                    break
            if error is not None:
                logger.warning(
                    "DeleteMonitoredItems failed for %s (%d items): %r — they stay where they "
                    "are until the next priority change retries them",
                    self.datasource_name, len(chunk), error,
                )
                failed.update(chunk)
        return failed

    async def _delete_tracked(self, sub: Any, tracked: dict[str, list], paths: list[str]) -> set[str]:
        """Delete the items *tracked* holds for *paths* from *sub*; returns the
        paths whose items are all gone, and stops tracking those. One whose
        delete failed stays tracked, retried by the next recompute, so a node
        is never live on both subscriptions."""
        handles = [h for path in paths for h in tracked.get(path, [])]
        failed = await self._delete_items(sub, handles) if sub is not None else set()
        cleared = {path for path in paths if failed.isdisjoint(tracked.get(path, ()))}
        for path in cleared:
            tracked.pop(path, None)
        return cleared

    def _log_rejected(self, action: str, rejected: list[tuple[str, ua.StatusCode]]) -> None:
        """One warning for the items one call could not create, however many
        — a failed chunk is up to a thousand of them — and each at debug."""
        if not rejected:
            return
        shown = ", ".join(f"{path} ({code.name})" for path, code in rejected[:5])
        more = f" and {len(rejected) - 5} more" if len(rejected) > 5 else ""
        logger.warning("%s rejected for %s: %s%s", action, self.datasource_name, shown, more)
        for path, code in rejected:
            logger.debug("%s rejected for %s/%s: %s", action, self.datasource_name, path, code.name)

    def _record_handles(
        self, target: dict[str, list[Any]], items: list[tuple[str, Any]], handles: list[Any], action: str,
    ) -> list[tuple[str, ua.StatusCode]]:
        """Track each created handle in *target* under its path; log and
        return ``(path, StatusCode)`` for the items the server refused."""
        rejected: list[tuple[str, ua.StatusCode]] = []
        for (path, _node), handle in zip(items, handles, strict=False):
            if isinstance(handle, ua.StatusCode):
                rejected.append((path, handle))
            else:
                target[path] = [handle]
        self._log_rejected(action, rejected)
        return rejected

    @staticmethod
    def _field_routes(ds_entry: Any) -> dict[str, tuple[str, tuple[str | int, ...]]]:
        """``_struct_field_routes`` of *ds_entry*, built once per entry and
        kept on it (``derived``): a walk of every leaf (70,000 on a large PLC)
        that only a config edit — which replaces the entry — changes, repeated
        on every page switch otherwise."""
        routes = ds_entry.derived.get("field_routes")
        if routes is None:
            routes = ds_entry.derived["field_routes"] = _struct_field_routes(ds_entry)
        return routes

    def _route_items(
        self, items: list[tuple[str, Any]], field_routes: dict[str, tuple[str, tuple[str | int, ...]]],
    ) -> None:
        """Route each ``(path, node)``'s datachange notifications to the
        struct-field O(1) patch path (_node_to_field) when *path* is a
        struct/array-of-struct leaf, else the plain per-path scalar path
        (_node_to_path)."""
        for path, node in items:
            nid = node.nodeid
            route = field_routes.get(path)
            if route is not None:
                self._node_to_field[nid] = (*route, path)
            else:
                self._node_to_path[nid] = path
            self._path_to_node_ids.setdefault(path, set()).add(nid)

    def _unroute_items(self, items: list[tuple[str, Any]]) -> None:
        """Undo _route_items for ``(path, node)`` items that have no monitored
        item, leaving a node another path routes alone."""
        for path, node in items:
            if path in self._bg_path_handles or path in self._priority_path_handles:
                continue
            nid = node.nodeid
            if self._node_to_path.get(nid) == path:
                del self._node_to_path[nid]
            field_route = self._node_to_field.get(nid)
            if field_route is not None and field_route[2] == path:
                del self._node_to_field[nid]
            nids = self._path_to_node_ids.get(path)
            if nids is not None:
                nids.discard(nid)
                if not nids:
                    del self._path_to_node_ids[path]

    @staticmethod
    def _expand_priority_paths(paths: set[str], ds_entry: Any) -> set[str]:
        """Resolve logical variable/folder bindings to monitored leaf paths.

        Keeping the transition state in this concrete namespace makes promote
        and demote symmetric: a struct folder that expands to ten monitored
        leaves is later demoted through those same ten keys instead of being
        skipped because the folder itself is not in ``registry``.

        A folder's leaves are walked once per entry and kept on it
        (``derived``): every recompute, any client's table scroll included,
        re-walked every bound folder otherwise — 13 ms for 70,000 leaves.
        """
        leaves_of = ds_entry.derived.setdefault("folder_leaves", {})
        expanded: set[str] = set()
        for path in paths:
            if path in ds_entry.registry:
                expanded.add(path)
                continue
            leaves = leaves_of.get(path)
            if leaves is None:
                folder_entry = ds_entry.folder_registry.get(path)
                if folder_entry is None:
                    continue
                leaves = leaves_of[path] = tuple(
                    child_path
                    for _steps, child_path in _composite_leaf_steps(folder_entry, ds_entry.folder_registry)
                )
            expanded.update(leaves)
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
            "bg_queue_depth": self._queue_depth(self._background_sub),
            "priority_queue_depth": self._queue_depth(self._priority_sub),
        }

    @staticmethod
    def _queue_depth(sub: Any) -> int | None:
        """Notifications *sub* has received and _consume_subscription not yet
        handled — unbounded, so a growing number means the consumer is falling
        behind. asyncua has no public accessor; None when unavailable."""
        queue = getattr(sub, "_event_queue", None)
        return queue.qsize() if isinstance(queue, asyncio.Queue) else None

    async def _subscribe_priority_nodes_with_revised_sampling(
        self, items: list[tuple[str, Any]], ds_entry: Any,
    ) -> tuple[list[Any], list[float]]:
        """Subscribe ``(path, node)`` items on the priority subscription and
        return handles + revised sampling."""
        sub = self._priority_sub
        if sub is None:
            return [], []

        handles = await self._create_items(sub, items, ds_entry, self._requested_priority_sampling_interval_ms)

        # The revised sampling interval is diagnostics only, and a server
        # revises every item the same way — so sample one item once per
        # connection instead of spending a ModifyMonitoredItems round trip on
        # every page switch (or per variable, which made a page open O(N)).
        revised_samples: list[float] = []
        first = None
        if not self._priority_revised_sampling_count:
            first = next((h for h in handles if not isinstance(h, ua.StatusCode)), None)
        if first is not None:
            try:
                result = await sub.modify_monitored_item(
                    first,
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
                    first,
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

    def _schedule_close(self) -> bool:
        """Close the client from a callback that cannot wait for it; True if
        this call started the close. One at a time: a close still pending
        covers a second request, and disconnect() cancels the one it tracks."""
        if self._status_close_task is None or self._status_close_task.done():
            self._status_close_task = asyncio.create_task(self._close_client())
            return True
        return False

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
        self._dropped.set()
        if was_connected and self._status_callback is not None:
            await self._status_callback(self.datasource_name, False)

    async def _reconnect_loop(self) -> None:
        # Route through the same safe-fallback/clamp helper as the other
        # intervals — a blank/non-numeric value must not kill the reconnect
        # task, and 0/negative must not spin the loop without backoff.
        interval = get_config_float(self._config, "reconnect_interval_s", 5.0, minimum=1.0, maximum=300.0)
        # Reset only by a connection that lasts an interval, so a server that
        # keeps dropping us is not reconnected (and resubscribed) twice a second.
        retry_s = RECONNECT_FIRST_RETRY_S
        while not self._shutdown:
            # Cleared before connecting, so a drop at any later point ends the wait below.
            self._dropped.clear()
            if not self._connected:
                try:
                    await self._do_connect()
                except Exception as exc:
                    self._error = _short_probe_error(exc)
                    logger.warning(
                        "OPC-UA connect failed for %s: %s", self.datasource_name, exc
                    )
                    await asyncio.sleep(retry_s)
                    retry_s = min(retry_s * 2, interval)
                    continue
            # The health check's period, cut short by a drop.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._dropped.wait(), interval)
            if self._shutdown:
                return
            if self._connected:
                retry_s = RECONNECT_FIRST_RETRY_S
                await self._check_health()
            else:
                await asyncio.sleep(retry_s)
                retry_s = min(retry_s * 2, interval)

    async def _check_health(self) -> None:
        """Close the client when the connection can no longer be trusted — the
        reconnect loop then connects afresh — and otherwise retry the
        background items a create refused."""
        client = self._client
        if client is None:
            await self._close_client()
            return
        try:
            await client.get_namespace_array()
        except Exception as exc:
            logger.warning(
                "OPC-UA connection lost for %s — retrying (%s)",
                self.datasource_name, _short_probe_error(exc),
            )
            await self._close_client()
            return
        await self._retry_bg()

    async def _reconnect_instead_of_recreating(self) -> None:
        """Stands in for each subscription's ``recreate()``.

        asyncua's stale-subscription watchdog re-creates a subscription the
        server stopped publishing, giving every item a new server handle the
        engine never hears of: a delete of a tracked handle then misses while
        the item lives on. Only a reconnect re-subscribes consistently. The
        watchdog asks again every half second until the close stops it.
        """
        if self._schedule_close():
            logger.warning("A subscription of %s went stale — reconnecting", self.datasource_name)

    async def _do_connect(self) -> None:
        url = self._config.get("server_url", "opc.tcp://localhost:4840")
        username = self._config.get("username", "")
        password = self._config.get("password", "")
        # asyncua's 4 s default fails a 1000-item CreateMonitoredItems on a
        # busy server and then falls back to one request per variable. Its
        # watchdog probes the server every second with that same 1 s as the
        # deadline, so a server busy with our own subscription burst (or a
        # neighbour's) reads as "lost" and the connect→subscribe→lost loop
        # never finishes. The transport still reports a real drop at once;
        # our own reconnect loop probes every reconnect_interval_s.
        request_timeout_s = get_config_float(self._config, "request_timeout_s", 30.0, minimum=1.0, maximum=300.0)
        client = Client(url, timeout=request_timeout_s, watchdog_intervall=request_timeout_s)

        try:
            self._server_certificate = await apply_client_security(client, self._config)
        except ServerCertificateNotTrusted as exc:
            self._server_certificate = exc.certificate
            raise

        if username:
            client.set_user(username)
            client.set_password(password)
        connect_timeout_s = float(self._config.get("connect_timeout_s", 10.0))
        await asyncio.wait_for(client.connect(), timeout=connect_timeout_s)
        self._client = client
        self._connected = True
        self._error = None
        logger.info("OPC-UA connected: %s → %s", self.datasource_name, url)
        telemetry.mark("connected")
        self._wire_types = {}
        await self._discover_operation_limits()
        if self._status_callback is not None:
            await self._status_callback(self.datasource_name, True)
        try:
            await self._setup_subscriptions()
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
        # Keep-alive: send a heartbeat after ~30 s of silence
        params.RequestedMaxKeepAliveCount = max(3, int(30_000 / max(interval_ms, 1)))
        # A reconnect never resumes a subscription, so one left behind by a
        # dropped connection holds its items on the server until its lifetime
        # runs out: four keep-alives (two minutes up to a 10 s interval), past
        # the spec's minimum of three.
        params.RequestedLifetimeCount = 4 * params.RequestedMaxKeepAliveCount
        params.MaxNotificationsPerPublish = 0  # 0 = unlimited
        params.PublishingEnabled = True
        params.Priority = priority
        return params

    async def _create_subscription(self, interval_ms: float, priority: int) -> Any:
        """A subscription with _make_sub_params' counts, even when the server
        revises the publishing interval.

        asyncua answers a revised interval with a ModifySubscription asking
        a keep-alive of 75% of the session timeout (27,000 at 100 ms), and
        the spec then has the server raise the lifetime to three of those:
        hours for a subscription a dropped connection leaves behind. So the
        counts are asked for again, for the revised interval.
        """
        # handler=None → iterator mode, drained by _consume_subscription;
        # queue_maxsize=0 is unbounded, so the initial burst is never dropped.
        sub = await self._client.create_subscription(
            self._make_sub_params(interval_ms, priority), None, queue_maxsize=0,
        )
        sub.recreate = self._reconnect_instead_of_recreating
        revised_ms = sub.parameters.RequestedPublishingInterval  # asyncua copies a revision here
        if revised_ms != interval_ms:
            params = self._make_sub_params(revised_ms, priority)
            await sub.update(ua.ModifySubscriptionParameters(
                SubscriptionId=sub.subscription_id,
                RequestedPublishingInterval=revised_ms,
                RequestedLifetimeCount=params.RequestedLifetimeCount,
                RequestedMaxKeepAliveCount=params.RequestedMaxKeepAliveCount,
                MaxNotificationsPerPublish=params.MaxNotificationsPerPublish,
                Priority=priority,
            ))
        return sub

    async def _setup_subscriptions(self) -> None:
        """Create both subscriptions, re-apply the priority set, then
        subscribe the background set — in that order, so the page open in a
        browser has its values before the whole tree is subscribed, which
        takes tens of seconds on a large PLC."""
        async with self._subscription_transition_lock:
            pending = await self._setup_subscriptions_locked()
        await self._reapply_priority_paths()
        if not pending:
            return
        ds_entry, enabled_items = pending
        if not await self._subscribe_bg(enabled_items, ds_entry):
            return
        # A request that timed out or was refused whole answered each of its
        # items with it: those are tried once more now, and what is refused
        # again waits for the health check.
        await self._retry_bg()
        logger.info(
            "Background subscription complete for %s: %d paths, %d left for the health check",
            self.datasource_name, len(self._bg_path_handles), len(self._bg_retry),
        )

    async def _subscribe_bg(self, items: list[tuple[str, Any, str]], ds_entry: Any) -> bool:
        """Put ``(path, node, node_id)`` *items* on the background subscription
        chunk by chunk, taking the lock per chunk: a page context change
        (set_priority_paths) then waits for one request instead of the whole
        tree — tens of seconds for 100k nodes. False when the subscriptions
        were torn down meanwhile."""
        chunk_size = min(self._operation_limits.monitored_items_budget(), BG_SUBSCRIBE_CHUNK)
        for i in range(0, len(items), chunk_size):
            async with self._subscription_transition_lock:
                if self._background_sub is None or self._client is None:
                    return False
                await self._subscribe_bg_chunk(self._bg_wanted(items[i : i + chunk_size]), ds_entry)
        return True

    def _bg_wanted(self, items: list[tuple[str, Any, str]]) -> list[tuple[str, Any]]:
        """The ``(path, node, node_id)`` *items* still to put on the
        background, judged when they are sent, as ``(path, node)``.

        A path promoted in the meantime must not land on the background as
        well, and one promoted and demoted again is already back on it:
        subscribing it twice orphans a handle. A config save swaps the
        datasource entry, and datasource_sync handles a path it disabled or
        pointed at another node: an older snapshot must not bring it back.
        """
        current = self._datasource_manager.get(self.datasource_name)
        keep = []
        for path, node, node_id in items:
            if path in self._priority_path_handles or path in self._bg_path_handles:
                continue
            entry = current.registry.get(path) if current is not None else None
            if entry and is_subscribable(entry) and entry.get("node_id") == node_id:
                keep.append((path, node))
        return keep

    async def _retry_bg(self) -> None:
        """Retry the paths a background create refused (`_bg_retry`); what is
        refused again waits twice as many health checks as last time, up to 16."""
        ds_entry = self._datasource_manager.get(self.datasource_name)
        if not self._bg_retry or ds_entry is None or self._client is None:
            return
        if self._bg_retry_wait:
            self._bg_retry_wait -= 1
            return
        pending, self._bg_retry = self._bg_retry, {}
        items = [(path, self._client.get_node(node_id), node_id) for path, node_id in pending.items()]
        try:
            await self._subscribe_bg(items, ds_entry)
        except Exception as exc:  # never the reconnect loop's end; a reconnect resubscribes them
            logger.warning("Background retry failed for %s: %s", self.datasource_name, exc)
        self._bg_retry_backoff = min(self._bg_retry_backoff * 2 or 1, 16) if self._bg_retry else 0
        self._bg_retry_wait = self._bg_retry_backoff

    async def _reapply_priority_paths(self) -> None:
        """Re-apply priority paths that were requested before the OPC-UA
        connection was ready: set_priority_paths() is a no-op when not
        connected, so those requests were silently dropped.

        Prefers the full recompute (page-driven + alarm triggers + historized
        variables) so a reconnect doesn't drop alarm/historian subscriptions
        until the next browser navigation; falls back to the page-driven keys
        derivable locally when no recompute callback is wired (e.g. in tests).
        """
        if self._priority_recompute_callback is not None:
            await self._priority_recompute_callback()
            return
        dm = self._datasource_manager
        if dm is None:
            return
        priority_paths = {
            path for ds, path in map(parse_var_key, dm.get_priority_keys())
            if ds == self.datasource_name and path
        }
        if priority_paths:
            await self.set_priority_paths(priority_paths)

    async def _subscribe_bg_chunk(
        self, chunk: list[tuple[str, Any]], ds_entry: Any, action: str = "Subscribe",
    ) -> None:
        """Subscribe ``(path, node)`` *chunk* on the background subscription —
        the one way an item gets there. What it refuses goes to `_bg_retry`
        for the health check, unless the node itself is wrong. A timed-out
        item too, though the server has often created it all the same: the
        untracked duplicate that can leave until the next reconnect is the
        price over a variable with no monitored item."""
        if not chunk:
            return
        # sampling_interval=-1 → server samples at the publishing interval,
        # not the asyncua default of 50 ms.  For 500 variables at 1000 ms
        # this saves the server ~20x unnecessary sampling work.
        handles = await self._create_items(self._background_sub, chunk, ds_entry, -1)
        for path, code in self._record_handles(self._bg_path_handles, chunk, handles, action):
            if code.value not in _NODE_REFUSALS:
                self._bg_retry[path] = ds_entry.registry[path]["node_id"]

    async def _setup_subscriptions_locked(self) -> tuple[Any, list[tuple[str, Any, str]]] | None:
        """Create both subscriptions and return what the background one still
        has to subscribe, as ``(ds_entry, [(path, node, node_id), …])``."""
        dm = self._datasource_manager
        if dm is None or self._client is None:
            return None
        self._sub_handler = _DsSubHandler(self)
        disable_bg = bool(self._config.get("disable_background_sync", False))
        bg_interval = self._background_publish_interval_ms()
        priority_interval = self._priority_publish_interval_ms()
        priority_sampling = self._priority_sampling_interval_ms()
        self._requested_bg_publish_interval_ms = bg_interval
        self._requested_priority_publish_interval_ms = priority_interval
        self._requested_priority_sampling_interval_ms = priority_sampling
        self._requested_priority_ws_batch_ms = self._priority_ws_batch_ms()
        self._deadband_refused = False
        self._priority_revised_sampling_count = 0
        self._priority_revised_sampling_sum_ms = 0.0
        self._priority_revised_sampling_min_ms = None
        self._priority_revised_sampling_max_ms = None
        if not disable_bg:
            self._background_sub = await self._create_subscription(bg_interval, priority=0)
            self._revised_bg_publish_interval_ms = float(
                self._background_sub.parameters.RequestedPublishingInterval,
            )
            self._sub_consumer_tasks.append(
                asyncio.create_task(self._consume_subscription(self._background_sub))
            )
        self._priority_sub = await self._create_subscription(priority_interval, priority=200)
        self._revised_priority_publish_interval_ms = float(
            self._priority_sub.parameters.RequestedPublishingInterval,
        )
        self._sub_consumer_tasks.append(
            asyncio.create_task(self._consume_subscription(self._priority_sub))
        )
        self._node_to_path.clear()
        self._node_to_field.clear()
        self._path_to_node_ids.clear()
        self._bg_path_handles.clear()
        self._priority_path_handles.clear()
        self._current_priority_paths.clear()

        ds_entry = dm.get(self.datasource_name)
        if ds_entry is None:
            return None

        logger.info(
            "Subscriptions set up for %s: bg requested=%sms revised=%sms enabled=%s, "
            "priority requested=%sms revised=%sms sampling requested=%sms",
            self.datasource_name,
            self._requested_bg_publish_interval_ms,
            self._revised_bg_publish_interval_ms,
            not disable_bg,
            self._requested_priority_publish_interval_ms,
            self._revised_priority_publish_interval_ms,
            self._requested_priority_sampling_interval_ms,
        )
        if disable_bg:
            return None

        # Collect all enabled items; _setup_subscriptions sends one
        # CreateMonitoredItems request per chunk instead of one per variable.
        enabled_items: list[tuple[str, Any, str]] = []
        for path, var_entry in ds_entry.registry.items():
            if not is_subscribable(var_entry):
                continue
            node_id = var_entry.get("node_id", "")
            if not node_id:
                continue
            enabled_items.append((path, self._client.get_node(node_id), node_id))
        return ds_entry, enabled_items

    async def _consume_subscription(self, sub: Any) -> None:
        """Drain one subscription's event queue into the datachange handler.

        Ends when the subscription is deleted (asyncua closes the iterator).
        Yields to the loop every so often so a long burst cannot starve the
        WebSocket side; one notification is still one synchronous call.
        """
        handler = self._sub_handler
        if handler is None:
            return
        n = 0
        try:
            async for event in sub:
                if isinstance(event, DataChangeEvent):
                    handler.datachange_notification(event.node, event.value, event.data)
                elif isinstance(event, StatusChangeEvent):
                    await handler.status_change_notification(event.notification)
                n += 1
                if n % CONSUME_YIELD_EVERY == 0:
                    await asyncio.sleep(0)
        except Exception:
            logger.exception("Subscription consumer failed for %s", self.datasource_name)

    async def _teardown_subscriptions(self) -> None:
        async with self._subscription_transition_lock:
            await self._teardown_subscriptions_locked()

    async def _teardown_subscriptions_locked(self) -> None:
        for sub in (self._background_sub, self._priority_sub):
            if sub is not None:
                with contextlib.suppress(Exception):
                    await sub.delete()
        for task in self._sub_consumer_tasks:
            task.cancel()
        self._sub_consumer_tasks = []
        self._background_sub = None
        self._priority_sub = None
        self._sub_handler = None
        self._node_to_path.clear()
        self._node_to_field.clear()
        self._path_to_node_ids.clear()
        self._bg_path_handles.clear()
        self._priority_path_handles.clear()
        self._current_priority_paths.clear()
        self._bg_retry.clear()
        self._bg_retry_wait = self._bg_retry_backoff = 0

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
        variant = ua.Variant(value, variant_type) if variant_type is not None else ua.Variant(value)
        # A bare DataValue: asyncua stamps anything else with a SourceTimestamp,
        # and TwinCAT and S7 servers refuse a timestamped write outright
        # (BadWriteNotSupported) — every write failed.
        await node.write_value(ua.DataValue(variant))

    async def read_current_values(self, paths: set[str], *, raw: bool = False) -> dict[str, Any]:
        """Bulk-read current values for requested paths and folder structs.

        Values come back in their cache form (``normalize_value``); *raw* keeps
        the asyncua values instead, for a caller that writes them back to the
        server — a patched array element write.

        A folder's leaves are also seeded into the cache under their own keys,
        where it holds none yet: a composite something reads but nothing has
        cached is built whole from the leaf caches, and every leaf not cached
        by then would drop out of it. One already cached is left as it is. A
        leaf notification that comes in while the read is in flight is newer
        than the read, so the value read takes it instead, a variable read
        under its own path and a folder's leaf alike: the caller seeds the
        cache with what it returns, and a composite, patched in place from
        then on, would keep the read's older value until that leaf changes
        again.
        """
        if not paths or not self._connected or self._client is None:
            return {}
        dm = self._datasource_manager
        if dm is None:
            return {}
        ds_entry = dm.get(self.datasource_name)
        if ds_entry is None:
            return {}

        # (bound key, leaf path, the leaf's place in the bound path's value,
        # node): a variable is its own value; a folder's leaves fill its
        # composite, every array nested in it a list in position order.
        requests: list[tuple[str, str, tuple[str | int, ...], Node]] = []
        for path in sorted(paths):
            key = build_var_key(self.datasource_name, path)
            folder_entry = ds_entry.folder_registry.get(path)
            leaves = (
                _composite_leaf_steps(folder_entry, ds_entry.folder_registry)
                if folder_entry is not None
                else [((), path)]
            )
            for steps, leaf_path in leaves:
                entry = ds_entry.registry.get(leaf_path)
                if not entry or not is_subscribable(entry):
                    continue
                node_id = entry.get("node_id", "")
                if not node_id:
                    continue
                requests.append((key, leaf_path, steps, self._client.get_node(node_id)))

        if not requests:
            return {}

        # One Read operation per node, chunked to MaxNodesPerRead and the
        # server's message size: a server fails the whole over-limit request,
        # so an over-limit page context would leave every variable on the page
        # without a value.
        nodes_to_read = [node for *_, node in requests]
        values: list[Any] = []
        newer: dict[str, Any] = {}
        if not raw:
            dm.register_value_listener(newer.__setitem__)
        try:
            for span in self._operation_limits.read_chunks([n.nodeid for n in nodes_to_read]):
                values.extend(await self._client.read_values(nodes_to_read[span]))
        finally:
            dm.unregister_value_listener(newer.__setitem__)
        result: dict[str, Any] = {}
        leaf_values: dict[str, Any] = {}
        # A struct's leaves come one after another (_composite_leaf_steps): each
        # goes into the container the one before it went into, rather than a
        # walk from the root — 59 ms of loop for a 70,000-leaf folder.
        last_parent: tuple[str, tuple[str | int, ...]] | None = None
        parent: dict | list = result
        for (key, leaf_path, steps, _node), value in zip(requests, values, strict=False):
            coerced = value if raw else normalize_value(value)
            if not raw:
                leaf_key = build_var_key(self.datasource_name, leaf_path)
                coerced = newer.get(leaf_key, coerced)
                if steps:
                    leaf_values[leaf_key] = coerced
            here = (key, steps[:-1])
            if here == last_parent and isinstance(parent, dict):
                parent[steps[-1]] = coerced
            else:
                parent = _place(result, (key, *steps), coerced)
                last_parent = here
        if leaf_values:
            dm.seed_cached_values(leaf_values, overwrite=False)

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
        """Subscribe one variable a config save enabled or re-pointed on the
        background subscription."""
        async with self._subscription_transition_lock:
            if not self._connected or self._background_sub is None:
                return
            if path in self._bg_path_handles:
                # Already tracked (e.g. a reconnect's full resync racing an
                # independent enable-variable call) — reuse it instead of
                # creating a duplicate monitored item and leaking the existing
                # handle, which would double-deliver every datachange.
                return
            node_id = (ds_entry.registry.get(path) or {}).get("node_id", "")
            if not node_id:
                return
            try:
                await self._subscribe_bg_chunk([(path, self._client.get_node(node_id))], ds_entry)
            except ConnectionError:
                return  # the session is gone: the reconnect subscribes it
            except Exception as exc:
                logger.warning(
                    "Failed to subscribe %s/%s: %s", self.datasource_name, path, exc,
                )

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
            # A lost session ends the transition where it is — one request per
            # path would only fail thousands of times more; the reconnect
            # resubscribes everything.
            with contextlib.suppress(ConnectionError):
                await self._set_priority_paths_locked(paths)

    async def _set_priority_paths_locked(self, paths: set[str]) -> None:
        """Promote paths to priority subscription, demote the rest.

        Uses bulk OPC-UA calls (one DeleteMonitoredItems + one CreateMonitoredItems
        per direction, split only by the server's OperationLimits) instead of one
        call per variable, so a page switch with N active variables costs 4
        round-trips for any N one request can carry.
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

        # Handle tracking is the authoritative actual state. Failed operations
        # therefore remain a delta and are retried by the next recompute.
        actual_priority_paths = set(self._priority_path_handles)
        to_promote = desired_leaf_paths - actual_priority_paths
        to_demote = actual_priority_paths - desired_leaf_paths

        # ── Batch promote: bg → priority ──────────────────────────────────────
        # Enabled variables only: the keys come from any client's set_context, a
        # folder key expands to every leaf under it, and a promoted value is
        # broadcast to every client. Stale vars (present_on_server=False) are
        # skipped too: subscribing to them only generates "Subscribe rejected"
        # warnings.
        promote_items: list[tuple[str, Any]] = []   # (path, node)
        for path in to_promote:
            entry = ds_entry.registry.get(path)
            if not entry or not is_subscribable(entry):
                continue
            node_id = entry.get("node_id", "")
            if not node_id:
                continue
            promote_items.append((path, self._client.get_node(node_id)))

        if promote_items:
            # 1. Bulk-unsubscribe from background
            unsubscribed = await self._delete_tracked(
                self._background_sub, self._bg_path_handles, [path for path, _ in promote_items],
            )
            cleared = [item for item in promote_items if item[0] in unsubscribed]

            # 2. Bulk-subscribe to priority — only the paths whose background
            # item is gone, so a node is never live on both subscriptions at
            # once. The rest simply stay on the background sub (no data loss)
            # and the next recompute retries them.
            rejected: list[tuple[str, ua.StatusCode]] = []
            if cleared:
                # Routed here too: with disable_background_sync=True nothing
                # else routes a priority-sub value.
                handles, revised_samples = await self._subscribe_priority_nodes_with_revised_sampling(
                    cleared, ds_entry,
                )
                self._record_priority_revised_sampling(revised_samples)
                rejected = self._record_handles(self._priority_path_handles, cleared, handles, "Promote")

            # A successful bg-unsubscribe followed by a refused or timed-out
            # priority creation must not leave an enabled variable with no
            # monitored item: the user may have moved on before the next
            # recompute, which then never selects it again. Those paths go
            # back to the background in bulk — a refused request refuses every
            # item of its chunk, up to a thousand, too many for one request
            # each under the lock. A timed-out one may live on the priority
            # subscription all the same, untracked: the price, as for any
            # timed-out create, over a variable with no values.
            if self._background_sub is not None:
                rejected_paths = {path for path, _ in rejected}
                await self._subscribe_bg_chunk(
                    [item for item in cleared if item[0] in rejected_paths], ds_entry, "Promote-fallback",
                )

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
            # 1. Bulk-unsubscribe from priority. One whose delete failed stays
            # priority and skips step 2.
            cleared_paths = await self._delete_tracked(
                self._priority_sub, self._priority_path_handles,
                [p for p, _ in demote_items] + demote_paths_no_bg,
            )
            demote_items = [(path, node) for path, node in demote_items if path in cleared_paths]

            # 2. Bulk-resubscribe to background — only after the priority
            # side was actually cleared. No recompute selects a demoted path
            # again, so what the background refuses waits for the health
            # check — not now: the subscription that just refused the request
            # would refuse it again.
            await self._subscribe_bg_chunk(demote_items, ds_entry, "Demote-resub")

            # Disabled/dropped paths must remove stale routing so callback map
            # stays consistent — only once their priority unsubscribe actually
            # succeeded (otherwise the subscription is still live).
            for path in cleared_paths.intersection(demote_paths_no_bg):
                for nid in self._path_to_node_ids.pop(path, set()):
                    self._node_to_path.pop(nid, None)
                    self._node_to_field.pop(nid, None)

        # Actual state, deliberately distinct from `_requested_priority_paths`.
        self._current_priority_paths = set(self._priority_path_handles)
