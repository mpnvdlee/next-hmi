"""Per-call project scope (``use_project``) for the multi-project MCP.

Verifies the ContextVar precedence (scope > process pin), that the scope is
correctly entered/restored (including nesting), and that an unknown id or a
missing folder is rejected.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from core import storage


class _Entry:
    def __init__(self, project_id: str, path: str) -> None:
        self.id = project_id
        self.path = path


def _patch_manifest(monkeypatch, entries: dict[str, str]) -> None:
    """Make ``use_project`` resolve ids from *entries* (id → folder path)."""
    monkeypatch.setattr(storage, "load_manifest", lambda: object())

    def _find(_manifest, project_id):
        path = entries.get(project_id)
        return _Entry(project_id, path) if path is not None else None

    monkeypatch.setattr(storage, "find_project", _find)


def test_use_project_scopes_active_path(monkeypatch, tmp_path: Path) -> None:
    proj = tmp_path / "A"
    proj.mkdir()
    _patch_manifest(monkeypatch, {"A": str(proj)})
    monkeypatch.delenv("NEXTHMI_ACTIVE_PROJECT_PATH", raising=False)

    assert storage.current_scoped_project_id() is None
    with storage.use_project("A") as p:
        assert p == proj
        assert storage.active_project_root() == proj
        assert storage.active_pages_dir() == proj / "pages"
        assert storage.current_scoped_project_id() == "A"
    # Restored on exit.
    assert storage.current_scoped_project_id() is None


def test_scope_wins_over_env_pin(monkeypatch, tmp_path: Path) -> None:
    proj = tmp_path / "A"
    proj.mkdir()
    pinned = tmp_path / "pinned"
    pinned.mkdir()
    _patch_manifest(monkeypatch, {"A": str(proj)})
    monkeypatch.setenv("NEXTHMI_ACTIVE_PROJECT_PATH", str(pinned))

    # No scope: the process pin wins.
    assert storage.active_project_root() == pinned
    # Scope wins over the pin.
    with storage.use_project("A"):
        assert storage.active_project_root() == proj
    # And the pin is back once the scope exits.
    assert storage.active_project_root() == pinned


def test_use_project_unknown_id_raises(monkeypatch, tmp_path: Path) -> None:
    _patch_manifest(monkeypatch, {})
    with pytest.raises(storage.ProjectNotFoundError), storage.use_project("nope"):
        pass


def test_use_project_missing_folder_raises(monkeypatch, tmp_path: Path) -> None:
    _patch_manifest(monkeypatch, {"A": str(tmp_path / "ghost")})
    with pytest.raises(storage.ProjectNotFoundError), storage.use_project("A"):
        pass


def test_nested_scopes_restore_outer(monkeypatch, tmp_path: Path) -> None:
    a = tmp_path / "A"
    a.mkdir()
    b = tmp_path / "B"
    b.mkdir()
    _patch_manifest(monkeypatch, {"A": str(a), "B": str(b)})
    monkeypatch.delenv("NEXTHMI_ACTIVE_PROJECT_PATH", raising=False)

    with storage.use_project("A"):
        assert storage.active_project_root() == a
        with storage.use_project("B"):
            assert storage.active_project_root() == b
            assert storage.current_scoped_project_id() == "B"
        # Inner scope popped — outer restored.
        assert storage.active_project_root() == a
        assert storage.current_scoped_project_id() == "A"
