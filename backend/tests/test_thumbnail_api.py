"""Thumbnail write endpoint — served by the project instance, which derives the
target path from its own active project rather than from the request."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

import httpx
import pytest
from api import thumbnail_api
from core import runtime_home
from core.exceptions import register_exception_handlers
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _png_bytes(width: int = 4, height: int = 4) -> bytes:
    """A real, minimal PNG — the endpoint checks the magic bytes."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + b"\x00\x00\x00" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


@pytest.fixture
def home(monkeypatch, tmp_path: Path) -> Path:
    runtime_home_dir = tmp_path / "runtime-home"
    runtime_home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: runtime_home_dir)
    return runtime_home_dir


def _build_app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(thumbnail_api.instance_router)
    return app


@pytest.fixture
def client(monkeypatch, home: Path) -> TestClient:
    monkeypatch.setattr(thumbnail_api, "_active_project_id", lambda: "proj-1")
    return TestClient(_build_app())


def test_writes_png_for_the_active_project(client, home: Path):
    res = client.post(
        "/api/thumbnail", content=_png_bytes(), headers={"Content-Type": "image/png"}
    )
    assert res.status_code == 204
    assert (home / ".thumbnails" / "proj-1.png").read_bytes() == _png_bytes()


def test_rejects_a_body_that_is_not_a_png(client, home: Path):
    res = client.post(
        "/api/thumbnail", content=b"not an image", headers={"Content-Type": "image/png"}
    )
    assert res.status_code == 422
    assert not (home / ".thumbnails").exists()


def test_rejects_an_oversized_body(client, home: Path):
    oversized = _png_bytes() + b"\x00" * (2 * 1024 * 1024)
    res = client.post(
        "/api/thumbnail", content=oversized, headers={"Content-Type": "image/png"}
    )
    assert res.status_code == 422
    assert not (home / ".thumbnails").exists()


def test_thumbnail_updated_at_returns_none_when_stat_raises(monkeypatch, home: Path):
    """`_entry_dict` calls this once per project on every `GET /api/projects` —
    an OSError from a locked handle or a file deleted mid-request must not take
    down the whole list, just this project's timestamp."""
    shot = home / ".thumbnails" / "proj-1.png"
    shot.parent.mkdir(parents=True, exist_ok=True)
    shot.write_bytes(_png_bytes())

    original_stat = Path.stat

    def failing_stat(self, *args, **kwargs):
        if self == shot:
            raise OSError("locked")
        return original_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", failing_stat)

    assert thumbnail_api.thumbnail_updated_at("proj-1") is None


def test_overwrites_the_previous_thumbnail(client, home: Path):
    client.post("/api/thumbnail", content=_png_bytes(4), headers={"Content-Type": "image/png"})
    client.post("/api/thumbnail", content=_png_bytes(8), headers={"Content-Type": "image/png"})
    assert (home / ".thumbnails" / "proj-1.png").read_bytes() == _png_bytes(8)


def test_rejects_when_no_project_is_live(monkeypatch, home: Path):
    """The real ``_active_project_id`` path, not the fixture's monkeypatch:
    ``active_project_root()`` raises ``NoLiveProjectError`` when nothing is
    pinned, and the app-wide handler turns that into a 409."""
    monkeypatch.delenv("NEXTHMI_ACTIVE_PROJECT_PATH", raising=False)
    res = TestClient(_build_app()).post(
        "/api/thumbnail", content=_png_bytes(), headers={"Content-Type": "image/png"}
    )
    assert res.status_code == 409
    assert not (home / ".thumbnails").exists()


def test_rejects_when_the_active_projects_metadata_is_unreadable(home: Path, live_project_root: Path):
    """A project is pinned, but its ``config.json`` carries no ``project`` block —
    ``read_project_metadata`` returns ``None`` and the route reports 422."""
    res = TestClient(_build_app()).post(
        "/api/thumbnail", content=_png_bytes(), headers={"Content-Type": "image/png"}
    )
    assert res.status_code == 422
    assert not (home / ".thumbnails").exists()


def test_ignores_client_supplied_project_hints(client, home: Path):
    """The route reads no project id from the request — a query param or header
    that names another project is simply never consulted."""
    res = client.post(
        "/api/thumbnail?projectId=someone-elses-project",
        content=_png_bytes(),
        headers={
            "Content-Type": "image/png",
            "X-Project": '{"id": "someone-elses-project"}',
        },
    )
    assert res.status_code == 204
    assert (home / ".thumbnails" / "proj-1.png").read_bytes() == _png_bytes()
    assert not (home / ".thumbnails" / "someone-elses-project.png").exists()


@pytest.mark.asyncio
async def test_aborts_a_streamed_oversized_body_before_buffering_it_all(
    monkeypatch, home: Path
):
    """A real streamed request, chunk by chunk: the abort must land long before
    the whole (well past the cap) payload has been pulled off the wire."""
    monkeypatch.setattr(thumbnail_api, "_active_project_id", lambda: "proj-1")
    chunk = b"\x00" * 1024
    total_chunks = 3 * 1024  # 3 MiB total, comfortably past the 2 MiB cap
    pulled = {"n": 0}

    async def counting_chunks():
        for _ in range(total_chunks):
            pulled["n"] += 1
            yield chunk

    transport = httpx.ASGITransport(app=_build_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post(
            "/api/thumbnail", content=counting_chunks(), headers={"Content-Type": "image/png"}
        )

    assert res.status_code == 422
    assert pulled["n"] < total_chunks
    assert not (home / ".thumbnails").exists()


@pytest.fixture
def manager_client(monkeypatch, home: Path) -> TestClient:
    monkeypatch.setattr(thumbnail_api, "_known_project_ids", lambda: {"proj-1"})
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(thumbnail_api.manager_router)
    return TestClient(app)


def test_reads_back_a_stored_thumbnail(manager_client, home: Path):
    target = home / ".thumbnails" / "proj-1.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(_png_bytes())
    res = manager_client.get("/api/projects/proj-1/thumbnail")
    assert res.status_code == 200
    assert res.content == _png_bytes()
    assert res.headers["etag"]


def test_missing_thumbnail_is_404(manager_client):
    assert manager_client.get("/api/projects/proj-1/thumbnail").status_code == 404


def test_unknown_project_is_404(manager_client, home: Path):
    target = home / ".thumbnails" / "other.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(_png_bytes())
    assert manager_client.get("/api/projects/other/thumbnail").status_code == 404
