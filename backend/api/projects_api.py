"""REST API for project lifecycle and archive transport (export/import)."""
from __future__ import annotations

import ctypes
import errno
import logging
import os
import shutil
import stat
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from core import mcp_tokens, operator_setup, runtime_home
from core.exceptions import ConflictError, NotFoundError, ValidationError
from core.manifest import (
    ManifestV1,
    ProjectEntry,
    ProjectMetadata,
    ensure_project_metadata,
    find_project,
    load_manifest,
    manifest_transaction,
    project_mcp_enabled,
    read_project_metadata,
    running_entry,
    save_manifest,
    set_project_mcp_enabled,
    set_project_metadata_name,
    validate_project_id,
    write_project_metadata,
)
from core.project_migrations import PROJECT_FORMAT_VERSION
from core.project_packer import (
    UnsafeArchiveError,
    pack_project,
    safe_filename,
    unpack_project,
)
from core.time_utils import iso_now
from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects", tags=["projects"])

_REPO_ROOT = Path(__file__).parent.parent.parent
_SEED_DIR_CANDIDATES = (_REPO_ROOT / "project-seed", _REPO_ROOT / "backend" / "project-seed")


# ── request / response models ────────────────────────────────────────────────


class CreateProjectBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    path: str = Field(min_length=1)


class LocateProjectBody(BaseModel):
    path: str = Field(min_length=1)


class RegisterProjectBody(BaseModel):
    path: str = Field(min_length=1)
    name: str | None = None


class UpdateProjectBody(BaseModel):
    """Rename payload — send only the fields that change."""

    name: str | None = Field(default=None, max_length=200)
    id: str | None = Field(default=None, max_length=128)


class ValidatePathBody(BaseModel):
    path: str = Field(min_length=1)


# ── helpers ──────────────────────────────────────────────────────────────────


def _seed_dir() -> Path | None:
    for candidate in _SEED_DIR_CANDIDATES:
        if candidate.is_dir():
            return candidate
    return None


def _copy_seed_into(target: Path) -> None:
    seed = _seed_dir()
    if seed is None:
        # Empty project — caller is creating from scratch; create the minimal
        # folder skeleton so ``ensure_active_project_dirs`` has something to
        # work with when this project becomes live.
        target.mkdir(parents=True, exist_ok=True)
        for sub in ("assets", "certs", "custom-widgets", "external-libraries"):
            (target / sub).mkdir(parents=True, exist_ok=True)
        return
    for entry in seed.iterdir():
        dest = target / entry.name
        if entry.is_dir():
            shutil.copytree(entry, dest, dirs_exist_ok=True)
        else:
            shutil.copy2(entry, dest)


def _resolve_path(raw: str) -> Path:
    return Path(raw).expanduser().resolve()


def _path_status(raw_path: str) -> str:
    """``present`` if the folder exists and looks like a project; ``missing`` otherwise."""
    try:
        path = Path(raw_path).expanduser()
    except (OSError, ValueError):
        return "missing"
    return "present" if path.is_dir() else "missing"


def _entry_dict(entry: ProjectEntry, *, default_id: str | None = None) -> dict[str, Any]:
    setup_state = operator_setup.state(Path(entry.path).expanduser())
    return {
        "id": entry.id,
        "name": entry.name,
        "path": entry.path,
        "addedAt": entry.addedAt,
        "lastOpenedAt": entry.lastOpenedAt,
        "status": _path_status(entry.path),
        "isDefault": entry.id == default_id,
        "mcpEnabled": project_mcp_enabled(Path(entry.path).expanduser()),
        "operatorSetupRequired": setup_state.status is operator_setup.SetupStatus.REQUIRED,
        "operatorSetupStatus": setup_state.status.value,
        "operatorSetupError": setup_state.error,
    }


def _validate_destination(target: Path, *, must_be_empty: bool) -> None:
    """Reject obvious foot-guns before touching the filesystem.

    Raises ``ValidationError`` so the registered handler returns 422 with the
    explanation as ``detail``.
    """
    if target.is_file():
        raise ValidationError(f"Path is a file, not a directory: {target}")
    if target.exists():
        if not target.is_dir():
            raise ValidationError(f"Path exists and is not a directory: {target}")
        if must_be_empty and any(target.iterdir()):
            raise ValidationError(f"Destination directory is not empty: {target}")
    parent = target.parent
    if not parent.exists():
        raise ValidationError(f"Parent directory does not exist: {parent}")
    if not os.access(parent, os.W_OK):
        raise ValidationError(f"Parent directory is not writable: {parent}")


def _require_entry(manifest: ManifestV1, project_id: str) -> ProjectEntry:
    entry = find_project(manifest, project_id)
    if entry is not None:
        return entry
    raise NotFoundError(f"Project '{project_id}' not found")


def _move_runtime_state(old_id: str, new_id: str) -> None:
    """Carry the runtime-home folders keyed by project id across an id change.

    Best-effort: the instance logs are history and the widget build is a cache,
    so a failure here must not fail a rename the manifest already committed.
    """
    for base in (runtime_home.logs_dir() / "instances", runtime_home.widget_build_dir()):
        source, destination = base / old_id, base / new_id
        if not source.is_dir() or destination.exists():
            continue
        try:
            source.rename(destination)
        except OSError:
            logger.warning(
                "Could not move %s to %s after the project id changed", source, destination,
            )


def _prepare_import_destination(raw_path: str) -> Path:
    """Resolve, validate, and create an empty archive extraction target."""
    target = _resolve_path(raw_path)
    _validate_destination(target, must_be_empty=True)
    if target.exists() and read_project_metadata(target) is not None:
        raise ConflictError(
            f"Destination {target} already contains a NEXT HMI project; pick an empty folder.",
        )
    target.mkdir(parents=True, exist_ok=True)
    return target


@dataclass(frozen=True)
class _StagingDirectoryIdentity:
    device: int
    inode: int


@dataclass
class _StagingDirectoryBinding:
    identity: _StagingDirectoryIdentity
    handle: int

    def close(self) -> None:
        os.close(self.handle)


def _staging_identity(source: Path) -> _StagingDirectoryIdentity:
    source_stat = source.lstat()
    if not stat.S_ISDIR(source_stat.st_mode):
        raise ValidationError(f"Pull staging path is not a directory: {source}")
    return _StagingDirectoryIdentity(source_stat.st_dev, source_stat.st_ino)


def _bind_staging_directory(source: Path) -> _StagingDirectoryBinding:
    identity = _staging_identity(source)
    if os.name == "nt":
        import msvcrt

        create_file = ctypes.windll.kernel32.CreateFileW
        create_file.restype = ctypes.c_void_p
        windows_handle = create_file(
            str(source),
            0,
            0x00000001 | 0x00000002 | 0x00000004,
            None,
            3,
            0x02000000 | 0x00200000,
            None,
        )
        if windows_handle == ctypes.c_void_p(-1).value:
            raise OSError(ctypes.get_last_error(), "Could not bind pull staging directory")
        try:
            handle = msvcrt.open_osfhandle(windows_handle, os.O_RDONLY)
        except Exception:
            ctypes.windll.kernel32.CloseHandle(windows_handle)
            raise
        handle_stat = os.fstat(handle)
        handle_identity = _StagingDirectoryIdentity(handle_stat.st_dev, handle_stat.st_ino)
        if not stat.S_ISDIR(handle_stat.st_mode) or handle_identity != identity:
            os.close(handle)
            raise ValidationError(f"Could not bind pull staging directory: {source}")
        return _StagingDirectoryBinding(identity=identity, handle=handle)

    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    handle = os.open(source, flags)
    handle_stat = os.fstat(handle)
    handle_identity = _StagingDirectoryIdentity(handle_stat.st_dev, handle_stat.st_ino)
    if not stat.S_ISDIR(handle_stat.st_mode) or handle_identity != identity:
        os.close(handle)
        raise ValidationError(f"Could not bind pull staging directory: {source}")
    return _StagingDirectoryBinding(identity=identity, handle=handle)


def _validate_staging_binding(source: Path, binding: _StagingDirectoryBinding) -> None:
    handle_stat = os.fstat(binding.handle)
    handle_identity = _StagingDirectoryIdentity(handle_stat.st_dev, handle_stat.st_ino)
    if (
        not stat.S_ISDIR(handle_stat.st_mode)
        or handle_identity != binding.identity
        or _staging_identity(source) != binding.identity
    ):
        raise ValidationError(f"Pull staging directory changed before commit: {source}")


def _atomic_rename_noreplace(
    source: Path,
    destination: Path,
    binding: _StagingDirectoryBinding,
) -> None:
    """Atomically rename a directory while refusing an existing destination."""
    _validate_staging_binding(source, binding)
    if os.name == "nt":
        _windows_rename_noreplace(source, destination)
        return
    source_parent = _bind_staging_directory(source.parent)
    destination_parent = _bind_staging_directory(destination.parent)
    try:
        source_at_parent = os.stat(
            source.name,
            dir_fd=source_parent.handle,
            follow_symlinks=False,
        )
        if _StagingDirectoryIdentity(
            source_at_parent.st_dev, source_at_parent.st_ino
        ) != binding.identity:
            raise ValidationError(
                f"Pull staging directory changed before commit: {source}"
            )
        _native_rename_noreplace(
            source.name,
            destination.name,
            source_parent.handle,
            destination_parent.handle,
        )
    finally:
        destination_parent.close()
        source_parent.close()


def _windows_rename_noreplace(source: Path, destination: Path) -> None:
    """Check-then-rename fallback for Windows.

    Windows exposes no handle-relative rename that fails atomically on an
    existing destination, so the absence check and the rename are two steps.
    ``os.rename`` itself refuses an existing destination there (MoveFileExW
    without ``REPLACE_EXISTING``), which closes the common collision; what
    remains is a brief window in which a local actor who can already write into
    the projects root could place something at the destination. That is a
    documented weaker guarantee than the POSIX path — see
    ``docs/dev/architecture/backend.md``.
    """
    if destination.exists() or destination.is_symlink():
        raise OSError(errno.EEXIST, "Destination already exists", str(destination))
    os.rename(source, destination)


def _native_rename_noreplace(
    source_name: str,
    destination_name: str,
    source_parent_handle: int,
    destination_parent_handle: int,
) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    source_raw = os.fsencode(source_name)
    destination_raw = os.fsencode(destination_name)
    if sys.platform == "darwin":
        rename_exclusive = 0x00000004
        renameatx = getattr(libc, "renameatx_np", None)
        if renameatx is None:
            raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")
    elif sys.platform.startswith("linux"):
        rename_noreplace = 0x00000001
        renameat2 = getattr(libc, "renameat2", None)
        if renameat2 is None:
            raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")
    else:
        raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")

    if sys.platform == "darwin":
        result = renameatx(
            source_parent_handle,
            source_raw,
            destination_parent_handle,
            destination_raw,
            rename_exclusive,
        )
    else:
        result = renameat2(
            source_parent_handle,
            source_raw,
            destination_parent_handle,
            destination_raw,
            rename_noreplace,
        )

    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(
            error_number,
            os.strerror(error_number),
            destination_name,
        )


def _register_imported_project(
    target: Path,
    metadata: ProjectMetadata,
    requested_name: str | None,
    *,
    duplicate_message: str,
) -> tuple[ProjectEntry, ManifestV1]:
    """Register an unpacked project and synchronize its embedded display name."""
    display_name = (requested_name or metadata.name or target.name).strip() or target.name
    with manifest_transaction() as manifest:
        if find_project(manifest, metadata.id) is not None:
            shutil.rmtree(target, ignore_errors=True)
            raise ConflictError(duplicate_message)
        entry = ProjectEntry(
            id=metadata.id,
            name=display_name,
            path=str(target),
            addedAt=iso_now(),
        )
        manifest.projects.append(entry)
        save_manifest(manifest)
    set_project_metadata_name(target, display_name)
    return entry, manifest


# ── endpoints ────────────────────────────────────────────────────────────────


@router.get("")
def list_projects() -> dict[str, Any]:
    """Manifest entries + computed ``status`` (`present` | `missing`) and ``isDefault``."""
    manifest = load_manifest()
    return {
        "defaultProjectId": manifest.defaultProjectId,
        "defaultProjectsRoot": manifest.defaultProjectsRoot,
        "projects": [
            _entry_dict(entry, default_id=manifest.defaultProjectId)
            for entry in manifest.projects
        ],
    }


class McpEnabledBody(BaseModel):
    enabled: bool


@router.get("/{project_id}/mcp")
def get_project_mcp(project_id: str) -> dict[str, Any]:
    """Whether the workspace MCP may write to this project (auth scope)."""
    entry = _require_entry(load_manifest(), project_id)
    enabled = project_mcp_enabled(Path(entry.path).expanduser())
    return {"id": project_id, "mcpEnabled": enabled}


@router.post("/{project_id}/mcp")
def set_project_mcp(project_id: str, body: McpEnabledBody) -> dict[str, Any]:
    """Enable/disable MCP writes for one project. Works running or stopped — the
    flag is the per-project authorization scope the workspace MCP enforces."""
    entry = _require_entry(load_manifest(), project_id)
    set_project_mcp_enabled(Path(entry.path).expanduser(), body.enabled)
    return {"id": project_id, "mcpEnabled": body.enabled}


@router.post("/{project_id}/default")
def set_default(project_id: str) -> dict[str, Any]:
    """Mark a project as the origin-root default (``/`` redirects to its runtime).

    Manifest-only — the manager's root handler starts the project on demand when
    it isn't already running, so this works whether the project is up or stopped.
    """
    with manifest_transaction() as manifest:
        entry = _require_entry(manifest, project_id)
        manifest.defaultProjectId = entry.id
        save_manifest(manifest)
    return _entry_dict(entry, default_id=entry.id)


@router.patch("/{project_id}")
def update_project(project_id: str, body: UpdateProjectBody) -> dict[str, Any]:
    """Change a project's display name and/or its id.

    Both live in two places — the manifest entry and the project's own
    ``config.json`` — and the id additionally addresses the project in URLs,
    instance log folders and MCP tokens. So this only runs while the project is
    stopped, and an id change also requires the folder to be reachable: the
    embedded metadata has to follow the manifest, which is the source of truth
    the boot-time resync reads from.
    """
    new_name: str | None = None
    if body.name is not None:
        new_name = body.name.strip()
        if not new_name:
            raise ValidationError("Project name must not be empty")
    new_id = body.id.strip() if body.id is not None else None

    with manifest_transaction() as manifest:
        entry = _require_entry(manifest, project_id)
        if new_name is None and (new_id is None or new_id == entry.id):
            return _entry_dict(entry, default_id=manifest.defaultProjectId)
        if running_entry(manifest, entry.id) is not None:
            raise ConflictError("Cannot rename a running project. Stop it first.")

        old_id = entry.id
        target = Path(entry.path).expanduser()
        changing_id = new_id is not None and new_id != old_id
        if new_id is not None and changing_id:
            try:
                validate_project_id(new_id)
            except ValueError as exc:
                raise ValidationError(str(exc)) from exc
            # Case-insensitively: the id is also a folder name under the
            # runtime home, and two ids differing only in case would collide
            # there on macOS and Windows.
            if any(
                other.id.casefold() == new_id.casefold()
                for other in manifest.projects
                if other.id != old_id
            ):
                raise ConflictError(f"Project id '{new_id}' is already registered.")
            if read_project_metadata(target) is None:
                raise ValidationError(
                    f"Cannot change the id: no project metadata at {target} "
                    "(folder missing, or config.json has no `project` block).",
                )
            entry.id = new_id
            if manifest.defaultProjectId == old_id:
                manifest.defaultProjectId = new_id
        if new_name is not None:
            entry.name = new_name
        save_manifest(manifest)

    if changing_id:
        mcp_tokens.retarget_project(old_id, entry.id)
        _move_runtime_state(old_id, entry.id)

    metadata = read_project_metadata(target)
    if metadata is not None:
        updates: dict[str, Any] = {"id": entry.id}
        if new_name is not None:
            updates["name"] = new_name
        write_project_metadata(target, metadata.model_copy(update=updates))

    logger.info("Renamed project '%s' to '%s' (%s)", old_id, entry.name, entry.id)
    return _entry_dict(entry, default_id=manifest.defaultProjectId)


@router.post("/validate-path")
def validate_path(body: ValidatePathBody) -> dict[str, Any]:
    """Inline-validation helper for the create dialog.

    Returns a structured result — never raises — so the UI can show every
    failure mode side-by-side.
    """
    try:
        target = _resolve_path(body.path)
    except (OSError, ValueError) as exc:
        return {"ok": False, "reason": str(exc), "resolvedPath": body.path}

    if target.is_file():
        return {"ok": False, "reason": "path-is-file", "resolvedPath": str(target)}

    exists = target.exists()
    is_empty = True
    if exists:
        try:
            is_empty = not any(target.iterdir())
        except OSError:
            return {"ok": False, "reason": "not-readable", "resolvedPath": str(target)}

    parent = target.parent
    parent_writable = parent.exists() and os.access(parent, os.W_OK)
    if not parent.exists():
        return {"ok": False, "reason": "parent-missing", "resolvedPath": str(target)}
    if not parent_writable:
        return {"ok": False, "reason": "parent-not-writable", "resolvedPath": str(target)}

    return {
        "ok": True,
        "resolvedPath": str(target),
        "exists": exists,
        "isEmpty": is_empty,
        "parentWritable": parent_writable,
    }


@router.get("/browse-dir")
def browse_dir(path: str | None = Query(default=None)) -> dict[str, Any]:
    """List subdirectories of ``path`` for the in-app folder browser.

    Browsers never expose the absolute path of an OS folder picker, so the
    create/add-existing/import dialogs drive their own picker against this
    endpoint instead — it walks the real filesystem the backend runs on and
    returns real absolute paths. Falls back to the home directory when
    ``path`` is missing, unreadable, or not a directory.
    """
    target = Path.home()
    if path:
        try:
            candidate = _resolve_path(path)
        except (OSError, ValueError):
            candidate = None
        if candidate is not None:
            if candidate.is_dir():
                target = candidate
            elif candidate.parent.is_dir():
                target = candidate.parent

    entries: list[dict[str, str]] = []
    error: str | None = None
    try:
        children = sorted(target.iterdir(), key=lambda p: p.name.lower())
    except OSError as exc:
        children = []
        error = str(exc)
    for child in children:
        try:
            if child.is_dir() and not child.name.startswith("."):
                entries.append({"name": child.name, "path": str(child)})
        except OSError:
            continue

    parent = target.parent
    return {
        "path": str(target),
        "parent": str(parent) if parent != target else None,
        "entries": entries,
        "error": error,
        "hasConfigJson": (target / "config.json").is_file(),
    }


@router.post("", status_code=201)
def create_project(body: CreateProjectBody) -> dict[str, Any]:
    """Seed a new project folder from ``project-seed/`` and add it to the manifest.

    The target must not exist OR must be an empty directory. We seed into the
    directory and write a fresh ``project`` metadata block with a UUID into
    ``config.json``.
    """
    name = body.name.strip()
    if not name:
        raise ValidationError("Project name must not be empty")

    target = _resolve_path(body.path)
    # A folder that already carries project metadata isn't a new project.
    existing_metadata = read_project_metadata(target) if target.is_dir() else None
    if existing_metadata is not None:
        raise ConflictError(
            f"Path {target} already contains a NEXT HMI project (id {existing_metadata.id}); "
            "add the existing project instead of creating it again.",
        )

    _validate_destination(target, must_be_empty=True)
    target.mkdir(parents=True, exist_ok=True)

    try:
        _copy_seed_into(target)
    except OSError as exc:
        raise ValidationError(f"Failed to seed project at {target}: {exc}") from exc

    metadata = ensure_project_metadata(target, name=name)
    # Freshly seeded from project-seed/, which is already canonical, so stamp
    # it here rather than leaving it for the next activation.
    metadata = metadata.model_copy(update={"formatVersion": PROJECT_FORMAT_VERSION})
    write_project_metadata(target, metadata)
    with manifest_transaction() as manifest:
        if find_project(manifest, metadata.id) is not None:
            raise ConflictError(
                f"Project at {target} is already registered (id {metadata.id}); "
                "use its existing manager entry.",
            )

        entry = ProjectEntry(
            id=metadata.id,
            name=name,
            path=str(target),
            addedAt=iso_now(),
        )
        manifest.projects.append(entry)
        save_manifest(manifest)
    logger.info("Created project '%s' (%s) at %s", name, metadata.id, target)
    return _entry_dict(entry)


@router.post("/register", status_code=201)
def register_existing_project(body: RegisterProjectBody) -> dict[str, Any]:
    """Add an existing on-disk project folder to the manifest.

    The folder must already contain a ``project`` block in
    ``config.json``. If the id is already in the manifest, returns 409 so the
    UI can offer Locate instead.
    """
    target = _resolve_path(body.path)
    if not target.is_dir():
        raise ValidationError(f"Path is not a directory: {target}")
    metadata = read_project_metadata(target)
    if metadata is None:
        raise ValidationError(
            f"No NEXT HMI project metadata at {target} (config.json missing or has no `project` block).",
        )

    display_name = (body.name or "").strip() or metadata.name or target.name
    with manifest_transaction() as manifest:
        if find_project(manifest, metadata.id) is not None:
            raise ConflictError(
                f"Project at {target} is already registered (id {metadata.id}).",
            )

        entry = ProjectEntry(
            id=metadata.id,
            name=display_name,
            path=str(target),
            addedAt=iso_now(),
        )
        manifest.projects.append(entry)
        save_manifest(manifest)
    set_project_metadata_name(target, display_name)
    logger.info("Registered existing project '%s' (%s) at %s", display_name, metadata.id, target)
    return _entry_dict(entry)


@router.post("/{project_id}/locate")
def locate(project_id: str, body: LocateProjectBody) -> dict[str, Any]:
    """Update a missing entry's path; require the destination's metadata id to match."""
    target = _resolve_path(body.path)
    if not target.is_dir():
        raise ValidationError(f"Path is not a directory: {target}")
    metadata = read_project_metadata(target)
    if metadata is None:
        raise ValidationError(
            f"No NEXT HMI project metadata at {target} (config.json is missing or has no `project` block).",
        )
    with manifest_transaction() as manifest:
        entry = _require_entry(manifest, project_id)
        if metadata.id != entry.id:
            raise ConflictError(
                f"Project id mismatch — folder at {target} has id {metadata.id}, "
                f"entry expects {entry.id}.",
            )
        entry.path = str(target)
        save_manifest(manifest)
    return _entry_dict(entry)


@router.delete("/{project_id}", status_code=200)
def delete(project_id: str, deleteFolder: bool = False) -> dict[str, Any]:
    """Remove the manifest entry. With ``?deleteFolder=true``, also ``rmtree`` the folder.

    Refuses to delete a project that is in the running set — operator must stop
    it first. Refuses to delete a folder lacking the embedded `project` block in
    ``config.json`` (defense against a wrong/typo'd path wiping unrelated
    files).
    """
    with manifest_transaction() as manifest:
        entry = _require_entry(manifest, project_id)
        # The manifest's running set is the authoritative, process-independent record
        # of which projects the supervisor keeps up. Check it (not the in-process
        # supervisor singleton, which is empty in a project-instance child) so this
        # guard holds regardless of whether the request hits the manager or is
        # proxied to an instance.
        if running_entry(manifest, entry.id) is not None:
            raise ConflictError(
                "Cannot delete a running project. Stop it first.",
            )

        if deleteFolder:
            try:
                target = Path(entry.path).expanduser().resolve()
            except (OSError, ValueError) as exc:
                raise ValidationError(f"Stored path is invalid: {exc}") from exc
            if target.is_dir():
                if read_project_metadata(target) is None:
                    raise ValidationError(
                        f"Refusing to delete {target}: no `project` block in config.json — "
                        "remove the entry without the folder flag if this is the right thing to do.",
                    )
                shutil.rmtree(target)
                logger.info("Deleted project folder %s", target)

        manifest.projects = [p for p in manifest.projects if p.id != entry.id]
        save_manifest(manifest)
    logger.info("Removed project '%s' (%s) from manifest", entry.name, entry.id)
    return {"id": entry.id, "deletedFolder": bool(deleteFolder)}


@router.get("/_runtime-home")
def runtime_home_info() -> dict[str, Any]:
    """Read-only helper used by the create dialog to suggest a default path."""
    manifest = load_manifest()
    home = runtime_home.runtime_home_path()
    default_root = manifest.defaultProjectsRoot or str(home / "Projects")
    return {
        "runtimeHome": str(home),
        "defaultProjectsRoot": default_root,
    }


# ── export / import ──────────────────────────────────────────────────────────


@router.get("/{project_id}/export")
def export_project(project_id: str) -> StreamingResponse:
    """Stream the project as a zip download (excluding ``widget-build/``)."""
    manifest = load_manifest()
    entry = _require_entry(manifest, project_id)
    project_root = Path(entry.path).expanduser()
    if not project_root.is_dir():
        raise ConflictError(
            f"Project folder is missing at {entry.path}. Use Locate to update the path first.",
        )

    # Pack into a spooled temp file so we don't buffer the whole archive in
    # memory but also don't tie the response generator to a long-lived file
    # descriptor while the project tree is being walked.
    spool = tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024, mode="w+b")  # noqa: SIM115 -- must outlive this function: streamed and closed later by the `_iter()` generator, so a `with` block here would close it before the response body is read
    try:
        pack_project(project_root, spool)
    except Exception:
        spool.close()
        raise
    spool.seek(0)

    def _iter() -> Any:
        try:
            while True:
                chunk = spool.read(64 * 1024)
                if not chunk:
                    return
                yield chunk
        finally:
            spool.close()

    filename = f"{safe_filename(entry.name)}.nexthmi.zip"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(_iter(), media_type="application/zip", headers=headers)


@router.post("/import", status_code=201)
async def import_project(
    file: UploadFile = File(...),
    destinationPath: str = Form(...),
    name: str | None = Form(default=None),
) -> dict[str, Any]:
    """Unpack an uploaded zip into ``destinationPath`` and register it.

    The new project is NOT made the default. If the archive's project id
    already matches an existing manifest entry, returns 409.
    """
    target = _prepare_import_destination(destinationPath)

    try:
        try:
            # UploadFile wraps a SpooledTemporaryFile that is seekable — zipfile
            # needs that to read the central directory.
            file.file.seek(0)
            metadata = unpack_project(file.file, target)
        except UnsafeArchiveError as exc:
            raise ValidationError(str(exc)) from exc
        except zipfile.BadZipFile as exc:
            raise ValidationError(f"Uploaded file is not a valid zip: {exc}") from exc
    except Exception:
        # Clean up a partially-written destination on failure.
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        raise

    entry, _manifest = _register_imported_project(
        target,
        metadata,
        name,
        duplicate_message=(
            f"A project with id {metadata.id} is already registered. "
            "Remove it first or import a different archive."
        ),
    )
    logger.info("Imported project '%s' (%s) at %s", entry.name, metadata.id, target)
    return _entry_dict(entry)
