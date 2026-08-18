"""Tests for DatasourceOpcuaEngine subscription-transition safety (§2.1-§2.3)."""

import asyncio
from dataclasses import dataclass, field
from typing import Any

from asyncua import ua
from opcua.client_pool import DatasourceOpcuaEngine


@dataclass
class _FakeDsEntry:
    registry: dict[str, dict[str, Any]]
    folder_registry: dict[str, dict[str, Any]] = field(default_factory=dict)


class _FakeDM:
    def __init__(self, entry: _FakeDsEntry) -> None:
        self._entry = entry

    def get(self, _name: str) -> _FakeDsEntry:
        return self._entry


class _FakeNode:
    def __init__(self, node_id: str) -> None:
        self.nodeid = node_id


class _FakeClient:
    def get_node(self, node_id: str) -> _FakeNode:
        return _FakeNode(node_id)


class _FakePrioritySub:
    def __init__(self, handles: list[Any], *, raise_on_unsubscribe: bool = False) -> None:
        self._handles = handles
        self.raise_on_unsubscribe = raise_on_unsubscribe
        self.unsubscribed: list[Any] = []
        self.subscribe_calls: list[list[Any]] = []

    async def subscribe_data_change(self, nodes: list[Any], sampling_interval: float):
        self.subscribe_calls.append(nodes)
        await asyncio.sleep(0)
        return self._handles

    async def modify_monitored_item(self, handle, new_samp_time, new_queuesize=0, mod_filter_val=-1):
        item = ua.MonitoredItemModifyResult()
        item.StatusCode = ua.StatusCode(ua.StatusCodes.Good)
        item.RevisedSamplingInterval = new_samp_time
        return [item]

    async def unsubscribe(self, handles: Any) -> None:
        if self.raise_on_unsubscribe:
            raise RuntimeError("simulated unsubscribe failure")
        self.unsubscribed.append(handles)


class _FakeBgSub:
    def __init__(self, handles: list[Any] | None = None, *, raise_on_unsubscribe: bool = False) -> None:
        self._handles = handles if handles is not None else [99]
        self.raise_on_unsubscribe = raise_on_unsubscribe
        self.subscribe_calls: list[Any] = []
        self.unsubscribed: list[Any] = []

    async def subscribe_data_change(self, nodes: list[Any], sampling_interval: float):
        self.subscribe_calls.append(nodes)
        return self._handles

    async def unsubscribe(self, handles: Any) -> None:
        if self.raise_on_unsubscribe:
            raise RuntimeError("simulated unsubscribe failure")
        self.unsubscribed.append(handles)


def _make_engine(entry: _FakeDsEntry, *, priority_sub, background_sub) -> DatasourceOpcuaEngine:
    engine = DatasourceOpcuaEngine("DS")
    engine._connected = True
    engine._client = _FakeClient()
    engine.set_datasource_manager(_FakeDM(entry))
    engine._priority_sub = priority_sub
    engine._background_sub = background_sub
    return engine


# ── §2.2: promote (bg -> priority) must not double-subscribe ──────────────────


def test_promote_skipped_when_bg_unsubscribe_fails():
    entry = _FakeDsEntry(registry={"A": {"node_id": "ns=2;s=A", "enabled": True}})
    priority_sub = _FakePrioritySub([501])
    background_sub = _FakeBgSub(raise_on_unsubscribe=True)
    engine = _make_engine(entry, priority_sub=priority_sub, background_sub=background_sub)
    engine._bg_path_handles = {"A": [1]}

    asyncio.run(engine.set_priority_paths({"A"}))

    # bg-unsubscribe failed -> node must stay tracked on background only.
    assert engine._bg_path_handles == {"A": [1]}
    assert "A" not in engine._priority_path_handles
    assert engine._current_priority_paths == set()
    assert engine._requested_priority_paths == {"A"}


def test_promote_succeeds_when_bg_unsubscribe_succeeds():
    entry = _FakeDsEntry(registry={"A": {"node_id": "ns=2;s=A", "enabled": True}})
    priority_sub = _FakePrioritySub([501])
    background_sub = _FakeBgSub()
    engine = _make_engine(entry, priority_sub=priority_sub, background_sub=background_sub)
    engine._bg_path_handles = {"A": [1]}

    asyncio.run(engine.set_priority_paths({"A"}))

    assert "A" not in engine._bg_path_handles
    assert engine._priority_path_handles["A"] == [501]


# ── §2.1: demote (priority -> bg) must not double-subscribe ───────────────────


def test_demote_skipped_when_priority_unsubscribe_fails():
    entry = _FakeDsEntry(registry={"A": {"node_id": "ns=2;s=A", "enabled": True}})
    priority_sub = _FakePrioritySub([501], raise_on_unsubscribe=True)
    background_sub = _FakeBgSub(handles=[77])
    engine = _make_engine(entry, priority_sub=priority_sub, background_sub=background_sub)
    engine._current_priority_paths = {"A"}
    engine._priority_path_handles = {"A": [55]}

    asyncio.run(engine.set_priority_paths(set()))

    # priority-unsubscribe failed -> handle stays tracked for retry, and the
    # node must NOT also land on the background sub.
    assert engine._priority_path_handles == {"A": [55]}
    assert engine._current_priority_paths == {"A"}
    assert "A" not in engine._bg_path_handles
    assert background_sub.subscribe_calls == []


def test_demote_succeeds_when_priority_unsubscribe_succeeds():
    entry = _FakeDsEntry(registry={"A": {"node_id": "ns=2;s=A", "enabled": True}})
    priority_sub = _FakePrioritySub([501])
    background_sub = _FakeBgSub(handles=[77])
    engine = _make_engine(entry, priority_sub=priority_sub, background_sub=background_sub)
    engine._current_priority_paths = {"A"}
    engine._priority_path_handles = {"A": [55]}

    asyncio.run(engine.set_priority_paths(set()))

    assert "A" not in engine._priority_path_handles
    assert engine._bg_path_handles["A"] == [77]
    assert engine._current_priority_paths == set()


def test_struct_folder_priority_is_demoted_through_its_leaf_handles():
    entry = _FakeDsEntry(
        registry={"Motor/Speed": {"node_id": "ns=2;s=Speed", "enabled": True}},
        folder_registry={
            "Motor": {
                "_child_paths": {"Motor/Speed": "Speed"},
                "_nested_fields": {},
                "_element_paths": [],
            },
        },
    )
    priority_sub = _FakePrioritySub([501])
    background_sub = _FakeBgSub(handles=[77])
    engine = _make_engine(entry, priority_sub=priority_sub, background_sub=background_sub)
    engine._bg_path_handles = {"Motor/Speed": [1]}

    asyncio.run(engine.set_priority_paths({"Motor"}))
    assert engine._requested_priority_paths == {"Motor"}
    assert engine._current_priority_paths == {"Motor/Speed"}
    assert engine._priority_path_handles == {"Motor/Speed": [501]}

    asyncio.run(engine.set_priority_paths(set()))
    assert engine._priority_path_handles == {}
    assert engine._current_priority_paths == set()
    assert engine._bg_path_handles == {"Motor/Speed": [77]}


def test_concurrent_recomputes_do_not_double_subscribe_the_same_path():
    entry = _FakeDsEntry(registry={"A": {"node_id": "ns=2;s=A", "enabled": False}})
    priority_sub = _FakePrioritySub([501])
    engine = _make_engine(entry, priority_sub=priority_sub, background_sub=None)

    async def run_both() -> None:
        await asyncio.gather(
            engine.set_priority_paths({"A"}),
            engine.set_priority_paths({"A"}),
        )

    asyncio.run(run_both())
    assert len(priority_sub.subscribe_calls) == 1
    assert engine._priority_path_handles == {"A": [501]}


# ── §2.3: _subscribe_path dedupe guard ─────────────────────────────────────────


def test_subscribe_path_skips_when_already_tracked():
    entry = _FakeDsEntry(registry={})
    background_sub = _FakeBgSub(handles=[999])
    engine = _make_engine(entry, priority_sub=None, background_sub=background_sub)
    engine._bg_path_handles = {"A": [1]}

    asyncio.run(engine._subscribe_path("A", {"node_id": "ns=2;s=A"}, entry))

    # No new monitored item created — existing handle is untouched.
    assert background_sub.subscribe_calls == []
    assert engine._bg_path_handles == {"A": [1]}


def test_subscribe_path_subscribes_when_not_tracked():
    entry = _FakeDsEntry(registry={})
    background_sub = _FakeBgSub(handles=[999])
    engine = _make_engine(entry, priority_sub=None, background_sub=background_sub)

    asyncio.run(engine._subscribe_path("A", {"node_id": "ns=2;s=A"}, entry))

    assert len(background_sub.subscribe_calls) == 1
    assert engine._bg_path_handles["A"] == [999]
