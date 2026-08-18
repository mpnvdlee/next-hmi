"""Idempotency of the default-project bootstrap.

``ensure_default_project`` keys its "already registered?" check off the id
``ensure_project_metadata`` reads back from the target's own ``config.json``,
not off any manifest scratch field — so a later call reuses the existing
entry instead of appending a duplicate, however many times it runs.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from core import manifest as manifest_mod
from core import project_bootstrap, runtime_home


@pytest.fixture
def home(monkeypatch, tmp_path: Path) -> Path:
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    target = tmp_path / "Default-Project"
    target.mkdir(parents=True, exist_ok=True)
    (target / "config.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        project_bootstrap, "_default_project_target", lambda _home: (target, "Default")
    )
    return home_dir


def test_bootstrap_seeds_when_manifest_empty(home: Path) -> None:
    entry = project_bootstrap.ensure_default_project()
    persisted = manifest_mod.load_manifest()
    assert [p.id for p in persisted.projects] == [entry.id]


def test_bootstrap_reuses_entry_on_repeated_calls(home: Path) -> None:
    first = project_bootstrap.ensure_default_project()
    second = project_bootstrap.ensure_default_project()
    assert second.id == first.id
    assert len(manifest_mod.load_manifest().projects) == 1


def test_bootstrap_does_not_duplicate_once_project_is_running(home: Path) -> None:
    """The manager's running set doesn't affect bootstrap; it must not re-append."""
    first = project_bootstrap.ensure_default_project()

    manifest = manifest_mod.load_manifest()
    manifest.running = [manifest_mod.RunningEntry(id=first.id, port=None)]
    manifest_mod.save_manifest(manifest)

    project_bootstrap.ensure_default_project()

    persisted = manifest_mod.load_manifest()
    assert [p.id for p in persisted.projects] == [first.id]
