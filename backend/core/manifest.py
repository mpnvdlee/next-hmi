"""Project manifest stored at ``<runtime_home>/projects.json``.

Lists every project known to this runtime, the currently live one, optional
LAN peers, and the default location for new/incoming projects.

Pydantic models are the wire format. Plain reads use ``load_manifest()``;
every read-modify-write uses ``manifest_transaction()``. Loaded models carry a
source revision that ``save_manifest()`` compares with the current file, so a
stale writer from another process fails instead of erasing a newer update.
Writes remain atomic; a reentrant module ``RLock`` serializes local callers and
an adjacent OS-locked file serializes transactions across processes.

Tolerant of corruption: a missing or unparseable file returns an empty
manifest so a fresh install / a typo in the file never blocks startup. The
caller can persist a valid manifest by saving on top of it.

Per-project metadata lives inside ``<project_root>/config.json``
under the top-level ``project`` key — ``{ "id": ..., "name": ..., "createdAt": ... }``.
The id + friendly name are preserved across push/pull/zip round-trips so a
project moved between runtimes resolves to the same manifest entry and keeps
its name. Helpers below: ``read_project_metadata()`` /
``write_project_metadata()`` / ``set_project_metadata_name()``. Writers that
rebuild config.json from scratch (eg. ``config_api.PUT``) must read-and-preserve
this block; writers that read-modify-write keep it for free.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import unicodedata
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator

from core.runtime_home import manifest_path
from core.time_utils import iso_now

_lock = threading.RLock()
_held_file_locks: dict[Path, _HeldFileLock] = {}

MANIFEST_VERSION = 1
# Embedded inside config.json under this top-level key.
PROJECT_CONFIG_FILENAME = "config.json"
PROJECT_METADATA_KEY = "project"
_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_RESERVED_PROJECT_IDS = {
    "con", "prn", "aux", "nul",
    *(f"com{number}" for number in range(1, 10)),
    *(f"lpt{number}" for number in range(1, 10)),
}


def validate_project_id(value: str) -> str:
    """Validate an ID before it reaches URLs, process args, or filesystem paths."""
    if not isinstance(value, str) or not _PROJECT_ID_RE.fullmatch(value):
        raise ValueError(
            "Project id must be 1-128 characters, start with an alphanumeric, "
            "and contain only letters, digits, '.', '_' or '-'"
        )
    windows_basename = value.split(".", 1)[0].casefold()
    if windows_basename in _RESERVED_PROJECT_IDS or value.endswith((".", " ")):
        raise ValueError(f"Project id '{value}' is reserved")
    return value


class ProjectEntry(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    path: str
    addedAt: str
    lastOpenedAt: str | None = None

    _validate_id = field_validator("id")(validate_project_id)


PeerScheme = Literal["http", "https"]


class PeerEntry(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    host: str
    port: int = 8000
    scheme: PeerScheme = "http"
    addedAt: str


class RunningEntry(BaseModel):
    """A project the supervisor should keep running.

    Persisted so the manager can auto-resume the running set after a restart,
    re-binding the previous ``port`` when it is still free.
    """

    model_config = ConfigDict(extra="ignore")

    id: str
    port: int | None = None
    startedAt: str | None = None

    _validate_id = field_validator("id")(validate_project_id)


class ManifestV1(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version: int = MANIFEST_VERSION
    # The project served at the manager origin root (``/`` redirects to its
    # runtime). Chosen by the operator on the Projects page; independent of the
    # running set (a project can run without being the default).
    defaultProjectId: str | None = None
    defaultProjectsRoot: str | None = None
    projects: list[ProjectEntry] = Field(default_factory=list)
    peers: list[PeerEntry] = Field(default_factory=list)
    running: list[RunningEntry] = Field(default_factory=list)
    _source_revision: str | None = PrivateAttr(default=None)

    @field_validator("defaultProjectId")
    @classmethod
    def _validate_optional_project_id(cls, value: str | None) -> str | None:
        return validate_project_id(value) if value is not None else None


class ManifestConflictError(RuntimeError):
    """The manifest changed after this model was read."""


class InvalidManifestFormatError(RuntimeError):
    """A readable manifest uses unsupported values and must not be discarded."""


@dataclass
class _HeldFileLock:
    handle: BinaryIO
    depth: int = 1


def _acquire_file_lock(handle: BinaryIO) -> None:
    if os.name == "posix":
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        return
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        if handle.read(1) == b"":
            handle.seek(0)
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        return
    raise OSError(f"Cross-process manifest locking is unsupported on {os.name}")


def _release_file_lock(handle: BinaryIO) -> None:
    if os.name == "posix":
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        return
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return
    raise OSError(f"Cross-process manifest locking is unsupported on {os.name}")


@contextmanager
def _manifest_guard(path: Path) -> Iterator[None]:
    resolved_path = path.resolve()
    lock_path = resolved_path.with_name(f"{resolved_path.name}.lock")
    with _lock:
        held = _held_file_locks.get(lock_path)
        if held is not None:
            held.depth += 1
            try:
                yield
            finally:
                held.depth -= 1
            return

        lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = lock_path.open("a+b")
        try:
            _acquire_file_lock(handle)
            _held_file_locks[lock_path] = _HeldFileLock(handle=handle)
            try:
                yield
            finally:
                _held_file_locks.pop(lock_path, None)
                _release_file_lock(handle)
        finally:
            handle.close()


def _revision(raw: bytes | None) -> str:
    if raw is None:
        return "missing"
    return hashlib.sha256(raw).hexdigest()


def _read_manifest_bytes(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def load_manifest(path: Path | None = None) -> ManifestV1:
    """Read the manifest without silently discarding a readable invalid object."""
    if path is None:
        path = manifest_path()
    with _manifest_guard(path):
        try:
            raw = _read_manifest_bytes(path)
        except OSError:
            manifest = ManifestV1()
            manifest._source_revision = "unreadable"
            return manifest
        try:
            decoded = None if raw is None else json.loads(raw)
        except (OSError, ValueError, UnicodeDecodeError):
            decoded = None
        if raw is None or decoded is None or not isinstance(decoded, dict):
            manifest = ManifestV1()
        else:
            try:
                manifest = ManifestV1.model_validate(decoded)
            except ValueError as exc:
                raise InvalidManifestFormatError(
                    "Project manifest contains unsupported or invalid values; "
                    "the file was preserved and must be repaired before startup"
                ) from exc
        manifest._source_revision = _revision(raw)
        return manifest


def migrate_invalid_project_ids(path: Path | None = None) -> dict[str, str]:
    """Rewrite project ids that predate the canonical id grammar.

    An older ``slugify`` could emit ids the current grammar rejects (a leading
    ``_``/``.``, a Windows reserved basename), which would make every
    ``load_manifest`` fail. Runs before the manifest is first loaded and
    rewrites the id in ``projects``, ``running``, ``defaultProjectId`` and each
    project's own ``config.json``, so no permanent compatibility path is
    needed. Returns ``{old: new}``.
    """
    if path is None:
        path = manifest_path()
    with _manifest_guard(path):
        try:
            raw = _read_manifest_bytes(path)
        except OSError:
            return {}
        if raw is None:
            return {}
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return {}
        if not isinstance(data, dict) or not isinstance(data.get("projects"), list):
            return {}

        entries = [item for item in data["projects"] if isinstance(item, dict)]
        taken = set()
        for item in entries:
            identifier = item.get("id")
            if isinstance(identifier, str):
                try:
                    taken.add(validate_project_id(identifier))
                except ValueError:
                    continue

        renames: dict[str, str] = {}
        # Paired with its entry rather than keyed by the old id: two entries can
        # carry the same invalid id, and they must not both rewrite their
        # config.json to whichever replacement was assigned last.
        rewrites: list[tuple[dict[str, Any], str, str]] = []
        for item in entries:
            identifier = item.get("id")
            if not isinstance(identifier, str):
                continue
            try:
                validate_project_id(identifier)
                continue
            except ValueError:
                pass
            replacement = unique_slug(identifier, taken)
            taken.add(replacement)
            renames[identifier] = replacement
            rewrites.append((item, identifier, replacement))
            item["id"] = replacement

        changed = bool(rewrites)
        # Two entries can share one invalid id, so a single old->new map would
        # point every reference at whichever entry was renamed last. Only
        # unambiguous ids can be redirected; a duplicate cannot be resolved to
        # the project it meant, so those references are dropped instead of
        # silently aimed at the wrong project.
        occurrences: dict[str, int] = {}
        for _, old_id, _new_id in rewrites:
            occurrences[old_id] = occurrences.get(old_id, 0) + 1
        unambiguous = {
            old_id: new_id
            for _, old_id, new_id in rewrites
            if occurrences[old_id] == 1
        }

        # An invalid id can also survive with no project entry to migrate from —
        # deleting a project leaves it behind in these fields. It still fails
        # validation, so drop or clear it rather than leaving the manifest
        # permanently unloadable.
        surviving_running = []
        for item in data.get("running", []):
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                surviving_running.append(item)
                continue
            if item["id"] in unambiguous:
                item["id"] = unambiguous[item["id"]]
                changed = True
            elif not _is_valid_project_id(item["id"]):
                changed = True
                continue
            surviving_running.append(item)
        if isinstance(data.get("running"), list):
            data["running"] = surviving_running
        for key in ("defaultProjectId",):
            value = data.get(key)
            if not isinstance(value, str):
                continue
            if value in unambiguous:
                data[key] = unambiguous[value]
                changed = True
            elif not _is_valid_project_id(value):
                data[key] = None
                changed = True

        if changed:
            _atomic_write_json(path, data)

        # Re-derived from the manifest on every boot rather than only from this
        # run's renames: the rewrite below is best-effort so startup survives an
        # unwritable or unmounted project folder, and once the manifest is
        # written the entry's id is already valid — nothing would ever retry a
        # folder that was skipped. A stale id there is not cosmetic: it fails
        # validation, so the project reads back as having no metadata and gets
        # issued a third, invented id.
        for item in entries:
            raw_path = item.get("path")
            entry_id = item.get("id")
            if not isinstance(raw_path, str) or not isinstance(entry_id, str):
                continue
            config_path = project_config_path(Path(raw_path).expanduser())
            try:
                config = _read_config_json(config_path)
                if not isinstance(config, dict):
                    continue
                block = config.get(PROJECT_METADATA_KEY)
                if isinstance(block, dict) and block.get("id") != entry_id:
                    block["id"] = entry_id
                    _atomic_write_json(config_path, config)
            except OSError:
                continue
    return renames


def _is_valid_project_id(value: str) -> bool:
    try:
        validate_project_id(value)
    except ValueError:
        return False
    return True


def save_manifest(manifest: ManifestV1, path: Path | None = None) -> None:
    """Atomically write the manifest. Creates parent dirs as needed."""
    if path is None:
        path = manifest_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    with _manifest_guard(path):
        expected_revision = manifest._source_revision
        actual_revision = _revision(_read_manifest_bytes(path))
        if expected_revision is not None and expected_revision != actual_revision:
            raise ManifestConflictError(
                "Project manifest changed during update; retry with a fresh manifest",
            )
        try:
            serialized = manifest.model_dump_json(indent=2)
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                suffix=".tmp",
                prefix=f"{path.name}.",
                dir=path.parent,
                delete=False,
            ) as f:
                f.write(serialized)
                tmp_path = Path(f.name)
            os.replace(tmp_path, path)
            manifest._source_revision = _revision(_read_manifest_bytes(path))
        except OSError:
            if tmp_path is not None and tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
            raise


@contextmanager
def manifest_transaction(path: Path | None = None) -> Iterator[ManifestV1]:
    """Hold process-local and OS locks across a read/modify/write sequence."""
    if path is None:
        path = manifest_path()
    with _manifest_guard(path):
        yield load_manifest(path)


_SLUG_INVALID = re.compile(r"[^a-zA-Z0-9._-]+")
_SLUG_LEADING = re.compile(r"^[^A-Za-z0-9]+")


def slugify(name: str) -> str:
    """Folder-safe ASCII slug. Preserves hyphens, dots, and underscores.

    The result always satisfies ``validate_project_id``: slugs become both
    project ids and folder names, so a leading dot/underscore or a Windows
    reserved basename would otherwise produce a project that cannot be
    persisted or reloaded.
    """
    normalized = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    cleaned = _SLUG_LEADING.sub("", _SLUG_INVALID.sub("-", normalized))[:128]
    cleaned = cleaned.rstrip("-. ")
    if not cleaned:
        return "project"
    if cleaned.split(".", 1)[0].casefold() in _RESERVED_PROJECT_IDS:
        return f"project-{cleaned}"[:128].rstrip("-. ")
    return cleaned


def unique_slug(name: str, taken: Iterable[str]) -> str:
    """Suffix the slug with ``-2``, ``-3``, … until it doesn't collide with ``taken``."""
    base = slugify(name)
    taken_set = set(taken)
    if base not in taken_set:
        return base
    n = 2
    while f"{base}-{n}" in taken_set:
        n += 1
    return f"{base}-{n}"


def find_project(manifest: ManifestV1, project_id: str) -> ProjectEntry | None:
    for entry in manifest.projects:
        if entry.id == project_id:
            return entry
    return None


def default_project(manifest: ManifestV1) -> ProjectEntry | None:
    """The project the manager origin root resolves to, or ``None`` if unset/stale."""
    if not manifest.defaultProjectId:
        return None
    return find_project(manifest, manifest.defaultProjectId)


# ── running set (supervisor) ─────────────────────────────────────────────────


def running_entry(manifest: ManifestV1, project_id: str) -> RunningEntry | None:
    for entry in manifest.running:
        if entry.id == project_id:
            return entry
    return None


def upsert_running(project_id: str, port: int | None) -> None:
    """Record that *project_id* should be running, remembering its ``port``.

    Read-modify-write under the manifest lock so concurrent supervisor actions
    don't tear the file.
    """
    with manifest_transaction() as manifest:
        existing = running_entry(manifest, project_id)
        if existing is not None:
            existing.port = port
            if existing.startedAt is None:
                existing.startedAt = iso_now()
        else:
            manifest.running.append(
                RunningEntry(id=project_id, port=port, startedAt=iso_now())
            )
        save_manifest(manifest)


def remove_running(project_id: str) -> None:
    """Drop *project_id* from the persisted running set."""
    with manifest_transaction() as manifest:
        kept = [entry for entry in manifest.running if entry.id != project_id]
        if len(kept) != len(manifest.running):
            manifest.running = kept
            save_manifest(manifest)


# ── per-project metadata (embedded in config.json) ───────────────────────────


class ProjectMetadata(BaseModel):
    # Other writers (e.g. theme_manager._set_default_raw's ``defaultTheme``)
    # read-modify-write sibling fields directly into the same ``project``
    # block without going through this model. "allow" (not "ignore") so a
    # round trip through ``read_project_metadata``/``write_project_metadata``
    # preserves them instead of silently dropping them.
    model_config = ConfigDict(extra="allow")

    id: str
    name: str | None = None
    createdAt: str | None = None
    # 0 = unstamped (every project predating this field reads as 0). See
    # core.project_migrations.PROJECT_FORMAT_VERSION.
    formatVersion: int = 0

    _validate_id = field_validator("id")(validate_project_id)


def project_config_path(project_root: Path) -> Path:
    """The ``config.json`` that carries the embedded metadata block.

    ``project_root`` is the project folder registered in the manifest;
    ``config.json`` sits directly inside it (flat layout, no ``project/``
    wrapper).
    """
    return project_root / PROJECT_CONFIG_FILENAME


def _read_config_json(path: Path) -> dict[str, Any] | None:
    """Best-effort read of config.json. Returns the dict or None on miss/parse error."""
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    """Atomic JSON write. Local copy so manifest doesn't pull in core.storage."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            suffix=".tmp",
            prefix=f"{path.name}.",
            dir=path.parent,
            delete=False,
        ) as f:
            json.dump(data, f, indent=2)
            tmp_path = Path(f.name)
        os.replace(tmp_path, path)
    except OSError:
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise


def read_project_metadata(project_root: Path) -> ProjectMetadata | None:
    """Read the ``project`` block from ``config.json``."""
    config = _read_config_json(project_config_path(project_root))
    if config is None:
        return None
    block = config.get(PROJECT_METADATA_KEY)
    if not isinstance(block, dict):
        return None
    try:
        return ProjectMetadata.model_validate(block)
    except ValueError:
        return None


def write_project_metadata(project_root: Path, metadata: ProjectMetadata) -> None:
    """Set the ``project`` block in ``config.json``, atomically.

    Preserves all other top-level fields (pages, mcpEnabled, header, …).
    """
    path = project_config_path(project_root)
    with _lock:
        config = _read_config_json(path) or {}
        config[PROJECT_METADATA_KEY] = metadata.model_dump(mode="json")
        _atomic_write_json(path, config)


def project_mcp_enabled(project_root: Path) -> bool:
    """Whether the workspace MCP may write to this project, read straight off
    ``config.json``.

    The manager never loads a project's runtime, so it reads the file directly —
    which means a *stopped* project's flag is still authoritative. Missing file /
    field / any non-``true`` value resolves to ``False`` (closed by default).
    """
    config = _read_config_json(project_config_path(project_root))
    return isinstance(config, dict) and config.get("mcpEnabled") is True


def set_project_mcp_enabled(project_root: Path, enabled: bool) -> None:
    """Persist ``mcpEnabled`` into ``config.json``, preserving all other fields."""
    path = project_config_path(project_root)
    with _lock:
        config = _read_config_json(path) or {}
        config["mcpEnabled"] = bool(enabled)
        _atomic_write_json(path, config)


def ensure_project_metadata(project_root: Path, *, name: str | None = None) -> ProjectMetadata:
    """Read the embedded project metadata or create it with a fresh UUID.

    Used when adopting an existing folder into the manifest — without it,
    push/pull would treat the same folder as a different project each time.
    If ``name`` is given and the existing metadata's name differs, the file is
    rewritten so the friendly name stays in sync with the manifest entry.
    """
    existing = read_project_metadata(project_root)
    if existing is not None:
        if name and existing.name != name:
            updated = existing.model_copy(update={"name": name})
            write_project_metadata(project_root, updated)
            return updated
        return existing
    taken = {entry.id for entry in load_manifest().projects}
    metadata = ProjectMetadata(
        id=unique_slug(name or project_root.name, taken),
        name=name,
        createdAt=iso_now(),
    )
    write_project_metadata(project_root, metadata)
    return metadata


def set_project_metadata_name(project_root: Path, name: str) -> ProjectMetadata | None:
    """Update the metadata file's ``name`` field. Returns ``None`` if no metadata exists."""
    existing = read_project_metadata(project_root)
    if existing is None:
        return None
    if existing.name == name:
        return existing
    updated = existing.model_copy(update={"name": name})
    write_project_metadata(project_root, updated)
    return updated
