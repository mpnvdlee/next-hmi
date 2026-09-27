"""Instance-start seam.

Generic plumbing with no policy of its own, mirroring ``core.audit``. **The
public build registers no guards**, so :func:`refusal` always returns ``None``
there and the supervisor behaves exactly as it did before this module existed.

A guard answers one question — may the supervisor spawn a child for this
project right now? — and returns either ``None`` (yes) or a short operator-
facing sentence saying why not. The sentence reaches the dashboard as the
start call's error, so it has to read as an instruction rather than a code.

Guards run on the supervisor's own threads, ahead of the spawn, and must be
cheap and side-effect free: ``resume_all`` calls this once per project on cold
boot, and the crash monitor calls it again on every restart attempt.

Fail-open on a raising guard is deliberate. A guard that throws is a broken
guard, and a broken guard must not be able to keep a factory's screens down —
the same standard the audit seam applies to a failing listener.
"""
from __future__ import annotations

import contextlib
import logging
import threading
from collections.abc import Callable

logger = logging.getLogger(__name__)

StartGuard = Callable[[str], str | None]

_guards: list[StartGuard] = []
_lock = threading.Lock()


class TransientStartRefusal(ValueError):
    """A guard's refusal that may pass on its own, with no operator action.

    A guard answers "may it start *right now*" — the enterprise activation
    gate refuses every start while a licence is lapsed, and lifts itself the
    moment it is renewed. That is unlike the other reasons ``Supervisor.start``
    raises plain ``ValueError`` for (a pending format upgrade, unreadable
    credentials): those are an operator's to-do in the Projects page, and stay
    refused until it is done. ``resume_all`` prunes the persisted running set
    on the latter — an instance nothing will spawn on its own must stop being
    claimed as running — but not on this one, or a reboot during a lapsed
    licence would erase what was running before it and nothing would come back
    once the licence is fixed.
    """


def register_guard(fn: StartGuard) -> None:
    with _lock:
        if fn not in _guards:
            _guards.append(fn)


def unregister_guard(fn: StartGuard) -> None:
    with _lock, contextlib.suppress(ValueError):
        _guards.remove(fn)


def refusal(project_id: str) -> str | None:
    """The first guard's reason for refusing to start *project_id*, or None."""
    with _lock:
        current = list(_guards)
    for fn in current:
        try:
            reason = fn(project_id)
        except Exception:
            logger.exception("start guard failed for '%s' — allowing the start", project_id)
            continue
        if reason:
            return reason
    return None
