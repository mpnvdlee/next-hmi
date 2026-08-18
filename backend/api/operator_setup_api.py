"""Manager-only first-run operator credential setup endpoints."""

from pathlib import Path

from core import operator_setup
from core.exceptions import NotFoundError
from core.manifest import find_project, load_manifest
from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/manager/projects", tags=["manager"])


class OperatorSetupBody(BaseModel):
    password: str = Field(min_length=1, max_length=512)


@router.post("/{project_id}/operator-setup")
def setup_operator_password(project_id: str, body: OperatorSetupBody) -> dict:
    entry = find_project(load_manifest(), project_id)
    if entry is None:
        raise NotFoundError(f"Project '{project_id}' not found")
    operator_setup.complete(Path(entry.path).expanduser(), body.password)
    return {"id": project_id, "operatorSetupRequired": False}
