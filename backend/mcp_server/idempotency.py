"""Idempotency cache for MCP write tools.

A retry with the same ``idempotency_key`` returns the cached response
without re-executing the write OR re-broadcasting the change. WebSocket
clients that missed the original broadcast (refresh, reconnect) must
reconcile by re-reading the affected resource — the broadcast is not
re-fired on a cache hit by design (re-firing would duplicate events to
clients that did receive the original).

LRU + TTL + soft byte-size cap. Entries evict oldest-first when either
``CACHE_CAPACITY`` entries or ``CACHE_MAX_BYTES`` total bytes are
exceeded.
"""

from __future__ import annotations

import json
import threading
import time
from collections import OrderedDict
from typing import Any

CACHE_CAPACITY = 1024
CACHE_TTL_SECONDS = 300
CACHE_MAX_BYTES = 4 * 1024 * 1024

_cache: OrderedDict[tuple[str, str], tuple[float, int, Any]] = OrderedDict()
_current_bytes = 0
# Coarse lock guarding both ``_cache`` and ``_current_bytes``. FastMCP serves
# tool calls concurrently and entry expiry / put + pop / size accounting all
# touch shared state — without serialisation the byte counter can drift
# negative when two callers race on an expired entry.
_lock = threading.Lock()


def _estimate_size(response: Any) -> int:
    try:
        return len(json.dumps(response, default=str))
    except Exception:
        return 1024


def get(agent_label: str, idempotency_key: str) -> Any | None:
    global _current_bytes
    if not idempotency_key:
        return None
    key = (agent_label, idempotency_key)
    with _lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        expires_at, size, response = entry
        if time.monotonic() >= expires_at:
            _cache.pop(key, None)
            _current_bytes -= size
            return None
        _cache.move_to_end(key)
        return response


def put(agent_label: str, idempotency_key: str, response: Any) -> None:
    global _current_bytes
    if not idempotency_key:
        return
    key = (agent_label, idempotency_key)
    size = _estimate_size(response)
    expires_at = time.monotonic() + CACHE_TTL_SECONDS
    with _lock:
        if key in _cache:
            _current_bytes -= _cache[key][1]
        _cache[key] = (expires_at, size, response)
        _current_bytes += size
        _cache.move_to_end(key)
        while len(_cache) > CACHE_CAPACITY or _current_bytes > CACHE_MAX_BYTES:
            if not _cache:
                break
            _, (_, evicted_size, _) = _cache.popitem(last=False)
            _current_bytes -= evicted_size


def reset_for_tests() -> None:
    global _current_bytes
    with _lock:
        _cache.clear()
        _current_bytes = 0
