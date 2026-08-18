"""Race-safe, project-bound mutations for reusable-component storage."""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import stat
import tempfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Any

from core.component_validation import (
    ComponentScanError,
    FileIdentity,
    ProjectComponentScan,
)

BOUND_MUTATION_HOOK: Callable[[str], None] | None = None


class _WindowsApi:
    FILE_SHARE_READ = 0x00000001
    FILE_SHARE_WRITE = 0x00000002
    FILE_READ_ATTRIBUTES = 0x00000080
    DELETE = 0x00010000
    OPEN_EXISTING = 3
    FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
    FILE_DISPOSITION_DELETE = 0x00000001
    FILE_DISPOSITION_POSIX_SEMANTICS = 0x00000002
    FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE = 0x00000010
    FILE_DISPOSITION_INFO = 4
    FILE_DISPOSITION_INFO_EX = 21

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        class ByHandleFileInformation(ctypes.Structure):
            _fields_ = [
                ("dwFileAttributes", wintypes.DWORD),
                ("ftCreationTime", wintypes.FILETIME),
                ("ftLastAccessTime", wintypes.FILETIME),
                ("ftLastWriteTime", wintypes.FILETIME),
                ("dwVolumeSerialNumber", wintypes.DWORD),
                ("nFileSizeHigh", wintypes.DWORD),
                ("nFileSizeLow", wintypes.DWORD),
                ("nNumberOfLinks", wintypes.DWORD),
                ("nFileIndexHigh", wintypes.DWORD),
                ("nFileIndexLow", wintypes.DWORD),
            ]

        class FileDispositionInfo(ctypes.Structure):
            _fields_ = [("DeleteFile", wintypes.BOOL)]

        class FileDispositionInfoEx(ctypes.Structure):
            _fields_ = [("Flags", wintypes.DWORD)]

        self._ctypes = ctypes
        self._info_type = ByHandleFileInformation
        self._disposition_type = FileDispositionInfo
        self._disposition_ex_type = FileDispositionInfoEx
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._create = kernel32.CreateFileW
        self._create.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        ]
        self._create.restype = wintypes.HANDLE
        self._get_info = kernel32.GetFileInformationByHandle
        self._get_info.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(ByHandleFileInformation),
        ]
        self._get_info.restype = wintypes.BOOL
        self._close = kernel32.CloseHandle
        self._close.argtypes = [wintypes.HANDLE]
        self._close.restype = wintypes.BOOL
        self._set_info = kernel32.SetFileInformationByHandle
        self._set_info.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
        ]
        self._set_info.restype = wintypes.BOOL
        self._invalid = wintypes.HANDLE(-1).value

    def open_directory(self, path: Path) -> int:
        handle = self._create(
            str(path),
            self.FILE_READ_ATTRIBUTES,
            self.FILE_SHARE_READ | self.FILE_SHARE_WRITE,
            None,
            self.OPEN_EXISTING,
            self.FILE_FLAG_OPEN_REPARSE_POINT | self.FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
        if handle == self._invalid:
            raise OSError(self._ctypes.get_last_error(), f"cannot pin directory {path}")
        return handle

    def directory_info(self, handle: int) -> tuple[bool, tuple[int, int]]:
        info = self._info_type()
        if not self._get_info(handle, self._ctypes.byref(info)):
            raise OSError(
                self._ctypes.get_last_error(), "cannot inspect pinned directory"
            )
        file_index = (info.nFileIndexHigh << 32) | info.nFileIndexLow
        return (
            bool(info.dwFileAttributes & self.FILE_ATTRIBUTE_REPARSE_POINT),
            (info.dwVolumeSerialNumber, file_index),
        )

    def open_for_delete(self, path: Path, *, directory: bool) -> int:
        flags = self.FILE_FLAG_OPEN_REPARSE_POINT
        if directory:
            flags |= self.FILE_FLAG_BACKUP_SEMANTICS
        handle = self._create(
            str(path),
            self.FILE_READ_ATTRIBUTES | self.DELETE,
            self.FILE_SHARE_READ | self.FILE_SHARE_WRITE,
            None,
            self.OPEN_EXISTING,
            flags,
            None,
        )
        if handle == self._invalid:
            raise OSError(self._ctypes.get_last_error(), f"cannot pin entry {path}")
        return handle

    def mark_delete(self, handle: int) -> None:
        extended = self._disposition_ex_type()
        extended.Flags = (
            self.FILE_DISPOSITION_DELETE
            | self.FILE_DISPOSITION_POSIX_SEMANTICS
            | self.FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE
        )
        if self._set_info(
            handle,
            self.FILE_DISPOSITION_INFO_EX,
            self._ctypes.byref(extended),
            self._ctypes.sizeof(extended),
        ):
            return
        extended_error = self._ctypes.get_last_error()
        if extended_error not in {50, 87, 120}:
            raise OSError(extended_error, "cannot mark component entry for deletion")
        fallback = self._disposition_type()
        fallback.DeleteFile = True
        if not self._set_info(
            handle,
            self.FILE_DISPOSITION_INFO,
            self._ctypes.byref(fallback),
            self._ctypes.sizeof(fallback),
        ):
            raise OSError(
                self._ctypes.get_last_error(),
                "secure handle-based component deletion is unsupported",
            )

    def close(self, handle: int) -> None:
        self._close(handle)


class _WindowsDirectoryPin:
    """CreateFileW pin that deliberately omits FILE_SHARE_DELETE."""

    def __init__(self, path: Path, expected: tuple[int, int, int], api: Any) -> None:
        self.path = path
        self.expected = expected
        self.api = api
        self.handle: int | None = None
        self.handle_identity: tuple[int, int] | None = None

    def open(self) -> None:
        before = self.path.lstat()
        if _directory_identity(before) != self.expected:
            raise ComponentScanError(
                self.path.as_posix(), "/", "component directory changed after scan"
            )
        handle = self.api.open_directory(self.path)
        try:
            self.handle = handle
            reparse, self.handle_identity = self.api.directory_info(handle)
            if reparse:
                raise ComponentScanError(
                    self.path.as_posix(),
                    "/",
                    "component directory changed after scan",
                )
            self.verify()
        except Exception:
            self.api.close(handle)
            self.handle = None
            raise

    def verify(self) -> None:
        if self.handle is None:
            raise RuntimeError("directory pin is not open")
        reparse, handle_identity = self.api.directory_info(self.handle)
        after = self.path.lstat()
        if (
            reparse
            or _directory_identity(after) != self.expected
            or handle_identity != self.handle_identity
        ):
            raise ComponentScanError(
                self.path.as_posix(),
                "/",
                "component directory changed after scan",
            )

    def close(self) -> None:
        if self.handle is not None:
            self.api.close(self.handle)
            self.handle = None
            self.handle_identity = None


class _WindowsBoundStorage:
    def __init__(self, project_root: Path, scan: ProjectComponentScan) -> None:
        self.project_root = project_root
        self.scan = scan
        self.identities = dict(scan.directory_identities)
        self.api = _WindowsApi()
        self.root_pin: _WindowsDirectoryPin | None = None

    def open(self) -> None:
        expected = self.identities.get("components")
        if expected is None:
            raise ComponentScanError(
                "components", "/", "component storage changed after scan"
            )
        self.root_pin = _WindowsDirectoryPin(
            self.project_root / "components", expected, self.api
        )
        self.root_pin.open()

    def close(self) -> None:
        if self.root_pin is not None:
            self.root_pin.close()
            self.root_pin = None

    def _pin_directories(
        self, parts: tuple[str, ...], *, create: bool
    ) -> list[_WindowsDirectoryPin]:
        pins: list[_WindowsDirectoryPin] = []
        current = self.project_root / "components"
        relative = "components"
        try:
            for part in parts:
                current = current / part
                relative = f"{relative}/{part}"
                if not current.exists():
                    if not create:
                        raise FileNotFoundError(current)
                    current.mkdir()
                    self.identities[relative] = _directory_identity(current.lstat())
                expected = self.identities.get(relative)
                if expected is None:
                    expected = _directory_identity(current.lstat())
                    self.identities[relative] = expected
                pin = _WindowsDirectoryPin(current, expected, self.api)
                pin.open()
                pins.append(pin)
            return pins
        except Exception:
            for pin in reversed(pins):
                pin.close()
            raise

    @staticmethod
    def _close_pins(pins: list[_WindowsDirectoryPin]) -> None:
        for pin in reversed(pins):
            pin.close()

    def _verify_pins(self, pins: list[_WindowsDirectoryPin]) -> None:
        for pin in pins:
            pin.verify()
        if self.root_pin is not None:
            self.root_pin.verify()

    def atomic_write_json(
        self,
        relative_path: str,
        data: dict[str, Any],
        *,
        operation: str,
        expected_identity: FileIdentity | None,
        create_parents: bool,
    ) -> None:
        parts = _parts(relative_path)
        pins = self._pin_directories(parts[:-1], create=create_parents)
        target = self.project_root / "components" / Path(*parts)
        temp_path: Path | None = None
        try:
            if BOUND_MUTATION_HOOK is not None:
                BOUND_MUTATION_HOOK(operation)
            try:
                current = target.lstat()
            except FileNotFoundError:
                current = None
            if expected_identity is None:
                if current is not None:
                    raise FileExistsError(target)
            elif current is None or _file_identity(current) != expected_identity:
                raise ComponentScanError(
                    relative_path, "/", "component file changed after scan"
                )
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                suffix=".tmp",
                prefix=f"{target.name}.",
                dir=target.parent,
                delete=False,
            ) as handle:
                json.dump(data, handle, indent=2, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
                temp_path = Path(handle.name)
            os.replace(temp_path, target)
            temp_path = None
            self._verify_pins(pins)
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
            self._close_pins(pins)

    def unlink_file(
        self,
        relative_path: str,
        *,
        operation: str,
        expected_identity: FileIdentity,
    ) -> None:
        parts = _parts(relative_path)
        pins = self._pin_directories(parts[:-1], create=False)
        target = self.project_root / "components" / Path(*parts)
        try:
            if BOUND_MUTATION_HOOK is not None:
                BOUND_MUTATION_HOOK(operation)
            current = target.lstat()
            if _file_identity(current) != expected_identity:
                raise ComponentScanError(
                    relative_path, "/", "component file changed after scan"
                )
            self._delete_tree_by_handle(target, relative_path)
            self._verify_pins(pins)
        finally:
            self._close_pins(pins)

    def create_directory(self, relative_path: str, *, operation: str) -> None:
        parts = _parts(relative_path)
        pins = self._pin_directories(parts[:-1], create=True)
        target = self.project_root / "components" / Path(*parts)
        try:
            if BOUND_MUTATION_HOOK is not None:
                BOUND_MUTATION_HOOK(operation)
            target.mkdir()
            self._verify_pins(pins)
        finally:
            self._close_pins(pins)

    def _delete_tree_by_handle(self, path: Path, relative_path: str) -> None:
        before = path.lstat()
        if stat.S_ISLNK(before.st_mode) or bool(
            getattr(before, "st_file_attributes", 0)
            & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        ):
            raise ComponentScanError(
                relative_path,
                "/",
                "component path changed to a symlink or reparse point",
            )
        directory = stat.S_ISDIR(before.st_mode)
        if not directory and not stat.S_ISREG(before.st_mode):
            raise ComponentScanError(
                relative_path, "/", "unsupported component filesystem entry"
            )
        handle = self.api.open_for_delete(path, directory=directory)
        marked = False
        try:
            reparse, handle_identity = self.api.directory_info(handle)
            after = path.lstat()
            if reparse or _file_identity(before) != _file_identity(after):
                raise ComponentScanError(
                    relative_path, "/", "component path changed during deletion"
                )
            if directory:
                for child in sorted(path.iterdir(), key=lambda item: item.name):
                    self._delete_tree_by_handle(child, f"{relative_path}/{child.name}")
            reparse_after, identity_after = self.api.directory_info(handle)
            if reparse_after or identity_after != handle_identity:
                raise ComponentScanError(
                    relative_path, "/", "component path changed during deletion"
                )
            self.api.mark_delete(handle)
            marked = True
        except OSError as exc:
            raise ComponentScanError(
                relative_path,
                "/",
                "secure handle-based component deletion is unsupported",
            ) from exc
        finally:
            self.api.close(handle)
        if not marked:
            raise ComponentScanError(
                relative_path, "/", "component deletion was not committed"
            )

    def delete_directory(self, relative_path: str, *, operation: str) -> None:
        parts = _parts(relative_path)
        pins = self._pin_directories(parts[:-1], create=False)
        target = self.project_root / "components" / Path(*parts)
        try:
            if BOUND_MUTATION_HOOK is not None:
                BOUND_MUTATION_HOOK(operation)
            self._delete_tree_by_handle(target, relative_path)
            self._verify_pins(pins)
        finally:
            self._close_pins(pins)


def _file_identity(value: os.stat_result) -> FileIdentity:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_size,
        value.st_mtime_ns,
    )


def _directory_identity(value: os.stat_result) -> tuple[int, int, int]:
    return (value.st_dev, value.st_ino, value.st_mode)


def _parts(relative_path: str) -> tuple[str, ...]:
    path = PurePosixPath(relative_path)
    if (
        path.is_absolute()
        or not path.parts
        or path.parts[0] != "components"
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise ComponentScanError(relative_path, "/", "unsafe component path")
    return path.parts[1:]


class BoundComponentStorage:
    """Mutate only through directory handles bound to a validated scan."""

    def __init__(self, project_root: Path, scan: ProjectComponentScan) -> None:
        self.project_root = project_root
        self.scan = scan
        self._root_fd: int | None = None
        self._windows: _WindowsBoundStorage | None = None
        self._directory_identities = dict(scan.directory_identities)

    def __enter__(self) -> BoundComponentStorage:
        if os.name == "nt":
            self._windows = _WindowsBoundStorage(self.project_root, self.scan)
            self._windows.open()
            return self
        required = ("O_DIRECTORY", "O_NOFOLLOW")
        if any(not hasattr(os, name) for name in required):
            raise ComponentScanError(
                "components",
                "/",
                "secure bound component mutations are unavailable on this platform",
            )
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        try:
            descriptor = os.open(self.project_root / "components", flags)
        except OSError as exc:
            raise ComponentScanError(
                "components", "/", "component storage changed after scan"
            ) from exc
        opened = os.fstat(descriptor)
        if self.scan.root_identity != _directory_identity(opened):
            os.close(descriptor)
            raise ComponentScanError(
                "components", "/", "component storage changed after scan"
            )
        self._root_fd = descriptor
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._windows is not None:
            self._windows.close()
            self._windows = None
            return
        if self._root_fd is not None:
            os.close(self._root_fd)
            self._root_fd = None

    def _hook(self, operation: str) -> None:
        if BOUND_MUTATION_HOOK is not None:
            BOUND_MUTATION_HOOK(operation)

    def _root(self) -> int:
        if self._root_fd is None:
            raise RuntimeError("bound component storage is not open")
        return self._root_fd

    def _open_directory(
        self,
        parts: tuple[str, ...],
        *,
        create: bool = False,
    ) -> tuple[int, list[int]]:
        current = self._root()
        opened: list[int] = []
        relative_parts = ["components"]
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        try:
            for part in parts:
                relative_parts.append(part)
                relative = "/".join(relative_parts)
                try:
                    child = os.open(part, flags, dir_fd=current)
                except FileNotFoundError:
                    if not create:
                        raise
                    os.mkdir(part, dir_fd=current)
                    child = os.open(part, flags, dir_fd=current)
                identity = self._directory_identities.get(relative)
                if (
                    identity is not None
                    and _directory_identity(os.fstat(child)) != identity
                ):
                    os.close(child)
                    raise ComponentScanError(
                        relative, "/", "component directory changed after scan"
                    )
                opened.append(child)
                current = child
            return current, opened
        except Exception:
            for descriptor in reversed(opened):
                os.close(descriptor)
            raise

    @staticmethod
    def _close_opened(opened: list[int]) -> None:
        for descriptor in reversed(opened):
            os.close(descriptor)

    @staticmethod
    def _target_stat(parent_fd: int, name: str) -> os.stat_result | None:
        try:
            return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return None

    def atomic_write_json(
        self,
        relative_path: str,
        data: dict[str, Any],
        *,
        operation: str,
        expected_identity: FileIdentity | None,
        create_parents: bool,
    ) -> None:
        if self._windows is not None:
            self._windows.atomic_write_json(
                relative_path,
                data,
                operation=operation,
                expected_identity=expected_identity,
                create_parents=create_parents,
            )
            return
        parts = _parts(relative_path)
        if not parts:
            raise ComponentScanError(relative_path, "/", "component file path is empty")
        parent_fd, opened = self._open_directory(parts[:-1], create=create_parents)
        name = parts[-1]
        temp_name = f".{name}.{secrets.token_hex(8)}.tmp"
        temp_created = False
        try:
            self._hook(operation)
            current = self._target_stat(parent_fd, name)
            if expected_identity is None:
                if current is not None:
                    raise FileExistsError(name)
            elif current is None or _file_identity(current) != expected_identity:
                raise ComponentScanError(
                    relative_path, "/", "component file changed after scan"
                )
            payload = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
            descriptor = os.open(
                temp_name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
                dir_fd=parent_fd,
            )
            temp_created = True
            try:
                view = memoryview(payload)
                while view:
                    written = os.write(descriptor, view)
                    view = view[written:]
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            os.replace(
                temp_name,
                name,
                src_dir_fd=parent_fd,
                dst_dir_fd=parent_fd,
            )
            temp_created = False
            os.fsync(parent_fd)
        finally:
            if temp_created:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(temp_name, dir_fd=parent_fd)
            self._close_opened(opened)

    def unlink_file(
        self,
        relative_path: str,
        *,
        operation: str,
        expected_identity: FileIdentity,
    ) -> None:
        if self._windows is not None:
            self._windows.unlink_file(
                relative_path,
                operation=operation,
                expected_identity=expected_identity,
            )
            return
        parts = _parts(relative_path)
        parent_fd, opened = self._open_directory(parts[:-1])
        try:
            self._hook(operation)
            current = self._target_stat(parent_fd, parts[-1])
            if current is None or _file_identity(current) != expected_identity:
                raise ComponentScanError(
                    relative_path, "/", "component file changed after scan"
                )
            os.unlink(parts[-1], dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            self._close_opened(opened)

    def create_directory(self, relative_path: str, *, operation: str) -> None:
        if self._windows is not None:
            self._windows.create_directory(relative_path, operation=operation)
            return
        parts = _parts(relative_path)
        if not parts:
            raise FileExistsError("components")
        parent_fd, opened = self._open_directory(parts[:-1], create=True)
        try:
            self._hook(operation)
            os.mkdir(parts[-1], dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            self._close_opened(opened)

    def _remove_tree(self, directory_fd: int, relative_path: str) -> None:
        for name in sorted(os.listdir(directory_fd)):
            current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            child_relative = f"{relative_path}/{name}"
            if stat.S_ISLNK(current.st_mode):
                raise ComponentScanError(
                    child_relative, "/", "component path changed to a symlink"
                )
            if stat.S_ISDIR(current.st_mode):
                flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                child_fd = os.open(name, flags, dir_fd=directory_fd)
                try:
                    self._remove_tree(child_fd, child_relative)
                finally:
                    os.close(child_fd)
                os.rmdir(name, dir_fd=directory_fd)
            elif stat.S_ISREG(current.st_mode):
                os.unlink(name, dir_fd=directory_fd)
            else:
                raise ComponentScanError(
                    child_relative, "/", "unsupported component filesystem entry"
                )

    def delete_directory(self, relative_path: str, *, operation: str) -> None:
        if self._windows is not None:
            self._windows.delete_directory(relative_path, operation=operation)
            return
        parts = _parts(relative_path)
        if not parts:
            raise ComponentScanError(relative_path, "/", "cannot delete component root")
        parent_fd, parent_opened = self._open_directory(parts[:-1])
        target_fd: int | None = None
        try:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            target_fd = os.open(parts[-1], flags, dir_fd=parent_fd)
            expected = self._directory_identities.get(relative_path)
            if expected is None or _directory_identity(os.fstat(target_fd)) != expected:
                raise ComponentScanError(
                    relative_path, "/", "component directory changed after scan"
                )
            self._hook(operation)
            self._remove_tree(target_fd, relative_path)
            os.close(target_fd)
            target_fd = None
            os.rmdir(parts[-1], dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            if target_fd is not None:
                os.close(target_fd)
            self._close_opened(parent_opened)
