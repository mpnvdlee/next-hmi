"""Application version + edition strings.

Shared by the launcher banner and the SPA index templating, so the terminal
splash and the in-browser boot splash always name the same build.

Self-contained (no other backend imports) — ``launcher.py`` reads it before the
rest of the app is importable.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _resource_path(relative: str) -> Path:
    """Resolve a path bundled inside the frozen executable (``sys._MEIPASS``).

    Falls back to the repo layout when running from source (``backend/core/`` →
    two levels up is the repository root).
    """
    base = getattr(sys, "_MEIPASS", None)
    if base:
        return Path(base) / relative
    return Path(__file__).resolve().parent.parent.parent / relative


def app_version() -> str:
    """Version from the bundled ``version.txt``; ``"dev"`` in a checkout.

    Best-effort by contract: a missing or unreadable file must never take down
    the launcher or a page render.
    """
    try:
        return _resource_path("version.txt").read_text(encoding="utf-8").strip() or "dev"
    except OSError:
        return "dev"


def app_edition() -> str:
    """``"ee"`` for the commercial build, ``"oss"`` otherwise.

    The edition is fixed at package time (the spec refuses a mismatched SPA
    bundle) and set in the environment by the launcher and ``start-dev.py``, so
    reading it here is the same fact both halves already agree on. The SPA
    reads it to drop the AGPL attribution notice, which the commercial licence
    replaces.
    """
    return "ee" if os.environ.get("NEXTHMI_EDITION") == "ee" else "oss"
