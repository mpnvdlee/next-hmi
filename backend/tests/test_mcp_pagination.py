"""Pagination cursor codec — round-trip + clamp + reject."""

import pytest
from mcp_server.pagination import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    CursorError,
    clamp_limit,
    decode_cursor,
    encode_cursor,
    paginate,
    paginated_payload,
)


def test_cursor_round_trips():
    token = encode_cursor("page-z", "z-1")
    sort_key, ident = decode_cursor(token)
    assert (sort_key, ident) == ("page-z", "z-1")


def test_decode_cursor_rejects_malformed():
    with pytest.raises(CursorError):
        decode_cursor("not-base64!!!")
    with pytest.raises(CursorError):
        # Valid base64 but wrong shape
        import base64
        token = base64.urlsafe_b64encode(b'"hello"').decode()
        decode_cursor(token)


def test_clamp_limit():
    assert clamp_limit(None) == DEFAULT_LIMIT
    assert clamp_limit(0) == DEFAULT_LIMIT
    assert clamp_limit(50) == 50
    assert clamp_limit(MAX_LIMIT + 1) == MAX_LIMIT
    assert clamp_limit(-5) == DEFAULT_LIMIT


def test_paginate_first_page_and_continuation():
    items = [(f"k-{i:03d}", f"id-{i:03d}", {"i": i}) for i in range(250)]
    page1 = paginate(items, cursor=None, limit=100)
    assert len(page1.items) == 100
    assert page1.next_cursor is not None

    page2 = paginate(items, cursor=page1.next_cursor, limit=100)
    assert len(page2.items) == 100
    assert page2.next_cursor is not None
    assert page2.items[0] != page1.items[0]

    page3 = paginate(items, cursor=page2.next_cursor, limit=100)
    assert len(page3.items) == 50
    assert page3.next_cursor is None


def test_paginate_oversized_limit_clamps():
    items = [(f"k-{i}", f"i-{i}", i) for i in range(10)]
    page = paginate(items, cursor=None, limit=10_000)
    assert len(page.items) == 10
    assert page.next_cursor is None


def test_paginate_unknown_cursor_starts_at_end():
    items = [(f"k-{i}", f"i-{i}", i) for i in range(5)]
    # Cursor pointing past the last item
    page = paginate(items, cursor=encode_cursor("k-9999", "i-9999"), limit=10)
    assert page.items == []
    assert page.next_cursor is None


def test_paginated_payload_uses_common_list_envelope():
    items = [(f"k-{i}", f"i-{i}", {"i": i}) for i in range(3)]
    first = paginated_payload(items, cursor=None, limit=2)
    assert first["items"] == [{"i": 0}, {"i": 1}]
    assert isinstance(first["next_cursor"], str)

    last = paginated_payload(items, cursor=first["next_cursor"], limit=2)
    assert last == {"items": [{"i": 2}]}
