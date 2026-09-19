"""One-time, atomic baseline migration for a project's on-disk format.

A project's stamped format version lives at ``config.json``'s
``project.formatVersion`` (see ``core.manifest.ProjectMetadata``). Version
``0`` means unstamped — every project that predates the field.
``run_baseline_migration`` is the single entry point: it is safe to call on
every project activation (see ``main.py``'s lifespan) because it is a no-op
once a project is already stamped at ``PROJECT_FORMAT_VERSION``.

``_STEPS`` holds two steps: 4 → 5 rewrites stored layouts into the Hug/Fill/Fixed
sizing model, retiring the raw flex keys and margin from authored projects (see
``core.migration_size_modes``); 5 → 6 collapses the `padding` shorthand into the
four side keys it overlapped with (see ``core.migration_padding``). A project
stamped below 4 is carried through both — no shape older than the baseline is
otherwise supported.

``PROJECT_FORMAT_VERSION`` only ever counts up, including when steps are
retired: the number is stamped into user data that travels between builds
and machines, so reusing a number a different on-disk shape already carried
would make every project already stamped above it look like it came from a
newer build and be rejected here.

To add a step: append a ``MigrationStep`` to ``_STEPS`` whose
``from_version`` is the current ``PROJECT_FORMAT_VERSION``, then bump
``PROJECT_FORMAT_VERSION`` to its ``to_version``. Each step declares one or
more ``targets`` naming the top-level project paths it reads and writes;
``_TARGET_PATHS`` maps each name to its project-relative path, which may be a
directory (``datasources``) or a single file (``config.json``). Add a
``_TARGET_PATHS`` entry if the step touches a path no existing target covers.
The coordinator only backs up and stages a target when at least one pending
step actually names it, and swaps each staged target back into place
independently once every pending step across all targets has succeeded.
"""
from __future__ import annotations

import shutil
import tempfile
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from core.manifest import read_project_metadata, write_project_metadata
from core.migration_padding import migrate_padding
from core.migration_size_modes import migrate_size_modes

PROJECT_FORMAT_VERSION = 6

# Target name -> project-relative path a step reads and writes. A value may be a
# directory or a single file; the coordinator stages either shape.
_TARGET_PATHS: dict[str, str] = {
    "datasources": "datasources",
    "themes": "themes",
    "pages": "pages",
    "components": "components",
    "config": "config.json",
}


class UnsupportedProjectFormatError(Exception):
    """The project's stamped format version is newer than this build supports."""

    code = "unsupported_project_format"

    def __init__(self, project_root: Path, found_version: int) -> None:
        super().__init__(
            f"Project at {project_root} is stamped formatVersion={found_version}, "
            f"newer than this build's supported baseline "
            f"({PROJECT_FORMAT_VERSION}). Upgrade the application before "
            "opening this project."
        )
        self.project_root = project_root
        self.found_version = found_version


class MigrationFailedError(Exception):
    """A migration step failed partway through. The pre-migration backup is preserved."""

    code = "migration_failed"

    def __init__(self, project_root: Path, step_name: str, file: Path | None, reason: str) -> None:
        where = f" ({file})" if file is not None else ""
        super().__init__(
            f"Migration step '{step_name}' failed for project {project_root}{where}: "
            f"{reason}. The pre-migration backup was preserved; the project's "
            "affected data was restored to its pre-migration state."
        )
        self.project_root = project_root
        self.step_name = step_name
        self.file = file
        self.reason = reason


@dataclass
class StepResult:
    files_changed: list[str] = field(default_factory=list)
    diagnostics: list[str] = field(default_factory=list)


@dataclass
class MigrationStep:
    from_version: int
    to_version: int
    name: str
    targets: tuple[str, ...]  # keys of _TARGET_PATHS whose staged paths .run() operates on
    # (staged paths, real project root) -> StepResult. A step always writes to the
    # paths it is handed and never learns whether this is a dry run: the
    # coordinator stages one into a throwaway copy and deletes it afterwards. The
    # project root is passed separately because the staging is not under it.
    run: Callable[[Mapping[str, Path], Path], StepResult]


@dataclass
class MigrationResult:
    already_current: bool
    dry_run: bool
    from_version: int
    to_version: int
    files_changed: list[str] = field(default_factory=list)
    diagnostics: list[str] = field(default_factory=list)
    # Per-target pre-migration backups, keyed by target name. Only targets a
    # pending step actually named — and that existed on disk — get an entry.
    backups: dict[str, Path] = field(default_factory=dict)


_STEPS: list[MigrationStep] = [
    MigrationStep(
        from_version=4,
        to_version=5,
        name="layouts-to-size-modes",
        targets=("config", "pages", "components"),
        run=migrate_size_modes,
    ),
    MigrationStep(
        from_version=5,
        to_version=6,
        name="padding-to-sides",
        targets=("config", "pages", "components"),
        run=migrate_padding,
    ),
]


# ── coordinator ───────────────────────────────────────────────────────────────


def _backup_dir_name(real_path: Path) -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return real_path.with_name(f"{real_path.name}.pre-migration-backup-{stamp}-{uuid.uuid4().hex[:8]}")


def _copy_path(src: Path, dst: Path) -> None:
    """Duplicate a target, whichever shape it is."""
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)


def _discard_path(path: Path) -> None:
    """Delete a target, whichever shape it is."""
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink(missing_ok=True)


def _stage_target(real_path: Path, needed: bool) -> tuple[Path | None, Path]:
    """Back up and stage *real_path* if *needed* and it currently exists.

    The real directory or file is *moved* (not copied) aside as the backup, and
    a fresh copy of that backup becomes the staging path steps mutate. Returns
    ``(None, real_path)`` — no backup, nothing to swap back later — when
    either no pending step needs this target or it doesn't exist yet.
    """
    if needed and real_path.exists():
        backup_path = _backup_dir_name(real_path)
        real_path.rename(backup_path)
        staging_path = real_path.with_name(f"{real_path.name}.migrating-{uuid.uuid4().hex[:8]}")
        try:
            _copy_path(backup_path, staging_path)
        except Exception:
            # The rename already succeeded; undo it so a failed staging copy
            # doesn't leave real_path missing with no backup reference to
            # restore from (the caller only learns of backup_path on return).
            backup_path.rename(real_path)
            raise
        return backup_path, staging_path
    return None, real_path


def _swap_target(real_path: Path, backup_path: Path | None, staging_path: Path) -> bool:
    """Atomically move the staged, migrated copy into place. No-op if never staged."""
    if backup_path is not None:
        staging_path.rename(real_path)
        return True
    return False


def run_baseline_migration(project_root: Path, *, dry_run: bool = False) -> MigrationResult:
    """Migrate *project_root* to ``PROJECT_FORMAT_VERSION`` if it isn't already.

    Safe to call unconditionally on every project activation — a project
    already at the current version is a no-op. Raises
    ``UnsupportedProjectFormatError`` if the project is stamped newer than
    this build supports, and ``MigrationFailedError`` (leaving the
    pre-migration backup in place and the original data restored) if a step
    fails partway through.
    """
    metadata = read_project_metadata(project_root)
    if metadata is None:
        raise MigrationFailedError(
            project_root,
            "format-stamp",
            None,
            "project has no metadata block in config.json; cannot record format version",
        )
    current_version = metadata.formatVersion

    if current_version == PROJECT_FORMAT_VERSION:
        return MigrationResult(
            already_current=True,
            dry_run=dry_run,
            from_version=current_version,
            to_version=current_version,
        )
    if current_version > PROJECT_FORMAT_VERSION:
        raise UnsupportedProjectFormatError(project_root, current_version)

    # _STEPS is a contiguous 0..PROJECT_FORMAT_VERSION chain in ascending order,
    # so "from_version >= current_version" alone selects exactly the steps
    # still owed to this project, in the order they must run.
    pending = [step for step in _STEPS if step.from_version >= current_version]
    real_paths = {name: project_root / rel for name, rel in _TARGET_PATHS.items()}
    needed = {name for step in pending for name in step.targets}

    if dry_run:
        result = MigrationResult(
            already_current=False,
            dry_run=True,
            from_version=current_version,
            to_version=PROJECT_FORMAT_VERSION,
        )
        # Staged into a throwaway copy rather than handed the originals: a step
        # whose passes each read the shape the one before it wrote can only
        # report what it *would* do by actually doing it, and every step would
        # otherwise have to duplicate the targets itself.
        with tempfile.TemporaryDirectory() as tmp:
            preview = {name: Path(tmp) / path.name for name, path in real_paths.items()}
            for name, real_path in real_paths.items():
                if name in needed and real_path.exists():
                    _copy_path(real_path, preview[name])
            for step in pending:
                step_result = step.run(preview, project_root)
                result.files_changed.extend(step_result.files_changed)
                result.diagnostics.extend(step_result.diagnostics)
        return result

    backups: dict[str, Path | None] = dict.fromkeys(_TARGET_PATHS)
    staging = dict(real_paths)
    swapped: dict[str, bool] = dict.fromkeys(_TARGET_PATHS, False)
    try:
        for name, real_path in real_paths.items():
            backups[name], staging[name] = _stage_target(real_path, name in needed)

        result = MigrationResult(
            already_current=False,
            dry_run=False,
            from_version=current_version,
            to_version=PROJECT_FORMAT_VERSION,
            backups={name: path for name, path in backups.items() if path is not None},
        )
        for step in pending:
            step_result = step.run(staging, project_root)
            result.files_changed.extend(step_result.files_changed)
            result.diagnostics.extend(step_result.diagnostics)

        for name, real_path in real_paths.items():
            swapped[name] = _swap_target(real_path, backups[name], staging[name])

        new_metadata = metadata.model_copy(update={"formatVersion": PROJECT_FORMAT_VERSION})
        write_project_metadata(project_root, new_metadata)
        return result
    except MigrationFailedError:
        _restore_all(real_paths, backups, staging, swapped)
        raise
    except Exception as exc:
        _restore_all(real_paths, backups, staging, swapped)
        raise MigrationFailedError(project_root, pending[0].name if pending else "?", None, str(exc)) from exc


def _restore_all(
    real_paths: Mapping[str, Path],
    backups: Mapping[str, Path | None],
    staging: Mapping[str, Path],
    swapped: Mapping[str, bool],
) -> None:
    for name, real_path in real_paths.items():
        _restore_after_failure(real_path, backups[name], staging[name], swapped[name])


def _restore_after_failure(
    real_path: Path, backup_path: Path | None, staging_path: Path | None, swapped: bool
) -> None:
    """Restore the original directory or file and discard the partial staging copy.

    The backup itself is left in place (copied, not moved) so it survives as
    forensic evidence of the pre-migration state alongside the restored data.
    """
    if backup_path is not None:
        if swapped:
            # A later failure — the metadata stamp, or another target's swap —
            # left migrated data under the old formatVersion. Drop it, so what
            # is on disk is what the unchanged stamp describes.
            _discard_path(real_path)
        if not real_path.exists():
            _copy_path(backup_path, real_path)
    if staging_path is not None and staging_path != real_path and staging_path.exists():
        _discard_path(staging_path)
