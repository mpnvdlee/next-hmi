"""RFC 6901 JSON Pointer primitives used by MCP write tools and the diff
emitter.

``set_value`` lazy-creates intermediate dicts and lists so a pointer that
descends into a not-yet-existing branch (e.g. ``/style/backgroundColor``
on a widget that has no ``style`` map yet) just works.
"""

from __future__ import annotations

from typing import Any

from core.exceptions import ConfigValidationError


def escape_token(token: str) -> str:
    """Escape a single reference token per RFC 6901 §4."""
    return token.replace("~", "~0").replace("/", "~1")


def unescape_token(token: str) -> str:
    return token.replace("~1", "/").replace("~0", "~")


def split(pointer: str) -> list[str]:
    """Split a JSON Pointer into unescaped reference tokens.

    Raises ``ConfigValidationError`` for the empty / root pointer since the
    callers in this codebase always address a specific field.
    """
    if not pointer or pointer == "/":
        raise ConfigValidationError("JSON Pointer must address a field")
    parts = pointer.lstrip("/").split("/")
    return [unescape_token(p) for p in parts]


_MAX_LIST_INDEX = 10_000
# Maximum positions an index may extend a list past its current length on a
# single write. Pointer set ops on widget property arrays should always
# address an existing slot or the immediate next one — extending by hundreds
# of slots (let alone tens of thousands) would be an agent error and a
# memory-allocation hazard. Set just high enough to tolerate a handful of
# off-by-one writes while still rejecting `len(list) → 10000` jumps.
_MAX_LIST_SPARSE_GROWTH = 16


def _parse_index(raw_part: str) -> int:
    """Parse a JSON Pointer list-index token (RFC 6901 §4): digits only, no leading '-'."""
    if not raw_part or not raw_part.isdigit():
        raise ConfigValidationError(
            f"JSON Pointer expected non-negative list index, got '{raw_part}'"
        )
    idx = int(raw_part)
    if idx > _MAX_LIST_INDEX:
        raise ConfigValidationError(
            f"JSON Pointer list index {idx} exceeds maximum {_MAX_LIST_INDEX}"
        )
    return idx


def set_value(root: Any, parts: list[str], value: Any) -> None:
    """Set ``value`` at the path described by ``parts`` inside ``root``.

    Lazy-creates intermediate dicts (or lists, when the next token is a
    numeric index). The walk decides container type by peeking at the next
    token: ``"0"`` → list, anything else → dict.
    """
    if not parts:
        raise ConfigValidationError("JSON Pointer must address a field")
    cursor: Any = root
    for i, raw_part in enumerate(parts):
        is_last = i == len(parts) - 1
        if isinstance(cursor, list):
            idx = _parse_index(raw_part)
            if idx > len(cursor) + _MAX_LIST_SPARSE_GROWTH:
                raise ConfigValidationError(
                    f"JSON Pointer list index {idx} sparsely extends a length-"
                    f"{len(cursor)} list by more than {_MAX_LIST_SPARSE_GROWTH}"
                )
            while len(cursor) <= idx:
                cursor.append(None)
            if is_last:
                cursor[idx] = value
            else:
                if cursor[idx] is None:
                    next_part = parts[i + 1]
                    cursor[idx] = [] if next_part.isdigit() else {}
                cursor = cursor[idx]
        elif isinstance(cursor, dict):
            if is_last:
                cursor[raw_part] = value
            else:
                if raw_part not in cursor:
                    next_part = parts[i + 1]
                    cursor[raw_part] = [] if next_part.isdigit() else {}
                cursor = cursor[raw_part]
        else:
            raise ConfigValidationError(
                f"JSON Pointer attempted to descend into non-container at '{raw_part}'"
            )
