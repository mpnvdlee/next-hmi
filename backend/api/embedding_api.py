"""Sites that may embed NEXT HMI (Settings → Sites that may embed NEXT HMI).

Device-level like HTTPS — one origin serves every screen — so it lives on the
manager behind the device-admin session. No restart: ``core.security_headers``
reads the list on every HTML response, re-parsed whenever the file changes. At
most ``embed_settings.MAX_ORIGINS`` sites; a longer list is a readable 422.
"""

from __future__ import annotations

from core import embed_settings
from core.exceptions import ValidationError
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/system/embedding", tags=["system"])


class EmbeddingBody(BaseModel):
    origins: list[str]


@router.get("")
async def get_embedding() -> dict:
    return {"origins": list(embed_settings.allowed_origins())}


@router.put("")
async def put_embedding(body: EmbeddingBody) -> dict:
    try:
        origins = embed_settings.set_allowed_origins(body.origins)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return {"origins": list(origins)}
