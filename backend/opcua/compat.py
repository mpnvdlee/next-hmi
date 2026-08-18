"""opcua.compat — compatibility helpers for asyncua runtime issues.

Provides a log filter that downgrades asyncua's "Error in watchdog loop"
from ERROR (with full traceback) to WARNING, since a transient OPC-UA server
disconnect is a normal operational event and not a crash.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def apply_asyncua_watchdog_log_patch() -> None:
    """Downgrade asyncua 'Error in watchdog loop' from ERROR to WARNING.

    asyncua logs a full traceback at ERROR level whenever its internal
    keepalive detects a server disconnect. That is normal behaviour when a PLC
    or test server is temporarily unreachable, so ERROR+traceback is misleading
    noise. This filter demotes those records to WARNING and strips the traceback.
    """
    _MARKER = "_nexthmi_watchdog_patch"
    asyncua_client_logger = logging.getLogger("asyncua.client.client")
    if getattr(asyncua_client_logger, _MARKER, False):
        return

    class _WatchdogFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            if record.levelno == logging.ERROR and "watchdog loop" in record.getMessage():
                # Demote only the *display* level (levelname), not the
                # numeric levelno. Filters run before each handler's own
                # level-threshold check (record.levelno >= hdlr.level) — if
                # levelno itself were lowered to WARNING here, a handler
                # configured at level=ERROR would silently drop the record
                # instead of seeing it (as WARNING, without the traceback).
                # Leaving levelno at ERROR keeps it passing every handler's
                # threshold while still rendering as WARNING (§2.9).
                record.levelname = "WARNING"
                record.exc_info = None
                record.exc_text = None
            return True

    asyncua_client_logger.addFilter(_WatchdogFilter())
    setattr(asyncua_client_logger, _MARKER, True)
