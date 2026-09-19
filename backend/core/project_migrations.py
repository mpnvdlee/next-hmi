"""One-time, atomic baseline migration for a project's on-disk format.

A project's stamped format version lives at ``config.json``'s
``project.formatVersion`` (see ``core.manifest.ProjectMetadata``). Version
``0`` means unstamped — every project that predates the field.
``run_baseline_migration`` is the single entry point: it is safe to call on
every project activation (see ``main.py``'s lifespan) because it is a no-op
once a project is already stamped at ``PROJECT_FORMAT_VERSION``.

``_STEPS`` holds two steps. The first, 4 → 7, rewrites stored layouts into
the Hug/Fill/Fixed sizing model, retiring the raw flex keys and margin from
authored projects (see ``core.migration_size_modes``), then collapses the
`padding` shorthand into the four side keys it overlapped with (see
``core.migration_padding``) — both against the same staged copy, in one atomic
swap. A project stamped below 4 is carried through it too — no shape
older than the baseline is otherwise supported. (Formats 5 and 6 briefly
existed as two separate steps during development; nothing was ever stamped at
either in the wild, so they were retired and folded into this one combined
step rather than kept as dead waypoints.) The second, 7 → 8, turns every
dialog into a page in the Dialogs folder and rewrites the dialog actions into
page-overlay actions, moving their documents into ``dialogs/``
(see ``core.migration_dialogs_folder``).

``PROJECT_FORMAT_VERSION`` only ever counts up, including when steps are
retired: the number is stamped into user data that travels between builds
and machines, so reusing a number a different on-disk shape already carried
would make every project already stamped above it look like it came from a
newer build and be rejected here.

``PROJECT_FORMAT_MIN_APP`` names the release that introduced the current
``PROJECT_FORMAT_VERSION``, and is stamped beside it so a build too old to
open a project can say which version the operator actually needs — a number
no build can derive for a format that postdates it. Bump the two together,
and only in a release whose minor or major moves: the published contract is
that a patch update never makes a project unopenable. That rule governs
released versions; a pre-release sorts below the release it is a candidate
for, so ``0.1.0`` introducing formats 5 through 8 over the ``0.0.1-rc*`` line
that carried 4 keeps the promise whole — "0.1.0 or newer" does exclude every
rc, and no release ever stamped 5, 6 or 7 on its own. It is a display string
only — never parsed or compared. The integer stays the sole gate.

Its absence carries meaning of its own: a project with no ``minAppVersion`` was
stamped by a build from before the field, so the number it carries says where
it landed without saying which code took it there. ``run_baseline_migration``
replays the whole chain on such a project instead of trusting the number, and
the manager routes it through the same upgrade confirmation as a stale one.

Before any of that runs, the coordinator zips the whole project into
``<project>/.backups/`` via ``core.project_packer.pack_project`` — one archive
per migration, holding the project exactly as it stood going in. That zip is
the backup an operator restores from; everything the staging machinery moves
aside below is internal scaffolding, deleted on the success and the failure
path alike, so a migrated project root is left as clean as it started. A
project that cannot be zipped is not migrated: the archive is written first and
a failure there aborts with nothing touched.

Every target a pending step names is staged, including one the project does
not have yet: a migrated project therefore ends up with the step's directory
targets present, empty ones included.

To add a step: append a ``MigrationStep`` to ``_STEPS`` whose
``from_version`` is the current ``PROJECT_FORMAT_VERSION``, then bump
``PROJECT_FORMAT_VERSION`` to its ``to_version``. Each step declares one or
more ``targets`` naming the top-level project paths it reads and writes;
``_TARGET_PATHS`` maps each name to its project-relative path and shape —
a directory (``datasources``) or a single file (``config.json``). Add a
``_TARGET_PATHS`` entry if the step touches a path no existing target covers.
The coordinator only stages a target when at least one pending step actually
names it, and swaps each staged target back into place independently once
every pending step across all targets has succeeded. The zip above is written
whatever the targets are — it covers the whole project, not just them.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from core.manifest import (
    ProjectMetadata,
    ProjectMigrationRecord,
    read_project_metadata,
    write_project_metadata,
)
from core.migration_dialogs_folder import STEP_NAME as DIALOGS_FOLDER_STEP_NAME
from core.migration_dialogs_folder import migrate_dialogs_folder
from core.migration_padding import migrate_padding
from core.migration_size_modes import migrate_size_modes
from core.project_packer import BACKUPS_SUBDIR, pack_project, safe_filename
from core.time_utils import iso_now
from core.version import app_version

PROJECT_FORMAT_VERSION = 8
# The release that introduced format 8. See the module docstring; bump with it.
PROJECT_FORMAT_MIN_APP = "0.1.0"

@dataclass(frozen=True)
class _Target:
    """Where a target lives in a project, and which shape it has.

    The shape cannot be read off the disk — a target a step writes for the
    first time does not exist yet — so it is declared here, beside the path,
    rather than in a second table keyed on the same names.
    """

    path: str
    directory: bool = True


# Target name -> the project-relative path a step reads and writes. A directory
# a step writes for the first time is staged empty rather than skipped (see
# `_stage_target`).
_TARGET_PATHS: dict[str, _Target] = {
    "datasources": _Target("datasources"),
    "themes": _Target("themes"),
    "pages": _Target("pages"),
    "dialogs": _Target("dialogs"),
    "components": _Target("components"),
    "config": _Target("config.json", directory=False),
}


def stamp_current_format(metadata: ProjectMetadata) -> ProjectMetadata:
    """Return ``metadata`` carrying this build's format version and its release.

    The two fields are one fact and every writer sets them together, so callers
    go through here rather than spelling out the pair.
    """
    return metadata.model_copy(
        update={
            "formatVersion": PROJECT_FORMAT_VERSION,
            "minAppVersion": PROJECT_FORMAT_MIN_APP,
        }
    )


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
    """A migration failed partway through. The project's data was restored."""

    code = "migration_failed"

    def __init__(self, project_root: Path, step_name: str, file: Path | None, reason: str) -> None:
        where = f" ({file})" if file is not None else ""
        super().__init__(
            f"Migration step '{step_name}' failed for project {project_root}{where}: "
            f"{reason}. The project's affected data was restored to its "
            f"pre-migration state; the pre-migration backup is in {BACKUPS_SUBDIR}/."
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
    # Zip of the whole project as it stood before any target was touched.
    # None on a dry run and on an already-current project — neither writes one.
    backup: Path | None = None


def _retire_flex_and_collapse_padding(staged: Mapping[str, Path], project_root: Path) -> StepResult:
    """Combined step: retire the raw flex keys/margin (Hug/Fill/Fixed sizing),
    then collapse the `padding` shorthand into the four side keys — same
    staged copy, in sequence. See `core.migration_size_modes` /
    `core.migration_padding` for the rules each half follows."""
    size_modes_result = migrate_size_modes(staged, project_root)
    padding_result = migrate_padding(staged, project_root)
    files_changed = list(
        dict.fromkeys([*size_modes_result.files_changed, *padding_result.files_changed])
    )
    return StepResult(
        files_changed=files_changed,
        diagnostics=[*size_modes_result.diagnostics, *padding_result.diagnostics],
    )


_STEPS: list[MigrationStep] = [
    MigrationStep(
        from_version=4,
        to_version=7,
        name="retire-flex-and-collapse-padding",
        targets=("config", "pages", "components"),
        run=_retire_flex_and_collapse_padding,
    ),
    MigrationStep(
        from_version=7,
        to_version=8,
        name=DIALOGS_FOLDER_STEP_NAME,
        targets=("config", "pages", "dialogs", "components"),
        run=migrate_dialogs_folder,
    ),
]


# ── coordinator ───────────────────────────────────────────────────────────────


def _write_backup_zip(project_root: Path) -> Path:
    """Zip the whole project into ``.backups/`` and return the archive path.

    Named for the build that wrote it rather than the format numbers it spans:
    ``formatVersion``/``toVersion`` are already recorded in ``lastMigration``,
    while the release an operator would have to reinstall to undo this appears
    nowhere else. The archive streams to a ``.partial`` sibling and is renamed
    into place only once complete, so a crash mid-write never leaves a
    truncated file that looks like a usable backup.
    """
    backups_dir = project_root / BACKUPS_SUBDIR
    backups_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    base = f"pre-migration-{stamp}-app-{safe_filename(app_version())}"
    archive = backups_dir / f"{base}.zip"
    if archive.exists():
        archive = backups_dir / f"{base}-{uuid.uuid4().hex[:8]}.zip"
    partial = archive.with_name(f"{archive.name}.partial")
    try:
        with partial.open("wb") as output:
            pack_project(project_root, output)
        os.replace(partial, archive)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return archive


def _aside_name(real_path: Path) -> Path:
    """Name for a target moved out of the way while its replacement is built.

    Internal scaffolding only — deleted on the success and the failure path
    alike. The durable record of the pre-migration state is the zip.
    """
    return real_path.with_name(f"{real_path.name}.pre-swap-{uuid.uuid4().hex[:8]}")


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


def _stage_target(real_path: Path, needed: bool, *, directory: bool) -> tuple[Path | None, Path]:
    """Move *real_path* aside and stage a copy of it if *needed*.

    The real directory or file is *moved* (not copied) aside, and a fresh copy
    of that aside copy becomes the staging path steps mutate. A target the
    project does not have yet is staged all the same — an empty directory, or
    for a file simply a path the step may create — so a step that writes a
    target into existence still writes outside the project and lands in one
    atomic swap. (In production every directory target exists before this runs:
    ``main.py`` calls ``ensure_active_project_dirs`` first. The branch is what
    keeps a step's writes staged wherever that is not true.) Returns
    ``(None, real_path)`` — nothing moved, nothing to swap back later — only
    when no pending step needs this target.
    """
    if not needed:
        return None, real_path
    staging_path = real_path.with_name(f"{real_path.name}.migrating-{uuid.uuid4().hex[:8]}")
    if not real_path.exists():
        if directory:
            staging_path.mkdir(parents=True)
        return None, staging_path
    aside_path = _aside_name(real_path)
    real_path.rename(aside_path)
    try:
        _copy_path(aside_path, staging_path)
    except Exception:
        # The rename already succeeded; undo it so a failed staging copy
        # doesn't leave real_path missing with nothing on disk to put back
        # (the caller only learns of aside_path on return).
        aside_path.rename(real_path)
        raise
    return aside_path, staging_path


def _swap_target(real_path: Path, staging_path: Path) -> bool:
    """Atomically move the staged, migrated copy into place.

    The discriminator is the staging path itself: a target that was never staged
    has ``staging_path == real_path`` and nothing to move, and a staged file
    target the step never created has nothing to move either.
    """
    if staging_path == real_path or not staging_path.exists():
        return False
    staging_path.rename(real_path)
    return True


def run_baseline_migration(project_root: Path, *, dry_run: bool = False) -> MigrationResult:
    """Migrate *project_root* to ``PROJECT_FORMAT_VERSION`` if it isn't already.

    Safe to call unconditionally on every project activation — a project
    already at the current version is a no-op. Raises
    ``UnsupportedProjectFormatError`` if the project is stamped newer than
    this build supports, and ``MigrationFailedError`` (leaving the
    pre-migration zip in ``.backups/`` and the original data restored) if a
    step fails partway through.
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

    if current_version > PROJECT_FORMAT_VERSION:
        raise UnsupportedProjectFormatError(project_root, current_version)

    # A project carrying no release stamp was written before the stamp existed,
    # by a build whose migrations are not necessarily the ones that shipped —
    # its number says where it landed, not which code took it there. Replay the
    # chain from the start rather than trust it. The steps are written to be
    # re-runnable for exactly this: each skips what it has already converted.
    unstamped_release = metadata.minAppVersion is None

    if current_version == PROJECT_FORMAT_VERSION and not unstamped_release:
        return MigrationResult(
            already_current=True,
            dry_run=dry_run,
            from_version=current_version,
            to_version=current_version,
        )

    # _STEPS is a contiguous 0..PROJECT_FORMAT_VERSION chain in ascending order,
    # so "from_version >= chain_start" alone selects exactly the steps still
    # owed to this project, in the order they must run.
    chain_start = 0 if unstamped_release else current_version
    pending = [step for step in _STEPS if step.from_version >= chain_start]
    real_paths = {name: project_root / t.path for name, t in _TARGET_PATHS.items()}
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

    # Written before anything is touched, so it holds the project exactly as it
    # stood going in. A project that cannot be zipped is not migrated.
    try:
        backup = _write_backup_zip(project_root)
    except Exception as exc:
        raise MigrationFailedError(
            project_root,
            "pre-migration-backup",
            None,
            f"could not write the pre-migration backup zip ({exc})",
        ) from exc

    asides: dict[str, Path | None] = dict.fromkeys(_TARGET_PATHS)
    staging = dict(real_paths)
    swapped: dict[str, bool] = dict.fromkeys(_TARGET_PATHS, False)
    try:
        for name, real_path in real_paths.items():
            asides[name], staging[name] = _stage_target(
                real_path, name in needed, directory=_TARGET_PATHS[name].directory
            )

        result = MigrationResult(
            already_current=False,
            dry_run=False,
            from_version=current_version,
            to_version=PROJECT_FORMAT_VERSION,
            backup=backup,
        )
        for step in pending:
            step_result = step.run(staging, project_root)
            result.files_changed.extend(step_result.files_changed)
            result.diagnostics.extend(step_result.diagnostics)

        for name, real_path in real_paths.items():
            swapped[name] = _swap_target(real_path, staging[name])

        new_metadata = stamp_current_format(metadata).model_copy(
            update={
                "lastMigration": ProjectMigrationRecord(
                    fromVersion=current_version,
                    toVersion=PROJECT_FORMAT_VERSION,
                    at=iso_now(),
                    backup=str(backup),
                ),
            }
        )
        write_project_metadata(project_root, new_metadata)
        return result
    except MigrationFailedError:
        _restore_all(real_paths, asides, staging, swapped)
        raise
    except Exception as exc:
        _restore_all(real_paths, asides, staging, swapped)
        raise MigrationFailedError(project_root, pending[0].name if pending else "?", None, str(exc)) from exc
    finally:
        # After _restore_all on the failure path, so the asides are only dropped
        # once whatever was going to be put back already has been.
        _discard_asides(real_paths, asides)


def _restore_all(
    real_paths: Mapping[str, Path],
    asides: Mapping[str, Path | None],
    staging: Mapping[str, Path],
    swapped: Mapping[str, bool],
) -> None:
    for name, real_path in real_paths.items():
        _restore_after_failure(real_path, asides[name], staging[name], swapped[name])


def _restore_after_failure(
    real_path: Path, aside_path: Path | None, staging_path: Path | None, swapped: bool
) -> None:
    """Put the original directory or file back and discard the partial staging copy.

    The aside copy is *moved* back rather than copied: the pre-migration zip is
    the durable record of this state, so nothing needs to survive here.
    """
    if swapped:
        # A later failure — the metadata stamp, or another target's swap —
        # left migrated data under the old formatVersion. Drop it, so what
        # is on disk is what the unchanged stamp describes. With no aside
        # there was nothing there before either, so dropping it is the whole
        # restore for a target staged from nothing.
        _discard_path(real_path)
    if aside_path is not None and not real_path.exists() and aside_path.exists():
        aside_path.rename(real_path)
    if staging_path is not None and staging_path != real_path and staging_path.exists():
        _discard_path(staging_path)


def _discard_asides(real_paths: Mapping[str, Path], asides: Mapping[str, Path | None]) -> None:
    """Drop each moved-aside original once its real path is back in place.

    An aside whose real path is somehow still missing is left alone: it is then
    the only copy of that data outside the zip, and a tidy project root is not
    worth spending it.
    """
    for name, aside_path in asides.items():
        if aside_path is not None and aside_path.exists() and real_paths[name].exists():
            _discard_path(aside_path)
