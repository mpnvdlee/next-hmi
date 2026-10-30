"""Best-effort "this runtime is alive" ping, so installs can be counted.

A binary handed to an operator otherwise disappears: nothing else in the
product talks to next-hmi.com. One POST on manager start and one every hour
after it is the whole mechanism — enough to answer "how many installs are
running, for how long, and do they get past connecting", and deliberately not
enough to profile anyone. What is sent is the random install id, the build, the
platform, how it was installed, three first-time flags and coarse size classes;
no project names, no tag names, no addresses, no IP kept at the far end.

Offline is the normal case for a plant network, not an error: a failed ping is
a debug line and nothing more, and the app never waits on one. Everything a
ping carries is state on disk or in this process, so a missed ping loses
nothing the next one does not resend.

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
import sys
import threading
import time
import uuid
from contextlib import suppress
from pathlib import Path
from typing import Any, Literal

import httpx
from models.datasource import flatten_with_paths

from core import runtime_home
from core.manifest import load_manifest, project_mcp_enabled, read_project_config
from core.storage import write_text_atomic
from core.time_utils import iso_now
from core.version import app_edition, app_version

logger = logging.getLogger(__name__)

# The extensionless form on purpose: the site's .htaccess 301s any request that
# spells out ``.php``, and a redirected POST arrives without its body.
PING_URL = "https://next-hmi.com/ping"
HEARTBEAT_SECONDS = 60 * 60
_TIMEOUT_SECONDS = 5.0

_INSTALL_ID_FILENAME = ".install-id.json"
_SETTINGS_FILENAME = ".telemetry.json"
_SESSION_FILENAME = ".telemetry-session.json"
_MILESTONES_DIRNAME = ".telemetry-milestones"
ENV_VAR = "NEXTHMI_TELEMETRY"
_OFF_VALUES = frozenset({"off", "0", "false", "no"})

Event = Literal["start", "heartbeat"]
Milestone = Literal["connected", "pageSaved", "mcpUsed"]
MILESTONES: tuple[Milestone, ...] = ("connected", "pageSaved", "mcpUsed")

_lock = threading.RLock()
_task: asyncio.Task | None = None
# Set by start(); a heartbeat without a session is never sent.
_session: dict[str, Any] | None = None


def _install_id_path(home: Path | None = None) -> Path:
    return (home or runtime_home.runtime_home_path()) / _INSTALL_ID_FILENAME


def _settings_path(home: Path | None = None) -> Path:
    return (home or runtime_home.runtime_home_path()) / _SETTINGS_FILENAME


def _session_path(home: Path | None = None) -> Path:
    return (home or runtime_home.runtime_home_path()) / _SESSION_FILENAME


def _milestone_path(milestone: Milestone, home: Path | None = None) -> Path:
    return (home or runtime_home.runtime_home_path()) / _MILESTONES_DIRNAME / milestone


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


def _update_settings(home: Path | None = None, **changes: Any) -> None:
    with _lock:
        path = _settings_path(home)
        write_text_atomic(
            path, json.dumps({**_read_json(path), "version": 1, **changes}, indent=2)
        )


def set_enabled(enabled: bool, home: Path | None = None) -> None:
    _update_settings(home, enabled=bool(enabled))


def dismiss_contact_prompt(home: Path | None = None) -> None:
    _update_settings(home, contactPromptDismissed=True)


# ── first-time milestones ────────────────────────────────────────────────────


def mark(milestone: Milestone, home: Path | None = None) -> None:
    """Record that this installation reached *milestone*. Sticky and idempotent.

    Called from project instances as well as the manager, so each milestone is
    its own file: there is no shared document for two processes to race on.
    Recorded whether or not reporting is on — the contact prompt reads them too,
    and nothing leaves the machine from here.
    """
    path = _milestone_path(milestone, home)
    if path.exists():
        return
    try:
        write_text_atomic(path, iso_now())
    except OSError as exc:
        logger.debug("telemetry: could not record %s: %s", milestone, exc)


def milestones(home: Path | None = None) -> dict[str, bool]:
    return {m: _milestone_path(m, home).exists() for m in MILESTONES}


def status(home: Path | None = None) -> dict[str, Any]:
    reached = milestones(home)
    return {
        "enabled": is_enabled(home),
        "envOverride": env_override(),
        "installId": install_id(home),
        # Asked once, and only of an installation that is past trying it out.
        "contactPrompt": reached["connected"]
        and reached["pageSaved"]
        and not _read_json(_settings_path(home)).get("contactPromptDismissed"),
    }


# ── what the ping describes ──────────────────────────────────────────────────


def install_method() -> str:
    if getattr(sys, "frozen", False):
        return "bundle"
    if runtime_home._running_from_checkout():
        return "source"
    if Path("/.dockerenv").exists() or Path("/run/.containerenv").exists():
        return "docker"
    return "other"


def size_class(count: int) -> str:
    if count <= 0:
        return "0"
    if count <= 10:
        return "1-10"
    if count <= 100:
        return "11-100"
    return "100+"


def usage() -> dict[str, Any]:
    """Coarse size of what is configured across every project in the manifest.

    Counts and classes only: the files are read for their shape, and no name,
    path or value from them is ever part of the result.
    """
    pages = tags = opcua = 0
    mcp_enabled = False
    try:
        projects = load_manifest().projects
    except Exception as exc:
        logger.debug("telemetry: manifest unreadable: %s", exc)
        projects = []
    for entry in projects:
        root = Path(entry.path)
        # A malformed project must cost its own counts, never the ping.
        try:
            pages += sum(1 for _ in root.glob("pages/*.json"))
            for source in root.glob("datasources/*.json"):
                document = _read_json(source)
                if document.get("type") == "opcua-client":
                    opcua += 1
                variables = document.get("variables")
                if isinstance(variables, list):
                    tags += len(flatten_with_paths(variables))
            mcp_enabled = mcp_enabled or project_mcp_enabled(root, read_project_config(root))
        except Exception as exc:
            logger.debug("telemetry: skipped counting a project: %s", exc)
    return {
        "opcuaConns": size_class(opcua),
        "tags": size_class(tags),
        "pages": size_class(pages),
        "mcpEnabled": mcp_enabled,
    }


# ── sessions ─────────────────────────────────────────────────────────────────


def _begin_session(home: Path | None = None) -> dict[str, Any]:
    """Open a session and report how the previous one ended.

    A stop event would miss exactly the endings worth knowing about — a crash,
    a kill, a power cut — so the clean flag is written on a graceful stop and
    read back on the next start instead.
    """
    with _lock:
        path = _session_path(home)
        previous = _read_json(path)
        if not previous:
            prev_exit = "none"
        else:
            prev_exit = "clean" if previous.get("clean") is True else "unclean"
        prev_version = previous.get("appVersion")
        session = {
            "sessionId": uuid.uuid4().hex,
            "startedAt": time.monotonic(),
            "prevExit": prev_exit,
            "prevVersion": (
                prev_version
                if isinstance(prev_version, str) and prev_version != app_version()
                else ""
            ),
        }
        write_text_atomic(
            path,
            json.dumps(
                {
                    "version": 1,
                    "sessionId": session["sessionId"],
                    "appVersion": app_version(),
                    "clean": False,
                },
                indent=2,
            ),
        )
        return session


def _end_session(session: dict[str, Any], home: Path | None = None) -> None:
    with _lock:
        path = _session_path(home)
        stored = _read_json(path)
        if stored.get("sessionId") != session["sessionId"]:
            return
        write_text_atomic(path, json.dumps({**stored, "clean": True}, indent=2))


def _payload(event: Event, session: dict[str, Any], home: Path | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "installId": install_id(home),
        "version": app_version(),
        "edition": app_edition(),
        "os": platform.system(),
        "osRelease": platform.release(),
        "python": platform.python_version(),
        "event": event,
        "installMethod": install_method(),
        "sessionId": session["sessionId"],
        "uptimeS": int(time.monotonic() - session["startedAt"]),
        **milestones(home),
        **usage(),
    }
    if event == "start":
        payload["prevExit"] = session["prevExit"]
        payload["prevVersion"] = session["prevVersion"]
    return payload


async def _ping(event: Event, session: dict[str, Any], home: Path | None = None) -> bool:
    """POST one event. Never raises, never retries — the next heartbeat is the retry."""
    try:
        # Off the loop: usage() walks every project's pages and datasources.
        payload = await asyncio.to_thread(_payload, event, session, home)
        async with httpx.AsyncClient(timeout=httpx.Timeout(_TIMEOUT_SECONDS)) as client:
            response = await client.post(PING_URL, json=payload)
        response.raise_for_status()
        return True
    except (httpx.HTTPError, OSError, ValueError) as exc:
        logger.debug("telemetry: %s ping failed: %s", event, exc)
        return False


async def _loop(session: dict[str, Any]) -> None:
    event: Event = "start"
    while True:
        if is_enabled():
            await _ping(event, session)
        event = "heartbeat"
        await asyncio.sleep(HEARTBEAT_SECONDS)


def start() -> asyncio.Task | None:
    """Start the ping loop unless it is switched off. Returns ``None`` when it is."""
    global _task, _session
    if not is_enabled():
        logger.debug("telemetry: disabled, no ping loop started")
        return None
    if _task is not None and not _task.done():
        return _task
    _session = _begin_session()
    _task = asyncio.create_task(_loop(_session))
    return _task


async def stop() -> None:
    global _task, _session
    task, _task = _task, None
    session, _session = _session, None
    if task is None:
        return
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    if session is not None:
        try:
            _end_session(session)
        except OSError as exc:
            logger.debug("telemetry: could not close the session: %s", exc)
