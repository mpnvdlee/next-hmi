"""Seed the supervisor's running set on manager startup.

Runs once in the manager lifespan before :meth:`Supervisor.resume_all`. Two cases:

* **Running set already populated** — nothing to do; resume handles it.
* **Fresh install** — no projects at all. Seed the bundled example project; a
  pending first-run operator setup keeps it stopped until credentials exist.

An install that has projects but deliberately none running (operator stopped them
all) is respected: the running set stays empty.
"""
from __future__ import annotations

import logging
from pathlib import Path

from core import operator_setup
from core.manifest import (
    RunningEntry,
    manifest_transaction,
    save_manifest,
)
from core.project_bootstrap import ensure_default_project
from core.time_utils import iso_now

logger = logging.getLogger(__name__)


def prepare_running_set() -> None:
    with manifest_transaction() as manifest:
        if manifest.running:
            return
        needs_seed = not manifest.projects

    if not needs_seed:
        return
    entry = ensure_default_project()
    with manifest_transaction() as manifest:
        if manifest.running:
            return
        setup_state = operator_setup.state(Path(entry.path).expanduser())
        if setup_state.status is not operator_setup.SetupStatus.COMPLETE:
            save_manifest(manifest)
            logger.info(
                "resume: fresh install — seed project '%s' awaits valid operator credentials",
                entry.id,
            )
            return
        manifest.running = [RunningEntry(id=entry.id, port=None, startedAt=iso_now())]
        save_manifest(manifest)
    logger.info("resume: fresh install — auto-starting seed project '%s'", entry.id)
