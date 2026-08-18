"""Manager-only REST API for the project supervisor.

Mounted on the manager app (not on project instances). Drives start/stop of
per-project child processes and exposes their live status to the dashboard.
The single-live ``make-live`` flow is retired in favour of these.
"""
from __future__ import annotations

import asyncio
import logging

from core.exceptions import ConflictError
from fastapi import APIRouter
from services.supervisor import supervisor

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/manager", tags=["manager"])


@router.get("/running")
async def list_running() -> dict[str, list[dict]]:
    """Status snapshot for every instance the supervisor knows about."""
    return {"instances": supervisor.running_snapshot()}


@router.post("/projects/{project_id}/start", status_code=202)
async def start_project(project_id: str) -> dict:
    try:
        return await asyncio.to_thread(supervisor.start, project_id)
    except ValueError as exc:
        raise ConflictError(str(exc)) from exc


@router.post("/projects/{project_id}/stop", status_code=200)
async def stop_project(project_id: str) -> dict:
    return await asyncio.to_thread(supervisor.stop, project_id)


@router.get("/projects/{project_id}/status")
async def project_status(project_id: str) -> dict:
    snapshot = supervisor.status(project_id)
    return snapshot or {"id": project_id, "status": "stopped"}
