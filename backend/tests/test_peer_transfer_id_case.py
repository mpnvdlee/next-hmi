"""A peer transfer cannot register a project id that differs from one already
registered only in case.

On Windows and macOS ``line3`` and ``LINE3`` share ``.widget-build/<id>``,
``.logs/instances/<id>`` and ``.thumbnails/<id>.png`` under the runtime home, so
a pushed or pulled ``LINE3`` would overwrite what ``line3`` serves. The refusal
lives in ``save_manifest``, which both directions commit through.
"""
from __future__ import annotations

import io
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
from api import manager_peers_api
from api.manager_auth_api import router as auth_router
from api.manager_peers_api import manager_router, public_router
from core import manager_auth, runtime_home
from core.exceptions import register_exception_handlers
from core.manifest import (
    ManifestV1,
    ProjectEntry,
    ProjectMetadata,
    load_manifest,
    save_manifest,
    write_project_metadata,
)
from core.project_packer import pack_project
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(auth_router)
    app.include_router(public_router)
    app.include_router(manager_router)
    return app


def _home_with_line3(monkeypatch, tmp_path: Path) -> Path:
    home = tmp_path / "runtime"
    root = home / "Projects"
    existing = root / "line3"
    existing.mkdir(parents=True)
    write_project_metadata(existing, ProjectMetadata(id="line3", name="Line 3"))
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home)
    save_manifest(
        ManifestV1(
            defaultProjectsRoot=str(root),
            projects=[
                ProjectEntry(
                    id="line3", name="Line 3", path=str(existing), addedAt="2026-01-01T00:00:00Z"
                )
            ],
        )
    )
    manager_auth.set_password("destination-admin")
    return root


def _archive(tmp_path: Path, project_id: str) -> bytes:
    source = tmp_path / f"source-{project_id}"
    source.mkdir()
    write_project_metadata(source, ProjectMetadata(id=project_id, name="Line 3 elsewhere"))
    (source / "users.json").write_text('{"users": []}', encoding="utf-8")
    output = io.BytesIO()
    pack_project(source, output)
    return output.getvalue()


def _assert_refused_for_case(message: str) -> None:
    assert "'LINE3' matches the registered project 'line3'" in message
    assert "project ids ignore upper and lower case" in message
    # The transfer dialog maps this phrase to its collision explanation and
    # offers the copy/replace resolutions.
    assert "project id or folder already exists" in message


def test_push_receive_refuses_a_case_variant(monkeypatch, tmp_path: Path) -> None:
    root = _home_with_line3(monkeypatch, tmp_path)

    with TestClient(_app()) as client:
        token = client.post(
            "/api/manager/peer/pair", json={"password": "destination-admin"}
        ).json()["token"]
        received = client.post(
            "/api/manager/peer/transfers",
            headers={"Authorization": f"Bearer {token}"},
            data={
                "transferId": "tx-case",
                "sourceProjectId": "LINE3",
                "destinationProjectId": "LINE3",
                "destinationFolder": "LINE3-copy",
                "collisionPolicy": "reject",
                "confirmReplace": "false",
                "start": "false",
            },
            files={"file": ("project.zip", _archive(tmp_path, "LINE3"), "application/zip")},
        )

    assert received.status_code == 409, received.text
    _assert_refused_for_case(received.json()["detail"])
    assert [entry.id for entry in load_manifest().projects] == ["line3"]
    assert not (root / "LINE3-copy").exists()


class _Download:
    def __init__(self, body: bytes) -> None:
        self.status_code = 200
        self.headers = {"content-length": str(len(body))}
        self._body = body

    async def __aenter__(self) -> _Download:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def aiter_bytes(self, chunk_size: int = 65536):
        yield self._body


class _Peer:
    def __init__(self, body: bytes) -> None:
        self._body = body

    async def __aenter__(self) -> _Peer:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    def stream(self, method: str, url: str, headers=None) -> _Download:
        return _Download(self._body)


def test_pull_refuses_a_case_variant(monkeypatch, tmp_path: Path) -> None:
    root = _home_with_line3(monkeypatch, tmp_path)
    archive = _archive(tmp_path, "LINE3")
    monkeypatch.setattr(
        manager_peers_api,
        "_resolve_private_peer",
        lambda host, port, scheme="http": manager_peers_api.PeerEndpoint(
            "http://peer.invalid", {"Host": f"{host}:{port}"}, True, host, port, "127.0.0.1"
        ),
    )
    fake_httpx = SimpleNamespace(**vars(httpx))
    fake_httpx.AsyncClient = lambda *a, **k: _Peer(archive)
    monkeypatch.setattr(manager_peers_api, "httpx", fake_httpx)

    with TestClient(_app()) as client:
        begun = client.post(
            "/api/manager/pulls",
            json={
                "transferId": "pull-case",
                "sourceProjectId": "LINE3",
                "destinationProjectId": "LINE3",
                "destinationFolder": "LINE3-copy",
                "peerHost": "10.0.0.5",
                "peerPort": 8000,
                "token": "peer-token",
            },
        )
        assert begun.status_code == 202, begun.text
        deadline = time.monotonic() + 5.0
        status = begun.json()
        while status.get("status") == "active" and time.monotonic() < deadline:
            time.sleep(0.02)
            status = client.get("/api/manager/pulls/pull-case").json()

    assert status["status"] == "error", status
    _assert_refused_for_case(status["message"])
    assert [entry.id for entry in load_manifest().projects] == ["line3"]
    assert not (root / "LINE3-copy").exists()
