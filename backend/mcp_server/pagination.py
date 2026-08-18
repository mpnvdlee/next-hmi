from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import TypeVar

DEFAULT_LIMIT = 100
MAX_LIMIT = 500

T = TypeVar("T")


class CursorError(ValueError):
    pass


def encode_cursor(sort_key: str, item_id: str) -> str:
    payload = json.dumps({"k": sort_key, "i": item_id}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def decode_cursor(token: str) -> tuple[str, str]:
    try:
        payload = base64.urlsafe_b64decode(token.encode("ascii"))
        obj = json.loads(payload)
    except Exception as exc:
        raise CursorError(f"malformed cursor: {exc}") from exc
    if not isinstance(obj, dict) or "k" not in obj or "i" not in obj:
        raise CursorError("malformed cursor: missing fields")
    return str(obj["k"]), str(obj["i"])


def clamp_limit(value: int | None) -> int:
    if value is None:
        return DEFAULT_LIMIT
    if value < 1:
        return DEFAULT_LIMIT
    if value > MAX_LIMIT:
        return MAX_LIMIT
    return int(value)


@dataclass
class Page:
    items: list
    next_cursor: str | None


def paginate(  # noqa: UP047 -- PEP 695 type-param syntax is a manual rewrite (module-level TypeVar `T` also used elsewhere), not mechanical
    items: list[tuple[str, str, T]],
    cursor: str | None,
    limit: int | None,
) -> Page:
    items_sorted = sorted(items, key=lambda x: (x[0], x[1]))
    start = 0
    if cursor:
        key, ident = decode_cursor(cursor)
        for i, (k, ident_i, _) in enumerate(items_sorted):
            if (k, ident_i) > (key, ident):
                start = i
                break
        else:
            start = len(items_sorted)
    page_limit = clamp_limit(limit)
    chunk = items_sorted[start : start + page_limit]
    next_cursor: str | None = None
    if start + page_limit < len(items_sorted) and chunk:
        last_key, last_id, _ = chunk[-1]
        next_cursor = encode_cursor(last_key, last_id)
    return Page(items=[payload for _, _, payload in chunk], next_cursor=next_cursor)


def paginated_payload(  # noqa: UP047 -- PEP 695 type-param syntax is a manual rewrite (module-level TypeVar `T` also used elsewhere), not mechanical
    items: list[tuple[str, str, T]],
    cursor: str | None,
    limit: int | None,
) -> dict:
    """Return the common MCP list response shape."""
    page = paginate(items, cursor=cursor, limit=limit)
    payload = {"items": page.items}
    if page.next_cursor:
        payload["next_cursor"] = page.next_cursor
    return payload
