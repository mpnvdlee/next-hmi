"""Theme configuration API endpoints.

``/api/themes`` is the multi-theme surface (list/get/create/update/delete +
default pointer). The old singular ``/api/theme`` shim (register R07) was
removed after confirming no caller depended on it.
"""

from typing import Any

from core.exceptions import ThemeValidationError
from fastapi import APIRouter
from models.theme import ThemeConfig, ThemeValidationResult, validate_theme_payload
from pydantic import BaseModel, Field
from services.theme_manager import theme_manager

router = APIRouter(tags=["theme"])


# ── Response / request models ──────────────────────────────────────────────────

class ThemeEnvelope(BaseModel):
    id: str
    config: ThemeConfig


class ThemesIndex(BaseModel):
    default: str
    themes: list[ThemeEnvelope]


class DefaultThemeBody(BaseModel):
    default: str


class CreateThemeBody(BaseModel):
    name: str
    source: str | None = Field(default=None, description="Optional theme id to duplicate from")


# ── Multi-theme endpoints ───────────────────────────────────────────────────────

@router.get("/api/themes", response_model=ThemesIndex)
def list_themes() -> ThemesIndex:
    """All themes plus the default id — enough for the runtime to switch instantly."""
    return ThemesIndex(
        default=theme_manager.get_default_id(),
        themes=[ThemeEnvelope(id=tid, config=cfg) for tid, cfg in theme_manager.list_all()],
    )


# Pointer + builtin-defaults live OFF the /api/themes/{id} path so a theme whose
# id is literally "default"/"defaults" is never shadowed by a static segment.
@router.get("/api/default-theme", response_model=DefaultThemeBody)
def get_default_theme() -> DefaultThemeBody:
    return DefaultThemeBody(default=theme_manager.get_default_id())


@router.put("/api/default-theme", response_model=DefaultThemeBody)
def set_default_theme(body: DefaultThemeBody) -> DefaultThemeBody:
    theme_manager.set_default_id(body.default)
    return DefaultThemeBody(default=theme_manager.get_default_id())


@router.post("/api/themes", response_model=ThemeEnvelope)
def create_theme(body: CreateThemeBody) -> ThemeEnvelope:
    """Create a new theme (optionally duplicated from an existing one)."""
    new_id, config = theme_manager.create(body.name, body.source)
    return ThemeEnvelope(id=new_id, config=config)


@router.get("/api/themes/{theme_id}", response_model=ThemeConfig)
def get_theme(theme_id: str) -> ThemeConfig:
    return theme_manager.get(theme_id)


@router.put("/api/themes/{theme_id}", response_model=ThemeConfig)
def put_theme(theme_id: str, body: ThemeConfig) -> ThemeConfig:
    """Create or replace a theme by id."""
    try:
        return theme_manager.save(theme_id, body)
    except ValueError as e:
        raise ThemeValidationError(str(e)) from e


@router.delete("/api/themes/{theme_id}")
def delete_theme(theme_id: str) -> dict:
    theme_manager.delete(theme_id)
    return {"deleted": theme_id}


@router.post("/api/themes/{theme_id}/validate", response_model=ThemeValidationResult)
def validate_theme_endpoint(theme_id: str, body: dict[str, Any]) -> ThemeValidationResult:
    """Validate a theme configuration without saving it.

    Accepts the raw payload (not a typed ``ThemeConfig``) so malformed input
    is reported as ``{valid: false, errors: [...]}`` through the same
    response model as domain diagnostics, rather than FastAPI's differently
    shaped automatic 422.
    """
    return validate_theme_payload(body)
