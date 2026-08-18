"""Tests for GET /api/assets, including nested asset subfolders."""
from __future__ import annotations

import asyncio
from pathlib import Path

import core.storage as storage
import pytest
from api import widgets_api


@pytest.fixture(autouse=True)
def _isolated_workspace(live_project_root: Path):
    storage.ensure_active_project_dirs()


def test_list_assets_walks_nested_subfolders():
    (storage.active_icons_dir() / "machines").mkdir()
    (storage.active_icons_dir() / "machines" / "pump.svg").write_text(
        "<svg/>", encoding="utf-8"
    )
    (storage.active_images_dir() / "logos" / "brand").mkdir(parents=True)
    (storage.active_images_dir() / "logos" / "brand" / "logo.png").write_bytes(
        b"\x89PNG\r\n"
    )

    result = asyncio.run(widgets_api.list_assets())

    paths = sorted(item["path"] for item in result)
    assert paths == ["icons/machines/pump.svg", "images/logos/brand/logo.png"]
