"""Project zip packer / unpacker — one code path for export, import, push, pull.

Streams in/out so a large project doesn't pin the archive in memory. Every
archive carries the project metadata embedded in ``config.json`` (under the
top-level ``project`` key) so the receiver can deduplicate against the
manifest by stable id; ``unpack_project`` returns the parsed metadata after
extraction.

Hardened against zip-bomb size exhaustion (cap via
``NEXTHMI_MAX_PROJECT_ZIP_MB``, default 500 MB), path-traversal entries,
absolute-path entries, and symlink members.

``widget-build/`` is intentionally skipped during pack — the receiver
rebuilds it from sources after applying the archive.
"""
from __future__ import annotations

import contextlib
import logging
import os
import stat
import zipfile
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import BinaryIO

from core.component_validation import (
    ComponentScanError,
    scan_project_component_bindings,
)
from core.manifest import (
    PROJECT_CONFIG_FILENAME,
    ProjectMetadata,
    ensure_project_metadata,
    read_project_metadata,
)

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[int, int], None]

DEFAULT_MAX_ZIP_MB = 500
_CHUNK = 64 * 1024

# Folder names skipped during pack — relative to the project root.
_SKIP_TOPLEVEL = frozenset({"widget-build", ".widget-build"})

# Historian state files that are installation-local and should not travel with
# a pushed/exported project. Matched by suffix anywhere under ``historian/``.
# Note: this only strips data files (SQLite databases, journals); historian
# configuration (``config.json``) must still ship so the receiver knows which
# variables to log, what retention to apply, etc.
_HISTORIAN_LOCAL_SUFFIXES = (
    ".db",
    ".db-wal",
    ".db-shm",
    ".sqlite",
    ".sqlite-journal",
)


class UnsafeArchiveError(Exception):
    """Archive member would escape the destination, exceed limits, or break safety rules."""


def safe_filename(name: str) -> str:
    """ASCII-safe slice of ``name`` for Content-Disposition; never empty."""
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in name)
    cleaned = cleaned.strip("-") or "project"
    return cleaned[:120]


def max_zip_bytes() -> int:
    raw = os.environ.get("NEXTHMI_MAX_PROJECT_ZIP_MB")
    try:
        mb = int(raw) if raw else DEFAULT_MAX_ZIP_MB
    except ValueError:
        mb = DEFAULT_MAX_ZIP_MB
    return max(1, mb) * 1024 * 1024


# ── pack ─────────────────────────────────────────────────────────────────────


def _iter_pack_files(project_root: Path) -> Iterable[Path]:
    """Walk the project tree, pruning ``widget-build/`` and skipping symlinks."""
    for root, dirs, files in os.walk(project_root, followlinks=False):
        root_path = Path(root)
        rel_root = root_path.relative_to(project_root)
        if rel_root == Path("."):
            dirs[:] = [d for d in dirs if d not in _SKIP_TOPLEVEL]
        # Skip descending into symlinked subdirs (followlinks=False already
        # prevents traversal, but we want to omit the link entry itself).
        dirs[:] = [d for d in dirs if not (root_path / d).is_symlink()]
        in_historian = rel_root.parts[:1] == ("historian",)
        for fname in files:
            file_path = root_path / fname
            if file_path.is_symlink():
                continue
            if in_historian and fname.endswith(_HISTORIAN_LOCAL_SUFFIXES):
                continue
            yield file_path


def pack_project(
    project_root: Path,
    output: BinaryIO,
    progress: ProgressCallback | None = None,
) -> None:
    """Stream the project tree into ``output`` as a zip.

    ``ensure_project_metadata`` is called first so a never-registered project
    still ships with a stable id. Skips ``widget-build/`` and symlinks.
    """
    if not project_root.is_dir():
        raise FileNotFoundError(f"Project root does not exist: {project_root}")

    ensure_project_metadata(project_root)

    files = sorted(_iter_pack_files(project_root))
    total_bytes = sum(f.stat().st_size for f in files)
    bytes_done = 0
    if progress:
        progress(bytes_done, total_bytes)

    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for file_path in files:
            rel = file_path.relative_to(project_root)
            arcname = rel.as_posix()
            info = zipfile.ZipInfo.from_file(str(file_path), arcname=arcname)
            info.compress_type = zipfile.ZIP_DEFLATED
            with file_path.open("rb") as src, zf.open(info, "w", force_zip64=True) as dst:
                while True:
                    chunk = src.read(_CHUNK)
                    if not chunk:
                        break
                    dst.write(chunk)
                    bytes_done += len(chunk)
                    if progress:
                        progress(bytes_done, total_bytes)

    if progress:
        progress(bytes_done, total_bytes)


# ── unpack ───────────────────────────────────────────────────────────────────


def _is_symlink_member(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    return stat.S_ISLNK(mode)


def _safe_extract_path(destination_resolved: Path, member_name: str) -> Path:
    """Resolve ``member_name`` against ``destination``, rejecting escapes."""
    if not member_name:
        raise UnsafeArchiveError("Empty member name in archive")
    if member_name.startswith(("/", "\\")):
        raise UnsafeArchiveError(f"Absolute path in archive: {member_name!r}")
    if len(member_name) >= 2 and member_name[1] == ":":
        raise UnsafeArchiveError(f"Drive-letter path in archive: {member_name!r}")
    candidate = (destination_resolved / member_name).resolve()
    if candidate != destination_resolved and not candidate.is_relative_to(destination_resolved):
        raise UnsafeArchiveError(f"Path traversal in archive: {member_name!r}")
    return candidate


def unpack_project(
    source: BinaryIO,
    destination: Path,
    progress: ProgressCallback | None = None,
) -> ProjectMetadata:
    """Stream ``source`` into ``destination``.

    The destination is created if missing. Raises ``UnsafeArchiveError`` on
    path traversal, symlink members, or size cap exceeded. Returns the parsed
    project metadata after extraction; raises if the archive's
    ``config.json`` lacks a ``project`` block.
    """
    destination.mkdir(parents=True, exist_ok=True)
    destination_resolved = destination.resolve()
    max_bytes = max_zip_bytes()

    with zipfile.ZipFile(source, "r") as zf:
        infos = zf.infolist()

        total_uncompressed = 0
        for info in infos:
            if _is_symlink_member(info):
                raise UnsafeArchiveError(
                    f"Archive contains a symlink member ({info.filename!r}); refusing.",
                )
            total_uncompressed += info.file_size
            if total_uncompressed > max_bytes:
                raise UnsafeArchiveError(
                    f"Archive exceeds size cap ({max_bytes // (1024 * 1024)} MB).",
                )

        bytes_done = 0
        if progress:
            progress(bytes_done, total_uncompressed)

        for info in infos:
            if info.is_dir():
                _safe_extract_path(destination_resolved, info.filename)
                continue
            target = _safe_extract_path(destination_resolved, info.filename)
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info, "r") as src, target.open("wb") as dst:
                while True:
                    chunk = src.read(_CHUNK)
                    if not chunk:
                        break
                    dst.write(chunk)
                    bytes_done += len(chunk)
                    if progress:
                        progress(bytes_done, total_uncompressed)
            mode = (info.external_attr >> 16) & 0o777
            if mode:
                with contextlib.suppress(OSError):
                    os.chmod(target, mode)

        if progress:
            progress(bytes_done, total_uncompressed)

    metadata = read_project_metadata(destination)
    if metadata is None:
        raise UnsafeArchiveError(
            f"Unpacked archive at {destination} has no project metadata "
            f"(missing or empty `project` block in {PROJECT_CONFIG_FILENAME}).",
        )
    try:
        violations = scan_project_component_bindings(destination)
    except ComponentScanError as exc:
        raise UnsafeArchiveError(
            f"Imported project contains an invalid reusable component at {exc}."
        ) from exc
    if violations:
        violation = violations[0]
        raise UnsafeArchiveError(
            "Imported project contains a reusable-component direct variable binding "
            f"at {violation.file}#{violation.source_path}; use $componentProp instead."
        )
    return metadata
