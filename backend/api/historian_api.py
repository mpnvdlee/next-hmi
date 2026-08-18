"""Historian REST API — query, config, and status endpoints."""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

router = APIRouter(prefix="/api/historian", tags=["historian"])


class HistorianVariableConfig(BaseModel):
    """Per-variable historian settings."""
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    minInterval: float = Field(0, ge=0)  # seconds between samples; 0 = no throttle
    retention: float = Field(2_592_000, ge=0)  # seconds; default 30 days


class HistorianConfig(BaseModel):
    """Top-level historian config persisted to <project>/historian/config.json."""
    model_config = ConfigDict(extra="forbid")

    variables: dict[str, HistorianVariableConfig] = Field(default_factory=dict)


@router.get("/query")
async def query_history(
    variables: str = Query(..., description="Comma-separated variable keys"),
    start: str = Query(..., description="Start time (ISO or relative like -1h)"),
    end: str = Query("now", description="End time (ISO or 'now')"),
    maxPoints: int = Query(500, ge=1, le=10000),
) -> dict[str, Any]:
    from services.historian_manager import historian_manager

    try:
        series = await asyncio.to_thread(
            historian_manager.query,
            variables=variables.split(","),
            start=start,
            end=end,
            max_points=maxPoints,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"series": series}


@router.get("/config")
async def get_config() -> dict[str, Any]:
    from services.historian_manager import historian_manager
    return historian_manager.get_config()


@router.put("/config")
async def set_config(body: HistorianConfig) -> dict[str, Any]:
    from services.historian_manager import historian_manager
    from services.websocket_manager import websocket_manager
    historian_manager.set_config(body.model_dump())
    # Re-fold the new enabled-variable set into the fast subscriptions so newly
    # enabled variables start flowing (and are captured) immediately, and newly
    # disabled ones demote unless still held by a page or alarm.
    await websocket_manager.recompute_priority_subscriptions()
    return historian_manager.get_config()


@router.get("/available-variables")
async def available_variables() -> list[str]:
    from services.datasource_manager import datasource_manager

    def _collect() -> list[str]:
        # Use the configured registry — not just cached keys — so variables
        # that haven't received a value yet (cold OPC-UA tag, freshly added)
        # also show up in the historian config picker. The historian only
        # logs numeric scalars, so filter out struct / struct[] kinds.
        metadata = datasource_manager.variable_metadata()
        keys = [k for k, m in metadata.items() if m.get("type", {}).get("kind") == "scalar"]
        keys.sort()
        return keys

    return await asyncio.to_thread(_collect)


@router.get("/status")
async def get_status() -> dict[str, Any]:
    from services.historian_manager import historian_manager
    return await asyncio.to_thread(historian_manager.get_status)
