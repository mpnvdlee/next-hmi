"""Internal loopback hooks — driven by the manager, never by browsers.

The multi-project workspace MCP runs in the manager process and edits a
project's files directly. When the edited project has a running child, the
manager POSTs the change here so this child re-reads the affected files and
updates its live clients (open editor tabs) and OPC-UA pipeline.

This router is only reachable on the child's ``127.0.0.1`` instance port. The
manager reverse proxy refuses ``/runtime|editor/<id>/api/internal/*`` (see
``manager.py``), so a browser holding a manager session can never drive it.
"""
from __future__ import annotations

import logging
from typing import Any

from core.storage import active_datasources_dir, read_json
from fastapi import APIRouter
from pydantic import BaseModel, Field
from services.datasource_manager import datasource_manager
from services.datasource_sync import apply_datasource_change, enabled_paths
from services.websocket_manager import ConfigChangedEvent, websocket_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/internal", tags=["internal"])


class ReloadBody(BaseModel):
    artifact_type: str
    artifact_ids: list[str] = Field(default_factory=list)
    source: str = "mcp"
    summary: str = ""
    diff: Any = None
    agent_label: str | None = None


@router.post("/reload")
async def reload(body: ReloadBody) -> dict[str, str]:
    """Re-apply a workspace MCP write to this child's live runtime + clients."""
    # Variable edits change the datasource subscription set; re-apply the delta
    # against the running OPC-UA pipeline before notifying browsers so live
    # values reflect the edit.
    if body.artifact_type == "variables":
        await _reload_datasources(body.artifact_ids)

    event = ConfigChangedEvent(
        artifact_type=body.artifact_type,
        artifact_ids=list(body.artifact_ids),
        source=body.source,
        summary=body.summary,
        diff=body.diff,
        agent_label=body.agent_label,
    )
    await websocket_manager.broadcast_config_changed(event)
    return {"status": "ok"}


async def _reload_datasources(artifact_ids: list[str]) -> None:
    """Re-read each affected datasource and apply its subscription delta.

    Variable artifact ids are ``"<datasource>/<path>"``; we reload each distinct
    datasource once. ``datasource_manager`` still holds the pre-edit config, so
    its current enabled set is the correct ``old_enabled`` for the delta.
    """
    names = {aid.split("/", 1)[0] for aid in artifact_ids if aid}
    for name in names:
        path = active_datasources_dir() / f"{name}.json"
        if not path.exists():
            continue
        try:
            after = read_json(path)
        except Exception:
            logger.warning("reload hook: failed to read datasource %s", name)
            continue
        old_enabled = enabled_paths(datasource_manager.get(name))
        await apply_datasource_change(name, after, old_enabled)
