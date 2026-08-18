"""Reusable component API endpoints."""

from __future__ import annotations

from fastapi import APIRouter
from models.component import ComponentDefinition
from pydantic import BaseModel
from services.component_manager import component_manager

router = APIRouter(prefix="/api/components", tags=["components"])


class FolderCreate(BaseModel):
    """Request body for creating a component folder.

    ``name`` may be a ``/``-joined path (e.g. ``"A/B/C"``) to create nested
    folders in one call; missing intermediate folders are created too.
    """

    name: str


@router.get("", response_model=list[ComponentDefinition])
def list_components() -> list[ComponentDefinition]:
    """Return all reusable component definitions."""
    return component_manager.list_all()


# Declared before ``/{component_id}`` so "folders" is not captured as an id.
@router.get("/folders", response_model=list[str])
def list_folders() -> list[str]:
    """Return all component folder paths, any depth (including empty folders)."""
    return component_manager.list_folders()


@router.post("/folders")
def create_folder(body: FolderCreate) -> dict[str, str]:
    """Create a new (empty) component folder, creating parent folders as needed."""
    name = component_manager.create_folder(body.name)
    return {"status": "ok", "name": name}


# ``:path`` so nested paths (e.g. "A/B/C") round-trip through the URL; declared
# before ``/{component_id}`` for the same reason as the routes above.
@router.delete("/folders/{folder_path:path}")
def delete_folder(folder_path: str) -> dict[str, str]:
    """Delete a component folder and everything inside it (subfolders and components)."""
    component_manager.delete_folder(folder_path)
    return {"status": "ok"}


@router.get("/{component_id}", response_model=ComponentDefinition)
def get_component(component_id: str) -> ComponentDefinition:
    """Return a single reusable component definition by id."""
    return component_manager.get(component_id)


@router.post("", response_model=ComponentDefinition)
def create_component(body: ComponentDefinition) -> ComponentDefinition:
    """Create a reusable component definition."""
    return component_manager.create(body)


@router.put("/{component_id}", response_model=ComponentDefinition)
def update_component(component_id: str, body: ComponentDefinition) -> ComponentDefinition:
    """Replace a reusable component definition."""
    return component_manager.update(component_id, body)


@router.delete("/{component_id}")
def delete_component(component_id: str) -> dict[str, str]:
    """Delete a reusable component definition."""
    component_manager.delete(component_id)
    return {"status": "ok"}
