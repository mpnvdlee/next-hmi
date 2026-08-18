from __future__ import annotations

import asyncio
import logging
from typing import Any

from core.storage import current_scoped_project_id

from .server import get_agent_label

log = logging.getLogger(__name__)

# Strong refs to in-flight broadcast / reload-notify tasks so a fast tool return
# doesn't let the garbage collector reap the task mid-flight. Tasks remove
# themselves via the done callback once they complete.
_inflight: set[asyncio.Task[Any]] = set()

# Loopback HTTP timeout for the manager→child reload hook. The child answers
# immediately (it schedules its own broadcast); a hung child must not bound the
# agent's tool latency.
_RELOAD_TIMEOUT_SECONDS = 5.0

# Shared client for the loopback reload hook. Agents make many sequential edits
# to the same project, so a single keep-alive client avoids a fresh connection
# pool per write. Built lazily and closed by ``drain_inflight_broadcasts``.
_loopback_client: Any = None


def _get_loopback_client() -> Any:
    global _loopback_client
    if _loopback_client is None:
        import httpx

        _loopback_client = httpx.AsyncClient(timeout=_RELOAD_TIMEOUT_SECONDS)
    return _loopback_client


def _track(task: asyncio.Task[Any]) -> None:
    _inflight.add(task)
    task.add_done_callback(_on_broadcast_done)


def _on_broadcast_done(task: asyncio.Task[Any]) -> None:
    _inflight.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        log.debug("emit_change notify failed: %s", exc)


def _event_payload(
    artifact_type: str, artifact_ids: list[str], summary: str, diff: Any, agent_label: str
) -> dict[str, Any]:
    return {
        "artifact_type": artifact_type,
        "artifact_ids": list(artifact_ids),
        "source": "mcp",
        "summary": summary,
        "diff": diff,
        "agent_label": agent_label,
    }


async def emit_change(
    *,
    artifact_type: str,
    artifact_ids: list[str],
    summary: str,
    diff: Any,
) -> None:
    """Publish a project-changed event after a write.

    Two modes:

    * **Workspace (manager).** A ``use_project`` scope is active, so the write
      landed on some project's files. If a child is running for that project,
      POST the change to its loopback reload hook so open browsers + the OPC-UA
      pipeline update; if nothing is running there is nothing to notify and the
      files are simply current for the next start.
    * **In-process (legacy / tests).** No scope — the MCP and the live pipeline
      share a process, so broadcast straight to the local WebSocket manager.
    """
    agent_label = get_agent_label()
    payload = _event_payload(artifact_type, artifact_ids, summary, diff, agent_label)

    project_id = current_scoped_project_id()
    if project_id is not None:
        _track(asyncio.create_task(_notify_child(project_id, payload)))
        return

    # Legacy in-process path.
    from services.websocket_manager import ConfigChangedEvent, websocket_manager

    event = ConfigChangedEvent(
        artifact_type=artifact_type,
        artifact_ids=list(artifact_ids),
        source="mcp",
        summary=summary,
        diff=diff,
        agent_label=agent_label,
    )
    _track(asyncio.create_task(websocket_manager.broadcast_config_changed(event)))


async def _notify_child(project_id: str, payload: dict[str, Any]) -> None:
    """Fire the loopback reload hook on the running child for *project_id*.

    No-op when the project is not running. The child re-reads the affected files
    and broadcasts to its own WebSocket clients.
    """
    from services.supervisor import supervisor

    port = supervisor.port_for(project_id)
    if port is None:
        return
    import httpx

    url = f"http://127.0.0.1:{port}/api/internal/reload"
    try:
        await _get_loopback_client().post(url, json=payload)
    except httpx.HTTPError as exc:
        log.debug("reload hook for '%s' failed: %s", project_id, exc)


async def drain_inflight_broadcasts(timeout: float = 5.0) -> None:
    """Wait for outstanding fire-and-forget notifications to finish.

    Called from the manager lifespan shutdown so a reload hook in flight isn't
    cancelled before it reaches the child.
    """
    global _loopback_client
    if _inflight:
        pending = list(_inflight)
        try:
            await asyncio.wait_for(
                asyncio.gather(*pending, return_exceptions=True), timeout=timeout,
            )
        except TimeoutError:
            log.warning(
                "drain_inflight_broadcasts: %d task(s) still pending after %.1fs",
                len(_inflight), timeout,
            )
    if _loopback_client is not None:
        await _loopback_client.aclose()
        _loopback_client = None
