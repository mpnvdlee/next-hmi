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
from pathlib import Path

from core import runtime_home
from core.exceptions import ValidationError
from core.manifest import read_project_metadata
from core.storage import active_project_root, write_bytes_atomic
from fastapi import APIRouter, Request, Response

logger = logging.getLogger(__name__)

instance_router = APIRouter(prefix="/api", tags=["thumbnail"])

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
