"""Tests for ``core.manifest`` and ``core.runtime_home``.

Phase 1 of the project-management redesign: these modules are additive — no
existing call site uses them yet. We test round-trip serialization,
corruption tolerance, slug behavior, and the runtime-home resolver order.
"""
from __future__ import annotations

import json
import multiprocessing
import uuid
from pathlib import Path

import pytest
from core import runtime_home
from core.manifest import (
    ManifestV1,
    PeerEntry,
    ProjectEntry,
    ProjectMetadata,
    default_project,
    find_project,
    load_manifest,
    migrate_invalid_project_ids,
    read_project_metadata,
    save_manifest,
    slugify,
    unique_slug,
    validate_project_id,
    write_project_metadata,
)
from pydantic import ValidationError as PydanticValidationError


def _make_project(name: str = "Plant A", *, project_id: str | None = None) -> ProjectEntry:
    return ProjectEntry(
        id=project_id or str(uuid.uuid4()),
        name=name,
        path=f"/tmp/{name.replace(' ', '-')}",
        addedAt="2026-05-24T10:00:00Z",
    )


def _hold_project_transaction(path: str, entered, release) -> None:
    from core.manifest import manifest_transaction

    with manifest_transaction(Path(path)) as manifest:
        entered.set()
        if not release.wait(10):
            raise RuntimeError("timed out waiting to release manifest transaction")
        manifest.projects.append(_make_project("Pulled"))
        save_manifest(manifest, Path(path))


def _append_peer_transaction(path: str, attempting, entered) -> None:
    from core.manifest import manifest_transaction

    attempting.set()
    with manifest_transaction(Path(path)) as manifest:
        entered.set()
        manifest.peers.append(
            PeerEntry(
                name="Peer",
                host="peer.local",
                port=8000,
                addedAt="2026-05-24T10:00:00Z",
            ),
        )
        save_manifest(manifest, Path(path))


# ── round-trip ──────────────────────────────────────────────────────────────


def test_round_trip_preserves_uuids(tmp_path: Path) -> None:
    f = tmp_path / "projects.json"
    p1 = _make_project("Plant A")
    p2 = _make_project("Plant B")
    save_manifest(
        ManifestV1(defaultProjectId=p1.id, projects=[p1, p2]),
        f,
    )
    loaded = load_manifest(f)
    assert loaded.defaultProjectId == p1.id
    assert [p.id for p in loaded.projects] == [p1.id, p2.id]


def test_round_trip_preserves_peers(tmp_path: Path) -> None:
    f = tmp_path / "projects.json"
    peer = PeerEntry(name="Plant-B", host="10.0.0.42", port=8001, addedAt="2026-05-24T10:00:00Z")
    save_manifest(ManifestV1(peers=[peer]), f)
    loaded = load_manifest(f)
    assert loaded.peers == [peer]


def test_round_trip_preserves_default_projects_root(tmp_path: Path) -> None:
    f = tmp_path / "projects.json"
    save_manifest(ManifestV1(defaultProjectsRoot=str(tmp_path / "Projects")), f)
    loaded = load_manifest(f)
    assert loaded.defaultProjectsRoot == str(tmp_path / "Projects")


def test_missing_on_disk_entries_survive_round_trip(tmp_path: Path) -> None:
    """Entries pointing at non-existent paths must persist — the UI surfaces
    them as ``missing`` and offers Locate/Remove. We never auto-purge."""
    f = tmp_path / "projects.json"
    entry = ProjectEntry(
        id="ghost",
        name="Old",
        path="/does/not/exist/anywhere",
        addedAt="2026-05-24T10:00:00Z",
    )
    save_manifest(ManifestV1(projects=[entry]), f)
    loaded = load_manifest(f)
    assert loaded.projects[0].path == "/does/not/exist/anywhere"


# ── tolerance ───────────────────────────────────────────────────────────────


def test_load_missing_returns_empty_manifest(tmp_path: Path) -> None:
    loaded = load_manifest(tmp_path / "absent.json")
    assert loaded.projects == []
    assert loaded.defaultProjectId is None
    assert loaded.version == 1


def test_load_corrupt_returns_empty_manifest(tmp_path: Path) -> None:
    f = tmp_path / "projects.json"
    f.write_text("{not json")
    loaded = load_manifest(f)
    assert loaded.projects == []


def test_load_non_object_returns_empty_manifest(tmp_path: Path) -> None:
    f = tmp_path / "projects.json"
    f.write_text('["nope"]')
    loaded = load_manifest(f)
    assert loaded.projects == []


def test_save_creates_parent_dirs(tmp_path: Path) -> None:
    f = tmp_path / "nested" / "dir" / "projects.json"
    save_manifest(ManifestV1(), f)
    assert f.exists()


def test_save_failure_leaves_original_intact(tmp_path: Path, monkeypatch) -> None:
    f = tmp_path / "projects.json"
    save_manifest(ManifestV1(projects=[_make_project("Keep")]), f)
    original = f.read_text()

    import core.manifest as manifest_mod

    def boom(_src, _dst):
        raise OSError("simulated")

    monkeypatch.setattr(manifest_mod.os, "replace", boom)
    with pytest.raises(OSError):
        save_manifest(ManifestV1(projects=[_make_project("Other")]), f)

    assert f.read_text() == original
    leftover = [p for p in tmp_path.iterdir() if p.suffix == ".tmp"]
    assert leftover == []


def test_stale_manifest_writer_cannot_erase_new_project(tmp_path: Path) -> None:
    from core.manifest import ManifestConflictError, manifest_transaction

    path = tmp_path / "projects.json"
    save_manifest(ManifestV1(), path)
    stale = load_manifest(path)

    with manifest_transaction(path) as current:
        current.projects.append(_make_project("Pulled"))
        save_manifest(current, path)

    stale.peers.append(
        PeerEntry(name="Peer", host="peer.local", port=8000, addedAt="2026-05-24T10:00:00Z"),
    )
    with pytest.raises(ManifestConflictError):
        save_manifest(stale, path)

    persisted = load_manifest(path)
    assert [project.name for project in persisted.projects] == ["Pulled"]
    assert persisted.peers == []


def test_manifest_transaction_serializes_processes_without_lost_updates(tmp_path: Path) -> None:
    path = tmp_path / "projects.json"
    save_manifest(ManifestV1(), path)
    context = multiprocessing.get_context("spawn")
    first_entered = context.Event()
    release_first = context.Event()
    second_attempting = context.Event()
    second_entered = context.Event()
    first = context.Process(
        target=_hold_project_transaction,
        args=(str(path), first_entered, release_first),
    )
    second = context.Process(
        target=_append_peer_transaction,
        args=(str(path), second_attempting, second_entered),
    )

    first.start()
    try:
        assert first_entered.wait(5)
        second.start()
        assert second_attempting.wait(5)
        assert not second_entered.wait(0.2)
        release_first.set()
        first.join(10)
        second.join(10)
    finally:
        release_first.set()
        for process in (first, second):
            if process.is_alive():
                process.terminate()
                process.join(5)
    assert first.exitcode == 0
    assert second.exitcode == 0
    persisted = load_manifest(path)
    assert [project.name for project in persisted.projects] == ["Pulled"]
    assert [peer.name for peer in persisted.peers] == ["Peer"]


# ── slug helpers ────────────────────────────────────────────────────────────


def test_slugify_replaces_unsafe_chars() -> None:
    assert slugify("Plant A!") == "Plant-A"
    assert slugify("Plant / B") == "Plant-B"
    assert slugify("Plant_A.v2") == "Plant_A.v2"


def test_slugify_strips_non_ascii() -> None:
    # NFKD decomposes 'é' into 'e' + combining acute; the combining mark is
    # what gets stripped, so the bare letter survives.
    assert slugify("Café") == "Cafe"
    assert slugify("über") == "uber"


def test_slugify_falls_back_to_placeholder() -> None:
    assert slugify("---") == "project"
    assert slugify("!!!") == "project"
    assert slugify("") == "project"


def test_slugify_always_produces_a_valid_project_id() -> None:
    # A slug becomes both a project id and a folder name; a leading dot or
    # underscore, or a Windows reserved basename, used to slug cleanly and then
    # fail id validation — bricking creation and manifest reload.
    assert slugify("_Line 3") == "Line-3"
    assert slugify(".hidden") == "hidden"
    assert slugify("CON") == "project-CON"
    assert slugify("nul.project") == "project-nul.project"
    for name in ("_Line 3", ".hidden", "CON", "aux", "COM9.bak", "-_.", "x" * 300):
        validate_project_id(slugify(name))


def test_unique_slug_no_collision() -> None:
    assert unique_slug("Plant A", []) == "Plant-A"


def test_unique_slug_suffixes_on_collision() -> None:
    assert unique_slug("Plant A", {"Plant-A"}) == "Plant-A-2"
    assert unique_slug("Plant A", {"Plant-A", "Plant-A-2"}) == "Plant-A-3"
    assert unique_slug("Plant A", {"Plant-A", "Plant-A-3"}) == "Plant-A-2"


# ── lookup helpers ──────────────────────────────────────────────────────────


def test_find_project_by_id() -> None:
    p1 = _make_project("A", project_id="id-1")
    p2 = _make_project("B", project_id="id-2")
    manifest = ManifestV1(projects=[p1, p2])
    assert find_project(manifest, "id-2") is p2
    assert find_project(manifest, "missing") is None


def test_default_project_returns_none_when_unset() -> None:
    p = _make_project("A", project_id="id-1")
    assert default_project(ManifestV1(projects=[p])) is None


def test_default_project_resolves_by_id() -> None:
    p = _make_project("A", project_id="id-1")
    manifest = ManifestV1(defaultProjectId="id-1", projects=[p])
    assert default_project(manifest) is p


def test_default_project_returns_none_when_id_dangling() -> None:
    """``defaultProjectId`` pointing at a removed project shouldn't crash —
    callers will see ``None`` and fall back to the Projects page."""
    p = _make_project("A", project_id="id-1")
    manifest = ManifestV1(defaultProjectId="ghost", projects=[p])
    assert default_project(manifest) is None


@pytest.mark.parametrize(
    "project_id",
    [
        "../escape",
        "a/b",
        "a\\b",
        "/absolute",
        ".hidden",
        "..",
        "CON",
        "con.txt",
        "x" * 129,
    ],
)
def test_project_ids_reject_filesystem_and_url_escapes(project_id: str) -> None:
    with pytest.raises(ValueError):
        validate_project_id(project_id)
    with pytest.raises(PydanticValidationError):
        ProjectEntry(
            id=project_id,
            name="Unsafe",
            path="/tmp/unsafe",
            addedAt="2026-05-24T10:00:00Z",
        )


def test_running_and_metadata_use_same_canonical_project_id() -> None:
    from core.manifest import RunningEntry

    with pytest.raises(PydanticValidationError):
        RunningEntry(id="../../logs", port=8000)
    with pytest.raises(PydanticValidationError):
        ProjectMetadata(id="../../widgets", name="Unsafe")


def test_write_project_metadata_preserves_sibling_fields_it_does_not_model(tmp_path: Path) -> None:
    """Other writers (theme_manager's ``defaultTheme``) read-modify-write
    fields into the same ``project`` block directly, bypassing this model.
    A read/write round trip through ``ProjectMetadata`` must not clobber
    them — regression for a real data-loss bug caught during backlog #20."""
    project_root = tmp_path / "proj"
    project_root.mkdir()
    config_path = project_root / "config.json"
    config_path.write_text(json.dumps({
        "project": {"id": "proj", "name": "Proj", "createdAt": "2026-01-01T00:00:00Z", "defaultTheme": "light"},
        "mcpEnabled": True,
    }))

    metadata = read_project_metadata(project_root)
    assert metadata is not None
    updated = metadata.model_copy(update={"formatVersion": 1})
    write_project_metadata(project_root, updated)

    saved = json.loads(config_path.read_text())
    assert saved["project"]["defaultTheme"] == "light"
    assert saved["project"]["formatVersion"] == 1
    assert saved["mcpEnabled"] is True


# ── runtime_home resolver ───────────────────────────────────────────────────


def test_runtime_home_uses_env_var(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(tmp_path / "custom"))
    assert runtime_home.runtime_home_path() == tmp_path / "custom"


def test_runtime_home_uses_bootstrap_when_no_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("NEXTHMI_DATA_DIR", raising=False)
    boot = tmp_path / "runtime.json"
    boot.write_text('{"dataDir": "' + str(tmp_path / "from-boot") + '"}')

    from core import bootstrap

    monkeypatch.setattr(bootstrap, "bootstrap_config_path", lambda: boot)
    assert runtime_home.runtime_home_path() == tmp_path / "from-boot"


def test_runtime_home_falls_back_to_dev_when_in_checkout(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("NEXTHMI_DATA_DIR", raising=False)
    monkeypatch.setattr(runtime_home, "_running_from_checkout", lambda: True)
    monkeypatch.setattr(runtime_home.bootstrap, "read_bootstrap_config", lambda: {})
    assert runtime_home.runtime_home_path() == runtime_home._DEV_RUNTIME_HOME


def test_runtime_home_falls_back_to_platform_default_when_not_in_checkout(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("NEXTHMI_DATA_DIR", raising=False)
    monkeypatch.setattr(runtime_home, "_running_from_checkout", lambda: False)
    monkeypatch.setattr(runtime_home.bootstrap, "read_bootstrap_config", lambda: {})
    expected = runtime_home._platform_default()
    assert runtime_home.runtime_home_path() == expected


def test_manifest_path_lives_inside_runtime_home(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(tmp_path))
    assert runtime_home.manifest_path() == tmp_path / "projects.json"


def test_widget_build_dir_under_runtime_home(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("NEXTHMI_WIDGET_BUILD_DIR", raising=False)
    assert runtime_home.widget_build_dir() == tmp_path / ".widget-build"


def test_widget_build_dir_env_var_wins(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("NEXTHMI_WIDGET_BUILD_DIR", str(tmp_path / "wb-override"))
    assert runtime_home.widget_build_dir() == tmp_path / "wb-override"


def test_logs_dir_env_var_wins(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("NEXTHMI_LOGS_DIR", str(tmp_path / "logs-override"))
    assert runtime_home.logs_dir() == tmp_path / "logs-override"


def test_restart_sentinel_under_runtime_home(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(tmp_path))
    assert runtime_home.restart_sentinel_path() == tmp_path / ".restart-pending"


def test_migrate_invalid_project_ids_rewrites_every_reference(tmp_path: Path) -> None:
    project_root = tmp_path / "line-3"
    project_root.mkdir()
    (project_root / "config.json").write_text(
        json.dumps({"project": {"id": "_Line-3", "name": "Line 3"}, "mcpEnabled": True}),
        encoding="utf-8",
    )
    path = tmp_path / "projects.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "defaultProjectId": "_Line-3",
                "projects": [
                    {
                        "id": "_Line-3",
                        "name": "Line 3",
                        "path": str(project_root),
                        "addedAt": "2026-01-01T00:00:00Z",
                    },
                    {
                        "id": "Line-3",
                        "name": "Other",
                        "path": str(tmp_path / "other"),
                        "addedAt": "2026-01-01T00:00:00Z",
                    },
                ],
                "running": [{"id": "_Line-3", "port": 8123}],
            }
        ),
        encoding="utf-8",
    )

    renames = migrate_invalid_project_ids(path)

    # The valid id already owns "Line-3", so the migrated one must not collide.
    assert renames == {"_Line-3": "Line-3-2"}
    manifest = load_manifest(path)
    assert [entry.id for entry in manifest.projects] == ["Line-3-2", "Line-3"]
    assert [entry.id for entry in manifest.running] == ["Line-3-2"]
    assert manifest.defaultProjectId == "Line-3-2"
    config = json.loads((project_root / "config.json").read_text(encoding="utf-8"))
    assert config["project"]["id"] == "Line-3-2"
    assert config["mcpEnabled"] is True


def test_migrate_invalid_project_ids_is_a_noop_for_valid_manifests(
    tmp_path: Path,
) -> None:
    path = tmp_path / "projects.json"
    save_manifest(ManifestV1(projects=[_make_project()]), path)
    before = path.read_text(encoding="utf-8")

    assert migrate_invalid_project_ids(path) == {}
    assert path.read_text(encoding="utf-8") == before


def test_migrate_clears_legacy_ids_with_no_project_entry(tmp_path: Path) -> None:
    # Deleting a project leaves defaultProjectId/running behind. With no entry
    # to migrate from, they must still be sanitized or the manager can never
    # load the manifest again.
    path = tmp_path / "projects.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "defaultProjectId": "_Line-3",
                "projects": [],
                "running": [{"id": "_Line-3", "port": 8123}],
            }
        ),
        encoding="utf-8",
    )

    migrate_invalid_project_ids(path)

    manifest = load_manifest(path)
    assert manifest.defaultProjectId is None
    assert manifest.running == []


def test_migrate_keeps_duplicate_legacy_ids_distinct(tmp_path: Path) -> None:
    # Two entries can share an invalid id. Each must get its own replacement in
    # both the manifest and its own config.json — never the same one twice.
    first = tmp_path / "first"
    second = tmp_path / "second"
    for root in (first, second):
        root.mkdir()
        (root / "config.json").write_text(
            json.dumps({"project": {"id": "_dup", "name": root.name}}), encoding="utf-8"
        )
    path = tmp_path / "projects.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "projects": [
                    {
                        "id": "_dup",
                        "name": "First",
                        "path": str(first),
                        "addedAt": "2026-01-01T00:00:00Z",
                    },
                    {
                        "id": "_dup",
                        "name": "Second",
                        "path": str(second),
                        "addedAt": "2026-01-01T00:00:00Z",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    migrate_invalid_project_ids(path)

    manifest = load_manifest(path)
    ids = [entry.id for entry in manifest.projects]
    assert len(set(ids)) == 2, ids
    for entry in manifest.projects:
        on_disk = json.loads(
            (Path(entry.path) / "config.json").read_text(encoding="utf-8")
        )
        assert on_disk["project"]["id"] == entry.id


def test_migrate_survives_an_unwritable_project_folder(
    tmp_path: Path, monkeypatch
) -> None:
    # An unwritable project folder must not abort manager startup; the manifest
    # write is what matters and the config rewrite retries on a later boot.
    import core.manifest as manifest_mod

    project_root = tmp_path / "line"
    project_root.mkdir()
    (project_root / "config.json").write_text(
        json.dumps({"project": {"id": "_Line-3", "name": "Line 3"}}), encoding="utf-8"
    )
    path = tmp_path / "projects.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "projects": [
                    {
                        "id": "_Line-3",
                        "name": "Line 3",
                        "path": str(project_root),
                        "addedAt": "2026-01-01T00:00:00Z",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    original_write = manifest_mod._atomic_write_json

    def refuse_project_config(target: Path, payload) -> None:
        if target.name == "config.json":
            raise PermissionError(13, "read-only project folder")
        original_write(target, payload)

    monkeypatch.setattr(manifest_mod, "_atomic_write_json", refuse_project_config)

    assert migrate_invalid_project_ids(path) == {"_Line-3": "Line-3"}
    assert load_manifest(path).projects[0].id == "Line-3"


def test_migrate_resolves_config_divergence_on_a_later_boot(
    tmp_path: Path, monkeypatch
) -> None:
    # A folder that was unwritable during the first boot keeps the legacy id
    # forever unless the rewrite is re-derived from the manifest each time —
    # and a stale id there reads back as "no metadata", earning a third id.
    import core.manifest as manifest_mod

    project_root = tmp_path / "line"
    project_root.mkdir()
    (project_root / "config.json").write_text(
        json.dumps({"project": {"id": "_Line-3", "name": "Line 3"}}), encoding="utf-8"
    )
    path = tmp_path / "projects.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "projects": [
                    {
                        "id": "_Line-3",
                        "name": "Line 3",
                        "path": str(project_root),
                        "addedAt": "2026-01-01T00:00:00Z",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    original_write = manifest_mod._atomic_write_json

    def refuse_project_config(target: Path, payload) -> None:
        if target.name == "config.json":
            raise PermissionError(13, "read-only project folder")
        original_write(target, payload)

    monkeypatch.setattr(manifest_mod, "_atomic_write_json", refuse_project_config)
    migrate_invalid_project_ids(path)
    assert json.loads((project_root / "config.json").read_text())["project"]["id"] == (
        "_Line-3"
    )

    # Folder writable again on the next boot.
    monkeypatch.setattr(manifest_mod, "_atomic_write_json", original_write)
    migrate_invalid_project_ids(path)

    manifest = load_manifest(path)
    assert manifest.projects[0].id == "Line-3"
    on_disk = json.loads((project_root / "config.json").read_text())
    assert on_disk["project"]["id"] == "Line-3"
    assert read_project_metadata(project_root).id == "Line-3"


def test_migrate_drops_references_it_cannot_attribute(tmp_path: Path) -> None:
    # Two projects share one invalid id, so a reference to that id cannot be
    # resolved to a project. Aiming it at whichever was renamed last would
    # resume or serve the wrong project; dropping it is the honest outcome.
    first = tmp_path / "first"
    second = tmp_path / "second"
    for root in (first, second):
        root.mkdir()
    path = tmp_path / "projects.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "defaultProjectId": "_dup",
                "projects": [
                    {
                        "id": "_dup",
                        "name": "First",
                        "path": str(first),
                        "addedAt": "2026-01-01T00:00:00Z",
                    },
                    {
                        "id": "_dup",
                        "name": "Second",
                        "path": str(second),
                        "addedAt": "2026-01-01T00:00:00Z",
                    },
                ],
                "running": [{"id": "_dup", "port": 8123}],
            }
        ),
        encoding="utf-8",
    )

    migrate_invalid_project_ids(path)

    manifest = load_manifest(path)
    assert len({entry.id for entry in manifest.projects}) == 2
    assert manifest.defaultProjectId is None
    assert manifest.running == []
