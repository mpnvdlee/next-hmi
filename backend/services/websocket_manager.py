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
            alarm_ack      -> acknowledge one alarm as this connection's user
            alarm_ack_all  -> acknowledge every alarm as this connection's user
            login          -> authenticate a scoped session
            logout         -> revert a scoped session to the auto-login user
"""

import asyncio
import contextlib
import hashlib
import json
import logging
import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, cast

from core import audit
from core.exceptions import RateLimitError
from core.number_utils import get_config_float
from core.page_index import INDEX_ROOTS, page_document_dir, root_nodes
from core.storage import (
    active_config_dir,
    read_json,
)
from core.validation.ids import is_valid_panel_name
from fastapi import WebSocket, WebSocketDisconnect
from models.datasource import build_var_key, parse_var_key
from models.websocket import (
    LoginMessage,
    LogoutMessage,
    RequestIdentityMessage,
    SetContextMessage,
    ToggleFieldMessage,
    WriteFieldMessage,
    build_auth_error,
    build_user_identity,
    build_write_error,
    build_write_response,
)

from services import recipe_manager as recipe_manager_module
from services import write_service

logger = logging.getLogger(__name__)


def _config_path():
    return active_config_dir() / "config.json"

# --- OPC-UA write coercion constants (built once at import time) --------------
_MAX_PAGE_IDS = 2000
_MAX_PRIORITY_KEYS = 5000
_MAX_WS_MESSAGE_BYTES = 64 * 1024
# Identity scopes are a view's own name ("runtime:" plus 12 hex digits,
# "runtime:preview"). Each stored one costs memory for the connection's life,
# so both its length and how many one socket keeps are capped.
_MAX_SCOPE_LENGTH = 64
_MAX_SCOPES_PER_CONNECTION = 16
# A set_context can resubscribe and read the PLC: one socket gets at most one
# applied per interval (the latest wins), and the fast subscriptions are
# recomputed at most once per interval however many sockets move them.
_SET_CONTEXT_INTERVAL_S = 0.25
_PRIORITY_RECOMPUTE_INTERVAL_S = 0.25
# Prefetch reads in flight at once across every socket. Each first takes what
# the reads before it cached, so sockets opening one page together cost the
# PLC a few reads, not one each.
_MAX_CONCURRENT_PREFETCHES = 4
# Runtime sockets one project instance serves at once, far above any plant's
# panel count. Editor sockets, behind the device-admin session, don't count.
_MAX_RUNTIME_CONNECTIONS = 500
_CLOSE_TRY_AGAIN_LATER = 1013
# Names this backend process, so a client can tell a reconnect from a restart.
_BOOT_ID = uuid.uuid4().hex
# How long a runtime login can be resumed on a new socket after it was last used.
_SESSION_TTL_S = 12 * 3600
# Documented reason codes echoed back to clients in auth_error / write_error
# messages. Frontend action-result handlers $switch on these strings, so they
# are a stable contract — do not rename without a coordinated frontend change.
REASON_INVALID_CREDENTIALS = "invalid_credentials"
REASON_RATE_LIMITED = "rate_limited"
REASON_BAD_REQUEST = "bad_request"


@dataclass
class ConfigChangedEvent:
    """Payload for ``broadcast_config_changed``.

    ``source`` is ``"mcp"``, ``"rest"`` or ``"api"``. ``agent_label`` is
    included on the wire only when ``source == "mcp"``; ``tab_id`` names the
    browser tab whose REST write this was, when it named itself.
    """

    artifact_type: str
    artifact_ids: list[str]
    source: str
    summary: str = ""
    diff: Any = None
    agent_label: str | None = None
    tab_id: str | None = None


@dataclass
class _SocketContext:
    """One socket's set_context pacing and its OPC-UA prefetch."""

    applied_at: float = float("-inf")
    waiting: SetContextMessage | None = None  # the latest, held for its turn
    apply_task: asyncio.Task | None = None
    prefetch_task: asyncio.Task | None = None
    # The latest (keys, page ids) that arrived while a prefetch ran.
    prefetch_waiting: tuple[set[str], list[str]] | None = None


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
        # Resumable logins: token -> (username, monotonic expiry, credential
        # mark). Outlive the socket so a reconnect or page reload stays logged in.
        # shortcut: in memory, so a backend restart logs everyone out; persist
        # (signed tokens) if operators must survive a restart.
        self._sessions: dict[str, tuple[str, float, str]] = {}
        # Connections the manager opened through the session-gated editor prefix.
        self._editor_clients: set[str] = set()
        # Runtime connections whose tab named its panel (``?panel=``): client_id -> name.
        self._client_panels: dict[str, str] = {}
        # Per-client connection timestamps: client_id -> ISO string
        self._client_connected_at: dict[str, str] = {}
        # Priority batch delay per datasource name, beside the entry it was read
        # from: an edited or reloaded datasource is a new entry object, so a
        # stale value is recognised without the datasource side reporting it.
        self._priority_delay_cache: dict[str, tuple[Any, float]] = {}
        # Coalesced background priority recompute (see schedule_priority_recompute)
        self._priority_recompute_task: asyncio.Task | None = None
        self._priority_recompute_rerun = False
        # The composite keys each client's last set_context asked for. A
        # var_update reaches a client only for keys in here (plus the shared
        # keys every client reads), so a 100k-variable server does not stream
        # every change to every browser.
        self._client_keys: dict[str, set[str]] = {}
        # Bytes of value frames sent per client, for the Admin page.
        self._client_bytes: dict[str, int] = {}
        self._priority_recomputed_at = float("-inf")
        self._contexts: dict[str, _SocketContext] = {}
        self._prefetch_slots = asyncio.Semaphore(_MAX_CONCURRENT_PREFETCHES)

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
        latest live state rather than stacking one task per save. Runs start
        at least ``_PRIORITY_RECOMPUTE_INTERVAL_S`` apart, so sockets moving
        the union in turn cost the PLC a few resubscriptions a second, not one
        per message. Failures are logged, never raised — this must never
        affect the caller.
        """
        if self._priority_recompute_task is not None and not self._priority_recompute_task.done():
            self._priority_recompute_rerun = True
            return
        self._priority_recompute_rerun = False
        self._priority_recompute_task = asyncio.create_task(self._run_priority_recompute())

    async def _run_priority_recompute(self) -> None:
        while True:
            await asyncio.sleep(
                max(0.0, self._priority_recomputed_at + _PRIORITY_RECOMPUTE_INTERVAL_S - time.monotonic())
            )
            self._priority_recomputed_at = time.monotonic()
            try:
                await self.recompute_priority_subscriptions()
            except Exception:
                logger.exception("Background alarm priority recompute failed")
            if not self._priority_recompute_rerun:
                return
            self._priority_recompute_rerun = False

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
                await self._broadcast_values(priority_pending)
            if self._connections and pending:
                await self._broadcast_values(pending)

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
        entry = self._datasource_manager.get(ds_name)
        cached = self._priority_delay_cache.get(ds_name)
        if cached is not None and cached[0] is entry:
            return cached[1]
        settings = entry.config.get("settings", {}) if entry is not None else {}
        value = get_config_float(settings, "priority_ws_batch_ms", 10.0, minimum=0.0, maximum=1000.0)
        self._priority_delay_cache[ds_name] = (entry, value)
        return value

    async def _broadcast(self, payload: dict) -> None:
        if not self._connections:
            return
        message = json.dumps(payload)
        await self._send_all([(client_id, message) for client_id in self._connections])

    async def _send_all(self, frames: list[tuple[str, str]]) -> None:
        """Send each (client_id, frame) concurrently; a client whose send
        fails or stalls past 5 s is dropped."""
        live = [(client_id, self._connections.get(client_id), frame) for client_id, frame in frames]
        live = [(client_id, ws, frame) for client_id, ws, frame in live if ws is not None]
        if not live:
            return
        results = await asyncio.gather(
            *[asyncio.wait_for(ws.send_text(frame), timeout=5.0) for _, ws, frame in live],
            return_exceptions=True,
        )
        for (client_id, _, _), result in zip(live, results, strict=True):
            if isinstance(result, Exception):
                self._connections.pop(client_id, None)

    def _values_frame(self, client_id: str, values: dict[str, Any]) -> str:
        """A var_update frame for one client, counted towards its bytes sent."""
        frame = json.dumps({"type": "var_update", "values": values})
        self._client_bytes[client_id] = self._client_bytes.get(client_id, 0) + len(frame)
        return frame

    def _shared_value_keys(self) -> set[str]:
        """Keys every client reads whatever its page: a recipe's parameters,
        which the client compares against the loaded dataset itself."""
        if self._recipe_manager is None:
            return set()
        return {
            build_var_key(ds_name, path)
            for ds_name, paths in self._recipe_manager.get_parameter_paths_by_datasource().items()
            for path in paths
        }

    def _delivery_keys(self, promoted: set[str]) -> set[str]:
        """Every key a client holding *promoted* receives: those keys, the
        shared recipe parameters, and the elements of each struct array it
        binds whole (the client reads an element under its own key). Decided
        once per set_context, so every delivery path — metadata, cached
        values, the prefetch, the live broadcast — is one set lookup."""
        keys = set(promoted) | self._shared_value_keys()
        if self._datasource_manager is not None:
            for key in promoted:
                keys |= self._datasource_manager.element_keys(key)
        return keys

    async def _broadcast_values(self, values: dict[str, Any]) -> None:
        """Send each client the slice of *values* its context asked for.
        Clients wanting the same slice share one serialised frame."""
        if not self._connections:
            return
        frames: list[tuple[str, str]] = []
        shared_frames: dict[frozenset[str], str] = {}
        for client_id in list(self._connections):
            wanted = self._client_keys.get(client_id)
            if not wanted:
                continue
            if len(wanted) < len(values):
                subset = {k: values[k] for k in wanted if k in values}
            else:
                subset = {k: v for k, v in values.items() if k in wanted}
            if not subset:
                continue
            signature = frozenset(subset)
            frame = shared_frames.get(signature)
            if frame is None:
                frame = shared_frames[signature] = json.dumps({"type": "var_update", "values": subset})
            self._client_bytes[client_id] = self._client_bytes.get(client_id, 0) + len(frame)
            frames.append((client_id, frame))
        await self._send_all(frames)

    async def broadcast_var_removed(self, var_ids: list[str]) -> None:
        """Notify all connected clients that these variable IDs are no longer available."""
        if var_ids and self._connections:
            await self._broadcast({"type": "var_removed", "ids": var_ids})

    async def broadcast_var_values(self, values: dict[str, Any]) -> None:
        """Broadcast an explicit cache refresh after a datasource edit."""
        if values and self._connections:
            await self._broadcast_values(values)

    async def broadcast_var_metadata(self) -> None:
        """Send every client a fresh metadata snapshot for its own context.

        Datasource edits can add, remove, or reshape bindings while clients stay
        connected. The snapshot is authoritative: the client drops values for
        keys no longer in it, so one that lost all its keys gets an empty map.
        """
        if self._datasource_manager is None or not self._connections:
            return
        for client_id in list(self._connections):
            await self._send_context_metadata(client_id, self._client_keys.get(client_id, set()))

    async def _send_context_metadata(self, client_id: str, keys: set[str]) -> None:
        """The metadata a client holding *keys* reads (see ``variable_metadata``)."""
        ws = self._connections.get(client_id)
        if ws is None or self._datasource_manager is None:
            return
        meta = self._datasource_manager.variable_metadata(keys)
        try:
            await ws.send_text(json.dumps({"type": "var_metadata", "meta": meta}))
        except Exception:
            self._connections.pop(client_id, None)

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

        ``event.source`` is ``"mcp"``, ``"rest"`` or ``"api"``. For anything but
        ``"mcp"``, ``agent_label`` is omitted from the payload regardless of value.

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
        if event.tab_id:
            payload["tab_id"] = event.tab_id
        await self._broadcast(payload)

    # -- Connection lifecycle -------------------------------------------------

    async def connect(self, websocket: WebSocket, *, editor: bool = False) -> str:
        """Accept connection, send snapshot, register client. Returns client_id.

        ``editor`` marks a socket the manager proxied from ``/editor/<slug>/ws``.
        A runtime socket over ``_MAX_RUNTIME_CONNECTIONS`` is closed ``1013``
        and raises ``WebSocketDisconnect``.
        """
        await websocket.accept()
        if not editor and len(self._connections) - len(self._editor_clients) >= _MAX_RUNTIME_CONNECTIONS:
            logger.warning("WS client refused: %d runtime connections open", _MAX_RUNTIME_CONNECTIONS)
            await websocket.close(
                code=_CLOSE_TRY_AGAIN_LATER, reason="Too many open connections to this project"
            )
            raise WebSocketDisconnect(_CLOSE_TRY_AGAIN_LATER)
        client_id = str(uuid.uuid4())
        self._connections[client_id] = websocket
        if editor:
            self._editor_clients.add(client_id)
        self._client_users[client_id] = {}
        self._client_connected_at[client_id] = datetime.now(UTC).isoformat()
        try:
            # Send an empty snapshot immediately so the client marks snapshotReceived=true
            # and the UI becomes interactive, then stream the actual values in chunks.
            await websocket.send_text(
                json.dumps({"type": "var_snapshot", "values": {}, "bootId": _BOOT_ID})
            )
            # No metadata or value snapshot here: both follow the client's
            # set_context (metadata for its keys, cached values at once, the
            # rest after a read), so a client only ever holds what its pages
            # bind — 100k variables are 13 MB of metadata per connect otherwise.
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
        self._client_keys.pop(client_id, None)
        self._client_bytes.pop(client_id, None)
        self._editor_clients.discard(client_id)
        self._client_panels.pop(client_id, None)
        self._client_connected_at.pop(client_id, None)
        # Before its keys are cleared: a context still being applied would
        # otherwise store them again for a socket that is gone.
        if (context := self._contexts.pop(client_id, None)) is not None:
            for task in (context.apply_task, context.prefetch_task):
                if task is not None:
                    task.cancel()
        if self._datasource_manager is not None and self._datasource_manager.clear_client(client_id):
            # Demote the paths only this client's page held back to background
            self.schedule_priority_recompute()
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
                            # What this socket's context asked for, and what
                            # it has been sent — the per-client half of the
                            # value filter made visible.
                            "keys": len(self._client_keys.get(client_id, ())),
                            "bytesSent": self._client_bytes.get(client_id, 0),
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
            await self._pace_set_context(client_id, cast(SetContextMessage, msg))
        elif msg_type == "write_field":
            await self._handle_write_field(client_id, cast(WriteFieldMessage, msg))
        elif msg_type == "toggle_field":
            await self._handle_toggle_field(client_id, cast(ToggleFieldMessage, msg))
        elif msg_type == "recipe_load":
            await self._handle_recipe_load(client_id, msg)
        elif msg_type == "recipe_save":
            await self._handle_recipe_save(client_id, msg)
        elif msg_type in ("alarm_ack", "alarm_ack_all"):
            await self._handle_alarm_ack(client_id, msg)
        elif msg_type == "login":
            await self._handle_login(client_id, cast(LoginMessage, msg))
        elif msg_type == "logout":
            await self._handle_logout(client_id, cast(LogoutMessage, msg))
        elif msg_type == "request_identity":
            await self._handle_request_identity(client_id, cast(RequestIdentityMessage, msg))
        else:
            logger.debug("Unknown WS message type '%s' from %s", msg_type, client_id[:8])

    async def _pace_set_context(self, client_id: str, msg: SetContextMessage) -> None:
        """Apply *msg* now, or once this socket's interval is up, the latest
        context waiting by then winning."""
        context = self._contexts.setdefault(client_id, _SocketContext())
        wait = context.applied_at + _SET_CONTEXT_INTERVAL_S - time.monotonic()
        if context.apply_task is None and wait <= 0:
            context.applied_at = time.monotonic()
            await self._handle_set_context(client_id, msg)
            return
        context.waiting = msg
        if context.apply_task is None:
            context.apply_task = asyncio.create_task(self._apply_waiting_context(client_id, context, wait))

    async def _apply_waiting_context(self, client_id: str, context: _SocketContext, wait: float) -> None:
        try:
            while True:
                await asyncio.sleep(wait)
                msg, context.waiting = context.waiting, None
                if msg is None or client_id not in self._connections:
                    return
                context.applied_at = time.monotonic()
                await self._handle_set_context(client_id, msg)
                wait = max(0.0, context.applied_at + _SET_CONTEXT_INTERVAL_S - time.monotonic())
        except Exception:
            # A send to a socket that has gone; its receive loop disconnects it.
            logger.debug("set_context for %s not applied", client_id[:8], exc_info=True)
        finally:
            context.apply_task = None

    def _apply_priority_keys(self, client_id: str, keys: set[str]) -> None:
        """Store keys for this client and schedule the OPC-UA subscription
        update if the union moved.

        Deliberately not awaited: a client's WebSocket messages are handled
        one after another, so awaiting the promote/demote round-trips here
        would queue the *next* navigation (and the "page left" context) behind
        them. The coalesced recompute always reads the latest union, so
        superseded contexts are skipped, not replayed. A client opening a page
        others already show changes no subscription.
        """
        if self._datasource_manager is None or self._opcua_pool is None:
            return
        if self._datasource_manager.set_client_page(client_id, keys):
            self.schedule_priority_recompute()

    async def recompute_priority_subscriptions(self) -> None:
        """Recompute the per-datasource fast subscription set and push it to the pool.

        The priority set is the union of: page-driven keys across all clients,
        alarm trigger paths, and historized variables. Called on every client
        context change that moves the union (via _apply_priority_keys), on a
        disconnect that does, on an engine (re)connect, and whenever alarm/historian
        config changes whose writers call this method, so new entries are
        subscribed immediately rather than only on the next page navigation.
        """
        if self._datasource_manager is None or self._opcua_pool is None:
            return
        # A recipe edit changes what every client receives; cheap per client.
        for client_id in list(self._client_keys):
            self._client_keys[client_id] = self._delivery_keys(
                self._datasource_manager.client_page_keys(client_id)
            )
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
        explicit_priority_keys = _extract_explicit_priority_keys(msg)
        composite_keys = _resolve_context_composite_keys(
            current_page_ids=current_page_ids,
            explicit_priority_keys=explicit_priority_keys,
        )
        # Only keys naming a datasource variable or folder are kept: the rest
        # could never be answered or subscribed, only held per connection. An
        # array bound at a literal index is read, promoted and shipped as that
        # element, never as the whole array (see _promotion_keys).
        promoted = self._datasource_manager.known_keys(
            _promotion_keys(composite_keys, self._datasource_manager)
        )
        delivered = self._delivery_keys(promoted)
        previous = self._client_keys.get(client_id)
        self._client_keys[client_id] = delivered
        # Metadata first: the client validates a binding against it and drops
        # values for keys outside it, so it has to precede the values. An
        # unchanged context (a scroll in the variable table) resends nothing.
        if delivered != previous:
            await self._send_context_metadata(client_id, delivered)
        sent_keys = await self._send_cached_values(client_id, delivered)
        self._apply_priority_keys(client_id, promoted)
        # Elements of a whole-bound array arrive with the array itself.
        missing_keys = (promoted | self._shared_value_keys()) - sent_keys
        context = self._contexts.setdefault(client_id, _SocketContext())
        if not missing_keys:
            context.prefetch_waiting = None  # superseded: this context needs no read
            await self._send_context_ready(client_id, current_page_ids)
        elif context.prefetch_task is not None:
            # One read in flight per socket; the latest context waits for it.
            context.prefetch_waiting = (missing_keys, current_page_ids)
        else:
            context.prefetch_task = asyncio.create_task(
                self._prefetch(client_id, context, missing_keys, current_page_ids)
            )

    async def _prefetch(
        self, client_id: str, context: _SocketContext, keys: set[str], page_ids: list[str]
    ) -> None:
        """Background continuation of `_handle_set_context`: read the uncached
        keys, then tell the client this context is ready regardless, so it
        isn't left waiting forever on a page whose variables couldn't be read.
        Then the same for the context that arrived meanwhile, if any."""
        try:
            while True:
                await self._send_uncached_values(client_id, keys)
                await self._send_context_ready(client_id, page_ids)
                if context.prefetch_waiting is None:
                    return
                (keys, page_ids), context.prefetch_waiting = context.prefetch_waiting, None
        finally:
            context.prefetch_task = None

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
        await self._checked_write(client_id, msg, ds_name, path, field=field, value=value)

    async def _handle_toggle_field(self, client_id: str, msg: ToggleFieldMessage) -> None:
        """Invert a Boolean variable. Same audit and
        `write_response` / `write_error` contract as `_handle_write_field`; the
        value written is read on the server, never taken from the client."""
        request_id = msg.get("requestId")

        if self._datasource_manager is None:
            await self._send_write_result(
                client_id, request_id, "", "", write_service.REASON_OPCUA_UNREACHABLE
            )
            return

        target = write_service.parse_toggle_request(msg)
        if target is None:
            logger.warning("toggle_field: missing datasource/path in %s", msg)
            ds_name = str(msg.get("datasource", ""))
            path = str(msg.get("path", ""))
            await self._send_write_result(client_id, request_id, ds_name, path, REASON_BAD_REQUEST)
            return

        ds_name, path = target
        await self._checked_write(client_id, msg, ds_name, path, toggle=True)

    async def _checked_write(
        self,
        client_id: str,
        msg: WriteFieldMessage | ToggleFieldMessage,
        ds_name: str,
        path: str,
        *,
        field: str | None = None,
        value: Any = None,
        toggle: bool = False,
    ) -> None:
        """Resolve, write (or toggle), audit and respond."""
        request_id = msg.get("requestId")
        registry_path = write_service.registry_path_of(self._datasource_manager, ds_name, path)

        entry_data = self._datasource_manager.get_entry(ds_name, registry_path)
        if entry_data is None:
            logger.warning("%s: unknown %s:%s", msg.get("type"), ds_name, path)
            await self._send_write_result(
                client_id, request_id, ds_name, path, write_service.REASON_BAD_PATH
            )
            return

        scope = msg.get("scope", "")
        if toggle:
            outcome, value = await write_service.toggle_value(
                self._datasource_manager, self._opcua_pool, ds_name, path,
            )
        else:
            outcome = await write_service.write_value(
                self._datasource_manager, self._opcua_pool, ds_name, path, value, field=field,
            )
        if not outcome.ok:
            logger.warning("%s %s:%s.%s failed: %s", msg.get("type"), ds_name, path, field, outcome.reason)
        else:
            # Moving a setpoint is the most consequential thing an operator does
            # here; failures stay in the log above.
            await write_service.audit_write(
                *self._attributed(client_id, self._session_actor(client_id, scope)),
                ds_name, path, value, field,
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
        try:
            result = await self._recipe_manager.download(dataset_id, verify=verify)
        except Exception:
            logger.exception("recipe_load failed for dataset %s", dataset_id)
            await self._send_recipe_result(client_id, request_id, None, "download_failed")
            return
        if result is None:
            await self._send_recipe_result(client_id, request_id, None, "not_found")
            return
        await recipe_manager_module.audit_load(
            result, *self._attributed(client_id, self._session_actor(client_id, msg.get("scope", ""))),
        )
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
        username, _source = self._attributed(
            client_id, identity.get("username", "") if isinstance(identity, dict) else "",
        )
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

    async def _handle_alarm_ack(self, client_id: str, msg: dict) -> None:
        """Acknowledge one alarm (``alarm_ack``) or all (``alarm_ack_all``).

        Attributed to the identity this connection holds, never to a name the
        message carries. Replies ``alarm_ack_response`` / ``alarm_ack_error``
        when the client supplied a ``requestId``.
        """
        request_id = msg.get("requestId")
        if self._alarm_manager is None:
            await self._send_ack_result(client_id, request_id, "alarms_unavailable")
            return
        actor, actor_source = self._attributed(client_id, self._connection_actor(client_id))
        if msg.get("type") == "alarm_ack_all":
            # The alarm manager saves state and calls audit listeners synchronously.
            await asyncio.to_thread(
                self._alarm_manager.ack_all, actor, actor_source=actor_source,
            )
            await self._send_ack_result(client_id, request_id, None)
            return
        instance_id = msg.get("instanceId")
        if not isinstance(instance_id, str) or not instance_id:
            await self._send_ack_result(client_id, request_id, REASON_BAD_REQUEST)
            return
        found = await asyncio.to_thread(
            self._alarm_manager.ack_alarm, instance_id, actor, actor_source=actor_source,
        )
        await self._send_ack_result(client_id, request_id, None if found else "not_found")

    async def _send_ack_result(
        self, client_id: str, request_id: str | None, reason: str | None,
    ) -> None:
        """Emit alarm_ack_response (reason=None) or alarm_ack_error. No-op without requestId."""
        if not request_id:
            return
        payload: dict[str, Any] = (
            {"type": "alarm_ack_error", "requestId": request_id, "reason": reason}
            if reason
            else {"type": "alarm_ack_response", "requestId": request_id}
        )
        await self._safe_send_json(client_id, payload)

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

    def _session_actor(self, client_id: str, scope: str) -> str:
        """Name this connection authenticated as for *scope*, never one it sent.

        A connection that never logged in falls back to "guest". That is still a
        fact the server established (this socket presented no credentials), not
        a claim, so it is honest to tag it `ACTOR_SESSION`.
        """
        return _username(self._client_users.get(client_id, {}).get(scope) if scope else None)

    def _attributed(self, client_id: str, username: str) -> tuple[str, str]:
        """``(actor, actor_source)`` for a write, recipe load or ack on this socket.

        An editor socket is the engineer's, whichever project user its Test-mode
        preview is signed in as. Login and logout records keep the HMI user.
        """
        if client_id in self._editor_clients:
            return audit.ENGINEER_ACTOR, audit.ACTOR_DEVICE_ADMIN
        return username, audit.ACTOR_SESSION

    def _connection_actor(self, client_id: str) -> str:
        """Name the identity this connection established most recently.

        For a message that names no scope (alarm acks: the SDK's ``ackAlarm``
        has none to send). A runtime tab holds one live HmiView, and a remounted
        one gets a new scope while the old scope's entry stays behind, so the
        latest identity — see ``_apply_and_respond_identity`` — is the screen
        the operator is looking at. "guest" when the socket has none.
        """
        return _username(next(reversed((self._client_users.get(client_id) or {}).values()), None))

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
        self._store_identity(client_id, scope, identity)
        await self._send_identity(client_id, scope, identity, doc, request_id=request_id)

    def _store_identity(self, client_id: str, scope: str, identity: dict) -> None:
        scopes = self._client_users.setdefault(client_id, {})
        # Re-insert so the dict's last entry is the latest identity (_connection_actor).
        scopes.pop(scope, None)
        scopes[scope] = identity
        # Evict rather than refuse: the oldest is a view that remounted long
        # ago, and refusing would leave the newest view with no identity.
        while len(scopes) > _MAX_SCOPES_PER_CONNECTION:
            del scopes[next(iter(scopes))]

    async def _send_identity(
        self, client_id: str, scope: str, identity: dict, doc: dict, *, request_id: str | None = None
    ) -> None:
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
                session_token=identity.get("session"),
            ),
        )

    def _start_session(self, user: dict) -> str:
        """A resumable login for *user*, the users.json entry it signed in as."""
        now = time.monotonic()
        self._sessions = {t: s for t, s in self._sessions.items() if s[1] > now}
        token = secrets.token_urlsafe(32)
        self._sessions[token] = (user["username"], now + _SESSION_TTL_S, _credential_mark(user))
        return token

    async def _handle_login(self, client_id: str, msg: LoginMessage) -> None:
        """Validate credentials and update the scoped identity."""
        scope = msg.get("scope", "")
        if not _is_valid_scope(scope):
            return

        username = msg.get("username", "")
        password = msg.get("password", "")
        request_id = msg.get("requestId")

        from services import users_manager
        websocket = self._connections.get(client_id)
        if websocket is None:
            return
        # This socket is on the public runtime prefix, so the throttle in
        # ``users_manager.authenticate`` is the only thing metering guesses
        # here. It reports a lockout by raising; say so rather than letting the
        # operator read "wrong password" for a minute after the fifth typo.
        try:
            authenticated = await users_manager.authenticate(
                username, password, websocket.client.host if websocket.client else None
            )
        except RateLimitError:
            await self._safe_send_json(
                client_id,
                build_auth_error(scope, REASON_RATE_LIMITED, request_id=request_id),
            )
            return
        if authenticated is None:
            await self._safe_send_json(
                client_id,
                build_auth_error(scope, REASON_INVALID_CREDENTIALS, request_id=request_id),
            )
            return

        identity, doc = authenticated
        replaced = self._held_token(client_id, scope)
        identity = {**identity, "session": self._start_session(_user(doc, identity["username"]) or identity)}
        # Stored first so the reset below passes this scope by, and sent last:
        # the tab saves the token of the last user_identity it gets, and a
        # stale scope of the same tab that held the replaced login would
        # otherwise wipe the new one. A panel's other monitors lose it too.
        self._store_identity(client_id, scope, identity)
        await self._reset_sessions({replaced} - {None}, _auto_login_identity(doc), doc)
        # Send what the scope holds now: a sign-out or refresh that landed
        # during the reset wins, and the tab must show what the server enforces.
        current = self._client_users.get(client_id, {}).get(scope, identity)
        await self._send_identity(client_id, scope, current, doc, request_id=request_id)
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
        if not _is_valid_scope(scope):
            return

        panel = msg.get("panel")
        # The editor is the engineer's, never a panel an integration may sign in.
        if is_valid_panel_name(panel) and client_id not in self._editor_clients:
            self._client_panels[client_id] = cast(str, panel)
        else:
            self._client_panels.pop(client_id, None)

        from services import users_manager
        doc = users_manager.load()
        resumed = self._resume_session(msg.get("sessionToken"), doc)
        if resumed is not None:
            await self._apply_and_respond_identity(client_id, scope, resumed, doc)
            return
        await self._apply_and_respond_identity(client_id, scope, _auto_login_identity(doc), doc)

    def _resume_session(self, token: object, doc: dict) -> dict[str, Any] | None:
        """Identity for a still-valid login token, with the user's current groups."""
        if not isinstance(token, str):
            return None
        session = self._sessions.get(token)
        if session is None:
            return None
        username, expires, mark = session
        user = _user(doc, username)
        if expires <= time.monotonic() or user is None or _credential_mark(user) != mark:
            del self._sessions[token]
            return None
        self._sessions[token] = (username, time.monotonic() + _SESSION_TTL_S, mark)
        return {"username": username, "groups": _groups(user), "session": token}

    async def _handle_logout(self, client_id: str, msg: LogoutMessage) -> None:
        """Revert scoped identity back to the auto-login user."""
        scope = msg.get("scope", "")
        if not _is_valid_scope(scope):
            return

        request_id = msg.get("requestId")
        # Read before the revert overwrites it — this is who the session was.
        previous_actor = self._session_actor(client_id, scope)
        ended = self._held_token(client_id, scope)

        from services import users_manager
        doc = users_manager.load()
        identity = _auto_login_identity(doc)
        await self._apply_and_respond_identity(client_id, scope, identity, doc, request_id=request_id)
        # Every monitor sharing this login (a signed-in panel) signs out with it.
        await self._reset_sessions({ended} - {None}, identity, doc)
        # Only a real session ending is worth a record. A logout holding no login
        # — a double logout, or a socket still on the auto-login user — ended
        # nothing, and the trail is append-only and never truncated.
        if ended is not None:
            await audit.emit_async(
                audit.AuditEvent(
                    actor=previous_actor,
                    actor_source=audit.ACTOR_SESSION,
                    action="user.logout",
                    subject=scope,
                )
            )

    # -- Named panels (API v1 sign-in, via api/internal) ----------------------

    def panels(self) -> list[dict[str, Any]]:
        """Each named panel with its connection count and who is signed in on it."""
        users: dict[str, list[str]] = {}
        for client_id, panel in self._client_panels.items():
            users.setdefault(panel, []).append(self._connection_actor(client_id))
        return [
            {"name": name, "connections": len(names), "users": sorted(set(names))}
            for name, names in sorted(users.items())
        ]

    def has_panel(self, panel: str) -> bool:
        return panel in self._client_panels.values()

    def _held_token(self, client_id: str, scope: str) -> str | None:
        return (self._client_users.get(client_id, {}).get(scope) or {}).get("session")

    def _panel_scopes(self, panel: str) -> list[tuple[str, str]]:
        return [
            (client_id, scope)
            for client_id, name in list(self._client_panels.items())
            if name == panel and client_id in self._connections
            for scope in list(self._client_users.get(client_id, {}))
        ]

    async def _set_in_place(self, client_id: str, scope: str, identity: dict, doc: dict) -> None:
        # In place keeps scope order, so _connection_actor still reads the live screen.
        scopes = self._client_users.get(client_id)
        if scopes is None or scope not in scopes:
            return
        scopes[scope] = identity
        await self._send_identity(client_id, scope, identity, doc)

    async def _reset_sessions(self, tokens: set[str], identity: dict, doc: dict) -> set[str]:
        """Give every scope holding one of *tokens* `identity`, then revoke them.

        A panel login is one token on many scopes: each monitor of the panel,
        and any tab that resumed it, even under another panel name or none.
        Returns the usernames it replaced.
        """
        replaced: set[str] = set()
        # Revoked before the first send yields, so no tab can resume one meanwhile.
        for token in tokens:
            self._sessions.pop(token, None)
        for client_id in [c for c in self._client_users if c in self._connections]:
            for scope, held in list(self._client_users.get(client_id, {}).items()):
                # Skip a scope that logged in afresh while an earlier send awaited.
                if held.get("session") in tokens and self._client_users.get(client_id, {}).get(scope) is held:
                    replaced.add(held.get("username", "guest"))
                    await self._set_in_place(client_id, scope, identity, doc)
        return replaced

    async def sign_in_panel(self, panel: str, identity: dict, doc: dict) -> None:
        # One resumable login per panel, so a reload of any of its tabs keeps it.
        pairs = self._panel_scopes(panel)
        replaced = {t for c, s in pairs if (t := self._held_token(c, s))}
        signed_in = {**identity, "session": self._start_session(_user(doc, identity["username"]) or identity)}
        for client_id, scope in pairs:
            await self._set_in_place(client_id, scope, signed_in, doc)
        await self._reset_sessions(replaced, _auto_login_identity(doc), doc)

    async def sign_out_panel(self, panel: str) -> list[str]:
        """Drop *panel*, and every copy of the logins it held, back to the
        auto-login user; returns who was signed in."""
        from services import users_manager
        doc = users_manager.load()
        fallback = _auto_login_identity(doc)
        pairs = self._panel_scopes(panel)
        previous = {self._connection_actor(c) for c, _ in pairs}
        previous |= await self._reset_sessions(
            {t for c, s in pairs if (t := self._held_token(c, s))}, fallback, doc
        )
        for client_id, scope in pairs:
            held = self._client_users.get(client_id, {}).get(scope)
            if held is not None and held != fallback:
                # A login this scope took while the reset above awaited.
                if held.get("session"):
                    self._sessions.pop(held["session"], None)
                previous.add(held.get("username", "guest"))
                await self._set_in_place(client_id, scope, fallback, doc)
        return sorted(previous)

    async def refresh_identities(self) -> None:
        """Re-check every held identity against users.json after a user write:
        a deleted or renamed user, and every login of one whose password
        changed, falls back to the auto-login user; a regrouped one gets its
        new groups. Updated in place, so scope order is kept."""
        from services import users_manager
        doc = users_manager.load()
        users = {u.get("username"): u for u in doc.get("users", []) if isinstance(u, dict)}
        stale = {
            token
            for token, (username, _expires, mark) in self._sessions.items()
            if username not in users or _credential_mark(users[username]) != mark
        }
        await self._reset_sessions(stale, _auto_login_identity(doc), doc)
        for client_id, scopes in list(self._client_users.items()):
            for scope, identity in list(scopes.items()):
                user = users.get(identity.get("username"))
                if user is None:
                    updated = _auto_login_identity(doc)
                else:
                    updated = {**identity, "groups": _groups(user)}
                if updated != identity:
                    scopes[scope] = updated
                    await self._send_identity(client_id, scope, updated, doc)

    async def _send_cached_values(self, client_id: str, composite_keys: set[str]) -> set[str]:
        if self._datasource_manager is None or not composite_keys:
            return set()
        cached = self._datasource_manager.get_cached_values(composite_keys)
        if not cached:
            return set()
        ws = self._connections.get(client_id)
        if ws is None:
            return set()
        await ws.send_text(self._values_frame(client_id, cached))
        return set(cached)

    async def _send_uncached_values(self, client_id: str, composite_keys: set[str]) -> None:
        """Read *composite_keys* from the server and send the client the ones
        its current context still wants — a page it has already left only
        warms the cache for its return."""
        if not composite_keys or self._datasource_manager is None or self._opcua_pool is None:
            return

        fresh_values: dict[str, Any] = {}
        async with self._prefetch_slots:
            # A read that finished since (this socket's last, or another's)
            # may have cached some of them: those are not read again.
            values = self._datasource_manager.get_cached_values(composite_keys)
            for ds_name, paths in _group_priority_paths_by_datasource(composite_keys - values.keys()).items():
                engine = self._opcua_pool.get(ds_name)
                if engine is None:
                    continue
                try:
                    fresh_values.update(await engine.read_current_values(paths))
                except Exception as exc:
                    logger.warning("Failed to prefetch values for %s: %s", ds_name, exc)
            self._datasource_manager.seed_cached_values(fresh_values)
        values.update(fresh_values)
        ws = self._connections.get(client_id)
        wanted = self._client_keys.get(client_id, set())
        values = {k: v for k, v in values.items() if k in wanted}
        if ws is None or not values:
            return
        try:
            await ws.send_text(self._values_frame(client_id, values))
        except Exception:
            self._connections.pop(client_id, None)
            return

    async def _send_context_ready(self, client_id: str, current_page_ids: list[str]) -> None:
        """Tell the client every variable requested by this set_context has
        been sent (from cache and/or freshly read). The client uses this to
        reveal a newly navigated page once its own data has actually arrived,
        instead of a session-wide "a snapshot landed at some point" flag.

        The page ids are echoed so each surface — the routed page and every
        open page overlay — can recognise the ack for its own id and settle on
        it rather than on a timer."""
        ws = self._connections.get(client_id)
        if ws is None:
            return
        try:
            await ws.send_text(
                json.dumps({
                    "type": "context_ready",
                    "currentPageIds": current_page_ids,
                })
            )
        except Exception:
            self._connections.pop(client_id, None)


# -- Helpers -----------------------------------------------------------------


def _user(doc: dict, username: str) -> dict[str, Any] | None:
    return next(
        (u for u in doc.get("users", []) if isinstance(u, dict) and u.get("username") == username),
        None,
    )


def _groups(user: dict) -> list[str]:
    return list(user.get("groups", ["guest"]))


def _is_valid_scope(scope: object) -> bool:
    return isinstance(scope, str) and 0 < len(scope) <= _MAX_SCOPE_LENGTH


def _username(identity: object) -> str:
    """The identity's username, or "guest" when it holds none."""
    username = identity.get("username") if isinstance(identity, dict) else None
    return username if isinstance(username, str) and username else "guest"


def _credential_mark(user: dict) -> str:
    """Fingerprint of the credential a login was granted against: a password
    change alters it, and the logins taken with the old one end."""
    credential = [user.get("passwordHash"), user.get("password", "")]
    return hashlib.sha256(json.dumps(credential, sort_keys=True, default=str).encode()).hexdigest()


def _auto_login_identity(doc: dict) -> dict[str, Any]:
    """The configured autoLoginName user's identity, or bare guest without one."""
    settings = doc.get("settings", {})
    auto_login_name = settings.get("autoLoginName", "guest") if isinstance(settings, dict) else "guest"
    user = next(
        (u for u in doc.get("users", []) if isinstance(u, dict) and u.get("username") == auto_login_name),
        None,
    )
    if user is None:
        return {"username": "guest", "groups": ["guest"]}
    return {"username": user["username"], "groups": _groups(user)}


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


@dataclass
class _RuntimePages:
    """The runtime pages config, with what set_context has resolved from it.

    A context may name 2000 page ids; walking the page tree for each, on every
    set_context, held the event loop for a second. Kept until the config
    changes, each id is walked once.
    """

    config: dict
    # Kept sets are never handed out: ``resolve`` copies them into a fresh one.
    shared_keys: ContextKeys  # header and footer, in every context
    # Every id a page or group node carries: no other id can match a page,
    # so one is answered without a walk and is never kept.
    page_ids: frozenset[str]
    scopes: dict[str, ContextKeys] = field(default_factory=dict)

    def keys_for(self, page_id: str) -> ContextKeys:
        keys = self.scopes.get(page_id)
        if keys is None:
            keys = self.scopes[page_id] = ContextKeys()
            for root in INDEX_ROOTS:
                if _collect_active_scope_composite_keys(self.config.get(root, []), page_id, keys):
                    break
        return keys

    def resolve(self, current_page_ids: list[str]) -> ContextKeys:
        """Header, footer and every current page's keys, with their index refs."""
        keys = ContextKeys()
        for part in (self.shared_keys, *map(self.keys_for, self.page_ids.intersection(current_page_ids))):
            keys |= part
            for key, indexes in part.index_refs.items():
                keys.index_refs.setdefault(key, set()).update(indexes)
        return keys


_runtime_pages_config_cache: _RuntimePages | None = None
_runtime_pages_config_lock = threading.Lock()


def invalidate_runtime_pages_config_cache() -> None:
    """Drop the cached runtime pages_config. Call after writes to config.json or page files."""
    global _runtime_pages_config_cache
    with _runtime_pages_config_lock:
        _runtime_pages_config_cache = None


def _get_runtime_pages() -> _RuntimePages | None:
    global _runtime_pages_config_cache
    with _runtime_pages_config_lock:
        if _runtime_pages_config_cache is not None:
            return _runtime_pages_config_cache
    try:
        raw = read_json(_config_path())
    except Exception as exc:
        logger.warning("set_context: could not read config.json: %s", exc)
        return None
    config = _to_runtime_pages_config(raw)
    shared_keys = ContextKeys()
    _walk_components(config["header"], shared_keys)
    _walk_components(config["footer"], shared_keys)
    page_ids: set[str] = set()
    for root in INDEX_ROOTS:
        _collect_page_ids(config.get(root, []), page_ids)
    runtime = _RuntimePages(config, shared_keys, frozenset(page_ids))
    with _runtime_pages_config_lock:
        _runtime_pages_config_cache = runtime
    return runtime


def _collect_page_ids(nodes: list, ids: set[str]) -> None:
    """Every string id below *nodes* that the page/group walk can reach."""
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if isinstance(node.get("id"), str):
            ids.add(node["id"])
        _collect_page_ids(
            [
                child
                for child in _iter_dict_children(node.get("children", []))
                if _is_page_group_node(node) or _is_page_group_node(child)
            ],
            ids,
        )


def _resolve_context_composite_keys(
    *,
    current_page_ids: list[str],
    explicit_priority_keys: set[str],
) -> set[str]:
    # Datasource live-values can drive fast-subscriptions using explicit
    # priority keys without any page context.
    if not current_page_ids:
        return set(explicit_priority_keys)

    pages = _get_runtime_pages()
    if pages is None:
        return set(explicit_priority_keys)

    composite_keys = pages.resolve(current_page_ids)
    # An explicit key the saved config does not bind (an unsaved edit, a
    # variable table row) carries no index: it is wanted whole.
    for key in explicit_priority_keys:
        if key not in composite_keys:
            composite_keys.index_refs.setdefault(key, set()).add(None)
    composite_keys.update(explicit_priority_keys)
    return composite_keys


def _promotion_keys(composite_keys: set[str], dm: Any) -> set[str]:
    """What to put on the fast subscription for *composite_keys*.

    An array-of-struct folder bound only at literal indexes (``Motors[3]``,
    ``Motors[7]``) is replaced by those element folders, so two bindings into
    a 50-element array promote, cache and ship two elements instead of all
    250 leaves. The client reads the element under its own key (see
    ``resolveElement``) and falls back to ``value[index]`` of the aggregate
    when a context named the array whole.
    """
    keys = set(composite_keys)
    for key, indexes in getattr(composite_keys, "index_refs", {}).items():
        if None in indexes:
            continue
        elements = dm.element_keys(key, indexes)
        if elements:
            keys.discard(key)
            keys |= elements
    return keys


def _iter_dict_children(raw_children: Any) -> list[dict]:
    if not isinstance(raw_children, list):
        return []
    return [child for child in raw_children if isinstance(child, dict)]


def _collect_context_composite_keys(
    raw_pages_config: dict,
    *,
    current_page_ids: list[str],
) -> set[str]:
    """Collect all variable keys for the current runtime context (raw input)."""
    return _collect_from_runtime_pages_config(
        _to_runtime_pages_config(raw_pages_config),
        current_page_ids=current_page_ids,
    )


def _collect_from_runtime_pages_config(
    pages_config: dict,
    *,
    current_page_ids: list[str],
) -> set[str]:
    """Collect variable keys from a pages_config already in runtime shape.

    A current page id may name a page in either index root: the routed page
    lives under ``pages``, an open page overlay under either one."""
    keys: set[str] = ContextKeys()

    _walk_components(pages_config.get("header", []), keys)
    _walk_components(pages_config.get("footer", []), keys)

    for page_id in current_page_ids:
        for root in INDEX_ROOTS:
            if _collect_active_scope_composite_keys(pages_config.get(root, []), page_id, keys):
                break

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
    header  = v if isinstance(v := raw.get("header"),  list) else []
    footer  = v if isinstance(v := raw.get("footer"),  list) else []

    return {
        **{
            root: [
                _to_runtime_page_node(node, root)
                for node in root_nodes(raw, root)
                if isinstance(node, dict)
            ]
            for root in INDEX_ROOTS
        },
        "header": [node for node in header if isinstance(node, dict)],
        "footer": [node for node in footer if isinstance(node, dict)],
    }


def _load_page_file_children(page_id: str, root: str) -> list[dict]:
    """Load a leaf page's widgets from its document — every section's array,
    since a page document keeps its widgets in a ``sections`` map.

    The directory comes from the index root the node was found under, never from
    a search: a leftover ``pages/<id>.json`` beside the real ``dialogs/<id>.json``
    would otherwise decide what the operator sees, and an unreadable document in
    one root would silently serve the other root's.
    """
    try:
        data: Any = read_json(page_document_dir(root) / f"{page_id}.json")
    except Exception:
        # Includes a runtime with no live project, where the resolver itself
        # raises — the same "no document" answer.
        return []
    sections = data.get("sections") if isinstance(data, dict) else None
    if not isinstance(sections, dict):
        return []
    return [
        widget
        for widgets in sections.values()
        if isinstance(widgets, list)
        for widget in widgets
        if isinstance(widget, dict)
    ]


def _to_runtime_page_node(node: dict, root: str) -> dict:
    if _is_page_group_node(node):
        return {
            **{k: v for k, v in node.items() if k != "children"},
            "type": "page-group",
            "children": [
                _to_runtime_page_node(child, root)
                for child in _iter_dict_children(node.get("children", []))
            ],
        }

    runtime = {**node}
    # In v2 split-page storage, leaf page component trees are in per-page files
    # and the index node has no 'children' key.  Load from the file when absent/empty.
    raw_children = _iter_dict_children(node.get("children", []))
    if not raw_children:
        page_id = node.get("id", "")
        raw_children = _load_page_file_children(page_id, root) if page_id else []
    children: list[dict] = []
    for child in raw_children:
        if _is_page_group_node(child):
            children.append(_to_runtime_page_node(child, root))
        else:
            children.append(child)

    runtime["children"] = children
    runtime["type"] = runtime.get("type") or "page"
    return runtime


class ContextKeys(set):
    """The composite keys a context binds, plus how each array folder was
    addressed: ``index_refs[key]`` holds every literal element index bound,
    and ``None`` once something binds the array whole (a Repeater, a bound
    index). ``_promotion_keys`` promotes only the bound elements of an array
    that is addressed by literal indexes alone."""

    def __init__(self, *args: Any) -> None:
        super().__init__(*args)
        self.index_refs: dict[str, set[int | None]] = {}


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
        key = build_var_key(ds, path)
        keys.add(key)
        index = value["$var"].get("index")
        refs = getattr(keys, "index_refs", None)
        if refs is not None:
            literal = isinstance(index, int) and not isinstance(index, bool) and index >= 0
            refs.setdefault(key, set()).add(index if literal else None)
        # A bound index is a source of its own, which may read another variable.
        _extract_variable_keys_from_value(index, keys, depth - 1)
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
