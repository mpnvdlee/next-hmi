from __future__ import annotations

import json
from typing import Any

from .json_pointer import escape_token

DIFF_CAP_BYTES = 32 * 1024


def _ptr(parts: list[str]) -> str:
    return "" if not parts else "/" + "/".join(escape_token(p) for p in parts)


class _Truncated(Exception):
    """Raised internally to abort the walk once the byte budget is exhausted.

    Keeps deep walks from continuing to allocate ops once we know the result
    will be replaced by the truncation sentinel.
    """


def _emit(ops: list[dict], op: dict, budget: list[int]) -> None:
    # Approximate the serialized cost: the op itself plus a ',' separator if
    # it's not the first op. `[...]` brackets are ~2 bytes and we ignore them.
    op_size = len(json.dumps(op, separators=(",", ":")).encode("utf-8"))
    if ops:
        op_size += 1  # comma separator
    budget[0] -= op_size
    if budget[0] < 0:
        raise _Truncated
    ops.append(op)


def _walk(before: Any, after: Any, parts: list[str], ops: list[dict], budget: list[int]) -> None:
    if before == after:
        return
    if isinstance(before, dict) and isinstance(after, dict):
        before_keys = set(before.keys())
        after_keys = set(after.keys())
        for k in sorted(before_keys - after_keys):
            parts.append(k)
            try:
                _emit(ops, {"op": "remove", "path": _ptr(parts)}, budget)
            finally:
                parts.pop()
        for k in sorted(after_keys - before_keys):
            parts.append(k)
            try:
                _emit(ops, {"op": "add", "path": _ptr(parts), "value": after[k]}, budget)
            finally:
                parts.pop()
        for k in sorted(before_keys & after_keys):
            parts.append(k)
            try:
                _walk(before[k], after[k], parts, ops, budget)
            finally:
                parts.pop()
        return
    if isinstance(before, list) and isinstance(after, list):
        common = min(len(before), len(after))
        for i in range(common):
            parts.append(str(i))
            try:
                _walk(before[i], after[i], parts, ops, budget)
            finally:
                parts.pop()
        if len(after) > len(before):
            parts.append("-")
            try:
                for i in range(common, len(after)):
                    _emit(ops, {"op": "add", "path": _ptr(parts), "value": after[i]}, budget)
            finally:
                parts.pop()
        elif len(before) > len(after):
            for i in range(len(before) - 1, common - 1, -1):
                parts.append(str(i))
                try:
                    _emit(ops, {"op": "remove", "path": _ptr(parts)}, budget)
                finally:
                    parts.pop()
        return
    _emit(ops, {"op": "replace", "path": _ptr(parts), "value": after}, budget)


def make_diff(before: Any, after: Any) -> list[dict] | dict[str, Any]:
    ops: list[dict] = []
    budget = [DIFF_CAP_BYTES]
    try:
        _walk(before, after, [], ops, budget)
    except _Truncated:
        return {"truncated": True, "reason": "patch_too_large", "op_count": len(ops)}
    return ops
