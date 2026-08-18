"""Phases 4-5 — REST surface for the projects manifest, including zip export/import.

Each test spins up a FastAPI app with only the projects router (plus the
system router where ``make-live`` needs it) and points the manifest +
runtime-home resolvers at a tmp dir. ``signal.raise_signal`` / ``os._exit``
are stubbed out so ``make-live``'s self-restart trigger doesn't kill the
test process.
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
from api import projects_api, system_api
from core import manifest as manifest_mod
from core import mcp_tokens, runtime_home
from core.exceptions import register_exception_handlers
from core.project_packer import pack_project
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def home(monkeypatch, tmp_path: Path) -> Path:
    """Isolated runtime home + manifest for the test."""
    runtime_home_dir = tmp_path / "runtime-home"
    runtime_home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: runtime_home_dir)
    return runtime_home_dir


@pytest.fixture
def client(monkeypatch, home: Path) -> TestClient:
    """Bare FastAPI app with the projects router (and system router for restart)."""
    calls: dict[str, list] = {"raise_signal": [], "kill": [], "exit": []}
    monkeypatch.setattr(
        system_api.signal,
        "raise_signal",
        lambda sig: calls["raise_signal"].append(sig),
    )
    monkeypatch.setattr(system_api.os, "kill", lambda pid, sig: calls["kill"].append((pid, sig)))
    monkeypatch.setattr(system_api.os, "_exit", lambda code: calls["exit"].append(code))
    monkeypatch.setattr(system_api, "_hard_exit_grace_seconds", lambda: 0.01)
    monkeypatch.setattr(system_api, "_RESPONSE_FLUSH_DELAY", 0.0)

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(projects_api.router)
    app.include_router(system_api.router)
    tc = TestClient(app)
    tc.app.state.restart_calls = calls  # type: ignore[attr-defined]
    return tc


def _make_project_folder(target: Path, *, name: str = "Plant A") -> str:
    """Create a folder with project metadata and return its id."""
    target.mkdir(parents=True, exist_ok=True)
    metadata = manifest_mod.ensure_project_metadata(target, name=name)
    return metadata.id


# ── list ─────────────────────────────────────────────────────────────────────


def test_list_empty_manifest(client: TestClient) -> None:
    resp = client.get("/api/projects")
    assert resp.status_code == 200
    body = resp.json()
    assert body["defaultProjectId"] is None
    assert body["projects"] == []


def test_list_marks_missing_and_default(client: TestClient, tmp_path: Path, home: Path) -> None:
    present_path = tmp_path / "present"
    present_id = _make_project_folder(present_path, name="Present")
    manifest = manifest_mod.ManifestV1(
        defaultProjectId=present_id,
        projects=[
            manifest_mod.ProjectEntry(
                id=present_id, name="Present", path=str(present_path), addedAt="2026-05-24T10:00:00Z",
            ),
            manifest_mod.ProjectEntry(
                id="ghost",
                name="Gone",
                path=str(tmp_path / "does-not-exist"),
                addedAt="2026-05-24T10:00:00Z",
            ),
        ],
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")

    body = client.get("/api/projects").json()
    rows = {p["id"]: p for p in body["projects"]}
    assert rows[present_id]["status"] == "present"
    assert rows[present_id]["isDefault"] is True
    assert rows["ghost"]["status"] == "missing"
    assert rows["ghost"]["isDefault"] is False


# ── default project ───────────────────────────────────────────────────────────


def test_set_default_marks_entry(client: TestClient, tmp_path: Path, home: Path) -> None:
    path = tmp_path / "p1"
    pid = _make_project_folder(path, name="P1")
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id=pid, name="P1", path=str(path), addedAt="2026-05-24T10:00:00Z",
            ),
        ],
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")

    resp = client.post(f"/api/projects/{pid}/default")
    assert resp.status_code == 200
    assert resp.json()["isDefault"] is True

    body = client.get("/api/projects").json()
    assert body["defaultProjectId"] == pid
    rows = {p["id"]: p for p in body["projects"]}
    assert rows[pid]["isDefault"] is True


def test_set_default_unknown_project_404(client: TestClient) -> None:
    assert client.post("/api/projects/ghost/default").status_code == 404


# ── rename (name / id) ───────────────────────────────────────────────────────


def _single_project_manifest(
    home: Path, path: Path, project_id: str, *, name: str = "Plant A", **kwargs,
) -> None:
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id=project_id, name=name, path=str(path), addedAt="2026-05-24T10:00:00Z",
            ),
        ],
        **kwargs,
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")


def test_rename_updates_name_id_metadata_and_default(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    path = tmp_path / "plant-a"
    project_id = _make_project_folder(path)
    _single_project_manifest(home, path, project_id, defaultProjectId=project_id)

    resp = client.patch(
        f"/api/projects/{project_id}", json={"name": "Plant B", "id": "plant-b"},
    )
    assert resp.status_code == 200
    assert resp.json()["id"] == "plant-b"
    assert resp.json()["name"] == "Plant B"
    assert resp.json()["isDefault"] is True

    reloaded = manifest_mod.load_manifest(home / "projects.json")
    assert [(p.id, p.name) for p in reloaded.projects] == [("plant-b", "Plant B")]
    assert reloaded.defaultProjectId == "plant-b"
    metadata = manifest_mod.read_project_metadata(path)
    assert metadata is not None
    assert (metadata.id, metadata.name) == ("plant-b", "Plant B")


def test_rename_name_only_keeps_id(client: TestClient, tmp_path: Path, home: Path) -> None:
    path = tmp_path / "plant-a"
    project_id = _make_project_folder(path)
    _single_project_manifest(home, path, project_id)

    resp = client.patch(f"/api/projects/{project_id}", json={"name": "  Renamed  "})
    assert resp.status_code == 200
    assert resp.json() == {**resp.json(), "id": project_id, "name": "Renamed"}
    metadata = manifest_mod.read_project_metadata(path)
    assert metadata is not None
    assert metadata.name == "Renamed"


def test_rename_moves_instance_logs_and_widget_build(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    path = tmp_path / "plant-a"
    project_id = _make_project_folder(path)
    _single_project_manifest(home, path, project_id)
    logs = home / ".logs" / "instances" / project_id
    logs.mkdir(parents=True)
    (logs / "instance.log").write_text("hello", encoding="utf-8")

    assert client.patch(f"/api/projects/{project_id}", json={"id": "plant-b"}).status_code == 200
    assert not logs.exists()
    assert (home / ".logs" / "instances" / "plant-b" / "instance.log").read_text(
        encoding="utf-8",
    ) == "hello"


def test_rename_retargets_mcp_tokens(
    client: TestClient, tmp_path: Path, home: Path, monkeypatch,
) -> None:
    monkeypatch.setattr(mcp_tokens.manager_auth, "credential_generation", lambda: "gen-1")
    path = tmp_path / "plant-a"
    project_id = _make_project_folder(path)
    _single_project_manifest(home, path, project_id)
    _token_id, raw = mcp_tokens.issue(project_id=project_id, access="write")

    assert client.patch(f"/api/projects/{project_id}", json={"id": "plant-b"}).status_code == 200
    scope = mcp_tokens.resolve(raw)
    assert scope is not None
    assert scope.project_id == "plant-b"


def test_rename_refuses_running_project(client: TestClient, tmp_path: Path, home: Path) -> None:
    path = tmp_path / "plant-a"
    project_id = _make_project_folder(path)
    _single_project_manifest(
        home, path, project_id, running=[manifest_mod.RunningEntry(id=project_id, port=8123)],
    )

    resp = client.patch(f"/api/projects/{project_id}", json={"name": "Plant B"})
    assert resp.status_code == 409


def test_rename_refuses_id_taken_by_another_project(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    first = tmp_path / "plant-a"
    second = tmp_path / "plant-b"
    first_id = _make_project_folder(first, name="Plant A")
    second_id = _make_project_folder(second, name="Plant B")
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id=first_id, name="Plant A", path=str(first), addedAt="2026-05-24T10:00:00Z",
            ),
            manifest_mod.ProjectEntry(
                id=second_id, name="Plant B", path=str(second), addedAt="2026-05-24T10:00:00Z",
            ),
        ],
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")

    # Case-insensitively: the id doubles as a folder name under the runtime home.
    resp = client.patch(f"/api/projects/{first_id}", json={"id": second_id.upper()})
    assert resp.status_code == 409


def test_rename_rejects_invalid_id(client: TestClient, tmp_path: Path, home: Path) -> None:
    path = tmp_path / "plant-a"
    project_id = _make_project_folder(path)
    _single_project_manifest(home, path, project_id)

    assert client.patch(f"/api/projects/{project_id}", json={"id": "../escape"}).status_code == 422
    assert client.patch(f"/api/projects/{project_id}", json={"name": "  "}).status_code == 422


def test_rename_rejects_id_change_when_folder_is_missing(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    _single_project_manifest(home, tmp_path / "gone", "ghost", name="Gone")

    assert client.patch("/api/projects/ghost", json={"id": "still-gone"}).status_code == 422
    # The display name is manifest-side, so it renames without the folder.
    assert client.patch("/api/projects/ghost", json={"name": "Gone Away"}).status_code == 200


def test_rename_unknown_project_404(client: TestClient) -> None:
    assert client.patch("/api/projects/ghost", json={"name": "X"}).status_code == 404


# ── validate-path ────────────────────────────────────────────────────────────


def test_validate_path_ok_for_new_dir(client: TestClient, tmp_path: Path) -> None:
    body = client.post(
        "/api/projects/validate-path",
        json={"path": str(tmp_path / "new-project")},
    ).json()
    assert body["ok"] is True
    assert body["exists"] is False


def test_validate_path_rejects_non_empty_dir(client: TestClient, tmp_path: Path) -> None:
    target = tmp_path / "occupied"
    target.mkdir()
    (target / "x.txt").write_text("hi")
    body = client.post("/api/projects/validate-path", json={"path": str(target)}).json()
    assert body["ok"] is True  # validate-path reports state; create enforces empty
    assert body["exists"] is True
    assert body["isEmpty"] is False


def test_validate_path_rejects_missing_parent(client: TestClient, tmp_path: Path) -> None:
    body = client.post(
        "/api/projects/validate-path",
        json={"path": str(tmp_path / "no" / "such" / "tree")},
    ).json()
    assert body["ok"] is False
    assert body["reason"] == "parent-missing"


# ── browse-dir ───────────────────────────────────────────────────────────────


def test_browse_dir_lists_subdirectories(client: TestClient, tmp_path: Path) -> None:
    scan_dir = tmp_path / "scan"
    (scan_dir / "b-folder").mkdir(parents=True)
    (scan_dir / "a-folder").mkdir()
    (scan_dir / "not-a-dir.txt").write_text("hi")

    body = client.get("/api/projects/browse-dir", params={"path": str(scan_dir)}).json()
    assert body["path"] == str(scan_dir)
    assert [e["name"] for e in body["entries"]] == ["a-folder", "b-folder"]
    assert body["entries"][0]["path"] == str(scan_dir / "a-folder")
    assert body["parent"] == str(scan_dir.parent)


def test_browse_dir_hides_hidden_dirs(client: TestClient, tmp_path: Path) -> None:
    scan_dir = tmp_path / "scan"
    (scan_dir / ".hidden").mkdir(parents=True)
    (scan_dir / "visible").mkdir()

    body = client.get("/api/projects/browse-dir", params={"path": str(scan_dir)}).json()
    assert [e["name"] for e in body["entries"]] == ["visible"]


def test_browse_dir_falls_back_to_parent_for_file_path(client: TestClient, tmp_path: Path) -> None:
    scan_dir = tmp_path / "scan"
    scan_dir.mkdir()
    (scan_dir / "child").mkdir()
    a_file = scan_dir / "a_file.txt"
    a_file.write_text("hi")

    body = client.get("/api/projects/browse-dir", params={"path": str(a_file)}).json()
    assert body["path"] == str(scan_dir)


def test_browse_dir_falls_back_to_home_for_missing_path(client: TestClient) -> None:
    body = client.get(
        "/api/projects/browse-dir", params={"path": "/no/such/tree/at/all"}
    ).json()
    assert body["path"] == str(Path.home())


def test_browse_dir_no_path_defaults_to_home(client: TestClient) -> None:
    body = client.get("/api/projects/browse-dir").json()
    assert body["path"] == str(Path.home())


def test_browse_dir_flags_config_json(client: TestClient, tmp_path: Path) -> None:
    project_dir = tmp_path / "existing-project"
    project_dir.mkdir()
    (project_dir / "config.json").write_text("{}")

    body = client.get(
        "/api/projects/browse-dir", params={"path": str(project_dir)}
    ).json()
    assert body["hasConfigJson"] is True

    plain_dir = tmp_path / "plain"
    plain_dir.mkdir()
    body = client.get("/api/projects/browse-dir", params={"path": str(plain_dir)}).json()
    assert body["hasConfigJson"] is False


# ── create ───────────────────────────────────────────────────────────────────


def test_create_seeds_and_registers(client: TestClient, tmp_path: Path) -> None:
    target = tmp_path / "Plant-A"
    resp = client.post("/api/projects", json={"name": "Plant A", "path": str(target)})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "Plant A"
    assert body["isDefault"] is False
    # Embedded project metadata was written and shows up in the manifest.
    metadata = manifest_mod.read_project_metadata(target)
    assert metadata is not None
    assert metadata.id == body["id"]
    assert body["operatorSetupRequired"] is True
    users = (target / "users.json").read_text(encoding="utf-8")
    assert '"password": "admin"' not in users


def test_create_rejects_non_empty_target(client: TestClient, tmp_path: Path) -> None:
    target = tmp_path / "Occupied"
    target.mkdir()
    (target / "x.txt").write_text("hi")
    resp = client.post("/api/projects", json={"name": "X", "path": str(target)})
    assert resp.status_code == 422
    assert "not empty" in resp.json()["detail"]


def test_create_refuses_already_registered(client: TestClient, tmp_path: Path) -> None:
    target = tmp_path / "Plant-A"
    first = client.post("/api/projects", json={"name": "Plant A", "path": str(target)})
    assert first.status_code == 201
    # Try to create again at the same target — project metadata already exists,
    # so the second request hits the existing-project guard.
    second_target = tmp_path / "Plant-A-2"
    target.rename(second_target)
    resp = client.post("/api/projects", json={"name": "Plant A again", "path": str(second_target)})
    assert resp.status_code == 409, resp.text


# ── locate ───────────────────────────────────────────────────────────────────


def test_locate_updates_path_when_id_matches(client: TestClient, tmp_path: Path, home: Path) -> None:
    moved = tmp_path / "moved-here"
    project_id = _make_project_folder(moved, name="Moved")
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id=project_id,
                name="Moved",
                path=str(tmp_path / "old-location"),
                addedAt="2026-05-24T10:00:00Z",
            ),
        ],
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")

    resp = client.post(f"/api/projects/{project_id}/locate", json={"path": str(moved)})
    assert resp.status_code == 200
    assert Path(resp.json()["path"]) == moved.resolve()


def test_locate_rejects_id_mismatch(client: TestClient, tmp_path: Path, home: Path) -> None:
    other = tmp_path / "other-project"
    _make_project_folder(other, name="Other")
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id="entry-id",
                name="Entry",
                path=str(tmp_path / "old"),
                addedAt="2026-05-24T10:00:00Z",
            ),
        ],
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")

    resp = client.post("/api/projects/entry-id/locate", json={"path": str(other)})
    assert resp.status_code == 409


def test_locate_rejects_folder_without_metadata(client: TestClient, tmp_path: Path, home: Path) -> None:
    empty = tmp_path / "no-metadata"
    empty.mkdir()
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id="entry-id",
                name="Entry",
                path=str(tmp_path / "old"),
                addedAt="2026-05-24T10:00:00Z",
            ),
        ],
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")

    resp = client.post("/api/projects/entry-id/locate", json={"path": str(empty)})
    assert resp.status_code == 422


# ── delete ───────────────────────────────────────────────────────────────────


def test_delete_removes_entry(client: TestClient, tmp_path: Path, home: Path) -> None:
    target = tmp_path / "to-remove"
    project_id = _make_project_folder(target)
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id=project_id, name="X", path=str(target), addedAt="2026-05-24T10:00:00Z",
            ),
        ],
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")

    resp = client.delete(f"/api/projects/{project_id}")
    assert resp.status_code == 200
    assert manifest_mod.load_manifest(home / "projects.json").projects == []
    # Folder left on disk by default.
    assert target.exists()


def test_delete_with_folder_flag_rmtrees(client: TestClient, tmp_path: Path, home: Path) -> None:
    target = tmp_path / "wipe-me"
    project_id = _make_project_folder(target)
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id=project_id, name="X", path=str(target), addedAt="2026-05-24T10:00:00Z",
            ),
        ],
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")

    resp = client.delete(f"/api/projects/{project_id}?deleteFolder=true")
    assert resp.status_code == 200
    assert not target.exists()


def test_delete_with_folder_flag_refuses_when_metadata_missing(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    """Defense against a wrong/typo'd path: refuse to ``rmtree`` an unrelated dir."""
    target = tmp_path / "stranger"
    target.mkdir()
    (target / "important.txt").write_text("data")
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id="entry", name="X", path=str(target), addedAt="2026-05-24T10:00:00Z",
            ),
        ],
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")

    resp = client.delete("/api/projects/entry?deleteFolder=true")
    assert resp.status_code == 422
    assert target.exists()


def test_delete_refuses_running_project(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    target = tmp_path / "running"
    project_id = _make_project_folder(target)
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id=project_id, name="X", path=str(target), addedAt="2026-05-24T10:00:00Z",
            ),
        ],
        # The authoritative running set — the guard reads this, not the in-process
        # supervisor singleton (which is empty in a project-instance child).
        running=[manifest_mod.RunningEntry(id=project_id, port=8123)],
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")

    resp = client.delete(f"/api/projects/{project_id}")
    assert resp.status_code == 409


# ── 404 for unknown id ───────────────────────────────────────────────────────


def test_unknown_id_returns_404(client: TestClient) -> None:
    resp = client.delete("/api/projects/unknown")
    assert resp.status_code == 404


# ── runtime-home info ────────────────────────────────────────────────────────


def test_runtime_home_info(client: TestClient, home: Path) -> None:
    body = client.get("/api/projects/_runtime-home").json()
    assert body["runtimeHome"] == str(home)
    assert body["defaultProjectsRoot"].endswith("Projects")


# ── export / import ──────────────────────────────────────────────────────────


def _seed_registered_project(
    tmp_path: Path, home: Path, *, name: str = "Plant A",
) -> tuple[str, Path]:
    """Create a project folder, register it in the manifest, and return (id, path)."""
    target = tmp_path / name.replace(" ", "-")
    target.mkdir()
    target.mkdir(exist_ok=True)
    (target / "pages.json").write_text('{"pages":[]}')
    (target / "users.json").write_text('{"users":[]}')
    project_id = _make_project_folder(target, name=name)
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id=project_id, name=name, path=str(target), addedAt="2026-05-24T10:00:00Z",
            ),
        ],
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")
    return project_id, target


def test_export_returns_zip_with_metadata(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    project_id, _ = _seed_registered_project(tmp_path, home)
    resp = client.get(f"/api/projects/{project_id}/export")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    assert "attachment" in resp.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = set(zf.namelist())
    assert manifest_mod.PROJECT_CONFIG_FILENAME in names
    assert "users.json" in names
    assert "pages.json" in names


def test_export_rejects_missing_folder(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id="ghost",
                name="Gone",
                path=str(tmp_path / "vanished"),
                addedAt="2026-05-24T10:00:00Z",
            ),
        ],
    )
    manifest_mod.save_manifest(manifest, home / "projects.json")
    resp = client.get("/api/projects/ghost/export")
    assert resp.status_code == 409


def test_export_404_for_unknown_id(client: TestClient) -> None:
    resp = client.get("/api/projects/nope/export")
    assert resp.status_code == 404


def _build_zip(source_root: Path) -> bytes:
    buf = io.BytesIO()
    pack_project(source_root, buf)
    return buf.getvalue()


def test_import_creates_entry_and_extracts(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    source.mkdir(exist_ok=True)
    (source / "pages.json").write_text('{"hello":"world"}')
    src_id = _make_project_folder(source, name="Source")
    payload = _build_zip(source)

    destination = tmp_path / "imported"
    resp = client.post(
        "/api/projects/import",
        files={"file": ("source.zip", payload, "application/zip")},
        data={"destinationPath": str(destination), "name": "Imported"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["id"] == src_id
    assert body["name"] == "Imported"
    assert body["isDefault"] is False
    assert (destination / "pages.json").read_text() == '{"hello":"world"}'

    manifest = manifest_mod.load_manifest(home / "projects.json")
    assert [p.id for p in manifest.projects] == [src_id]


def test_import_rejects_when_id_already_registered(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    existing_id, _ = _seed_registered_project(tmp_path, home, name="Existing")

    # Build a zip whose metadata id collides with the existing entry.
    source = tmp_path / "twin"
    source.mkdir()
    source.mkdir(exist_ok=True)
    (source / "pages.json").write_text("{}")
    manifest_mod.write_project_metadata(
        source,
        manifest_mod.ProjectMetadata(id=existing_id, name="Twin"),
    )
    payload = _build_zip(source)

    destination = tmp_path / "imported"
    resp = client.post(
        "/api/projects/import",
        files={"file": ("twin.zip", payload, "application/zip")},
        data={"destinationPath": str(destination)},
    )
    assert resp.status_code == 409, resp.text
    assert not destination.exists(), "destination should be cleaned up on conflict"


def test_import_rejects_non_empty_destination(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _make_project_folder(source, name="Source")
    payload = _build_zip(source)

    destination = tmp_path / "occupied"
    destination.mkdir()
    (destination / "x.txt").write_text("hi")

    resp = client.post(
        "/api/projects/import",
        files={"file": ("source.zip", payload, "application/zip")},
        data={"destinationPath": str(destination)},
    )
    assert resp.status_code == 422
    assert "not empty" in resp.json()["detail"]


def test_import_rejects_invalid_zip(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    destination = tmp_path / "import-here"
    resp = client.post(
        "/api/projects/import",
        files={"file": ("bad.zip", b"not actually a zip", "application/zip")},
        data={"destinationPath": str(destination)},
    )
    assert resp.status_code == 422
    assert not destination.exists()


def test_import_rejects_component_direct_binding_and_cleans_destination(
    client: TestClient, tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _make_project_folder(source, name="Invalid component project")
    components = source / "components"
    components.mkdir()
    (components / "invalid.json").write_text(
        '{"name":"Invalid","componentProperties":{},"children":['
        '{"type":"Label","properties":{"text":{"$var":{"path":"PLC:Value"}}}}]}'
    )
    payload = _build_zip(source)
    destination = tmp_path / "imported-invalid"

    resp = client.post(
        "/api/projects/import",
        files={"file": ("source.zip", payload, "application/zip")},
        data={"destinationPath": str(destination)},
    )

    assert resp.status_code == 422
    assert "components/invalid.json#/children/0/properties/text/$var" in resp.json()["detail"]
    assert not destination.exists()


def test_import_rejects_malformed_component_without_registration(
    client: TestClient, tmp_path: Path, home: Path,
) -> None:
    source = tmp_path / "source-malformed"
    source.mkdir()
    _make_project_folder(source, name="Malformed component project")
    components = source / "components"
    components.mkdir()
    (components / "broken.json").write_text('{"name":')
    payload = _build_zip(source)
    destination = tmp_path / "imported-malformed"

    resp = client.post(
        "/api/projects/import",
        files={"file": ("source.zip", payload, "application/zip")},
        data={"destinationPath": str(destination)},
    )

    assert resp.status_code == 422
    assert (
        "components/broken.json#/: component file contains malformed JSON"
        in resp.json()["detail"]
    )
    assert not destination.exists()
    assert manifest_mod.load_manifest(home / "projects.json").projects == []
