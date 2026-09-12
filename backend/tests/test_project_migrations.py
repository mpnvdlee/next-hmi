"""Tests for the baseline project-format migration coordinator.

The first half covers the coordinator itself — version gating, target staging,
stamping. The second half registers a synthetic step to exercise the
staging/swap machinery in isolation from whatever the real steps do;
the 4 -> 5 step's own rules live in ``test_migration_size_modes.py``.
"""

import itertools
import json
import zipfile
from pathlib import Path

import core.project_migrations as pm
import pytest
from core.manifest import ProjectMetadata, read_project_metadata, write_project_metadata


def _stamp(project_root: Path, format_version: int, *, min_app: str | None = None) -> None:
    """Stamp a format version. ``min_app`` left out means a project from before
    the release stamp existed — which the coordinator replays rather than skips."""
    write_project_metadata(
        project_root,
        ProjectMetadata(id="proj", formatVersion=format_version, minAppVersion=min_app),
    )


def _write_datasource(project_root: Path, name: str, variables: list) -> Path:
    ds_dir = project_root / "datasources"
    ds_dir.mkdir(parents=True, exist_ok=True)
    path = ds_dir / f"{name}.json"
    path.write_text(json.dumps({"name": name, "type": "static", "variables": variables}))
    return path


@pytest.fixture
def project_root(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    return root


def test_the_step_chain_is_contiguous_and_ends_at_the_current_version() -> None:
    """The coordinator selects pending steps by `from_version >= current`, which
    only picks the right ones while the chain has no gaps and no overlaps."""
    for earlier, later in itertools.pairwise(pm._STEPS):
        assert earlier.to_version == later.from_version
    assert pm._STEPS[-1].to_version == pm.PROJECT_FORMAT_VERSION


def test_already_current_is_a_no_op(project_root: Path) -> None:
    _stamp(project_root, pm.PROJECT_FORMAT_VERSION, min_app=pm.PROJECT_FORMAT_MIN_APP)
    result = pm.run_baseline_migration(project_root)
    assert result.already_current is True
    assert result.files_changed == []
    assert result.backup is None
    assert not (project_root / ".backups").exists()


def test_rejects_newer_format_version(project_root: Path) -> None:
    _stamp(project_root, pm.PROJECT_FORMAT_VERSION + 1)
    with pytest.raises(pm.UnsupportedProjectFormatError):
        pm.run_baseline_migration(project_root)


def test_missing_metadata_raises(project_root: Path) -> None:
    with pytest.raises(pm.MigrationFailedError):
        pm.run_baseline_migration(project_root)


def test_a_target_no_pending_step_names_is_never_staged(project_root: Path) -> None:
    """`datasources` is in `_TARGET_PATHS` but named by no step, so it is not
    backed up, not copied, and not left with a staging directory beside it."""
    _stamp(project_root, 0)
    ds_path = _write_datasource(
        project_root, "DS1", [{"display_name": "Dyn", "data_type": "Float", "is_array": True}]
    )
    original_bytes = ds_path.read_bytes()

    result = pm.run_baseline_migration(project_root)

    assert result.already_current is False
    assert result.from_version == 0
    assert result.to_version == pm.PROJECT_FORMAT_VERSION
    assert ds_path.read_bytes() == original_bytes
    assert not list(project_root.glob("datasources.pre-swap-*"))
    assert not list(project_root.glob("*.migrating-*"))
    assert read_project_metadata(project_root).formatVersion == pm.PROJECT_FORMAT_VERSION


def test_migration_stamps_the_release_that_introduced_the_format(project_root: Path) -> None:
    _stamp(project_root, 0)
    pm.run_baseline_migration(project_root)
    metadata = read_project_metadata(project_root)
    assert metadata.formatVersion == pm.PROJECT_FORMAT_VERSION
    assert metadata.minAppVersion == pm.PROJECT_FORMAT_MIN_APP


def test_replays_the_chain_on_a_current_project_with_no_release_stamp(
    project_root: Path,
) -> None:
    """A build from before the stamp may not have run the migration that
    shipped, so the number alone is not enough to skip on."""
    _stamp(project_root, pm.PROJECT_FORMAT_VERSION)
    result = pm.run_baseline_migration(project_root)
    assert result.already_current is False
    assert result.from_version == pm.PROJECT_FORMAT_VERSION
    assert read_project_metadata(project_root).minAppVersion == pm.PROJECT_FORMAT_MIN_APP


def test_dry_run_leaves_the_release_stamp_alone(project_root: Path) -> None:
    _stamp(project_root, 0)
    pm.run_baseline_migration(project_root, dry_run=True)
    assert read_project_metadata(project_root).minAppVersion is None


def test_dry_run_reports_without_stamping(project_root: Path) -> None:
    _stamp(project_root, 0)
    result = pm.run_baseline_migration(project_root, dry_run=True)
    assert result.dry_run is True
    assert result.files_changed == []
    assert read_project_metadata(project_root).formatVersion == 0


def test_idempotent_rerun_after_success(project_root: Path) -> None:
    _stamp(project_root, 0)
    first = pm.run_baseline_migration(project_root)
    assert first.already_current is False

    second = pm.run_baseline_migration(project_root)
    assert second.already_current is True
    assert second.files_changed == []


# ── coordinator machinery, exercised through a synthetic step ────────────────


def _register_step(
    monkeypatch: pytest.MonkeyPatch, run, targets: tuple[str, ...] = ("datasources",)
) -> None:
    """Register a single step 0 -> 1, targeting ``datasources`` by default, for one test."""
    step = pm.MigrationStep(from_version=0, to_version=1, name="synthetic", targets=targets, run=run)
    monkeypatch.setattr(pm, "_STEPS", [step])
    monkeypatch.setattr(pm, "PROJECT_FORMAT_VERSION", 1)


def _rewrite_ds1(staged, project_root: Path) -> pm.StepResult:
    path = staged["datasources"] / "DS1.json"
    doc = json.loads(path.read_text())
    doc["migrated"] = True
    path.write_text(json.dumps(doc))
    return pm.StepResult(files_changed=["DS1.json"], diagnostics=["synthetic diagnostic"])


def test_step_output_is_swapped_in_and_the_zip_holds_the_original(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stamp(project_root, 0)
    ds_path = _write_datasource(project_root, "DS1", [])
    original_bytes = ds_path.read_bytes()
    _register_step(monkeypatch, _rewrite_ds1)

    result = pm.run_baseline_migration(project_root)

    assert result.files_changed == ["DS1.json"]
    assert result.diagnostics == ["synthetic diagnostic"]
    assert json.loads(ds_path.read_text())["migrated"] is True

    assert result.backup is not None
    with zipfile.ZipFile(result.backup) as zf:
        assert zf.read("datasources/DS1.json") == original_bytes
    # The moved-aside original is scaffolding; the zip is what survives.
    assert not list(project_root.glob("datasources.pre-swap-*"))
    assert not list(project_root.glob("datasources.migrating-*"))
    assert read_project_metadata(project_root).formatVersion == 1


def test_real_migration_records_last_migration(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stamp(project_root, 0)
    _write_datasource(project_root, "DS1", [])
    _register_step(monkeypatch, _rewrite_ds1)

    result = pm.run_baseline_migration(project_root)

    metadata = read_project_metadata(project_root)
    assert metadata.lastMigration is not None
    assert metadata.lastMigration.fromVersion == 0
    assert metadata.lastMigration.toVersion == 1
    assert metadata.lastMigration.backup == str(result.backup)


def test_dry_run_runs_the_step_for_real_somewhere_the_project_cannot_see(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The step writes unconditionally; only the coordinator knows it is staging
    into a throwaway copy, so the project keeps its bytes, its backup-free state
    and its stamp."""
    _stamp(project_root, 0)
    ds_path = _write_datasource(project_root, "DS1", [])
    original_text = ds_path.read_text()
    _register_step(monkeypatch, _rewrite_ds1)

    result = pm.run_baseline_migration(project_root, dry_run=True)

    assert result.files_changed == ["DS1.json"]
    assert result.backup is None
    assert ds_path.read_text() == original_text
    assert not (project_root / ".backups").exists()
    assert read_project_metadata(project_root).formatVersion == 0


def test_failure_mid_step_restores_original_and_keeps_the_zip(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stamp(project_root, 0)
    ds_path = _write_datasource(project_root, "DS1", [])
    original_text = ds_path.read_text()

    def _boom(staged, project_root: Path) -> pm.StepResult:
        (staged["datasources"] / "DS1.json").write_text("{}")
        raise pm.MigrationFailedError(project_root, "synthetic", None, "disk full")

    _register_step(monkeypatch, _boom)

    with pytest.raises(pm.MigrationFailedError):
        pm.run_baseline_migration(project_root)

    assert ds_path.read_text() == original_text
    assert len(list((project_root / ".backups").glob("pre-migration-*.zip"))) == 1
    assert not list(project_root.glob("datasources.pre-swap-*"))
    assert not list(project_root.glob("datasources.migrating-*"))
    assert read_project_metadata(project_root).formatVersion == 0


def test_unexpected_step_exception_is_wrapped_and_restored(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stamp(project_root, 0)
    ds_path = _write_datasource(project_root, "DS1", [])
    original_text = ds_path.read_text()

    def _raise(staged, project_root: Path) -> pm.StepResult:
        raise OSError("disk full")

    _register_step(monkeypatch, _raise)

    with pytest.raises(pm.MigrationFailedError) as excinfo:
        pm.run_baseline_migration(project_root)
    assert excinfo.value.step_name == "synthetic"

    assert ds_path.read_text() == original_text
    assert read_project_metadata(project_root).formatVersion == 0


def test_retry_after_failure_succeeds(project_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _stamp(project_root, 0)
    _write_datasource(project_root, "DS1", [])

    _register_step(monkeypatch, lambda staged, project_root: (_ for _ in ()).throw(OSError("boom")))
    with pytest.raises(pm.MigrationFailedError):
        pm.run_baseline_migration(project_root)

    _register_step(monkeypatch, _rewrite_ds1)
    result = pm.run_baseline_migration(project_root)
    assert result.already_current is False
    assert result.files_changed == ["DS1.json"]
    assert read_project_metadata(project_root).formatVersion == 1


def _rewrite_ds1_and_config(staged, project_root: Path) -> pm.StepResult:
    ds_path = staged["datasources"] / "DS1.json"
    config_path = staged["config"]
    ds_doc = json.loads(ds_path.read_text())
    ds_doc["migrated"] = True
    config_doc = json.loads(config_path.read_text())
    config_doc["migrated"] = True
    ds_path.write_text(json.dumps(ds_doc))
    config_path.write_text(json.dumps(config_doc))
    return pm.StepResult(files_changed=["DS1.json", "config.json"])


def test_multi_target_step_swaps_every_target_and_the_zip_holds_each_original(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stamp(project_root, 0)
    ds_path = _write_datasource(project_root, "DS1", [])
    config_path = project_root / "config.json"
    original_ds = ds_path.read_bytes()
    original_config = config_path.read_bytes()
    _register_step(monkeypatch, _rewrite_ds1_and_config, targets=("datasources", "config"))

    result = pm.run_baseline_migration(project_root)

    assert result.files_changed == ["DS1.json", "config.json"]
    assert json.loads(ds_path.read_text())["migrated"] is True
    assert json.loads(config_path.read_text())["migrated"] is True
    assert result.backup is not None
    with zipfile.ZipFile(result.backup) as zf:
        assert zf.read("datasources/DS1.json") == original_ds
        assert zf.read("config.json") == original_config
    assert not list(project_root.glob("*.migrating-*"))
    assert not list(project_root.glob("*.pre-swap-*"))
    assert read_project_metadata(project_root).formatVersion == 1


def test_failure_after_every_target_swapped_restores_all_of_them(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The stamp write fails once both targets already hold migrated data."""
    _stamp(project_root, 0)
    ds_path = _write_datasource(project_root, "DS1", [])
    config_path = project_root / "config.json"
    original_ds = ds_path.read_text()
    original_config = config_path.read_text()
    _register_step(monkeypatch, _rewrite_ds1_and_config, targets=("datasources", "config"))

    def _stamp_boom(root: Path, metadata) -> None:
        raise OSError("no space left on device")

    monkeypatch.setattr(pm, "write_project_metadata", _stamp_boom)

    with pytest.raises(pm.MigrationFailedError):
        pm.run_baseline_migration(project_root)

    assert ds_path.read_text() == original_ds
    assert config_path.read_text() == original_config
    assert len(list((project_root / ".backups").glob("pre-migration-*.zip"))) == 1
    assert not list(project_root.glob("*.pre-swap-*"))
    assert not list(project_root.glob("*.migrating-*"))
    assert read_project_metadata(project_root).formatVersion == 0


def test_failure_between_swaps_restores_the_already_swapped_target(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The second target's swap fails after the first one already went in."""
    _stamp(project_root, 0)
    ds_path = _write_datasource(project_root, "DS1", [])
    config_path = project_root / "config.json"
    original_ds = ds_path.read_text()
    original_config = config_path.read_text()
    _register_step(monkeypatch, _rewrite_ds1_and_config, targets=("datasources", "config"))

    real_swap = pm._swap_target
    calls = {"n": 0}

    def _swap_once(real_path: Path, backup_path: Path | None, staging_path: Path) -> bool:
        if backup_path is not None:
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError("cross-device link")
        return real_swap(real_path, backup_path, staging_path)

    monkeypatch.setattr(pm, "_swap_target", _swap_once)

    with pytest.raises(pm.MigrationFailedError):
        pm.run_baseline_migration(project_root)

    assert ds_path.read_text() == original_ds
    assert config_path.read_text() == original_config
    assert not list(project_root.glob("*.migrating-*"))
    assert read_project_metadata(project_root).formatVersion == 0


def test_target_that_does_not_exist_is_not_staged(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stamp(project_root, 0)
    _register_step(monkeypatch, lambda staged, project_root: pm.StepResult())

    result = pm.run_baseline_migration(project_root)

    assert not list(project_root.glob("*.pre-swap-*"))
    # Nothing to stage, but the project is still zipped before it is stamped.
    assert result.backup is not None and result.backup.exists()
    assert read_project_metadata(project_root).formatVersion == 1


# ── the pre-migration zip ────────────────────────────────────────────────────


def test_the_backup_zip_is_named_for_the_build_that_wrote_it(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The format numbers are already in `lastMigration`; the release that did
    the rewriting is recorded nowhere else."""
    _stamp(project_root, 0)
    _write_datasource(project_root, "DS1", [])
    _register_step(monkeypatch, _rewrite_ds1)
    monkeypatch.setattr(pm, "app_version", lambda: "1.2.3")

    result = pm.run_baseline_migration(project_root)

    assert result.backup is not None
    assert result.backup.parent == project_root / ".backups"
    assert result.backup.name.startswith("pre-migration-")
    assert result.backup.name.endswith("-app-1.2.3.zip")


def test_a_later_migration_does_not_nest_the_earlier_backup(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`.backups/` is skipped by the packer, so archives never compound."""
    _stamp(project_root, 0)
    _write_datasource(project_root, "DS1", [])
    _register_step(monkeypatch, _rewrite_ds1)
    first = pm.run_baseline_migration(project_root)

    _stamp(project_root, 0)
    second = pm.run_baseline_migration(project_root)

    assert second.backup is not None
    assert second.backup != first.backup
    with zipfile.ZipFile(second.backup) as zf:
        assert [name for name in zf.namelist() if name.startswith(".backups/")] == []


def test_a_backup_that_cannot_be_written_aborts_with_nothing_touched(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stamp(project_root, 0)
    ds_path = _write_datasource(project_root, "DS1", [])
    original_text = ds_path.read_text()
    _register_step(monkeypatch, _rewrite_ds1)

    def _boom(project_root: Path, output, progress=None) -> None:
        raise OSError("no space left on device")

    monkeypatch.setattr(pm, "pack_project", _boom)

    with pytest.raises(pm.MigrationFailedError) as excinfo:
        pm.run_baseline_migration(project_root)
    assert excinfo.value.step_name == "pre-migration-backup"

    assert ds_path.read_text() == original_text
    assert read_project_metadata(project_root).formatVersion == 0
    # A half-written archive must not be left looking like a usable backup.
    assert not list((project_root / ".backups").glob("*"))
