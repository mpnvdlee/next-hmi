"""First-run bootstrap of the projects manifest.

Creates a default project folder (reusing ``project-testbench/`` in a dev
checkout, or a fresh ``Default-Project/`` otherwise) and registers it in the
manifest when the runtime has none. Without it, a fresh runtime home would
have no project for a standalone backend to mount its static dirs against.

Called from ``manager.py`` (via ``services.project_resume`` on a fresh
install — the path both the launcher binary and ``start-dev.py`` take) and
``main.py`` (so direct ``uvicorn main:app`` still works without the manager).
Idempotent — reuses the existing entry on every later call instead of
registering a duplicate.
"""
from __future__ import annotations

import logging
import shutil
from pathlib import Path

from core import runtime_home
from core.manifest import (
    ProjectEntry,
    ensure_project_metadata,
    find_project,
    manifest_transaction,
    save_manifest,
    write_project_metadata,
)
from core.project_migrations import stamp_current_format
from core.storage import repo_root
from core.time_utils import iso_now

logger = logging.getLogger(__name__)

_SEED_DIRNAME = "project-seed"


def _dev_project() -> Path:
    return repo_root() / "project-testbench"


def _seed_dir_candidates() -> tuple[Path, ...]:
    """Where the bundled seed may sit, relative to the install root.

    Resolved through ``repo_root()`` rather than this file's own location: a
    frozen build seals this module inside the archive, where the walk up from
    ``__file__`` lands *above* the extracted tree and finds no seed at all —
    every new install would then come up with a bare default project.
    """
    root = repo_root()
    return (root / _SEED_DIRNAME, root / "backend" / _SEED_DIRNAME)


def _has_project_contents(path: Path) -> bool:
    """Heuristic — does this folder already look like a NEXT HMI project?"""
    return (path / "config.json").is_file()


def _seed_into(path: Path) -> bool:
    """Copy the bundled project-seed/ template into *path*. Returns True if a seed was found."""
    for candidate in _seed_dir_candidates():
        if candidate.is_dir():
            path.mkdir(parents=True, exist_ok=True)
            for entry in candidate.iterdir():
                dest = path / entry.name
                if entry.is_dir():
                    shutil.copytree(entry, dest, dirs_exist_ok=True)
                else:
                    shutil.copy2(entry, dest)
            return True
    return False


def _default_project_target(home: Path) -> tuple[Path, str]:
    """Pick the path + display name for the default project.

    In dev, prefer the existing ``<repo>/project-testbench/`` so a checkout keeps
    working without manual setup. In binary/docker, drop a fresh
    ``Default-Project/`` next to the manifest.
    """
    dev_project = _dev_project()
    if _has_project_contents(dev_project):
        return dev_project.resolve(), "Default"
    return (home / "Default-Project").resolve(), "Default"


def ensure_default_project() -> ProjectEntry:
    """Ensure the manifest has a default project registered, and return its entry.

    Idempotent — reuses the existing project-testbench/Default-Project entry
    on a later call instead of registering a duplicate. Safe to call on every
    startup.
    """
    home = runtime_home.runtime_home_path()
    home.mkdir(parents=True, exist_ok=True)

    target, name = _default_project_target(home)
    freshly_seeded = False
    if not _has_project_contents(target):
        target.mkdir(parents=True, exist_ok=True)
        freshly_seeded = _seed_into(target)
        if freshly_seeded:
            logger.info("Bootstrap: seeded default project at %s", target)
        else:
            logger.info(
                "Bootstrap: created empty default project at %s (no project-seed/ bundled)", target,
            )
    else:
        logger.info("Bootstrap: reusing existing project at %s", target)

    metadata = ensure_project_metadata(target, name=name)
    if freshly_seeded:
        # project-seed/ is already canonical, so stamp it here. A reused
        # pre-existing target (dev's project-testbench/ from a prior boot) is
        # deliberately left unstamped here; main.py's lifespan stamps it.
        metadata = stamp_current_format(metadata)
        write_project_metadata(target, metadata)

    # ``ensure_project_metadata`` reuses the id already written into a target
    # that survived from a previous boot, so this lookup finds the same entry
    # on every later call instead of registering a second copy.
    with manifest_transaction() as manifest:
        entry = find_project(manifest, metadata.id)
        if entry is None:
            entry = ProjectEntry(
                id=metadata.id,
                name=name,
                path=str(target),
                addedAt=iso_now(),
                lastOpenedAt=iso_now(),
            )
            manifest.projects.append(entry)
            logger.info("Bootstrap: registered default project '%s' (%s)", entry.name, entry.id)
        save_manifest(manifest)
    return entry
