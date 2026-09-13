"""Online-guessing throttle for project-user credentials.

The device-admin front door has had one of these since it was exposed
(``core.manager_auth``); this is the same idea for the *project* users in
``users.json``. It matters more here, not less: the live view is reachable with
no manager session at all, so ``POST /api/datasources/write``,
``POST /api/recipes/datasets/{id}/download`` and the WebSocket ``login`` message
each hand an anonymous LAN caller an unlimited, unmetered password oracle — and
every attempt costs a 200 000-iteration PBKDF2, which on a panel PC is an
availability problem before it is a brute-force one.

Two tiers, because one cannot cover both:

* **Per username** — five consecutive failures lock *that* name for a minute.
  Stops a targeted guess at the account an attacker actually wants, and leaves
  every other operator able to sign in while it runs.
* **Across all names** — a flood that rotates usernames never trips the
  per-name counter, so a much higher ceiling of failures per minute trips a
  short global cooldown. That is the CPU bound: without it, unlimited names buy
  unlimited hashing.

In-memory and per-process, like the manager's: it resets on restart, which is
enough to blunt online guessing without dragging in a datastore.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

# Per-username: consecutive failures before that name is locked, and for how
# long. Five is the manager's number; an operator who mistypes twice never
# meets it.
_LOCKOUT_THRESHOLD = 5
_LOCKOUT_SECONDS = 60.0

# Across all usernames: failures inside one window before every credential
# check is refused for the cooldown. Set far above what a panel full of
# fat-fingered operators produces, and far below what a brute-force run needs —
# at ~25 ms of hashing per attempt this caps the work an anonymous flood can
# buy at a few per cent of one core.
_FLOOD_CEILING = 60
_FLOOD_WINDOW_SECONDS = 60.0
_FLOOD_LOCKOUT_SECONDS = 30.0

# Usernames tracked at once. The key is whatever name was *presented*, so an
# attacker rotating names would otherwise grow this without bound.
_MAX_TRACKED = 1024


@dataclass
class _Attempts:
    failures: int = 0
    locked_until: float = 0.0
    # When this record stops meaning anything: failures decay rather than
    # accumulate for ever, so yesterday's typo cannot combine with today's.
    expires_at: float = 0.0


_lock = threading.Lock()
_attempts: dict[str, _Attempts] = {}
_flood_failures = 0
_flood_window_start = 0.0
_flood_until = 0.0


def lockout_remaining(username: str) -> float:
    """Seconds before *username* may present a credential again, else ``0.0``."""
    now = time.monotonic()
    with _lock:
        remaining = max(0.0, _flood_until - now)
        entry = _attempts.get(username)
        if entry is not None:
            remaining = max(remaining, entry.locked_until - now)
        return max(0.0, remaining)


def register_login_failure(username: str) -> None:
    """Count a failed credential check for *username*, tripping either tier."""
    global _flood_failures, _flood_window_start, _flood_until
    now = time.monotonic()
    with _lock:
        _prune(now)
        entry = _attempts.get(username)
        if entry is None or entry.expires_at <= now:
            entry = _Attempts()
            _attempts[username] = entry
        entry.failures += 1
        entry.expires_at = now + _LOCKOUT_SECONDS
        if entry.failures >= _LOCKOUT_THRESHOLD:
            entry.failures = 0
            entry.locked_until = now + _LOCKOUT_SECONDS
            entry.expires_at = entry.locked_until

        if now - _flood_window_start > _FLOOD_WINDOW_SECONDS:
            _flood_window_start = now
            _flood_failures = 0
        _flood_failures += 1
        if _flood_failures >= _FLOOD_CEILING:
            _flood_failures = 0
            _flood_window_start = now
            _flood_until = now + _FLOOD_LOCKOUT_SECONDS


def register_login_success(username: str) -> None:
    """Forget *username*'s failures. The flood window is deliberately left
    alone — one operator signing in mid-flood is not evidence the flood ended.
    """
    with _lock:
        _attempts.pop(username, None)


def reset() -> None:
    """Drop all throttle state. For tests, so one module's failed logins cannot
    lock out another's."""
    global _flood_failures, _flood_window_start, _flood_until
    with _lock:
        _attempts.clear()
        _flood_failures = 0
        _flood_window_start = 0.0
        _flood_until = 0.0


def _prune(now: float) -> None:
    """Keep the table bounded. Caller holds the lock."""
    if len(_attempts) < _MAX_TRACKED:
        return
    for name in [n for n, e in _attempts.items() if e.expires_at <= now]:
        del _attempts[name]
    while len(_attempts) >= _MAX_TRACKED:
        oldest = min(_attempts, key=lambda name: _attempts[name].expires_at)
        del _attempts[oldest]
