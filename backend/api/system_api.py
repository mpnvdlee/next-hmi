import asyncio
import logging
import multiprocessing
import os
import signal
import sys
import time
from typing import Any

from core import runtime_home
from core.storage import LOG_FILE_PATH, write_text_atomic
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/system", tags=["system"])

_MAX_TAIL_LINES = 5000

_start_time = time.time()
_opcua_pool = None
_deferred_tasks: set[asyncio.Task] = set()


def set_opcua_pool(pool: Any) -> None:
    global _opcua_pool
    _opcua_pool = pool


@router.get("/info")
async def get_system_info():
    """Return basic runtime information about the backend process."""
    return {
        "uptime_seconds": int(time.time() - _start_time),
        "python": sys.version.split()[0],
        "pid": os.getpid(),
    }


@router.get("/subscriptions")
async def get_subscription_status():
    """Return current fast-subscription (priority) paths per OPC-UA client datasource.

    Test-server-backed engines are excluded — they appear in opcua_pool under the
    same name but their type in the datasource registry is 'opcua-test-server'.
    """
    if _opcua_pool is None:
        return {}
    from services.datasource_manager import (
        datasource_manager,  # local import avoids circular dep
    )
    status = _opcua_pool.subscription_status()
    return {
        name: entry for name, entry in status.items()
        if (entry_ds := datasource_manager.get(name)) is not None
        and entry_ds.ds_type != "opcua-test-server"
    }


@router.get("/alarm-triggers")
def get_alarm_trigger_paths():
    """Return OPC-UA paths that the alarm manager keeps on the fast subscription,
    grouped by datasource name.  Not per-client — this is the global alarm config view.
    """
    from services.alarm_manager import alarm_manager  # local import avoids circular dep
    return {ds: sorted(paths) for ds, paths in alarm_manager.get_trigger_paths_by_datasource().items()}


@router.get("/historian-paths")
def get_historian_paths():
    """Return OPC-UA paths the historian keeps on the fast subscription (its enabled
    variables), grouped by datasource name. Empty when historian is unlicensed/idle.
    """
    from services.historian_manager import (
        historian_manager,  # local import avoids circular dep
    )
    return {ds: sorted(paths) for ds, paths in historian_manager.get_historized_paths_by_datasource().items()}


# Backstop for a lifespan teardown that never finishes. It has to stay clear of
# a *legitimate* shutdown: the manager terminates its project children one at a
# time, each with its own SIGTERM grace plus a SIGKILL wait, so an honest
# shutdown costs roughly that per running project. A fixed 8s — one child's
# grace on its own — fired during ordinary restarts and hard-exited past the
# launcher's sentinel re-exec, which shut the device down instead of restarting
# it.
_HARD_EXIT_GRACE_FLOOR_SECONDS = 30.0
_RESPONSE_FLUSH_DELAY = 0.1


def _hard_exit_grace_seconds() -> float:
    """How long to let teardown run before abandoning it.

    Read from the supervisor only if it is already loaded — the manager owns
    children, a project instance has none and must not pull the module in just
    to ask.
    """
    supervisor_module = sys.modules.get("services.supervisor")
    if supervisor_module is None:
        return _HARD_EXIT_GRACE_FLOOR_SECONDS
    try:
        children = len(supervisor_module.supervisor.running_snapshot())
        per_child = supervisor_module._STOP_GRACE_SECONDS + 5.0
    except Exception:
        return _HARD_EXIT_GRACE_FLOOR_SECONDS
    return max(_HARD_EXIT_GRACE_FLOOR_SECONDS, children * per_child + 10.0)


def write_restart_sentinel(reason: str) -> None:
    """Drop the supervisor's restart marker. Atomic + crash-safe."""
    path = runtime_home.restart_sentinel_path()
    payload = f"{int(time.time())} {reason}\n"
    write_text_atomic(path, payload)


def _signal_reload_parent_if_any() -> None:
    """SIGTERM the uvicorn ``--reload`` parent so the dev supervisor can respawn.

    With ``--reload`` the worker is a multiprocessing child of a long-lived
    reloader; SIGTERMing only the worker leaves the reloader polling for file
    changes forever, blocking ``start-dev.py``'s wait. Single-process runs
    (``launcher.py`` in production) have no multiprocessing parent, so this
    is a no-op there.
    """
    parent = multiprocessing.parent_process()
    if parent is None or not parent.pid:
        return
    try:
        os.kill(parent.pid, signal.SIGTERM)
    except OSError as exc:
        logger.warning("restart: could not signal reload parent %s: %s", parent.pid, exc)


async def shutdown_after_response(reason: str) -> None:
    """Yield for the 202 to flush, then signal SIGTERM (graceful) and
    fall back to a hard exit if lifespan teardown stalls.

    Signalling *ourselves* is enough: uvicorn's SIGTERM handler flips
    ``should_exit``, so the serve loop unwinds and the lifespan ``finally``
    runs. It then restores the previous handler and re-raises the signal, which
    is why ``launcher._absorb_uvicorns_signal_reraise`` has to own SIGTERM
    across that boundary — otherwise the re-raise lands on the default
    disposition and kills us before the sentinel re-exec.

    Extracted as a module-level coroutine so tests can drive it directly
    without racing the TestClient lifespan thread.
    """
    await asyncio.sleep(_RESPONSE_FLUSH_DELAY)
    logger.info("restart: signalling SIGTERM for graceful shutdown (reason=%s)", reason)
    _signal_reload_parent_if_any()
    try:
        signal.raise_signal(signal.SIGTERM)
    except (AttributeError, ValueError, OSError):
        os.kill(os.getpid(), signal.SIGTERM)
    grace = _hard_exit_grace_seconds()
    await asyncio.sleep(grace)
    logger.warning("restart: graceful shutdown exceeded %ss — hard exit", grace)
    os._exit(0)


@router.post("/restart", status_code=202)
async def restart_backend(reason: str = "manual"):
    """Clean-restart the backend process.

    1. Write the restart sentinel under the runtime home — the supervisor
       (``launcher.py`` for binaries, ``start-dev.py`` for the dev runner) reads
       this file after a clean exit to distinguish a requested restart from
       a normal shutdown.
    2. Broadcast ``{type: "restarting"}`` so clients can paint a
       "reconnecting…" banner before their socket closes.
    3. Signal ourselves with ``SIGTERM`` — uvicorn catches it and runs the
       lifespan shutdown (OPC-UA pool, WS connections, log flush).
    4. As a safety net, fall back to ``os._exit(0)`` if lifespan teardown
       hasn't completed within ``_hard_exit_grace_seconds()``. Without this
       a stuck async task could pin the process forever.

    Returns 202 immediately so the caller can begin polling ``/api/system/info``
    for the new PID.
    """
    try:
        write_restart_sentinel(reason)
    except OSError as exc:
        logger.error("restart: failed to write sentinel: %s", exc)
        raise HTTPException(status_code=500, detail="Could not write restart sentinel") from exc

    from services.websocket_manager import (
        websocket_manager,  # local import — avoids circular dep
    )
    await websocket_manager.broadcast_restarting(reason=reason)

    task = asyncio.create_task(shutdown_after_response(reason))
    _deferred_tasks.add(task)
    task.add_done_callback(_deferred_tasks.discard)
    return {"status": "restarting", "reason": reason}


@router.get("/runtimes")
def get_runtimes() -> dict:
    """Return currently connected runtime scopes with identity info (diagnostics only)."""
    from services.websocket_manager import websocket_manager
    return {"runtimes": websocket_manager.get_runtime_sessions()}


@router.get("/runtime-home")
def get_runtime_home() -> dict[str, Any]:
    """Return the runtime home dir.

    Resolved fresh from env / bootstrap on each call so the response always
    matches what ``core.storage`` sees.
    """
    return {"path": str(runtime_home.runtime_home_path())}


@router.get("/logs")
def get_logs(lines: int = 500) -> dict[str, Any]:
    """Return the last ``lines`` entries from the application log file.

    The log file is capped at 5 MB by the rotating handler, so reading the
    whole file then slicing is cheap. Returns an empty list (not 404) when
    the file doesn't exist yet — first-startup case before any log lines.
    """
    n = max(1, min(lines, _MAX_TAIL_LINES))
    if not LOG_FILE_PATH.exists():
        return {"path": str(LOG_FILE_PATH), "lines": [], "returned": 0, "total": 0, "truncated": False}
    text = LOG_FILE_PATH.read_text(encoding="utf-8", errors="replace")
    all_lines = text.splitlines()
    tail = all_lines[-n:]
    return {
        "path": str(LOG_FILE_PATH),
        "lines": tail,
        "returned": len(tail),
        "total": len(all_lines),
        "truncated": len(all_lines) > len(tail),
    }


@router.get("/logs/download")
def download_logs() -> FileResponse:
    """Stream the current (non-rotated) log file as an attachment."""
    if not LOG_FILE_PATH.exists():
        raise HTTPException(status_code=404, detail="No log file yet")
    return FileResponse(
        LOG_FILE_PATH,
        media_type="text/plain",
        filename=LOG_FILE_PATH.name,
    )


# Read-only subset for the manager app's device Settings page. The manager has no
# project pipeline, so it exposes only the process-generic diagnostics — never the
# project-only endpoints above nor /restart (which would SIGTERM the supervisor and
# tear down every running project).
manager_router = APIRouter(prefix="/api/system", tags=["system"])
manager_router.add_api_route("/info", get_system_info, methods=["GET"])
manager_router.add_api_route("/logs", get_logs, methods=["GET"])
manager_router.add_api_route("/logs/download", download_logs, methods=["GET"])
