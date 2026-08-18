"""Audit-event seam.

Generic plumbing with no audit semantics of its own, and the only audit-related
code that has to be public — its call sites are. **The public build registers no
listeners**, so ``emit()`` is a no-op there and behaviour is unchanged.

Mirrors the listener pattern ``datasource_manager`` already uses for alarms.

Scope, deliberately: an event is only emitted where a **named actor already
exists**. Config, page, theme, translation and widget-source edits are *not*
audited, because they carry no per-user attribution — the instance app's
``config_api``/``theme_api``/``widgets_api`` have no auth of their own and are
gated by the manager proxy's single shared password. Emitting an actor there
would assert attribution the system cannot deliver, which is a finding in
itself rather than partial credit. Closing that gap needs per-user editor
authentication, which is a separate feature.

Where an actor *does* exist, it still may not be worth the same. So every event
also says where its actor came from:

``ACTOR_SESSION``
    The server resolved the name itself, from the identity a connection
    established by authenticating (``websocket_manager._client_users``). The
    caller could not choose it.
``ACTOR_CLAIMED``
    The caller supplied the name and nothing checked it. Recorded because
    dropping it would lose the only lead there is, but recorded *as a claim*.

``actor_source`` defaults to ``ACTOR_CLAIMED``: a call site that forgets to say
then under-claims instead of over-claiming. A trail that overstates what it
knows is worse than one that admits the gap — the same standard that keeps
config edits out of the trail entirely.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

ACTOR_SESSION = "session"
ACTOR_CLAIMED = "claimed"


@dataclass(frozen=True)
class AuditEvent:
    actor: str
    action: str
    subject: str
    actor_source: str = ACTOR_CLAIMED
    detail: dict[str, Any] = field(default_factory=dict)
    ts: datetime = field(default_factory=lambda: datetime.now(UTC))


_listeners: list[Callable[[AuditEvent], None]] = []
_lock = threading.Lock()


def register_listener(fn: Callable[[AuditEvent], None]) -> None:
    with _lock:
        if fn not in _listeners:
            _listeners.append(fn)


def unregister_listener(fn: Callable[[AuditEvent], None]) -> None:
    with _lock, contextlib.suppress(ValueError):
        _listeners.remove(fn)


def emit(event: AuditEvent) -> None:
    """Fan out to every listener. No-op in the public build.

    A failing listener must never break the operation being audited, so
    exceptions are logged and swallowed — the caller is in the middle of an
    alarm acknowledgement, not a logging routine.
    """
    with _lock:
        current = list(_listeners)
    for fn in current:
        try:
            fn(event)
        except Exception:
            logger.exception("audit listener failed for %s", event.action)


async def emit_async(event: AuditEvent) -> None:
    """``emit`` for callers running on the event loop.

    A listener that persists the trail is blocking, fsync'd file I/O, and the
    instance event loop also drives OPC-UA polling and the WebSocket fan-out —
    the same reason the enterprise query routes are sync ``def``. Off-loading
    keeps one operator's write from stalling every other client's updates.
    Awaited rather than fire-and-forget so events reach the listener in the
    order they happened. Short-circuits when nobody is listening, which is
    always the case in the public build, so the thread hop costs nothing there.
    """
    with _lock:
        idle = not _listeners
    if idle:
        return
    await asyncio.to_thread(emit, event)
