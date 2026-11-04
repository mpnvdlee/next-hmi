"""Alarm configuration and runtime state API endpoints."""

from __future__ import annotations

from core.http_origins import invalidate_http_origin_cache
from fastapi import APIRouter, Query
from models.alarm import (
    AlarmConfig,
    AlarmHistoryEntry,
    AlarmInstance,
    AlarmSummary,
)
from services.alarm_manager import alarm_manager

from api.change_broadcast import broadcasts

router = APIRouter(prefix="/api/alarms", tags=["alarms"])


# ── Configuration endpoints ───────────────────────────────────────────────────


@router.get("/config", response_model=AlarmConfig)
def get_alarm_config() -> AlarmConfig:
    """Return the full alarm configuration."""
    return alarm_manager.get_config()


@router.put("/config", response_model=AlarmConfig, dependencies=[broadcasts("alarms")])
def put_alarm_config(body: AlarmConfig) -> AlarmConfig:
    """Replace the entire alarm configuration."""
    alarm_manager.set_config(body)
    # Alarm titles, descriptions and trigger bounds are property values, so
    # alarms.json is one of the documents the $http origin allowlist is derived
    # from (core/http_origins.py). Its mtime fingerprint alone is not enough on
    # a filesystem with coarse granularity, and stale there means the public
    # proxy still trusts an origin this save removed.
    invalidate_http_origin_cache()
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
