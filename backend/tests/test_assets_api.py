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


def test_list_assets_includes_nested_videos():
    (storage.active_videos_dir() / "lines").mkdir(parents=True)
    (storage.active_videos_dir() / "lines" / "clip.mp4").write_bytes(b"\x00\x00\x00 ftypmp42")

    result = asyncio.run(widgets_api.list_assets())

    video = next(item for item in result if item["type"] == "video")
    assert video["path"] == "videos/lines/clip.mp4"
    assert video["name"] == "clip.mp4"
    assert video["mime"] == "video/mp4"


def test_list_assets_skips_matroska_videos():
    """.mkv never plays in an HTML <video> element, so it is not an offerable asset."""
    (storage.active_videos_dir() / "clip.mkv").write_bytes(b"\x1a\x45\xdf\xa3")

    result = asyncio.run(widgets_api.list_assets())

    assert [item["path"] for item in result] == []


def test_assets_mount_answers_byte_range_requests():
    """Seeking in the Video widget is nothing but a Range request against the
    /assets mount, so the docs' seeking claim rests entirely on Starlette's
    StaticFiles. Pin it here — a dependency bump that drops Range would
    otherwise only surface as a video that refuses to scrub."""
    from fastapi import FastAPI
    from fastapi.staticfiles import StaticFiles
    from fastapi.testclient import TestClient

    (storage.active_videos_dir() / "clip.mp4").write_bytes(bytes(range(100)))

    app = FastAPI()
    app.mount(
        "/assets",
        StaticFiles(directory=str(storage.active_assets_dir()), follow_symlink=False),
        name="assets",
    )
    response = TestClient(app).get(
        "/assets/videos/clip.mp4", headers={"Range": "bytes=10-19"}
    )

    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 10-19/100"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.content == bytes(range(10, 20))
