"""Product documentation, served at ``/help``.

The portable zips ship a rendered HTML copy of the user guide beside the
executable (``build/render-docs.py`` writes it, the build scripts call it). When
that copy is present the manager serves it locally, so a panel with no internet
still has the guide behind the editor's Help button; when it isn't — a source
checkout, the Docker image — ``/help`` redirects to the same guide published at
``PUBLIC_DOCS_URL``, in the folder of this build's minor line (``v1.0/``). Both
branches land on the same document; only ``docs/user/`` is ever rendered, so
``docs/dev/`` cannot reach an operator.

Not ``/docs``: that path is FastAPI's own Swagger UI.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from core.version import app_version
from fastapi import APIRouter
from fastapi.responses import RedirectResponse

PUBLIC_DOCS_URL = "https://next-hmi.com/docs/"

router = APIRouter(tags=["help"])


def bundled_docs_dir() -> Path | None:
    """The rendered docs folder shipped with this build, or ``None``.

    Two candidates, in order: beside the executable (the one-folder PyInstaller
    layout, which is what the zips contain) and inside the frozen bundle's
    extraction root. A source checkout has neither — the docs there are the
    Markdown originals, not a rendered site.
    """
    candidates: list[Path] = []
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / "docs")
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            candidates.append(Path(meipass) / "docs")
    for candidate in candidates:
        if (candidate / "index.html").is_file():
            return candidate
    return None


@router.get("/help", include_in_schema=False)
async def help_redirect() -> RedirectResponse:
    """Only registered when no docs are bundled — see ``manager.py``."""
    return RedirectResponse(url=public_docs_url(app_version()))


def public_docs_url(version: str) -> str:
    """The published guide for ``version``'s minor line; the latest for ``"dev"``."""
    line = re.match(r"(\d+)\.(\d+)\.", version)
    return f"{PUBLIC_DOCS_URL}v{line[1]}.{line[2]}/" if line else PUBLIC_DOCS_URL
