"""Project thumbnails.

Split across the two apps on purpose: the project *instance* writes the PNG
(so the target is its own active project and a client cannot name another
project's file), and the *manager* reads it back for the projects list. They
meet on disk at ``<runtime_home>/.thumbnails/``, outside any project folder —
which is why ``core.project_packer`` needs no rule to keep a screenshot of live
process values out of an export or a peer push.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path

from core import runtime_home
from core.exceptions import NotFoundError, ValidationError
from core.manifest import load_manifest, read_project_metadata
from core.storage import active_project_root, write_bytes_atomic
from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)

instance_router = APIRouter(prefix="/api", tags=["thumbnail"])
manager_router = APIRouter(prefix="/api/projects", tags=["thumbnail"])

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024


def thumbnail_path(project_id: str) -> Path:
    return runtime_home.thumbnails_dir() / f"{project_id}.png"


def _active_project_id() -> str | None:
    metadata = read_project_metadata(active_project_root())
    return metadata.id if metadata is not None else None


async def _read_bounded_body(request: Request) -> bytes:
    """Accumulate the request body, aborting the moment it exceeds the cap —
    a client cannot make the server buffer an unbounded payload first."""
    chunks = bytearray()
    async for chunk in request.stream():
        chunks.extend(chunk)
        if len(chunks) > MAX_THUMBNAIL_BYTES:
            raise ValidationError("Thumbnail exceeds the 2 MB limit")
    return bytes(chunks)


@instance_router.post("/thumbnail", status_code=204)
async def put_thumbnail(request: Request) -> Response:
    """Store the PNG the editor rasterised after a successful save."""
    body = await _read_bounded_body(request)
    if not body.startswith(PNG_MAGIC):
        raise ValidationError("Thumbnail must be a PNG")

    project_id = _active_project_id()
    if project_id is None:
        raise ValidationError("No active project to attach a thumbnail to")

    write_bytes_atomic(thumbnail_path(project_id), body)
    return Response(status_code=204)


def _known_project_ids() -> set[str]:
    return {entry.id for entry in load_manifest().projects}


def thumbnail_updated_at(project_id: str) -> str | None:
    path = thumbnail_path(project_id)
    if not path.is_file():
        return None
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    return datetime.fromtimestamp(mtime, UTC).isoformat()


def delete_thumbnail(project_id: str) -> None:
    """Best-effort: a project's manifest entry is already gone by the time this
    runs, so a locked file or a read-only mount must not fail the removal."""
    path = thumbnail_path(project_id)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not delete thumbnail %s", path)


@manager_router.get("/{project_id}/thumbnail")
def get_thumbnail(project_id: str) -> FileResponse:
    """Serve a project's stored thumbnail.

    The id is matched against the manifest rather than trusted as a path
    segment, so a crafted id cannot read a file outside the thumbnail store.
    """
    if project_id not in _known_project_ids():
        raise NotFoundError(f"Unknown project {project_id}")
    path = thumbnail_path(project_id)
    if not path.is_file():
        raise NotFoundError(f"No thumbnail for project {project_id}")
    return FileResponse(path, media_type="image/png")
