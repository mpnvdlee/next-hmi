"""Recipe configuration, runtime state, and download/upload API endpoints."""

from __future__ import annotations

from typing import Any

from core.exceptions import RecipeNotFoundError
from core.http_origins import invalidate_http_origin_cache
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from models.recipe import DownloadResult, LoadedDataset, RecipeConfig
from pydantic import BaseModel, ConfigDict
from services import users_manager, write_service
from services.datasource_manager import datasource_manager
from services.recipe_manager import recipe_manager
from services.websocket_manager import websocket_manager

router = APIRouter(prefix="/api/recipes", tags=["recipes"])
_download_credentials = HTTPBasic(auto_error=False)


# ── Request / response models ─────────────────────────────────────────────────


class RecipeStateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    loaded: dict[str, LoadedDataset]


class DownloadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verify: bool = False


# ── Configuration endpoints ───────────────────────────────────────────────────


@router.get("/config", response_model=RecipeConfig)
def get_recipe_config() -> RecipeConfig:
    """Return the full recipe configuration."""
    return recipe_manager.get_config()


@router.put("/config", response_model=RecipeConfig)
async def put_recipe_config(body: RecipeConfig) -> RecipeConfig:
    """Replace the entire recipe configuration."""
    recipe_manager.set_config(body)
    # A recipe parameter's binding is a property value, so recipes.json is one
    # of the documents the $http origin allowlist is derived from
    # (core/http_origins.py) — see put_alarm_config for why the mtime
    # fingerprint alone is not enough.
    invalidate_http_origin_cache()
    # Keep parameter variables on the fast subscription for Upload / parametersChanged.
    await websocket_manager.recompute_priority_subscriptions()
    return recipe_manager.get_config()


# ── Runtime state endpoint ────────────────────────────────────────────────────


@router.get("/state", response_model=RecipeStateResponse)
def get_recipe_state() -> RecipeStateResponse:
    """Return the loaded dataset per type."""
    return RecipeStateResponse(loaded=recipe_manager.get_state())


# ── Download / upload endpoints ───────────────────────────────────────────────


async def _caller_identity(credentials: HTTPBasicCredentials | None) -> Any:
    """Who this request writes as: a project user, or nobody.

    This route is on the public runtime allowlist and the instance app has no
    project-user session — the only verified per-user identity it holds is
    established by ``login`` over the WebSocket and lives per *connection*
    (``websocket_manager._client_users``), which a separate REST request cannot
    be tied back to. So a plain request is *anonymous*, and ``None`` is exactly
    how ``write_service.write_permitted`` reads that: the ``guest`` group, the
    same standing an unauthenticated WebSocket has. Credentials lift the caller
    out of it the way they do on ``POST /api/datasources/write`` — and, as
    there, credentials that do not authenticate are refused rather than quietly
    downgraded to guest.
    """
    if credentials is None:
        return None
    authenticated = await users_manager.authenticate(credentials.username, credentials.password)
    if authenticated is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_credentials",
            headers={"WWW-Authenticate": "Basic"},
        )
    identity, _document = authenticated
    return identity


@router.post("/datasets/{dataset_id}/download", response_model=DownloadResult)
async def download_dataset(
    dataset_id: str,
    body: DownloadRequest | None = None,
    credentials: HTTPBasicCredentials | None = Depends(_download_credentials),
) -> DownloadResult:
    """Write a dataset's stored values to their variables (continue on error).

    Every parameter passes the same per-variable write ACL the WebSocket
    ``recipeLoad`` path applies — one that this caller's identity fails becomes a
    ``permission_denied`` failure in the result and is never written.
    """
    verify = body.verify if body is not None else False
    identity = await _caller_identity(credentials)
    result = await recipe_manager.download(
        dataset_id,
        verify=verify,
        permission_check=write_service.write_permission_gate(identity, datasource_manager),
    )
    if result is None:
        raise RecipeNotFoundError(f"Dataset '{dataset_id}' not found")
    return result


@router.post("/datasets/{dataset_id}/upload", response_model=RecipeConfig)
async def upload_dataset(
    dataset_id: str,
    credentials: HTTPBasicCredentials | None = Depends(_download_credentials),
) -> RecipeConfig:
    """Read live values into a dataset, overwriting its stored values in place.

    This route sits on the same anonymous allowlist as its download sibling —
    every parameter passes the same per-variable ACL, and the save is
    attributed to the caller `_caller_identity` resolves rather than to "".
    """
    identity = await _caller_identity(credentials)
    username = identity.get("username", "") if isinstance(identity, dict) else ""
    config = await recipe_manager.upload_into(
        dataset_id,
        username=username,
        permission_check=write_service.write_permission_gate(identity, datasource_manager),
    )
    if config is None:
        raise RecipeNotFoundError(f"Dataset '{dataset_id}' not found")
    return config
