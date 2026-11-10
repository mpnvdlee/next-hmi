"""Recipe configuration, runtime state, and download/upload API endpoints."""

from __future__ import annotations

from core import audit
from core.exceptions import RecipeNotFoundError
from core.http_origins import invalidate_http_origin_cache
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from models.recipe import DownloadResult, LoadedDataset, RecipeConfig
from pydantic import BaseModel, ConfigDict
from services import users_manager
from services.recipe_manager import audit_load, recipe_manager
from services.websocket_manager import websocket_manager

from api.change_broadcast import broadcasts

router = APIRouter(prefix="/api/recipes", tags=["recipes"])
_upload_credentials = HTTPBasic(auto_error=False)


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


@router.put("/config", response_model=RecipeConfig, dependencies=[broadcasts("recipes")])
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


async def _caller_username(request: Request, credentials: HTTPBasicCredentials | None) -> str:
    """Who an upload is attributed to: a project user, or nobody ("").

    This route is on the public runtime allowlist and the instance app has no
    project-user session — the only verified per-user identity it holds is
    established by ``login`` over the WebSocket and lives per *connection*
    (``websocket_manager._client_users``), which a separate REST request cannot
    be tied back to. Credentials name the caller the way they do on
    ``POST /api/datasources/write`` — and, as there, credentials that do not
    authenticate are refused rather than quietly dropped.
    """
    if credentials is None:
        return ""
    authenticated = await users_manager.authenticate(
        credentials.username, credentials.password, request.client.host if request.client else None
    )
    if authenticated is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_credentials",
            headers={"WWW-Authenticate": "Basic"},
        )
    identity, _document = authenticated
    return identity["username"]


@router.post("/datasets/{dataset_id}/download", response_model=DownloadResult)
async def download_dataset(
    dataset_id: str,
    request: Request,
    body: DownloadRequest | None = None,
) -> DownloadResult:
    """Write a dataset's stored values to their variables (continue on error).

    Audited as ``recipe.load``. The route carries no sign-in, so the actor is
    ``guest`` — or ``engineer`` when the manager marked the request as coming
    through the session-gated editor prefix.
    """
    verify = body.verify if body is not None else False
    result = await recipe_manager.download(dataset_id, verify=verify)
    if result is None:
        raise RecipeNotFoundError(f"Dataset '{dataset_id}' not found")
    if audit.from_editor(request.headers):
        await audit_load(result, audit.ENGINEER_ACTOR, audit.ACTOR_DEVICE_ADMIN)
    else:
        await audit_load(result, "guest", audit.ACTOR_ANONYMOUS)
    return result


@router.post(
    "/datasets/{dataset_id}/upload",
    response_model=RecipeConfig,
    dependencies=[broadcasts("recipes")],
)
async def upload_dataset(
    dataset_id: str,
    request: Request,
    credentials: HTTPBasicCredentials | None = Depends(_upload_credentials),
) -> RecipeConfig:
    """Read live values into a dataset, overwriting its stored values in place.

    The save is attributed to ``engineer`` through the editor, else to the
    caller ``_caller_username`` resolves.
    """
    username = (
        audit.ENGINEER_ACTOR
        if audit.from_editor(request.headers)
        else await _caller_username(request, credentials)
    )
    config = await recipe_manager.upload_into(dataset_id, username=username)
    if config is None:
        raise RecipeNotFoundError(f"Dataset '{dataset_id}' not found")
    return config
