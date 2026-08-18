"""Tests for the baseline project-format migration coordinator.

``pm._STEPS`` is empty — the current on-disk shape is the baseline — so the
first half covers the stamp-only behaviour every project actually gets today.
The second half registers a synthetic step to keep the staging/backup/swap
machinery under test until a real step needs it again.
"""

import json
from pathlib import Path

import core.project_migrations as pm
import pytest
from core.manifest import ProjectMetadata, read_project_metadata, write_project_metadata


def _stamp(project_root: Path, format_version: int) -> None:
    write_project_metadata(project_root, ProjectMetadata(id="proj", formatVersion=format_version))


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


def test_no_steps_are_registered() -> None:
    """Guards the docstring's claim: an unstamped project is stamped, not rewritten."""
    assert pm._STEPS == []


def test_already_current_is_a_no_op(project_root: Path) -> None:
    _stamp(project_root, pm.PROJECT_FORMAT_VERSION)
    result = pm.run_baseline_migration(project_root)
    assert result.already_current is True
    assert result.files_changed == []
    assert result.backups == {}


def test_rejects_newer_format_version(project_root: Path) -> None:
    _stamp(project_root, pm.PROJECT_FORMAT_VERSION + 1)
    with pytest.raises(pm.UnsupportedProjectFormatError):
        pm.run_baseline_migration(project_root)


def test_missing_metadata_raises(project_root: Path) -> None:
    with pytest.raises(pm.MigrationFailedError):
        pm.run_baseline_migration(project_root)


def test_unstamped_project_is_stamped_without_touching_files(project_root: Path) -> None:
    _stamp(project_root, 0)
    ds_path = _write_datasource(
        project_root, "DS1", [{"display_name": "Dyn", "data_type": "Float", "is_array": True}]
    )
    original_bytes = ds_path.read_bytes()

    result = pm.run_baseline_migration(project_root)

    assert result.already_current is False
    assert result.from_version == 0
    assert result.to_version == pm.PROJECT_FORMAT_VERSION
    assert result.files_changed == []
    assert result.backups == {}
    assert ds_path.read_bytes() == original_bytes
    # Nothing is staged when no pending step names a target.
    assert not list(project_root.glob("*.pre-migration-backup-*"))
    assert not list(project_root.glob("*.migrating-*"))
    assert read_project_metadata(project_root).formatVersion == pm.PROJECT_FORMAT_VERSION


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


def _rewrite_ds1(staged, dry_run: bool) -> pm.StepResult:
    path = staged["datasources"] / "DS1.json"
    doc = json.loads(path.read_text())
    doc["migrated"] = True
    if not dry_run:
        path.write_text(json.dumps(doc))
    return pm.StepResult(files_changed=["DS1.json"], diagnostics=["synthetic diagnostic"])


def test_step_output_is_swapped_in_and_the_backup_is_preserved(
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

    backup = result.backups["datasources"]
    assert backup.is_dir()
    assert (backup / "DS1.json").read_bytes() == original_bytes
    assert not list(project_root.glob("datasources.migrating-*"))
    assert read_project_metadata(project_root).formatVersion == 1


def test_dry_run_stages_nothing_and_leaves_files_alone(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stamp(project_root, 0)
    ds_path = _write_datasource(project_root, "DS1", [])
    original_text = ds_path.read_text()
    _register_step(monkeypatch, _rewrite_ds1)

    result = pm.run_baseline_migration(project_root, dry_run=True)

    assert result.files_changed == ["DS1.json"]
    assert result.backups == {}
    assert ds_path.read_text() == original_text
    assert not list(project_root.glob("datasources.pre-migration-backup-*"))
    assert read_project_metadata(project_root).formatVersion == 0


def test_failure_mid_step_restores_original_and_preserves_backup(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stamp(project_root, 0)
    ds_path = _write_datasource(project_root, "DS1", [])
    original_text = ds_path.read_text()

    def _boom(staged, dry_run: bool) -> pm.StepResult:
        (staged["datasources"] / "DS1.json").write_text("{}")
        raise pm.MigrationFailedError(project_root, "synthetic", None, "disk full")

    _register_step(monkeypatch, _boom)

    with pytest.raises(pm.MigrationFailedError):
        pm.run_baseline_migration(project_root)

    assert ds_path.read_text() == original_text
    assert len(list(project_root.glob("datasources.pre-migration-backup-*"))) == 1
    assert not list(project_root.glob("datasources.migrating-*"))
    assert read_project_metadata(project_root).formatVersion == 0


def test_unexpected_step_exception_is_wrapped_and_restored(
    project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stamp(project_root, 0)
    ds_path = _write_datasource(project_root, "DS1", [])
    original_text = ds_path.read_text()

    def _raise(staged, dry_run: bool) -> pm.StepResult:
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

    _register_step(monkeypatch, lambda staged, dry_run: (_ for _ in ()).throw(OSError("boom")))
    with pytest.raises(pm.MigrationFailedError):
        pm.run_baseline_migration(project_root)

    _register_step(monkeypatch, _rewrite_ds1)
    result = pm.run_baseline_migration(project_root)
    assert result.already_current is False
    assert result.files_changed == ["DS1.json"]
    assert read_project_metadata(project_root).formatVersion == 1


def _rewrite_ds1_and_config(staged, dry_run: bool) -> pm.StepResult:
    ds_path = staged["datasources"] / "DS1.json"
    config_path = staged["config"]
    ds_doc = json.loads(ds_path.read_text())
    ds_doc["migrated"] = True
    config_doc = json.loads(config_path.read_text())
    config_doc["migrated"] = True
    if not dry_run:
        ds_path.write_text(json.dumps(ds_doc))
        config_path.write_text(json.dumps(config_doc))
    return pm.StepResult(files_changed=["DS1.json", "config.json"])


def test_multi_target_step_swaps_every_target_and_backs_each_up(
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
    assert set(result.backups) == {"datasources", "config"}
    assert (result.backups["datasources"] / "DS1.json").read_bytes() == original_ds
    assert result.backups["config"].read_bytes() == original_config
    assert not list(project_root.glob("*.migrating-*"))
    # Targets no pending step names are never staged, so the untouched ones have
    # no backup even though _TARGET_PATHS knows about them.
    assert not list(project_root.glob("pages.pre-migration-backup-*"))
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
    assert len(list(project_root.glob("datasources.pre-migration-backup-*"))) == 1
    assert len(list(project_root.glob("config.json.pre-migration-backup-*"))) == 1
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
    _register_step(monkeypatch, lambda staged, dry_run: pm.StepResult())

    result = pm.run_baseline_migration(project_root)

    assert result.backups == {}
    assert read_project_metadata(project_root).formatVersion == 1
