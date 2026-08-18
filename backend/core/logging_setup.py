"""Shared logging configuration for every entry point.

Both ``backend/launcher.py`` (PyInstaller binary) and the FastAPI lifespan
in ``backend/main.py`` (dev + Docker) call into this module so the rotating
log file at ``LOGS_DIR/nexthmi.log`` is wired up the same way regardless of
how the backend was started.
"""
from __future__ import annotations

import logging
import logging.handlers
import sys
from pathlib import Path

from core.storage import LOG_FILE_PATH, LOGS_DIR


def configure_logging(*, verbose: bool = False) -> Path:
    """Wire the root logger to a stderr + rotating-file handler.

    Idempotent: prior handlers are stripped first so callers that fire on
    both the launcher path and the lifespan path don't produce duplicate
    output. Returns the resolved log file path so callers (e.g. the banner)
    can show it to the operator.

    Console: ``--verbose`` → INFO+, default → WARNING+ (keeps the splash
    as the only screen output).

    File: always INFO+ at ``LOGS_DIR/nexthmi.log``, rotated at 5 MB x 3
    backups so a long-running install doesn't grow without bound.
    """
    LOGS_DIR.mkdir(parents=True, exist_ok=True)

    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
    root.setLevel(logging.DEBUG)

    console = logging.StreamHandler(sys.stderr)
    console.setLevel(logging.INFO if verbose else logging.WARNING)
    console.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    root.addHandler(console)

    file_handler = logging.handlers.RotatingFileHandler(
        LOG_FILE_PATH, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    file_handler.setLevel(logging.INFO)
    file_handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    root.addHandler(file_handler)

    # asyncua emits INFO for every subscription_service / monitored_item_service /
    # uaprocessor / publish callback — drowns the log. Real warnings still flow.
    logging.getLogger("asyncua").setLevel(logging.WARNING)

    _silence_client_disconnect_noise()

    return LOG_FILE_PATH


class _ClientDisconnectFilter(logging.Filter):
    """Drop asyncio's traceback for a peer that hung up mid-write.

    A browser closing a tab, a page reload, or a WebSocket dropped on a flaky
    link all leave a half-written response in the transport. asyncio's default
    exception handler reports that as an unhandled callback error, so a normal
    day of operating the HMI fills the terminal and the log file with
    ``ConnectionResetError: [WinError 10054]`` stack traces from
    ``_ProactorBasePipeTransport._call_connection_lost``. There is nothing for
    anyone to act on: the connection is already gone and uvicorn has already
    cleaned up its side.

    Deliberately narrow — only connection-teardown errors raised from that one
    callback are dropped, so a genuine unhandled exception in any other
    callback still surfaces.
    """

    _CONNECTION_ERRORS = (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)

    def filter(self, record: logging.LogRecord) -> bool:
        exc_info = record.exc_info
        if not exc_info or not isinstance(exc_info[1], self._CONNECTION_ERRORS):
            return True
        return "_call_connection_lost" not in record.getMessage()


def _silence_client_disconnect_noise() -> None:
    """Attach ``_ClientDisconnectFilter`` to the ``asyncio`` logger once."""
    asyncio_logger = logging.getLogger("asyncio")
    if any(isinstance(f, _ClientDisconnectFilter) for f in asyncio_logger.filters):
        return
    asyncio_logger.addFilter(_ClientDisconnectFilter())
