"""Tests for project-anchored path resolvers in ``core.storage``.

The ``active_*`` functions all defer to ``_active_project_path``; we monkeypatch
that one resolver and verify each accessor composes the right sub-path. The
manifest-driven resolution itself is covered in ``test_manifest.py``.
"""
from __future__ import annotations

from pathlib import Path

import core.storage as storage
import pytest


def test_no_live_project_raises_structured_error(monkeypatch) -> None:
    """With no manifest, the resolver must raise ``NoLiveProjectError`` so the
    registered handler can turn it into a structured 409."""
    from core import manifest as manifest_mod

    monkeypatch.setattr(storage, "load_manifest", lambda: manifest_mod.ManifestV1())
    with pytest.raises(storage.NoLiveProjectError):
        storage.active_project_root()


def test_active_paths_compose_under_project_root(live_project_root: Path) -> None:
    project = live_project_root
    assert storage.active_project_root() == project
    assert storage.active_pages_dir() == project / "pages"
    assert storage.active_components_dir() == project / "components"
    assert storage.active_datasources_dir() == project / "datasources"
    assert storage.active_translations_dir() == project / "translations"
    assert storage.active_config_dir() == project
    assert storage.active_alarms_config_path() == project / "alarms.json"
    assert storage.active_alarm_state_path() == project / "alarm_state.json"
    assert storage.active_custom_widgets_dir() == project / "custom-widgets"
    assert storage.active_external_libraries_dir() == project / "external-libraries"
    assert storage.active_assets_dir() == project / "assets"
    assert storage.active_certs_dir() == project / "certs"
    assert storage.active_icons_dir() == project / "assets" / "icons"
    assert storage.active_images_dir() == project / "assets" / "images"


def test_switching_live_project_changes_resolved_paths(monkeypatch, tmp_path: Path) -> None:
    """Confirm the resolver is called fresh — changing the source path on the
    next call reflects everywhere, no caching to fight."""
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()

    current = {"path": first}
    monkeypatch.setattr(storage, "_active_project_path", lambda: current["path"])

    assert storage.active_pages_dir() == first / "pages"
    current["path"] = second
    assert storage.active_pages_dir() == second / "pages"


def test_repo_root_points_at_the_checkout_root() -> None:
    """The single place the ``backend/`` → repo-root depth is written down.

    Its readers — the ``/stdlib-js`` mount, the baked stdlib manifest, the
    built-in widget registry — all fail silently on a wrong depth (absent mount,
    empty catalog), so the depth is asserted here instead."""
    root = storage.repo_root()
    assert (root / "backend" / "core" / "storage.py").is_file()
    assert (root / "frontend" / "package.json").is_file()
