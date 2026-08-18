"""Fresh-install seeding of the supervisor running set."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from core import manifest as manifest_mod
from core import runtime_home
from services import project_resume


@pytest.fixture
def home(monkeypatch, tmp_path: Path) -> Path:
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    return home_dir


def test_running_set_untouched_when_already_populated(home: Path) -> None:
    manifest = manifest_mod.ManifestV1(
        running=[manifest_mod.RunningEntry(id="a", port=5000)],
    )
    manifest_mod.save_manifest(manifest)
    project_resume.prepare_running_set()
    persisted = manifest_mod.load_manifest()
    assert [r.id for r in persisted.running] == ["a"]


def test_fresh_install_seeds_example(home: Path, monkeypatch) -> None:
    seeded = manifest_mod.ProjectEntry(
        id="seed-1", name="Default", path=str(home / "Default-Project"), addedAt="2026-06-14T00:00:00Z"
    )
    Path(seeded.path).mkdir(parents=True)
    (Path(seeded.path) / "users.json").write_text(
        json.dumps({"settings": {}, "groups": [], "users": []}), encoding="utf-8"
    )

    def _fake_bootstrap():
        manifest = manifest_mod.load_manifest()
        manifest.projects.append(seeded)
        manifest_mod.save_manifest(manifest)
        return seeded

    monkeypatch.setattr(project_resume, "ensure_default_project", _fake_bootstrap)

    project_resume.prepare_running_set()

    persisted = manifest_mod.load_manifest()
    assert [r.id for r in persisted.running] == ["seed-1"]


def test_projects_present_but_none_running_stays_empty(home: Path, tmp_path: Path) -> None:
    # Operator stopped everything; a restart must not auto-start anything.
    target = tmp_path / "Existing"
    metadata = manifest_mod.ensure_project_metadata(target, name="Existing")
    manifest = manifest_mod.ManifestV1(
        projects=[
            manifest_mod.ProjectEntry(
                id=metadata.id, name="Existing", path=str(target), addedAt="2026-06-14T00:00:00Z"
            ),
        ],
    )
    manifest_mod.save_manifest(manifest)

    project_resume.prepare_running_set()
    assert manifest_mod.load_manifest().running == []


def test_fresh_seed_awaits_operator_setup_before_auto_start(
    home: Path, monkeypatch, tmp_path: Path
) -> None:
    target = tmp_path / "Default-Project"
    target.mkdir()
    (target / "users.json").write_text(
        json.dumps(
            {
                "settings": {},
                "groups": [
                    {"id": "guest", "label": "Guest"},
                    {"id": "admin", "label": "Admin"},
                ],
                "users": [
                    {
                        "id": "guest",
                        "username": "guest",
                        "password": "",
                        "groups": ["guest"],
                    }
                ],
                "operatorSetup": {"version": 1, "required": True},
            }
        ),
        encoding="utf-8",
    )
    seeded = manifest_mod.ProjectEntry(
        id="seed-pending",
        name="Default",
        path=str(target),
        addedAt="2026-06-14T00:00:00Z",
    )

    def _fake_bootstrap():
        manifest = manifest_mod.load_manifest()
        manifest.projects.append(seeded)
        manifest_mod.save_manifest(manifest)
        return seeded

    monkeypatch.setattr(project_resume, "ensure_default_project", _fake_bootstrap)

    project_resume.prepare_running_set()

    persisted = manifest_mod.load_manifest()
    assert persisted.running == []
