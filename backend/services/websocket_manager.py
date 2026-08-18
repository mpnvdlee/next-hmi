"""
WebSocket connection hub and broadcast manager.

Responsibilities:
  - Accept and track browser WebSocket connections.
  - Receive value updates from datasource_manager via enqueue() and batch them
    into 50 ms windows before broadcasting to all clients.
  - Send a full var_snapshot to every newly connected client.
  - Route incoming client messages:
            set_context    -> promote variables visible in active runtime context,
                               then reply with context_ready once every requested
                               variable has been sent (from cache and/or a fresh
                               OPC-UA read)
            write_field    -> write a value to the PLC via opcua_pool
            login          -> authenticate a scoped session
            logout         -> revert a scoped session to guest
"""

import asyncio
import contextlib
import itertools
import json
import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

from core import audit
from core.number_utils import get_config_float
from core.storage import active_config_dir, active_pages_dir, read_json
from fastapi import WebSocket
from models.datasource import build_var_key, parse_var_key
from models.websocket import (
    LoginMessage,
    LogoutMessage,
    RequestIdentityMessage,
    SetContextMessage,
    WriteFieldMessage,
    build_auth_error,
    build_user_identity,
    build_write_error,
    build_write_response,
)

from services import write_service

logger = logging.getLogger(__name__)
_MAX_DIALOG_IDS = 2000


def _config_path():
    return active_config_dir() / "config.json"

# --- OPC-UA write coercion constants (built once at import time) --------------
_MAX_PAGE_IDS = 2000
_MAX_PRIORITY_KEYS = 5000
_MAX_WS_MESSAGE_BYTES = 64 * 1024
# Matches "[N]" suffix used in array-element paths (e.g. "MyArray[2]")
_ARRAY_INDEX_RE = re.compile(r"\[(\d+)\]$")

# Documented reason codes echoed back to clients in auth_error / write_error
# messages. Frontend action-result handlers $switch on these strings, so they
# are a stable contract — do not rename without a coordinated frontend change.
REASON_INVALID_CREDENTIALS = "invalid_credentials"
REASON_PERMISSION_DENIED = "permission_denied"
REASON_BAD_REQUEST = "bad_request"


@dataclass
class ConfigChangedEvent:
    """Payload for ``broadcast_config_changed``.

    ``source`` is ``"mcp"`` or ``"rest"``. ``agent_label`` is included on the
    wire only when ``source == "mcp"``.
    """

    artifact_type: str
    artifact_ids: list[str]
    source: str
    summary: str = ""
    diff: Any = None
    agent_label: str | None = None


class WebSocketManager:
    def __init__(self) -> None:
        # Active connections keyed by client_id - O(1) add/remove
        self._connections: dict[str, WebSocket] = {}
        # Pending value updates accumulated between broadcast ticks
        self._pending_updates: dict[str, Any] = {}
        self._pending_priority_updates: dict[str, Any] = {}
        self._next_flush_at: float | None = None
        self._next_priority_flush_at: float | None = None
        self._pending_lock = threading.Lock()
        # Injected at startup by main.py
        self._datasource_manager = None
        self._opcua_pool = None
        self._alarm_manager = None
        self._historian_manager = None
        self._recipe_manager = None
        # Per-client identity store: client_id -> { scope -> {username, groups} }
        self._client_users: dict[str, dict[str, dict[str, Any]]] = {}
        # Per-client connection timestamps: client_id -> ISO string
        self._client_connected_at: dict[str, str] = {}
        # Cached priority batch delay per datasource name (invalidated on config change)
        self._priority_delay_cache: dict[str, float] = {}
        # Coalesced background priority recompute (see schedule_priority_recompute)
        self._priority_recompute_task: asyncio.Task | None = None
        self._priority_recompute_rerun = False
        self._deferred_tasks: set[asyncio.Task] = set()

    # -- Dependency injection -------------------------------------------------

    def set_datasource_manager(self, dm) -> None:
        self._datasource_manager = dm

    def set_opcua_pool(self, pool) -> None:
        self._opcua_pool = pool

    def set_alarm_manager(self, am) -> None:
        self._alarm_manager = am

    def set_historian_manager(self, hm) -> None:
        self._historian_manager = hm

    def set_recipe_manager(self, rm) -> None:
        self._recipe_manager = rm

    async def broadcast_alarm_update(self, payload: dict) -> None:
        """Broadcast an alarm state update to all connected clients."""
        if self._connections:
            await self._broadcast(payload)

    async def broadcast_recipe_update(self, payload: dict) -> None:
        """Broadcast a recipe config/state update to all connected clients."""
        if self._connections:
            await self._broadcast(payload)

    def schedule_priority_recompute(self) -> None:
        """Fire-and-forget coalesced recompute_priority_subscriptions() run.

        Must be called from the event-loop thread (sync, cross-thread callers
        such as alarm_manager's config writers bridge in via
        call_soon_threadsafe first). If a recompute is already running, this
        only flags a trailing rerun instead of starting a second task, so a
        burst of concurrent saves converges on one recompute reading the
        latest live state rather than stacking one task per save. Failures
        are logged, never raised — this must never affect the caller.
        """
        if self._priority_recompute_task is not None and not self._priority_recompute_task.done():
            self._priority_recompute_rerun = True
            return
        self._priority_recompute_rerun = False
        self._priority_recompute_task = asyncio.create_task(self._run_priority_recompute())

    async def _run_priority_recompute(self) -> None:
        while True:
            try:
                await self.recompute_priority_subscriptions()
            except Exception:
                logger.exception("Background alarm priority recompute failed")
            if not self._priority_recompute_rerun:
                return
            self._priority_recompute_rerun = False

    def invalidate_priority_delay_cache(self, ds_name: str | None = None) -> None:
        """Clear cached priority batch delay. Call after datasource config changes."""
        if ds_name is not None:
            self._priority_delay_cache.pop(ds_name, None)
        else:
            self._priority_delay_cache.clear()

    # -- Enqueue (called from datasource_manager, possibly from another thread) --

    def enqueue(self, key: str, value: Any, priority: bool = False) -> None:
        """Thread-safe: add composite-key update to the next broadcast batch."""
        now = time.monotonic()
        with self._pending_lock:
            if priority:
                self._pending_priority_updates[key] = value
                delay_s = self._priority_batch_delay_ms_for_key(key) / 1000.0
                deadline = now + delay_s
                if self._next_priority_flush_at is None or deadline < self._next_priority_flush_at:
                    self._next_priority_flush_at = deadline
                return
            self._pending_updates[key] = value
            if self._next_flush_at is None:
                self._next_flush_at = now + 0.05

    # -- Broadcast loop (runs as asyncio background task) --------------------

    async def broadcast_loop(self) -> None:
        """Flush priority and normal updates using separate batch windows."""
        while True:
            await asyncio.sleep(self._sleep_until_next_flush())
            now = time.monotonic()
            priority_pending: dict[str, Any] | None = None
            pending: dict[str, Any] | None = None
            with self._pending_lock:
                if (
                    self._pending_priority_updates
                    and self._next_priority_flush_at is not None
                    and now >= self._next_priority_flush_at
                ):
                    priority_pending = self._pending_priority_updates
                    self._pending_priority_updates = {}
                    self._next_priority_flush_at = None
                if (
                    self._pending_updates
                    and self._next_flush_at is not None
                    and now >= self._next_flush_at
                ):
                    pending = self._pending_updates
                    self._pending_updates = {}
                    self._next_flush_at = None
            if self._connections and priority_pending:
                await self._broadcast({"type": "var_update", "values": priority_pending})
            if self._connections and pending:
                await self._broadcast({"type": "var_update", "values": pending})

    def _sleep_until_next_flush(self) -> float:
        with self._pending_lock:
            deadlines = [d for d in (self._next_priority_flush_at, self._next_flush_at) if d is not None]
        if not deadlines:
            return 0.05
        delay = min(deadlines) - time.monotonic()
        if delay <= 0:
            return 0.001  # floor to prevent busy-spinning
        return min(delay, 0.05)

    def _priority_batch_delay_ms_for_key(self, key: str) -> float:
        if self._datasource_manager is None:
            return 10.0
        ds_name, _path = parse_var_key(key)
        cached = self._priority_delay_cache.get(ds_name)
        if cached is not None:
            return cached
        entry = self._datasource_manager.get(ds_name)
        settings = entry.config.get("settings", {}) if entry is not None else {}
        value = get_config_float(settings, "priority_ws_batch_ms", 10.0, minimum=0.0, maximum=1000.0)
        self._priority_delay_cache[ds_name] = value
        return value

    async def _broadcast(self, payload: dict) -> None:
        message = json.dumps(payload)
        if not self._connections:
            return
        # Snapshot the values (not a copy of the dict) so removals during gather are safe
        clients = list(self._connections.items())
        results = await asyncio.gather(
            *[asyncio.wait_for(ws.send_text(message), timeout=5.0) for _, ws in clients],
            return_exceptions=True,
        )
        for (client_id, _), result in zip(clients, results, strict=False):
            if isinstance(result, Exception):
                self._connections.pop(client_id, None)

    async def broadcast_var_removed(self, var_ids: list[str]) -> None:
        """Notify all connected clients that these variable IDs are no longer available."""
        if var_ids and self._connections:
            await self._broadcast({"type": "var_removed", "ids": var_ids})

    async def broadcast_var_values(self, values: dict[str, Any]) -> None:
        """Broadcast an explicit cache refresh after a datasource edit."""
        if values and self._connections:
            await self._broadcast({"type": "var_update", "values": values})

    async def broadcast_var_metadata(self) -> None:
        """Broadcast the complete authoritative variable metadata snapshot.

        Datasource edits can add, remove, or reshape bindings while clients stay
        connected. Sending a replacement snapshot keeps picker/runtime validation
        in sync without requiring a WebSocket reconnect. An empty mapping is
        significant and must also be sent.
        """
        if self._datasource_manager is None or not self._connections:
            return
        await self._broadcast(
            {"type": "var_metadata", "meta": self._datasource_manager.variable_metadata()}
        )

    async def broadcast_opcua_status(self, datasource_name: str, connected: bool) -> None:
        """Notify all connected clients of an OPC-UA connection state change."""
        await self._broadcast(
            {
                "type": "opcua_status",
                "datasource": datasource_name,
                "connected": connected,
            }
        )

    async def broadcast_restarting(self, reason: str = "manual") -> None:
        """Tell every connected client that the backend is about to exit.

        Lets the SPA show a "reconnecting…" banner immediately instead of
        waiting for the WS to error out. Best-effort: a send failure here
        never blocks the restart itself.
        """
        if not self._connections:
            return
        with contextlib.suppress(Exception):
            await self._broadcast({"type": "restarting", "reason": reason})

    async def broadcast_widget_updated(self, payload: dict[str, Any]) -> None:
        """Notify all connected clients that a custom-widget recompile finished.

        The payload comes straight from the widget_compiler watcher
        (``type``, canonical ``key``, display ``name``, ``ts``, ``schema_ok``).
        The frontend uses it to invalidate its widget module cache.
        """
        if self._connections:
            await self._broadcast(payload)

    async def broadcast_config_changed(self, event: ConfigChangedEvent) -> None:
        """Broadcast a config-changed event to every connected browser tab.

        ``event.source`` is ``"mcp"`` or ``"rest"``. For ``"rest"`` writes,
        ``agent_label`` is omitted from the payload regardless of value.

        ``event.diff`` may be a JSON Patch (list of ops) or the truncation
        sentinel ``{ truncated, reason, op_count }`` from ``mcp_server.diff``.
        """
        payload: dict[str, Any] = {
            "type": "config_changed",
            "artifact_type": event.artifact_type,
            "artifact_ids": list(event.artifact_ids),
            "source": event.source,
            "summary": event.summary,
        }
        if event.source == "mcp" and event.agent_label:
            payload["agent_label"] = event.agent_label
        if event.diff is not None:
            payload["diff"] = event.diff
        await self._broadcast(payload)

    # -- Connection lifecycle -------------------------------------------------

    async def connect(self, websocket: WebSocket) -> str:
        """Accept connection, send snapshot, register client. Returns client_id."""
        await websocket.accept()
        client_id = str(uuid.uuid4())
        self._connections[client_id] = websocket
        self._client_users[client_id] = {}
        self._client_connected_at[client_id] = datetime.now(UTC).isoformat()
        try:
            # Send an empty snapshot immediately so the client marks snapshotReceived=true
            # and the UI becomes interactive, then stream the actual values in chunks.
            await websocket.send_text(json.dumps({"type": "var_snapshot", "values": {}}))
            # Metadata is an authoritative replacement snapshot. Send it even
            # when no datasource manager/variables exist so a reconnect cannot
            # retain metadata from the previous backend generation.
            meta = (
                self._datasource_manager.variable_metadata()
                if self._datasource_manager is not None
                else {}
            )
            await websocket.send_text(json.dumps({"type": "var_metadata", "meta": meta}))
            if self._datasource_manager is not None:
                snapshot = self._datasource_manager.snapshot()
                it = iter(snapshot.items())
                while True:
                    chunk = dict(itertools.islice(it, 500))
                    if not chunk:
                        break
                    await websocket.send_text(json.dumps({"type": "var_update", "values": chunk}))
                    await asyncio.sleep(0)  # yield event loop between chunks
            # Replay current OPC-UA connection status for every datasource so that
            # clients which connect after the PLC is already up receive the correct
            # state instead of staying stuck at opcuaConnected=false.
            if self._opcua_pool is not None:
                for ds_name, connected in self._opcua_pool.connection_status().items():
                    await websocket.send_text(
                        json.dumps({
                            "type": "opcua_status",
                            "datasource": ds_name,
                            "connected": connected,
                        })
                    )
            # Send current alarm state so the client has the full picture.
            if self._alarm_manager is not None:
                alarm_payload = self._alarm_manager.build_snapshot_payload()
                await websocket.send_text(json.dumps(alarm_payload))
            # Send current recipe config + loaded state.
            if self._recipe_manager is not None:
                recipe_payload = self._recipe_manager.build_snapshot_payload()
                await websocket.send_text(json.dumps(recipe_payload))
        except Exception:
            await self.disconnect(client_id)
            raise
        logger.info("WS client connected: %s (total: %d)", client_id[:8], len(self._connections))
        return client_id

    async def disconnect(self, client_id: str) -> None:
        """Remove client and demote any variables that were only priority for this client."""
        self._connections.pop(client_id, None)
        self._client_users.pop(client_id, None)
        self._client_connected_at.pop(client_id, None)
        if self._datasource_manager is not None:
            self._datasource_manager.clear_client(client_id)
            # Re-apply priority so demoted paths are moved back to background
            await self._apply_priority_keys(client_id, set())
        logger.info(
            "WS client disconnected: %s (total: %d)",
            client_id[:8],
            len(self._connections),
        )

    # -- Runtime sessions (for diagnostics) ----------------------------------

    def get_runtime_sessions(self) -> list[dict[str, Any]]:
        """Return a list of active runtime scope entries for diagnostics."""
        result = []
        for client_id, scopes in self._client_users.items():
            connected_at = self._client_connected_at.get(client_id, "")
            for scope, identity in scopes.items():
                if scope.startswith("runtime:"):
                    result.append(
                        {
                            "clientId": client_id[:8],
                            "scope": scope,
                            "username": identity.get("username", "guest"),
                            "groups": identity.get("groups", ["guest"]),
                            "connectedAt": connected_at,
                        }
                    )
        return result

    @staticmethod
    def _build_group_labels(doc: dict, group_ids: list[str]) -> dict[str, str]:
        """Return a mapping of group_id -> label for the given group IDs."""
        all_groups = doc.get("groups", []) if isinstance(doc, dict) else []
        label_map = {
            g["id"]: g.get("label", g["id"])
            for g in all_groups
            if isinstance(g, dict) and "id" in g
        }
        return {gid: label_map.get(gid, gid) for gid in group_ids}

    # -- Incoming message handling -------------------------------------------

    async def handle_message(self, client_id: str, raw: str) -> None:
        if len(raw.encode("utf-8")) > _MAX_WS_MESSAGE_BYTES:
            logger.warning("WS message too large from %s", client_id[:8])
            return

        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("Invalid JSON from WS client %s", client_id[:8])
            return

        msg_type = msg.get("type")
        if msg_type == "set_context":
            await self._handle_set_context(client_id, cast(SetContextMessage, msg))
        elif msg_type == "write_field":
            await self._handle_write_field(client_id, cast(WriteFieldMessage, msg))
        elif msg_type == "recipe_load":
            await self._handle_recipe_load(client_id, msg)
        elif msg_type == "recipe_save":
            await self._handle_recipe_save(client_id, msg)
        elif msg_type == "login":
            await self._handle_login(client_id, cast(LoginMessage, msg))
        elif msg_type == "logout":
            await self._handle_logout(client_id, cast(LogoutMessage, msg))
        elif msg_type == "request_identity":
            await self._handle_request_identity(client_id, cast(RequestIdentityMessage, msg))
        else:
            logger.debug("Unknown WS message type '%s' from %s", msg_type, client_id[:8])

    async def _apply_priority_keys(self, client_id: str, keys: set[str]) -> None:
        """Store keys for this client, recompute union, update OPC-UA subscriptions."""
        if self._datasource_manager is None or self._opcua_pool is None:
            return
        self._datasource_manager.set_client_page(client_id, keys)
        await self.recompute_priority_subscriptions()

    async def recompute_priority_subscriptions(self) -> None:
        """Recompute the per-datasource fast subscription set and push it to the pool.

        The priority set is the union of: page-driven keys across all clients,
        alarm trigger paths, and historized variables. Called on every client
        context change (via _apply_priority_keys) and whenever alarm/historian
        config changes whose writers call this method, so new entries are
        subscribed immediately rather than only on the next page navigation.
        """
        if self._datasource_manager is None or self._opcua_pool is None:
            return
        priority_keys = self._datasource_manager.get_priority_keys()
        ds_keys = _group_priority_paths_by_datasource(priority_keys)

        # Merge alarm trigger paths so they are always on the fast subscription
        if self._alarm_manager is not None:
            for ds_name, paths in self._alarm_manager.get_trigger_paths_by_datasource().items():
                if paths:
                    ds_keys.setdefault(ds_name, set()).update(paths)

        # Merge historized variables so enabling historization actually captures
        # values even when no page binds the variable and no alarm references it
        if self._historian_manager is not None:
            for ds_name, paths in self._historian_manager.get_historized_paths_by_datasource().items():
                if paths:
                    ds_keys.setdefault(ds_name, set()).update(paths)

        # Merge recipe parameter variables so live values stay fresh for Upload
        # and the $recipe parametersChanged comparison
        if self._recipe_manager is not None:
            for ds_name, paths in self._recipe_manager.get_parameter_paths_by_datasource().items():
                if paths:
                    ds_keys.setdefault(ds_name, set()).update(paths)

        # Also call set_priority_paths for datasources with no priority keys
        # so they fully demote any previously promoted paths
        ds_names = []
        tasks = []
        for ds_name in self._datasource_manager.datasources:
            engine = self._opcua_pool.get(ds_name)
            if engine is not None:
                ds_names.append(ds_name)
                tasks.append(engine.set_priority_paths(ds_keys.get(ds_name, set())))
        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for ds_name, result in zip(ds_names, results, strict=False):
                if isinstance(result, Exception):
                    logger.warning(
                        "set_priority_paths failed for datasource '%s': %s", ds_name, result,
                    )

    async def _handle_set_context(self, client_id: str, msg: SetContextMessage) -> None:
        """Set active runtime context; backend computes priority keys from config."""
        if self._datasource_manager is None or self._opcua_pool is None:
            return
        current_page_ids = _resolve_current_page_ids(msg)
        open_dialog_ids = _coerce_non_empty_str_list(msg.get("openDialogIds"), _MAX_DIALOG_IDS)
        explicit_priority_keys = _extract_explicit_priority_keys(msg)
        composite_keys = _resolve_context_composite_keys(
            current_page_ids=current_page_ids,
            open_dialog_ids=open_dialog_ids,
            explicit_priority_keys=explicit_priority_keys,
        )
        sent_keys = await self._send_cached_values(client_id, composite_keys)
        await self._apply_priority_keys(client_id, composite_keys)
        missing_keys = composite_keys - sent_keys
        if missing_keys:
            task = asyncio.create_task(
                self._send_uncached_values_then_ready(client_id, missing_keys, current_page_ids)
            )
            self._deferred_tasks.add(task)
            task.add_done_callback(self._deferred_tasks.discard)
        else:
            await self._send_context_ready(client_id, current_page_ids)

    async def _handle_write_field(self, client_id: str, msg: WriteFieldMessage) -> None:
        """Write a value to the PLC via the appropriate OPC-UA pool engine,
        or directly update a static datasource variable.

        When the client supplied a `requestId`, every termination path emits a
        `write_response` (success) or `write_error` (failure with reason) so the
        client-side dispatcher can fire onSuccess / onFailed handlers. Requests
        without `requestId` are still processed but produce no response — keeps
        backwards compatibility with older clients.
        """
        request_id = msg.get("requestId")

        if self._datasource_manager is None:
            await self._send_write_result(
                client_id, request_id, "", "", write_service.REASON_OPCUA_UNREACHABLE
            )
            return

        write_request = write_service.parse_write_request(msg)
        if write_request is None:
            logger.warning("write_field: missing datasource/path/value in %s", msg)
            ds_name = str(msg.get("datasource", ""))
            path = str(msg.get("path", ""))
            await self._send_write_result(client_id, request_id, ds_name, path, REASON_BAD_REQUEST)
            return

        ds_name, path, field, value = write_request
        registry_path = _ARRAY_INDEX_RE.sub("", path)

        entry_data = self._datasource_manager.get_entry(ds_name, registry_path)
        if entry_data is None:
            logger.warning("write_field: unknown %s:%s", ds_name, path)
            await self._send_write_result(
                client_id, request_id, ds_name, path, write_service.REASON_BAD_PATH
            )
            return

        scope = msg.get("scope", "")
        if not self._check_write_permitted(client_id, scope, entry_data):
            logger.warning("write_field denied for %s:%s (scope=%s)", ds_name, path, scope)
            await self._send_write_result(client_id, request_id, ds_name, path, REASON_PERMISSION_DENIED)
            return

        outcome = await write_service.write_value(
            self._datasource_manager, self._opcua_pool, ds_name, path, value, field=field,
        )
        if not outcome.ok:
            logger.warning("write_field %s:%s.%s failed: %s", ds_name, path, field, outcome.reason)
        else:
            # Moving a setpoint is the most consequential thing an operator does
            # here, and it is one of the few actions with an actor the server
            # established itself — the identity `_check_write_permitted` just
            # decided against, five lines up. Emitted here rather than in
            # write_service because write_service is also the recipe-download
            # path, which has no operator behind it.
            #
            # Only writes that landed. A rejected or failed write moved nothing,
            # and an unauthenticated caller must not be able to grow an
            # append-only, never-truncated file by spamming rejects. Denials
            # stay in the log above.
            await audit.emit_async(
                audit.AuditEvent(
                    actor=self._session_actor(client_id, scope),
                    actor_source=audit.ACTOR_SESSION,
                    action="variable.write",
                    subject=build_var_key(ds_name, path),
                    detail={"value": value, "field": field} if field else {"value": value},
                )
            )
        await self._send_write_result(client_id, request_id, ds_name, path, outcome.reason)

    async def _handle_recipe_load(self, client_id: str, msg: dict) -> None:
        """Download a saved dataset's values to their variables.

        Replies with `recipe_response` (carrying the DownloadResult) or
        `recipe_error` when the client supplied a `requestId`, so button-bound
        `recipeLoad` actions can resolve `$result` / onSuccess / onFailed.
        """
        request_id = msg.get("requestId")
        if self._recipe_manager is None:
            await self._send_recipe_result(client_id, request_id, None, "recipes_unavailable")
            return
        dataset_id = msg.get("datasetId")
        if not isinstance(dataset_id, str) or not dataset_id:
            await self._send_recipe_result(client_id, request_id, None, REASON_BAD_REQUEST)
            return
        verify = bool(msg.get("verify", False))
        scope = msg.get("scope", "")

        def _permitted(ds_name: str, base_path: str) -> bool:
            dm = self._datasource_manager
            entry_data = dm.get_entry(ds_name, base_path) if dm is not None else None
            return self._check_write_permitted(client_id, scope, entry_data)

        try:
            result = await self._recipe_manager.download(
                dataset_id, verify=verify, permission_check=_permitted,
            )
        except Exception:
            logger.exception("recipe_load failed for dataset %s", dataset_id)
            await self._send_recipe_result(client_id, request_id, None, "download_failed")
            return
        if result is None:
            await self._send_recipe_result(client_id, request_id, None, "not_found")
            return
        await self._send_recipe_result(
            client_id, request_id, result.model_dump(by_alias=True), None,
        )

    async def _handle_recipe_save(self, client_id: str, msg: dict) -> None:
        """Upload live values into a dataset (overwrite in place).

        An omitted `datasetId` targets the currently-loaded dataset when exactly
        one is loaded across all types.
        """
        request_id = msg.get("requestId")
        if self._recipe_manager is None:
            await self._send_recipe_result(client_id, request_id, None, "recipes_unavailable")
            return
        dataset_id = msg.get("datasetId")
        if not isinstance(dataset_id, str) or not dataset_id:
            loaded = self._recipe_manager.get_state()
            if len(loaded) == 1:
                dataset_id = next(iter(loaded.values())).dataset_id
            else:
                # No datasetId given and no single loaded dataset to fall back
                # on — tell the client which case so it can prompt for a target.
                reason = "ambiguous_target" if loaded else "no_loaded_dataset"
                await self._send_recipe_result(client_id, request_id, None, reason)
                return
        scope = msg.get("scope", "")
        identity = self._client_users.get(client_id, {}).get(scope) if scope else None
        username = identity.get("username", "") if isinstance(identity, dict) else ""
        try:
            config = await self._recipe_manager.upload_into(dataset_id, username=username)
        except Exception:
            logger.exception("recipe_save failed for dataset %s", dataset_id)
            await self._send_recipe_result(client_id, request_id, None, "upload_failed")
            return
        if config is None:
            await self._send_recipe_result(client_id, request_id, None, "not_found")
            return
        await self._send_recipe_result(
            client_id, request_id, {"datasetId": dataset_id}, None,
        )

    async def _send_recipe_result(
        self,
        client_id: str,
        request_id: str | None,
        result: dict[str, Any] | None,
        reason: str | None,
    ) -> None:
        """Emit recipe_response (reason=None) or recipe_error. No-op without requestId."""
        if not request_id:
            return
        if reason:
            payload: dict[str, Any] = {"type": "recipe_error", "requestId": request_id, "reason": reason}
        else:
            payload = {"type": "recipe_response", "requestId": request_id, "result": result}
        await self._safe_send_json(client_id, payload)

    async def _safe_send_json(self, client_id: str, payload: dict[str, Any]) -> None:
        """Send a JSON payload to a client, swallowing connection errors.

        Used for best-effort messages where a disappeared client must not raise
        — write responses, auth errors, identity broadcasts.
        """
        ws = self._connections.get(client_id)
        if ws is None:
            return
        with contextlib.suppress(Exception):
            await ws.send_text(json.dumps(payload))

    async def _send_write_result(
        self,
        client_id: str,
        request_id: str | None,
        ds_name: str,
        path: str,
        reason: str | None = None,
    ) -> None:
        """Emit write_response (reason=None) or write_error (reason set).

        Skips emission entirely when the client did not supply a requestId —
        preserves the fire-and-forget contract for older clients.
        """
        if not request_id:
            return
        payload = (
            build_write_error(request_id, ds_name, path, reason)
            if reason
            else build_write_response(request_id, ds_name, path)
        )
        await self._safe_send_json(client_id, payload)

    def _check_write_permitted(self, client_id: str, scope: str, entry_data: Any) -> bool:
        """Return True if the client's identity for the given scope is allowed to write."""
        identity = self._client_users.get(client_id, {}).get(scope) if scope else None
        return write_service.write_permitted(identity, entry_data)

    def _session_actor(self, client_id: str, scope: str) -> str:
        """Name this connection authenticated as for *scope*, never one it sent.

        Read from the same store `_check_write_permitted` uses, so the audit
        record names whoever the permission decision was actually made against.
        A connection that never logged in falls back to "guest" — which
        `write_service.write_permitted` already treats it as. That is still a
        fact the server established (this socket presented no credentials), not
        a claim, so it is honest to tag it `ACTOR_SESSION`.
        """
        identity = self._client_users.get(client_id, {}).get(scope) if scope else None
        username = identity.get("username") if isinstance(identity, dict) else None
        return username if isinstance(username, str) and username else "guest"

    async def _apply_and_respond_identity(
        self,
        client_id: str,
        scope: str,
        identity: dict,
        doc: dict,
        *,
        request_id: str | None = None,
    ) -> None:
        """Store scoped identity and send user_identity message to the client.

        `request_id` is echoed only when supplied — i.e. when this call
        originates from a login/logout request. Auto-login via
        request_identity passes no request_id so its user_identity message
        cannot be mistaken for a login response by the client dispatcher.
        """
        self._client_users.setdefault(client_id, {})[scope] = identity
        if client_id not in self._connections:
            return
        group_labels = self._build_group_labels(doc, identity["groups"])
        await self._safe_send_json(
            client_id,
            build_user_identity(
                scope,
                identity["username"],
                identity["groups"],
                group_labels,
                request_id=request_id,
            ),
        )

    async def _handle_login(self, client_id: str, msg: LoginMessage) -> None:
        """Validate credentials and update the scoped identity."""
        scope = msg.get("scope", "")
        if not isinstance(scope, str) or not scope:
            return

        username = msg.get("username", "")
        password = msg.get("password", "")
        request_id = msg.get("requestId")

        from services import users_manager
        if client_id not in self._connections:
            return
        authenticated = await users_manager.authenticate(username, password)
        if authenticated is None:
            await self._safe_send_json(
                client_id,
                build_auth_error(scope, REASON_INVALID_CREDENTIALS, request_id=request_id),
            )
            return

        identity, doc = authenticated
        await self._apply_and_respond_identity(client_id, scope, identity, doc, request_id=request_id)
        # The one login path with credentials behind it. Auto-login via
        # request_identity is deliberately not audited — every page open would
        # otherwise append a guest record to an fsync'd, never-truncated file.
        # The name is the one the server just authenticated, not one the socket
        # sent, so it is ACTOR_SESSION like the writes it goes on to authorise.
        await audit.emit_async(
            audit.AuditEvent(
                actor=identity["username"],
                actor_source=audit.ACTOR_SESSION,
                action="user.login",
                subject=scope,
                detail={"groups": identity["groups"]},
            )
        )

    async def _handle_request_identity(self, client_id: str, msg: RequestIdentityMessage) -> None:
        """Auto-login the configured autoLoginName user for the given scope."""
        scope = msg.get("scope", "")
        if not isinstance(scope, str) or not scope:
            return

        from services import users_manager
        doc = users_manager.load()
        settings = doc.get("settings", {})
        auto_login_name = settings.get("autoLoginName", "guest") if isinstance(settings, dict) else "guest"
        user = next(
            (u for u in doc.get("users", []) if isinstance(u, dict) and u.get("username") == auto_login_name),
            None,
        )
        identity = (
            {"username": user["username"], "groups": list(user.get("groups", ["guest"]))}
            if user is not None
            else {"username": "guest", "groups": ["guest"]}
        )
        await self._apply_and_respond_identity(client_id, scope, identity, doc)

    async def _handle_logout(self, client_id: str, msg: LogoutMessage) -> None:
        """Revert scoped identity back to guest."""
        scope = msg.get("scope", "")
        if not isinstance(scope, str) or not scope:
            return

        request_id = msg.get("requestId")
        # Read before the revert overwrites it — this is who the session was.
        previous_actor = self._session_actor(client_id, scope)

        from services import users_manager
        doc = users_manager.load()
        guest = next((u for u in doc.get("users", []) if isinstance(u, dict) and u.get("username") == "guest"), None)
        identity = {
            "username": "guest",
            "groups": list(guest.get("groups", ["guest"])) if guest else ["guest"],
        }
        await self._apply_and_respond_identity(client_id, scope, identity, doc, request_id=request_id)
        # Only a real session ending is worth a record. A guest→guest logout —
        # a double logout, or a socket that never authenticated — ended nothing,
        # and the trail is append-only and never truncated.
        if previous_actor != "guest":
            await audit.emit_async(
                audit.AuditEvent(
                    actor=previous_actor,
                    actor_source=audit.ACTOR_SESSION,
                    action="user.logout",
                    subject=scope,
                )
            )

    async def _send_cached_values(self, client_id: str, composite_keys: set[str]) -> set[str]:
        if self._datasource_manager is None or not composite_keys:
            return set()
        cached = self._datasource_manager.get_cached_values(composite_keys)
        if not cached:
            return set()
        ws = self._connections.get(client_id)
        if ws is None:
            return set()
        await ws.send_text(json.dumps({"type": "var_update", "values": cached}))
        return set(cached)

    async def _send_uncached_values(self, client_id: str, composite_keys: set[str]) -> None:
        if not composite_keys or self._datasource_manager is None or self._opcua_pool is None:
            return

        fresh_values: dict[str, Any] = {}
        for ds_name, paths in _group_priority_paths_by_datasource(composite_keys).items():
            engine = self._opcua_pool.get(ds_name)
            if engine is None:
                continue
            try:
                fresh_values.update(await engine.read_current_values(paths))
            except Exception as exc:
                logger.warning("Failed to prefetch values for %s: %s", ds_name, exc)

        if not fresh_values:
            return

        self._datasource_manager.seed_cached_values(fresh_values)
        ws = self._connections.get(client_id)
        if ws is None:
            return
        try:
            await ws.send_text(json.dumps({"type": "var_update", "values": fresh_values}))
        except Exception:
            self._connections.pop(client_id, None)
            return

    async def _send_uncached_values_then_ready(
        self, client_id: str, composite_keys: set[str], current_page_ids: list[str]
    ) -> None:
        """Background continuation of `_handle_set_context`'s fire-and-forget
        OPC-UA prefetch: once the uncached reads land (or fail), tell the
        client this context is ready regardless, so it isn't left waiting
        forever on a page whose variables couldn't be read."""
        await self._send_uncached_values(client_id, composite_keys)
        await self._send_context_ready(client_id, current_page_ids)

    async def _send_context_ready(self, client_id: str, current_page_ids: list[str]) -> None:
        """Tell the client every variable requested by this set_context has
        been sent (from cache and/or freshly read). The client uses this to
        reveal a newly navigated page once its own data has actually arrived,
        instead of a session-wide "a snapshot landed at some point" flag."""
        ws = self._connections.get(client_id)
        if ws is None:
            return
        try:
            await ws.send_text(json.dumps({"type": "context_ready", "currentPageIds": current_page_ids}))
        except Exception:
            self._connections.pop(client_id, None)


# -- Helpers -----------------------------------------------------------------


def _group_priority_paths_by_datasource(priority_keys: set[str]) -> dict[str, set[str]]:
    grouped: dict[str, set[str]] = {}
    for key in priority_keys:
        ds_name, path = parse_var_key(key)
        if ds_name:
            grouped.setdefault(ds_name, set()).add(path)
    return grouped


def _parse_write_field_request(msg: dict) -> tuple[str, str, str | None, Any] | None:
    """Compatibility alias for callers/tests; implementation is transport-neutral."""
    return write_service.parse_write_request(msg)


def _coerce_non_empty_str_list(raw: Any, limit: int) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw[:limit]:
        if isinstance(item, str) and item:
            out.append(item)
    return out


def _extract_explicit_priority_keys(msg: dict) -> set[str]:
    return set(_coerce_non_empty_str_list(msg.get("priorityKeys"), _MAX_PRIORITY_KEYS))


def _resolve_current_page_ids(msg: dict) -> list[str]:
    return _coerce_non_empty_str_list(msg.get("currentPageIds"), _MAX_PAGE_IDS)


_runtime_pages_config_cache: dict | None = None
_runtime_pages_config_lock = threading.Lock()


def invalidate_runtime_pages_config_cache() -> None:
    """Drop the cached runtime pages_config. Call after writes to config.json or page files."""
    global _runtime_pages_config_cache
    with _runtime_pages_config_lock:
        _runtime_pages_config_cache = None


def _get_runtime_pages_config() -> dict | None:
    global _runtime_pages_config_cache
    with _runtime_pages_config_lock:
        if _runtime_pages_config_cache is not None:
            return _runtime_pages_config_cache
    try:
        raw = read_json(_config_path())
    except Exception as exc:
        logger.warning("set_context: could not read config.json: %s", exc)
        return None
    runtime = _to_runtime_pages_config(raw)
    with _runtime_pages_config_lock:
        _runtime_pages_config_cache = runtime
    return runtime


def _resolve_context_composite_keys(
    *,
    current_page_ids: list[str],
    open_dialog_ids: list[str],
    explicit_priority_keys: set[str],
) -> set[str]:
    # Datasource live-values can drive fast-subscriptions using explicit
    # priority keys without any page/dialog context.
    if not current_page_ids and not open_dialog_ids:
        return set(explicit_priority_keys)

    pages_config = _get_runtime_pages_config()
    if pages_config is None:
        return set(explicit_priority_keys)

    composite_keys = _collect_from_runtime_pages_config(
        pages_config,
        current_page_ids=current_page_ids,
        open_dialog_ids=open_dialog_ids,
    )
    composite_keys.update(explicit_priority_keys)
    return composite_keys


def _iter_dict_children(raw_children: Any) -> list[dict]:
    if not isinstance(raw_children, list):
        return []
    return [child for child in raw_children if isinstance(child, dict)]


def _collect_context_composite_keys(
    raw_pages_config: dict,
    *,
    current_page_ids: list[str],
    open_dialog_ids: list[str],
) -> set[str]:
    """Collect all variable keys for the current runtime context (raw input)."""
    return _collect_from_runtime_pages_config(
        _to_runtime_pages_config(raw_pages_config),
        current_page_ids=current_page_ids,
        open_dialog_ids=open_dialog_ids,
    )


def _collect_from_runtime_pages_config(
    pages_config: dict,
    *,
    current_page_ids: list[str],
    open_dialog_ids: list[str],
) -> set[str]:
    """Collect variable keys from a pages_config already in runtime shape."""
    keys: set[str] = set()

    _walk_components(pages_config.get("header", []), keys)
    _walk_components(pages_config.get("footer", []), keys)

    for page_id in current_page_ids:
        _collect_active_scope_composite_keys(pages_config.get("pages", []), page_id, keys)

    if open_dialog_ids:
        dialogs = pages_config.get("dialogs", [])
        dialog_map = {
            dialog.get("id"): dialog
            for dialog in dialogs
            if isinstance(dialog, dict) and isinstance(dialog.get("id"), str)
        }
        for dialog_id in open_dialog_ids:
            dialog = dialog_map.get(dialog_id)
            if isinstance(dialog, dict):
                _walk_components(dialog.get("widgets", []), keys)

    return keys


def _collect_active_scope_composite_keys(nodes: list[dict], page_id: str, keys: set[str]) -> bool:
    """
    Collect page keys for the active root scope.

    If the requested page is inside a top-level page-group, collect all pages in
    that group so tab/nested-page switches are already warm.
    """
    for node in nodes:
        if not isinstance(node, dict):
            continue

        if _is_page_group_node(node):
            if _group_contains_page_id(node, page_id, set()):
                _collect_group_subtree_composite_keys(node, keys, set())
                return True
            continue

        if _page_contains_page_id(node, page_id, set()):
            _collect_page_subtree_composite_keys(node, keys, set())
            return True

    return False


def _collect_group_subtree_composite_keys(group: dict, keys: set[str], visited: set[int]) -> None:
    if not _is_page_group_node(group) or id(group) in visited:
        return
    visited.add(id(group))
    for child in _iter_dict_children(group.get("children", [])):
        _collect_page_subtree_composite_keys(child, keys, visited)


def _collect_page_subtree_composite_keys(page: dict, keys: set[str], visited: set[int]) -> None:
    if not isinstance(page, dict) or id(page) in visited:
        return
    visited.add(id(page))
    for child in _iter_dict_children(page.get("children", [])):
        if _is_page_group_node(child):
            _collect_group_subtree_composite_keys(child, keys, visited)
        else:
            _walk_components([child], keys)


def _group_contains_page_id(group: dict, page_id: str, visited: set[int]) -> bool:
    if not _is_page_group_node(group) or id(group) in visited:
        return False
    visited.add(id(group))
    for child in _iter_dict_children(group.get("children", [])):
        if _page_contains_page_id(child, page_id, visited):
            return True
    return False


def _page_contains_page_id(page: Any, page_id: str, visited: set[int]) -> bool:
    if not isinstance(page, dict) or id(page) in visited:
        return False
    visited.add(id(page))
    if page.get("id") == page_id:
        return True
    for child in _iter_dict_children(page.get("children", [])):
        if not _is_page_group_node(child):
            continue
        if _group_contains_page_id(child, page_id, visited):
            return True
    return False


def _is_page_group_node(node: Any) -> bool:
    if not isinstance(node, dict):
        return False
    return node.get("type") == "page-group"


def _to_runtime_pages_config(raw: dict) -> dict:
    if not isinstance(raw, dict):
        return {"pages": [], "header": [], "footer": [], "dialogs": []}
    pages   = v if isinstance(v := raw.get("pages"),   list) else []
    header  = v if isinstance(v := raw.get("header"),  list) else []
    footer  = v if isinstance(v := raw.get("footer"),  list) else []
    dialogs = v if isinstance(v := raw.get("dialogs"), list) else []

    return {
        "pages": [_to_runtime_page_node(node) for node in pages if isinstance(node, dict)],
        "header": [node for node in header if isinstance(node, dict)],
        "footer": [node for node in footer if isinstance(node, dict)],
        "dialogs": [node for node in dialogs if isinstance(node, dict)],
    }


def _load_page_file_children(page_id: str) -> list[dict]:
    """Load component children for a leaf page from its per-page file (v2 split-page storage)."""
    try:
        data = read_json(active_pages_dir() / f"{page_id}.json")
    except Exception:
        return []
    children = data.get("children", []) if isinstance(data, dict) else []
    return [c for c in children if isinstance(c, dict)]


def _to_runtime_page_node(node: dict) -> dict:
    if _is_page_group_node(node):
        return {
            **{k: v for k, v in node.items() if k != "children"},
            "type": "page-group",
            "children": [
                _to_runtime_page_node(child)
                for child in _iter_dict_children(node.get("children", []))
            ],
        }

    runtime = {**node}
    # In v2 split-page storage, leaf page component trees are in per-page files
    # and the index node has no 'children' key.  Load from the file when absent/empty.
    raw_children = _iter_dict_children(node.get("children", []))
    if not raw_children:
        page_id = node.get("id", "")
        raw_children = _load_page_file_children(page_id) if page_id else []
    children: list[dict] = []
    for child in raw_children:
        if _is_page_group_node(child):
            children.append(_to_runtime_page_node(child))
        else:
            children.append(child)

    runtime["children"] = children
    runtime["type"] = runtime.get("type") or "page"
    return runtime


def _extract_binding_from_value(value: Any) -> tuple[str, str] | None:
    """Return (datasource, location) from a canonical $var source."""
    if not isinstance(value, dict):
        return None

    wrapped = value.get("$var")
    if isinstance(wrapped, dict):
        composite = wrapped.get("path")
        if isinstance(composite, str) and ":" in composite:
            ds, _, loc = composite.partition(":")
            if ds and loc:
                return (ds, loc)

    return None


MAX_EXTRACT_BINDING_DEPTH = 64

def _extract_variable_keys_from_value(value: Any, keys: set[str], depth: int = MAX_EXTRACT_BINDING_DEPTH) -> None:
    """Recursively collect every canonical ``$var`` below *value*.

    This intentionally follows the frontend's generic property-value walker
    rather than maintaining a second source allow-list. It therefore covers
    switch case conditions, string-expression wildcards, action payloads, and
    future property sources automatically.
    """
    if depth <= 0:
        return
    if isinstance(value, list):
        for item in value:
            _extract_variable_keys_from_value(item, keys, depth - 1)
        return
    if not isinstance(value, dict):
        return

    binding = _extract_binding_from_value(value)
    if binding is not None:
        ds, path = binding
        keys.add(build_var_key(ds, path))
        return

    for nested in value.values():
        _extract_variable_keys_from_value(nested, keys, depth - 1)


def _walk_components(components: list, keys: set[str], visited: set[int] | None = None) -> None:
    if visited is None:
        visited = set()
    for comp in components:
        if not isinstance(comp, dict) or id(comp) in visited:
            continue
        visited.add(id(comp))
        props = comp.get("properties", {})
        _extract_variable_keys_from_value(props, keys)
        _extract_variable_keys_from_value(comp.get("layout", {}), keys)
        _walk_components(_iter_dict_children(comp.get("children", [])), keys, visited)


# Singleton used by main.py
websocket_manager = WebSocketManager()
