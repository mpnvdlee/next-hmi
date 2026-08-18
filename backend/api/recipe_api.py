"""Recipe configuration, runtime state, and download/upload API endpoints."""

from __future__ import annotations

from core.exceptions import RecipeNotFoundError
from fastapi import APIRouter
from models.recipe import DownloadResult, LoadedDataset, RecipeConfig
from pydantic import BaseModel, ConfigDict
from services.recipe_manager import recipe_manager
from services.websocket_manager import websocket_manager

router = APIRouter(prefix="/api/recipes", tags=["recipes"])


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
    # Keep parameter variables on the fast subscription for Upload / parametersChanged.
    await websocket_manager.recompute_priority_subscriptions()
    return recipe_manager.get_config()


# ── Runtime state endpoint ────────────────────────────────────────────────────


@router.get("/state", response_model=RecipeStateResponse)
def get_recipe_state() -> RecipeStateResponse:
    """Return the loaded dataset per type."""
    return RecipeStateResponse(loaded=recipe_manager.get_state())


# ── Download / upload endpoints ───────────────────────────────────────────────


@router.post("/datasets/{dataset_id}/download", response_model=DownloadResult)
async def download_dataset(dataset_id: str, body: DownloadRequest | None = None) -> DownloadResult:
    """Write a dataset's stored values to their variables (continue on error)."""
    verify = body.verify if body is not None else False
    result = await recipe_manager.download(dataset_id, verify=verify)
    if result is None:
        raise RecipeNotFoundError(f"Dataset '{dataset_id}' not found")
    return result


@router.post("/datasets/{dataset_id}/upload", response_model=RecipeConfig)
async def upload_dataset(dataset_id: str) -> RecipeConfig:
    """Read live values into a dataset, overwriting its stored values in place."""
    config = await recipe_manager.upload_into(dataset_id)
    if config is None:
        raise RecipeNotFoundError(f"Dataset '{dataset_id}' not found")
    return config
