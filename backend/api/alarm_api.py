"""Alarm configuration and runtime state API endpoints."""

from __future__ import annotations

from typing import Any

from core import audit
from core.exceptions import AlarmNotFoundError, AlarmValidationError
from fastapi import APIRouter, Query
from models.alarm import (
    AlarmConfig,
    AlarmHistoryEntry,
    AlarmInstance,
    AlarmSummary,
)
from pydantic import BaseModel
from services.alarm_manager import alarm_manager

router = APIRouter(prefix="/api/alarms", tags=["alarms"])


# ── Request models ────────────────────────────────────────────────────────────


class AckRequest(BaseModel):
    username: str


# ── Configuration endpoints ───────────────────────────────────────────────────


@router.get("/config", response_model=AlarmConfig)
def get_alarm_config() -> AlarmConfig:
    """Return the full alarm configuration."""
    return alarm_manager.get_config()


@router.put("/config", response_model=AlarmConfig)
def put_alarm_config(body: AlarmConfig) -> AlarmConfig:
    """Replace the entire alarm configuration."""
    alarm_manager.set_config(body)
    return alarm_manager.get_config()


# ── Runtime state endpoints ───────────────────────────────────────────────────


@router.get("/active", response_model=list[AlarmInstance])
def get_active_alarms() -> list[AlarmInstance]:
    """Return all currently active alarm instances."""
    return alarm_manager.get_active()


@router.get("/history", response_model=list[AlarmHistoryEntry])
def get_alarm_history(
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> list[AlarmHistoryEntry]:
    """Return alarm history entries, newest first."""
    return alarm_manager.get_history(limit=limit, offset=offset)


@router.get("/summary", response_model=AlarmSummary)
def get_alarm_summary() -> AlarmSummary:
    """Return computed alarm summary counts."""
    return alarm_manager.get_summary()


# ── Acknowledgment endpoints ─────────────────────────────────────────────────


@router.post("/ack/{instance_id}")
def ack_alarm(instance_id: str, body: AckRequest) -> dict[str, str]:
    """Acknowledge a single active alarm.

    ``username`` is a claim, and is recorded as one. This route has no session:
    the only real per-user identity in the instance app is established by
    ``login`` over the WebSocket and lives per *connection*
    (``websocket_manager._client_users``), which a separate REST request cannot
    be tied back to. Nothing else gates the route either — on the instance's
    loopback port anyone who can reach it can post any name.

    So the name goes into the trail tagged ``ACTOR_CLAIMED`` and an auditor can
    see that nothing stood behind it. The tempting alternative — checking the
    claimed name against whoever is currently logged in over some WebSocket —
    is rejected on purpose: it would launder a guess into a "verified" record,
    and it succeeds exactly when the impersonated operator is on shift. Real
    attribution here needs the acknowledgement to carry a verified session
    (a WebSocket ack message, or a session token on this route), which is a
    feature, not something this handler can fake.
    """
    if not body.username:
        raise AlarmValidationError("Username is required")
    if not alarm_manager.ack_alarm(instance_id, body.username, actor_source=audit.ACTOR_CLAIMED):
        raise AlarmNotFoundError(f"Active alarm '{instance_id}' not found")
    return {"status": "ok"}


@router.post("/ack-all")
def ack_all_alarms(body: AckRequest) -> dict[str, Any]:
    """Acknowledge all active alarms. ``username`` is unverified — see ``ack_alarm``."""
    if not body.username:
        raise AlarmValidationError("Username is required")
    count = alarm_manager.ack_all(body.username, actor_source=audit.ACTOR_CLAIMED)
    return {"status": "ok", "count": count}
