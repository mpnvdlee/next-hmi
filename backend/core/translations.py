from __future__ import annotations

import hashlib
import os
import tempfile
import threading
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from core.exceptions import ConfigConflictError, ConfigValidationError

TranslationRows = dict[str, dict[str, str]]
EMPTY_DICTIONARY_MESSAGE = "dictionary needs at least one language column"

_lock_registry_guard = threading.Lock()
_local_locks: dict[Path, threading.RLock] = {}
_thread_state = threading.local()


@dataclass
class _HeldTranslationLock:
    handle: BinaryIO
    depth: int = 1


def _translation_lock_path(path: Path) -> Path:
    identity = str(path.resolve()).encode("utf-8")
    digest = hashlib.sha256(identity).hexdigest()
    return Path(tempfile.gettempdir()) / "nexthmi-translation-locks" / f"{digest}.lock"


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
    raise OSError(f"Cross-process translation locking is unsupported on {os.name}")


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
    raise OSError(f"Cross-process translation locking is unsupported on {os.name}")


@contextmanager
def translation_transaction(path: Path) -> Iterator[None]:
    resolved_path = path.resolve()
    with _lock_registry_guard:
        local_lock = _local_locks.setdefault(resolved_path, threading.RLock())

    with local_lock:
        held_locks: dict[Path, _HeldTranslationLock] = getattr(
            _thread_state, "held_locks", {}
        )
        _thread_state.held_locks = held_locks
        held = held_locks.get(resolved_path)
        if held is not None:
            held.depth += 1
            try:
                yield
            finally:
                held.depth -= 1
            return

        lock_path = _translation_lock_path(resolved_path)
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = lock_path.open("a+b")
        try:
            _acquire_file_lock(handle)
            held_locks[resolved_path] = _HeldTranslationLock(handle=handle)
            try:
                yield
            finally:
                held_locks.pop(resolved_path, None)
                _release_file_lock(handle)
        finally:
            handle.close()


def translation_revision(path: Path) -> str:
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return "missing"
    return hashlib.sha256(raw).hexdigest()


def translation_payload(rows: Sequence[Sequence[str]], path: Path) -> dict:
    return {**parse_translation_rows(rows), "revision": translation_revision(path)}


def parse_translation_rows(rows: Sequence[Sequence[str]]) -> dict:
    if not rows:
        raise ConfigValidationError(EMPTY_DICTIONARY_MESSAGE)

    codes = list(rows[0])
    _validate_codes(codes)

    translations: TranslationRows = {}
    for index, source_row in enumerate(rows[1:], start=1):
        row = list(source_row)
        key = row[0] if row else ""
        if not key.strip():
            raise ConfigValidationError(f"translation row {index} has an empty key")
        if key in translations:
            raise ConfigConflictError(f"duplicate translation key '{key}'")
        if len(row) > len(codes):
            raise ConfigValidationError(
                f"translation row {index} has more values than language columns"
            )
        translations[key] = {
            code: (row[column] if column < len(row) else "")
            for column, code in enumerate(codes)
        }

    return {
        "languages": [{"code": code} for code in codes],
        "rows": translations,
    }


def build_translation_rows(
    codes: Sequence[str],
    translations: Mapping[str, object],
    *,
    existing_rows: Sequence[Sequence[str]] | None = None,
) -> list[list[str]]:
    normalized_codes = list(codes)
    _validate_codes(normalized_codes)

    existing = parse_translation_rows(existing_rows) if existing_rows is not None else None
    if existing is not None and existing["languages"]:
        existing_codes = [language["code"] for language in existing["languages"]]
        if normalized_codes[0] != existing_codes[0]:
            raise ConfigValidationError(
                "the primary language column cannot be removed, moved, or renamed"
            )
        existing_keys = set(existing["rows"])
        submitted_keys = set(translations)
        if submitted_keys != existing_keys:
            raise ConfigValidationError(
                "translation keys are immutable; add or delete rows through their dedicated endpoint"
            )

    csv_rows: list[list[str]] = [normalized_codes]
    allowed_codes = set(normalized_codes)
    removed_secondary_codes: set[str] = set()
    if existing is not None and existing["languages"]:
        removed_secondary_codes = {
            language["code"] for language in existing["languages"][1:]
        } - allowed_codes
    primary_code = normalized_codes[0]
    for key, values in translations.items():
        if not isinstance(key, str) or not key.strip():
            raise ConfigValidationError("translation keys must be non-empty strings")
        if not isinstance(values, Mapping):
            raise ConfigValidationError(f"translation '{key}' must be an object")
        if any(not isinstance(code, str) for code in values):
            raise ConfigValidationError(f"translation '{key}' language codes must be strings")
        unknown_codes = set(values) - allowed_codes - removed_secondary_codes
        if unknown_codes:
            unknown = sorted(unknown_codes)[0]
            raise ConfigValidationError(
                f"translation '{key}' contains unknown language '{unknown}'"
            )
        if any(not isinstance(value, str) for value in values.values()):
            raise ConfigValidationError(f"translation '{key}' values must be strings")
        primary_value = values.get(primary_code, key)
        if primary_value != key:
            raise ConfigValidationError(
                f"translation key '{key}' cannot be changed through its primary-language value"
            )
        csv_rows.append([key, *(values.get(code, "") for code in normalized_codes[1:])])

    return csv_rows


def _validate_codes(codes: Sequence[str]) -> None:
    if not codes:
        raise ConfigValidationError("at least one language is required")
    seen: set[str] = set()
    for index, code in enumerate(codes):
        if not isinstance(code, str) or not code.strip():
            raise ConfigValidationError(
                f"languages[{index}].code must be a non-empty string"
            )
        if code in seen:
            raise ConfigValidationError(f"duplicate language code '{code}'")
        seen.add(code)
