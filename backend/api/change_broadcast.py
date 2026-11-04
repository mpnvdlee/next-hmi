"""``config_changed`` for REST writes, so open runtimes and editor tabs update.

``broadcasts(artifact_type)`` is a route dependency: after a write route returns
without raising, every connected browser hears what changed. The browser tab
that made the write names itself in the ``X-NextHMI-Tab`` header; the
broadcast echoes it as ``tab_id`` so that tab can tell its own save from
another tab's.
"""
from __future__ import annotations

import re
from collections.abc import AsyncIterator, Callable
from typing import Any

from fastapi import Depends, Request
from services.websocket_manager import ConfigChangedEvent, websocket_manager

TAB_HEADER = "x-nexthmi-tab"
# Echoed to every connected browser, so only an id-shaped value is passed on.
_TAB_ID = re.compile(r"[A-Za-z0-9-]{1,64}")


def tab_id(request: Request) -> str | None:
    value = request.headers.get(TAB_HEADER, "")
    return value if _TAB_ID.fullmatch(value) else None


def rest_change(
    request: Request, artifact_type: str, artifact_ids: list[str], diff: Any = None
) -> ConfigChangedEvent:
    return ConfigChangedEvent(
        artifact_type=artifact_type,
        artifact_ids=artifact_ids,
        source="rest",
        summary=f"{request.method} {request.url.path}",
        diff=diff,
        tab_id=tab_id(request),
    )


def broadcasts(artifact_type: str) -> Any:
    """Dependency that broadcasts ``artifact_type`` after a successful write.

    The ids are the route's path parameters (a theme id, a datasource name),
    empty for a route that replaces a whole document.
    """

    async def broadcast_after_write(request: Request) -> AsyncIterator[None]:
        # Skipped when the handler raises: nothing changed.
        yield
        if request.method in ("GET", "HEAD"):
            return
        ids = [str(value) for value in request.path_params.values()]
        await websocket_manager.broadcast_config_changed(rest_change(request, artifact_type, ids))

    dependency: Callable[..., Any] = broadcast_after_write
    dependency.artifact_type = artifact_type  # type: ignore[attr-defined]
    return Depends(dependency)
