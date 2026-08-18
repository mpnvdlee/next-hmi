"""Best-effort "this runtime is alive" ping, so installs can be counted.

A binary handed to an operator otherwise disappears: nothing else in the
product talks to next-hmi.com. One POST on manager start and one every 24h
after it is the whole mechanism — enough to answer "how many installs are
running", and deliberately not enough to profile anyone. What is sent is the
random install id, the build (version + edition) and the platform; no project
names, no addresses, no IP kept at the far end.

Offline is the normal case for a plant network, not an error: a failed ping is
a debug line and nothing more, and the app never waits on one.

Opting out is either ``NEXTHMI_TELEMETRY=off`` (the owning environment wins and
the UI goes read-only) or the Settings → Admin toggle, which the loop re-reads
before every ping so it takes effect without a restart.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import threading
import uuid
from contextlib import suppress
from pathlib import Path
from typing import Any, Literal

import httpx

from core import runtime_home
from core.storage import write_text_atomic
from core.time_utils import iso_now
from core.version import app_edition, app_version

logger = logging.getLogger(__name__)

# The extensionless form on purpose: the site's .htaccess 301s any request that
# spells out ``.php``, and a redirected POST arrives without its body.
PING_URL = "https://next-hmi.com/ping"
HEARTBEAT_SECONDS = 24 * 60 * 60
_TIMEOUT_SECONDS = 5.0

_INSTALL_ID_FILENAME = ".install-id.json"
_SETTINGS_FILENAME = ".telemetry.json"
ENV_VAR = "NEXTHMI_TELEMETRY"
_OFF_VALUES = frozenset({"off", "0", "false", "no"})

Event = Literal["start", "heartbeat"]

_lock = threading.RLock()
_task: asyncio.Task | None = None


def _install_id_path(home: Path | None = None) -> Path:
    return (home or runtime_home.runtime_home_path()) / _INSTALL_ID_FILENAME


def _settings_path(home: Path | None = None) -> Path:
    return (home or runtime_home.runtime_home_path()) / _SETTINGS_FILENAME


def _read_json(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def install_id(home: Path | None = None) -> str:
    """Random per-installation id, minted once and kept in the runtime home.

    Not derived from anything about the machine — a fresh runtime home is a
    fresh install, which is exactly the counting unit wanted here.
    """
    with _lock:
        path = _install_id_path(home)
        stored = _read_json(path).get("installId")
        if isinstance(stored, str) and stored:
            return stored
        minted = uuid.uuid4().hex
        write_text_atomic(
            path,
            json.dumps({"version": 1, "installId": minted, "createdAt": iso_now()}, indent=2),
        )
        return minted


def env_override() -> bool | None:
    """The setting pinned by the environment, or ``None`` when it is ours to own."""
    raw = (os.environ.get(ENV_VAR) or "").strip().lower()
    if not raw:
        return None
    return raw not in _OFF_VALUES


def is_enabled(home: Path | None = None) -> bool:
    override = env_override()
    if override is not None:
        return override
    stored = _read_json(_settings_path(home)).get("enabled")
    return stored is not False


def set_enabled(enabled: bool, home: Path | None = None) -> None:
    with _lock:
        write_text_atomic(
            _settings_path(home),
            json.dumps({"version": 1, "enabled": bool(enabled)}, indent=2),
        )


def status(home: Path | None = None) -> dict[str, Any]:
    return {
        "enabled": is_enabled(home),
        "envOverride": env_override(),
        "installId": install_id(home),
    }


def _payload(event: Event, home: Path | None = None) -> dict[str, str]:
    return {
        "installId": install_id(home),
        "version": app_version(),
        "edition": app_edition(),
        "os": platform.system(),
        "osRelease": platform.release(),
        "python": platform.python_version(),
        "event": event,
    }


async def _ping(event: Event, home: Path | None = None) -> bool:
    """POST one event. Never raises, never retries — the next heartbeat is the retry."""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(_TIMEOUT_SECONDS)) as client:
            response = await client.post(PING_URL, json=_payload(event, home))
        response.raise_for_status()
        return True
    except (httpx.HTTPError, OSError, ValueError) as exc:
        logger.debug("telemetry: %s ping failed: %s", event, exc)
        return False


async def _loop() -> None:
    event: Event = "start"
    while True:
        if is_enabled():
            await _ping(event)
        event = "heartbeat"
        await asyncio.sleep(HEARTBEAT_SECONDS)


def start() -> asyncio.Task | None:
    """Start the ping loop unless it is switched off. Returns ``None`` when it is."""
    global _task
    if not is_enabled():
        logger.debug("telemetry: disabled, no ping loop started")
        return None
    if _task is not None and not _task.done():
        return _task
    _task = asyncio.create_task(_loop())
    return _task


async def stop() -> None:
    global _task
    task, _task = _task, None
    if task is None:
        return
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
