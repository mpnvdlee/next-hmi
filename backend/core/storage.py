"""Filesystem layer for the active project + atomic JSON / CSV helpers.

The path API is split in two:

* **Project-anchored** paths (``active_project_root()`` and friends) resolve
  from ``NEXTHMI_ACTIVE_PROJECT_PATH`` (or the ``use_project`` scope) on every
  call — this process only ever serves the one project it was pinned to.
* **Runtime-home-anchored** paths (``LOGS_DIR``, ``WIDGET_BUILD_DIR``, …) stay
  module-level constants computed at import time from
  ``core.runtime_home``. These never change without a process restart, so
  freezing them keeps the call sites simple.

If this process was never pinned to a project, the active resolvers raise
``NoLiveProjectError``. The registered FastAPI handler turns that into a
structured ``409 {"code": "no_live_project"}`` so the SPA can render the
"no project running on this server" state.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import tempfile
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any, TypeVar

from core import runtime_home
from core.manifest import find_project, load_manifest

T = TypeVar("T")

logger = logging.getLogger(__name__)
_lock = threading.RLock()


class NoLiveProjectError(Exception):
    """Raised by the active-project resolvers when no project is marked live."""

    code = "no_live_project"


class ProjectNotFoundError(Exception):
    """Raised by ``use_project`` when the requested project id is unknown or its
    folder is missing on disk."""

    code = "project_not_found"


# ── Per-call project scope (multi-project MCP) ───────────────────────────────
# The workspace MCP server (hosted by the manager) serves *every* project from
# one process: each tool call names a ``project`` and runs inside
# ``use_project(id)``, which sets these ContextVars for the duration of the
# call. ``_active_project_path()`` consults the scope *before* the env/manifest
# fallback, so the existing project-anchored resolvers transparently act on the
# selected project. The id is kept alongside the path so the change-bus
# (``mcp_server.write_helpers``) can route a live-update to the right child.

_scoped_project_path: ContextVar[Path | None] = ContextVar(
    "nexthmi_scoped_project_path", default=None
)
_scoped_project_id: ContextVar[str | None] = ContextVar(
    "nexthmi_scoped_project_id", default=None
)


@contextmanager
def use_project(project_id: str) -> Iterator[Path]:
    """Scope every ``active_*`` resolver to *project_id* for the duration.

    Resolves the project through the manifest, validates that its folder exists,
    and binds the per-call ContextVars. Restores the previous scope on exit, so
    nested / cross-project use (read here, write there) is safe.

    Raises ``ProjectNotFoundError`` when the id is unknown or the folder is gone.
    """
    manifest = load_manifest()
    entry = find_project(manifest, project_id)
    if entry is None:
        raise ProjectNotFoundError(f"Project '{project_id}' not found")
    project_path = Path(entry.path).expanduser()
    if not project_path.is_dir():
        raise ProjectNotFoundError(f"Project folder is missing at {entry.path}")
    path_token = _scoped_project_path.set(project_path)
    id_token = _scoped_project_id.set(project_id)
    try:
        yield project_path
    finally:
        _scoped_project_path.reset(path_token)
        _scoped_project_id.reset(id_token)


def current_scoped_project_id() -> str | None:
    """The project id bound by the active ``use_project`` scope, or ``None``."""
    return _scoped_project_id.get()


# ── Runtime-home-anchored paths (frozen at import) ────────────────────────────
# These don't change without a process restart, so a one-shot import-time
# resolution is fine. Tests that need to redirect them can still
# ``monkeypatch.setattr(storage, "LOGS_DIR", tmp_path)`` as before.

LOGS_DIR = runtime_home.logs_dir()
LOG_FILE_PATH = LOGS_DIR / "nexthmi.log"
WIDGET_BUILD_DIR = runtime_home.widget_build_dir()
BUILD_STATUS_PATH = WIDGET_BUILD_DIR / ".build-status.json"


# ── Source-tree-anchored paths (frozen at import) ─────────────────────────────
# Derived from this file's own location, so it can only change by moving this
# file — frozen at import like the runtime-home constants above.

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def repo_root() -> Path:
    """The checkout / install root: the folder that holds ``backend/``.

    Every reader of the frontend source tree (the ``/stdlib-js`` mount, the
    baked stdlib manifest, the built-in widget registry) resolves through this
    so the ``parents[]`` depth is one fact in one place. Those readers degrade
    silently when the path is wrong — an empty catalog, an absent mount — so
    hand-rolling the derivation per call site is how it breaks. A packaged
    runtime has no ``frontend/`` under this root at all; those callers check
    ``NEXTHMI_FRONTEND_DIST`` first.
    """
    return _REPO_ROOT


# ── Project-anchored resolvers ────────────────────────────────────────────────


def _active_project_path() -> Path:
    """Resolve the active project's folder. Raises ``NoLiveProjectError`` if unset.

    Precedence:

    1. **Per-call scope** (``use_project``). The workspace MCP server serves
       every project from one process, so each tool call binds the target
       project for its duration; that wins over everything else.
    2. **Process pin** (``NEXTHMI_ACTIVE_PROJECT_PATH``). The supervisor pins
       each child process to one project via this env, so N children can each
       serve a different project in the same runtime home. A standalone
       ``uvicorn main:app`` self-pins it at startup the same way.
    """
    scoped = _scoped_project_path.get()
    if scoped is not None:
        return scoped
    pinned = os.environ.get("NEXTHMI_ACTIVE_PROJECT_PATH")
    if pinned:
        return Path(pinned).expanduser()
    raise NoLiveProjectError("No live project is configured")


def active_project_root() -> Path:
    """The live project's folder — holds every piece of user-owned project state."""
    return _active_project_path()


def active_custom_widgets_dir() -> Path:
    return active_project_root() / "custom-widgets"


def active_assets_dir() -> Path:
    return active_project_root() / "assets"


def active_external_libraries_dir() -> Path:
    return active_project_root() / "external-libraries"


def active_certs_dir() -> Path:
    return active_project_root() / "certs"


def active_icons_dir() -> Path:
    return active_assets_dir() / "icons"


def active_images_dir() -> Path:
    return active_assets_dir() / "images"


def active_config_dir() -> Path:
    return active_project_root()


def active_datasources_dir() -> Path:
    return active_project_root() / "datasources"


def active_pages_dir() -> Path:
    return active_project_root() / "pages"


def active_translations_dir() -> Path:
    return active_project_root() / "translations"


def active_components_dir() -> Path:
    return active_project_root() / "components"


def component_files() -> list[tuple[Path, str | None]]:
    """Return ``(path, group)`` for every component file in the live project.

    ``group`` is ``None`` for files directly in the components root, or the
    file's parent directory path relative to the root (``/``-joined, e.g.
    ``"A/B"``) for files nested in folders — any depth is supported.
    """
    root = active_components_dir()
    if not root.exists():
        return []
    out: list[tuple[Path, str | None]] = []
    for f in sorted(root.rglob("*.json")):
        rel_parent = f.parent.relative_to(root)
        group = None if rel_parent == Path(".") else rel_parent.as_posix()
        out.append((f, group))
    return out


def active_themes_dir() -> Path:
    return active_project_root() / "themes"


def active_alarms_config_path() -> Path:
    return active_project_root() / "alarms.json"


def active_alarm_state_path() -> Path:
    return active_project_root() / "alarm_state.json"


def active_recipes_config_path() -> Path:
    return active_project_root() / "recipes.json"


def active_recipe_state_path() -> Path:
    return active_project_root() / "recipe_state.json"


def ensure_active_project_dirs() -> None:
    """Create all sub-folders for the live project. Safe to call every startup."""
    project_root = active_project_root()
    project_root.mkdir(parents=True, exist_ok=True)
    active_custom_widgets_dir().mkdir(parents=True, exist_ok=True)
    active_external_libraries_dir().mkdir(parents=True, exist_ok=True)
    active_certs_dir().mkdir(parents=True, exist_ok=True)
    WIDGET_BUILD_DIR.mkdir(parents=True, exist_ok=True)
    for sub in ("datasources", "pages", "translations", "components"):
        (project_root / sub).mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    active_icons_dir().mkdir(parents=True, exist_ok=True)
    active_images_dir().mkdir(parents=True, exist_ok=True)

    # Translation baseline so the language APIs work on first launch.
    default_csv = active_translations_dir() / "Default.csv"
    from core.translations import translation_transaction

    with translation_transaction(default_csv):
        if not default_csv.exists():
            write_csv(default_csv, [["en-EN"]])


# ── File I/O helpers (unchanged) ──────────────────────────────────────────────


def read_json(path: str | Path) -> Any:
    path = Path(path)
    last_error: Exception | None = None
    for _ in range(3):
        try:
            with _lock, open(path, encoding="utf-8-sig") as f:
                return json.load(f)
        except json.JSONDecodeError as exc:
            last_error = exc
            time.sleep(0.01)
    if last_error is not None:
        raise last_error
    raise RuntimeError("read_json failed unexpectedly")


def load_json_or_default(  # noqa: UP047 -- PEP 695 type-param syntax is a manual rewrite (module-level TypeVar `T` also used elsewhere), not mechanical
    path: str | Path,
    default_factory: Callable[[], T],
    parse: Callable[[Any], T] | None = None,
) -> T:
    """Load JSON from *path* and convert via *parse*; on any error return default_factory().

    For Pydantic models, pass ``parse=Model.model_validate`` and
    ``default_factory=Model``. For plain dict/list state, pass a copy producer
    as ``default_factory`` and leave ``parse=None``.
    """
    path = Path(path)
    if not path.exists():
        return default_factory()
    try:
        raw = read_json(path)
    except Exception as exc:
        logger.error("Failed to read %s: %s", path.name, exc)
        return default_factory()
    if parse is None:
        return raw  # type: ignore[return-value]
    try:
        return parse(raw)
    except Exception as exc:
        logger.error("Failed to parse %s: %s", path.name, exc)
        return default_factory()


def write_json(path: str | Path, data: Any) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    with _lock:
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                suffix=".tmp",
                prefix=f"{path.name}.",
                dir=path.parent,
                delete=False,
            ) as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                tmp_path = Path(f.name)
            os.replace(tmp_path, path)
        except OSError as exc:
            logger.error("Failed to write JSON file %s: %s", path, exc)
            if tmp_path is not None and tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
            raise


def write_text_atomic(path: str | Path, data: str, encoding: str = "utf-8") -> None:
    """Atomic text write: tempfile + os.replace. Crash-safe (no partial files)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    with _lock:
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding=encoding,
                suffix=".tmp",
                prefix=f"{path.name}.",
                dir=path.parent,
                delete=False,
            ) as f:
                f.write(data)
                tmp_path = Path(f.name)
            os.replace(tmp_path, path)
        except OSError as exc:
            logger.error("Failed to write text file %s: %s", path, exc)
            if tmp_path is not None and tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
            raise


def write_bytes_atomic(path: str | Path, data: bytes) -> None:
    """Atomic binary write: tempfile + os.replace."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    with _lock:
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                suffix=".tmp",
                prefix=f"{path.name}.",
                dir=path.parent,
                delete=False,
            ) as f:
                f.write(data)
                tmp_path = Path(f.name)
            os.replace(tmp_path, path)
        except OSError as exc:
            logger.error("Failed to write binary file %s: %s", path, exc)
            if tmp_path is not None and tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
            raise


def read_csv(path: str | Path) -> list[list[str]]:
    """Read a semicolon-separated CSV file and return a list of rows."""
    with _lock, open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f, delimiter=";")
        return [row for row in reader if row]


def write_csv(path: str | Path, rows: list[list[str]]) -> None:
    """Overwrite a semicolon-separated CSV file atomically."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    with _lock:
        try:
            buf = io.StringIO()
            writer = csv.writer(buf, delimiter=";", lineterminator="\n")
            writer.writerows(rows)
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                suffix=".tmp",
                prefix=f"{path.name}.",
                dir=path.parent,
                newline="",
                delete=False,
            ) as f:
                f.write(buf.getvalue())
                tmp_path = Path(f.name)
            os.replace(tmp_path, path)
        except OSError as exc:
            logger.error("Failed to write CSV file %s: %s", path, exc)
            if tmp_path is not None and tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
            raise


