"""Usage-reporting switch (Admin → Usage reporting).

Device-level like HTTPS: one runtime home, one install id, one setting — so it
lives on the manager behind the device-admin session. No restart contract here,
unlike ``tls_api``: the ping loop re-reads the setting before every send.
"""

from __future__ import annotations

from core import telemetry
from core.exceptions import ConflictError
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/system/telemetry", tags=["system"])


class TelemetryBody(BaseModel):
    enabled: bool


@router.get("")
async def get_telemetry() -> dict:
    return telemetry.status()


@router.put("")
async def put_telemetry(body: TelemetryBody) -> dict:
    if telemetry.env_override() is not None:
        raise ConflictError(
            f"Usage reporting is pinned by {telemetry.ENV_VAR}; unset it to change this here"
        )
    telemetry.set_enabled(body.enabled)
    return telemetry.status()
