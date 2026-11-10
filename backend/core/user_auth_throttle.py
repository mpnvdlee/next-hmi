"""Online-guessing throttle for project-user credentials.

The device-admin front door has had one of these since it was exposed
(``core.manager_auth``); this is the same idea for the *project* users in
``users.json``. It matters more here, not less: the live view is reachable with
no manager session at all, so ``POST /api/recipes/datasets/{id}/upload`` and
the WebSocket ``login`` message each hand an anonymous LAN caller an
unlimited, unmetered password oracle — and every attempt costs a 200 000-iteration
PBKDF2, which on a panel PC is an availability problem before it is a
brute-force one.

Three tiers, because one cannot cover all of it:

* **Per username** — five consecutive failures lock *that* name for a minute.
  Stops a targeted guess at the account an attacker actually wants, and leaves
  every other operator able to sign in while it runs.
* **Per client address** — a guess that rotates usernames never meets the
  per-name counter, so 60 failures a minute from one address refuse that
  address for 30 s. That bounds the hashing one client can buy, without
  letting it lock anyone else out.
* **Across everything** — a far higher ceiling of failures a minute trips a
  short cooldown for every caller: the CPU bound for a flood spread over many
  addresses.

An attempt counts as a failure the moment it is admitted
(``begin_attempt``), and a success takes that back. Counted only once its
verification came back, every attempt already in flight had passed the gate
before the first failure counted, and N parallel guesses were N guesses.

In-memory and per-process, like the manager's: it resets on restart, which is
enough to blunt online guessing without dragging in a datastore.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

# Per username: consecutive failures before that name is locked, and for how
# long. Five is the manager's number; an operator who mistypes twice never
# meets it.
_LOCKOUT_THRESHOLD = 5
_LOCKOUT_SECONDS = 60.0

# Per client address, then across all of them: failures inside one window
# before that address (or everyone) is refused for the cooldown. The address
# ceiling sits far above what a panel full of fat-fingered operators produces
# and far below what a brute-force run needs — at ~25 ms of hashing per attempt
# it caps what one client can buy at a few per cent of one core. The global one
# is only a safety net for a flood from many addresses.
_ADDRESS_CEILING = 60
_GLOBAL_CEILING = 300
_FLOOD_WINDOW_SECONDS = 60.0
_FLOOD_LOCKOUT_SECONDS = 30.0

# Usernames, and addresses, tracked at once. The key is whatever was
# *presented*, so an attacker rotating either would otherwise grow these
# without bound.
_MAX_TRACKED = 1024


@dataclass
class _Attempts:
    failures: int = 0
    locked_until: float = 0.0
    # When this record stops meaning anything: failures decay rather than
    # accumulate for ever, so yesterday's typo cannot combine with today's.
    expires_at: float = 0.0


_lock = threading.Lock()
_names: dict[str, _Attempts] = {}
_addresses: dict[str, _Attempts] = {}
_everyone = _Attempts()


def begin_attempt(username: str, address: str | None) -> float:
    """Admit one credential check of *username* from *address*.

    Returns ``0.0`` and counts the check as a failure on every tier, or returns
    the seconds before either may try again and counts nothing.
    """
    now = time.monotonic()
    with _lock:
        _prune(_names, now)
        _prune(_addresses, now)
        address_key = address or ""
        tiers = (_names.get(username), _addresses.get(address_key), _everyone)
        remaining = max(entry.locked_until - now for entry in tiers if entry is not None)
        if remaining > 0:
            return remaining

        entry = _names.get(username)
        if entry is None or entry.expires_at <= now:
            entry = _names[username] = _Attempts()
        entry.failures += 1
        entry.expires_at = now + _LOCKOUT_SECONDS
        if entry.failures >= _LOCKOUT_THRESHOLD:
            entry.failures = 0
            entry.locked_until = entry.expires_at

        _count_flood(_addresses.setdefault(address_key, _Attempts()), now, _ADDRESS_CEILING)
        _count_flood(_everyone, now, _GLOBAL_CEILING)
        return 0.0


def register_login_success(username: str, address: str | None) -> None:
    """Take back the failure ``begin_attempt`` counted, and forget *username*'s
    earlier ones. Its address keeps the rest: one operator signing in from it
    is not evidence its other failures were typos."""
    with _lock:
        _names.pop(username, None)
        for entry in (_addresses.get(address or ""), _everyone):
            if entry is not None and entry.failures:
                entry.failures -= 1


def reset() -> None:
    """Drop all throttle state. For tests, so one module's failed logins cannot
    lock out another's."""
    global _everyone
    with _lock:
        _names.clear()
        _addresses.clear()
        _everyone = _Attempts()


def _count_flood(entry: _Attempts, now: float, ceiling: int) -> None:
    """One failure into a fixed window. Caller holds the lock."""
    if entry.expires_at <= now:
        entry.failures = 0
        entry.expires_at = now + _FLOOD_WINDOW_SECONDS
    entry.failures += 1
    if entry.failures >= ceiling:
        entry.failures = 0
        entry.locked_until = now + _FLOOD_LOCKOUT_SECONDS
        entry.expires_at = entry.locked_until


def _prune(table: dict[str, _Attempts], now: float) -> None:
    """Keep *table* bounded. Caller holds the lock."""
    if len(table) < _MAX_TRACKED:
        return
    for key in [k for k, e in table.items() if e.expires_at <= now]:
        del table[key]
    while len(table) >= _MAX_TRACKED:
        oldest = min(table, key=lambda key: table[key].expires_at)
        del table[oldest]
