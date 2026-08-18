"""Idempotency cache — LRU + TTL behavior."""


import pytest
from mcp_server import idempotency


@pytest.fixture(autouse=True)
def _reset_cache():
    idempotency.reset_for_tests()
    yield
    idempotency.reset_for_tests()


def test_get_returns_none_when_missing():
    assert idempotency.get("Claude@1", "key-1") is None


def test_put_then_get_returns_response():
    idempotency.put("Claude@1", "key-1", {"result": "applied"})
    assert idempotency.get("Claude@1", "key-1") == {"result": "applied"}


def test_keys_scoped_by_agent_label():
    idempotency.put("Claude@1", "k", {"by": "Claude"})
    idempotency.put("Other@1", "k", {"by": "Other"})
    assert idempotency.get("Claude@1", "k") == {"by": "Claude"}
    assert idempotency.get("Other@1", "k") == {"by": "Other"}


def test_empty_idempotency_key_skips_lookup():
    idempotency.put("Claude@1", "", {"r": "1"})
    assert idempotency.get("Claude@1", "") is None


def test_ttl_expires(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(idempotency.time, "monotonic", lambda: now[0])
    idempotency.put("Claude@1", "k", {"v": 1})
    assert idempotency.get("Claude@1", "k") == {"v": 1}
    # Advance past TTL (5 min)
    now[0] = 1000.0 + idempotency.CACHE_TTL_SECONDS + 1
    assert idempotency.get("Claude@1", "k") is None


def test_lru_evicts_oldest():
    capacity = idempotency.CACHE_CAPACITY
    for i in range(capacity + 5):
        idempotency.put("Claude@1", f"k-{i}", {"v": i})
    # First 5 keys should be evicted
    for i in range(5):
        assert idempotency.get("Claude@1", f"k-{i}") is None
    # The most-recently-inserted are present
    assert idempotency.get("Claude@1", f"k-{capacity + 4}") == {"v": capacity + 4}
