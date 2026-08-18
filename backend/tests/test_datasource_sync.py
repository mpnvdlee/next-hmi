"""Tests for services.datasource_sync — subscription-delta backfill (§1.1)."""

from dataclasses import dataclass, field
from typing import Any

import pytest
import services.datasource_sync as datasource_sync
from services.datasource_sync import apply_subscription_delta


@dataclass
class _FakeEntry:
    name: str = "DS"
    ds_type: str = "opcua-client"
    config: dict[str, Any] = field(default_factory=lambda: {"settings": {}})
    registry: dict[str, dict[str, Any]] = field(default_factory=dict)
    folder_registry: dict[str, dict[str, Any]] = field(default_factory=dict)


class _FakeEngine:
    def __init__(self) -> None:
        self.subscribed: list[str] = []
        self.unsubscribed: list[str] = []
        self.read_calls: list[set[str]] = []
        self.values: dict[str, Any] = {}

    async def add_subscription_by_path(self, path, _entry) -> None:
        self.subscribed.append(path)

    async def remove_subscription_by_path(self, _name, path) -> bool:
        self.unsubscribed.append(path)
        return True

    async def read_current_values(self, paths: set[str]) -> dict[str, Any]:
        self.read_calls.append(set(paths))
        return {k: v for k, v in self.values.items() if k.split(":", 1)[1] in paths}


class _RaisingEngine(_FakeEngine):
    async def read_current_values(self, paths: set[str]) -> dict[str, Any]:
        self.read_calls.append(set(paths))
        raise RuntimeError("simulated read failure")


class _FailedRemoveEngine(_FakeEngine):
    async def remove_subscription_by_path(self, _name, path) -> bool:
        self.unsubscribed.append(path)
        return False


class _FakePool:
    def __init__(self, engine: Any) -> None:
        self._engine = engine

    def get(self, _name: str) -> Any:
        return self._engine


class _RestartingPool(_FakePool):
    def __init__(self, engine: Any) -> None:
        super().__init__(engine)
        self.restarts: list[tuple[str, dict[str, Any]]] = []

    async def restart(self, name: str, settings: dict[str, Any]) -> None:
        self.restarts.append((name, settings))
        self._engine = _FakeEngine()


class _FakeManager:
    def __init__(self) -> None:
        self.evicted: list[tuple[str, str]] = []
        self.seeded: dict[str, Any] = {}

    def evict(self, name: str, path: str) -> None:
        self.evicted.append((name, path))

    def seed_cached_values(self, updates: dict[str, Any]) -> None:
        self.seeded.update(updates)


@pytest.mark.asyncio
async def test_backfills_all_still_enabled_variables_not_just_the_delta(monkeypatch):
    fake_manager = _FakeManager()
    monkeypatch.setattr(datasource_sync, "datasource_manager", fake_manager)

    entry = _FakeEntry(registry={
        "A": {"enabled": True, "node_id": "n1"},
        "B": {"enabled": True, "node_id": "n2"},
    })
    engine = _FakeEngine()
    engine.values = {"DS:A": 1.0, "DS:B": 2.0}
    pool = _FakePool(engine)

    # "A" was already enabled before this save; "B" is newly enabled.
    await apply_subscription_delta(
        "DS", old_enabled={"A"}, new_entry=entry, opcua_pool=pool, test_server_pool=None,
    )

    assert engine.subscribed == ["B"]
    assert engine.unsubscribed == []
    # Backfill reads the whole new-enabled set, so "A" (unchanged) gets
    # refreshed too instead of sitting empty until the PLC next reports.
    assert engine.read_calls == [{"A", "B"}]
    assert fake_manager.seeded == {"DS:A": 1.0, "DS:B": 2.0}


@pytest.mark.asyncio
async def test_backfill_failure_is_swallowed_not_raised(monkeypatch):
    fake_manager = _FakeManager()
    monkeypatch.setattr(datasource_sync, "datasource_manager", fake_manager)

    entry = _FakeEntry(registry={"A": {"enabled": True, "node_id": "n1"}})
    pool = _FakePool(_RaisingEngine())

    await apply_subscription_delta(
        "DS", old_enabled=set(), new_entry=entry, opcua_pool=pool, test_server_pool=None,
    )
    assert fake_manager.seeded == {}


@pytest.mark.asyncio
async def test_no_backfill_when_nothing_enabled(monkeypatch):
    fake_manager = _FakeManager()
    monkeypatch.setattr(datasource_sync, "datasource_manager", fake_manager)

    entry = _FakeEntry(registry={})
    engine = _FakeEngine()
    pool = _FakePool(engine)

    await apply_subscription_delta(
        "DS", old_enabled=set(), new_entry=entry, opcua_pool=pool, test_server_pool=None,
    )
    assert engine.read_calls == []
    assert fake_manager.seeded == {}


@pytest.mark.asyncio
async def test_replaces_subscription_when_node_id_changes_at_same_path(monkeypatch):
    fake_manager = _FakeManager()
    monkeypatch.setattr(datasource_sync, "datasource_manager", fake_manager)
    old_entry = _FakeEntry(registry={"A": {"enabled": True, "node_id": "old"}})
    new_entry = _FakeEntry(registry={"A": {"enabled": True, "node_id": "new"}})
    engine = _FakeEngine()

    removed = await apply_subscription_delta(
        "DS",
        old_enabled={"A"},
        new_entry=new_entry,
        opcua_pool=_FakePool(engine),
        test_server_pool=None,
        old_entry=old_entry,
    )

    assert engine.unsubscribed == ["A"]
    assert engine.subscribed == ["A"]
    # Same composite key, but it belongs to a new runtime identity and must be
    # cleared client-side before the refreshed value is published.
    assert removed == ["DS:A"]


@pytest.mark.asyncio
async def test_failed_remove_restarts_runtime_instead_of_forgetting_old_handle(monkeypatch):
    fake_manager = _FakeManager()
    monkeypatch.setattr(datasource_sync, "datasource_manager", fake_manager)
    old_entry = _FakeEntry(registry={"A": {"enabled": True, "node_id": "old"}})
    new_entry = _FakeEntry(
        config={"settings": {"url": "opc.tcp://new"}},
        registry={"A": {"enabled": True, "node_id": "new"}},
    )
    old_engine = _FailedRemoveEngine()
    pool = _RestartingPool(old_engine)

    await apply_subscription_delta(
        "DS", {"A"}, new_entry, pool, None, old_entry,
    )

    assert old_engine.unsubscribed == ["A"]
    assert old_engine.subscribed == []
    assert pool.restarts == [("DS", {"url": "opc.tcp://new"})]
    assert pool.get("DS").read_calls == [{"A"}]


@pytest.mark.asyncio
async def test_shape_change_at_same_path_resets_the_old_client_value(monkeypatch):
    fake_manager = _FakeManager()
    monkeypatch.setattr(datasource_sync, "datasource_manager", fake_manager)
    old_entry = _FakeEntry(registry={
        "A": {"enabled": True, "node_id": "n1", "data_type": "Float"},
    })
    new_entry = _FakeEntry(registry={
        "A": {"enabled": True, "node_id": "n1", "data_type": "String"},
    })

    removed = await apply_subscription_delta(
        "DS", {"A"}, new_entry, _FakePool(_FakeEngine()), None, old_entry,
    )

    assert removed == ["DS:A"]


@pytest.mark.asyncio
async def test_backfill_includes_struct_root_for_aggregate_and_element_keys(monkeypatch):
    fake_manager = _FakeManager()
    monkeypatch.setattr(datasource_sync, "datasource_manager", fake_manager)
    entry = _FakeEntry(
        registry={"Motor/Speed": {"enabled": True, "node_id": "n1"}},
        folder_registry={
            "Motor": {
                "_nested_fields": {},
                "_element_paths": [],
            },
        },
    )
    engine = _FakeEngine()

    await apply_subscription_delta(
        "DS",
        old_enabled={"Motor/Speed"},
        new_entry=entry,
        opcua_pool=_FakePool(engine),
        test_server_pool=None,
        old_entry=entry,
    )

    assert engine.read_calls == [{"Motor/Speed", "Motor"}]
