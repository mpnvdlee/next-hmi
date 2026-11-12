"""Tests for DatasourceOpcuaEngine subscription-transition safety."""

import asyncio
import itertools
import logging
import socket
import time
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import opcua.engine as engine_module
import pytest
from asyncua import Client, Server, ua
from asyncua.common.subscription import Subscription
from asyncua.server.subscription_service import SubscriptionService
from opcua.client_pool import DatasourceOpcuaEngine
from opcua.limits import OperationLimits


@dataclass
class _FakeDsEntry:
    registry: dict[str, dict[str, Any]]
    folder_registry: dict[str, dict[str, Any]] = field(default_factory=dict)
    derived: dict[str, Any] = field(default_factory=dict)


class _FakeDM:
    def __init__(self, entry: _FakeDsEntry) -> None:
        self._entry = entry

    def get(self, _name: str) -> _FakeDsEntry:
        return self._entry

    def get_priority_keys(self) -> set[str]:
        return set()


class _FakeNode:
    def __init__(self, node_id: str) -> None:
        self.nodeid = node_id


class _FakeClient:
    def get_node(self, node_id: str) -> _FakeNode:
        return _FakeNode(node_id)

    async def get_namespace_array(self) -> list[str]:
        return []

    async def disconnect(self) -> None:
        pass


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
            raise ua.UaStatusCodeError(ua.StatusCodes.BadInternalError)
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
            raise ua.UaStatusCodeError(ua.StatusCodes.BadInternalError)
        self.unsubscribed.append(handles)


def _make_engine(entry: _FakeDsEntry, *, priority_sub, background_sub) -> DatasourceOpcuaEngine:
    engine = DatasourceOpcuaEngine("DS")
    engine._connected = True
    engine._client = _FakeClient()
    engine.set_datasource_manager(_FakeDM(entry))
    engine._priority_sub = priority_sub
    engine._background_sub = background_sub
    return engine


# ── Promote (bg -> priority) must not double-subscribe ────────────────────────


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


# ── Demote (priority -> bg) must not double-subscribe ─────────────────────────


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
    entry = _FakeDsEntry(registry={"A": {"node_id": "ns=2;s=A", "enabled": True}})
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


# ── Only enabled variables are promoted ──────────────────────────────────────
# Any client's set_context names priority keys, and a promoted value is
# broadcast to every client: a disabled tag must never get a monitored item.


def test_a_disabled_variable_is_never_promoted():
    entry = _FakeDsEntry(registry={"Line/SafetyLimit": {"node_id": "ns=2;s=Limit", "enabled": False}})
    priority_sub = _FakePrioritySub([501])
    engine = _make_engine(entry, priority_sub=priority_sub, background_sub=None)

    asyncio.run(engine.set_priority_paths({"Line/SafetyLimit"}))

    assert priority_sub.subscribe_calls == []
    assert engine._priority_path_handles == {}


def test_a_struct_folder_promotes_only_its_enabled_leaves():
    entry = _FakeDsEntry(
        registry={
            "Line/Speed": {"node_id": "ns=2;s=Speed", "enabled": True},
            "Line/SafetyLimit": {"node_id": "ns=2;s=Limit", "enabled": False},
        },
        folder_registry={
            "Line": {
                "_child_paths": {"Line/Speed": "Speed", "Line/SafetyLimit": "SafetyLimit"},
                "_nested_fields": {},
                "_element_paths": [],
            },
        },
    )
    priority_sub = _FakePrioritySub([501])
    engine = _make_engine(entry, priority_sub=priority_sub, background_sub=_FakeBgSub())

    asyncio.run(engine.set_priority_paths({"Line"}))

    assert [[node.nodeid for node in call] for call in priority_sub.subscribe_calls] == [["ns=2;s=Speed"]]
    assert set(engine._priority_path_handles) == {"Line/Speed"}


# ── add_subscription_by_path dedupe guard ──────────────────────────────────────


def test_subscribe_path_skips_when_already_tracked():
    entry = _FakeDsEntry(registry={"A": {"node_id": "ns=2;s=A"}})
    background_sub = _FakeBgSub(handles=[999])
    engine = _make_engine(entry, priority_sub=None, background_sub=background_sub)
    engine._bg_path_handles = {"A": [1]}

    asyncio.run(engine.add_subscription_by_path("A", entry))

    # No new monitored item created — existing handle is untouched.
    assert background_sub.subscribe_calls == []
    assert engine._bg_path_handles == {"A": [1]}


def test_subscribe_path_subscribes_when_not_tracked():
    entry = _FakeDsEntry(registry={"A": {"node_id": "ns=2;s=A"}})
    background_sub = _FakeBgSub(handles=[999])
    engine = _make_engine(entry, priority_sub=None, background_sub=background_sub)

    asyncio.run(engine.add_subscription_by_path("A", entry))

    assert len(background_sub.subscribe_calls) == 1
    assert engine._bg_path_handles["A"] == [999]


# ── Monitored-item requests fit the server's OperationLimits ─────────────────

_handle_ids = itertools.count(1000)


class _ServerSub:
    """A subscription as the server sees it: a unique handle per created item,
    the live items by handle, and every Create/DeleteMonitoredItems request.

    `create_errors` maps a create request's number (1-based) to what it raises
    instead. A delete request numbered in `lost_deletes` never arrives; one in
    `unanswered_deletes` is carried out but its answer never comes. Like
    asyncua, a delete whose first item is unknown raises
    BadMonitoredItemIdInvalid after the server deleted the rest.
    """

    def __init__(
        self,
        name: str = "",
        log: list | None = None,
        *,
        create_errors: dict[int, Exception] | None = None,
        lost_deletes: set[int] = frozenset(),
        unanswered_deletes: set[int] = frozenset(),
        round_trip_s: float = 0.0,
    ) -> None:
        self.name = name
        self.log = log if log is not None else []
        self.create_errors = create_errors or {}
        self.lost_deletes = lost_deletes
        self.unanswered_deletes = unanswered_deletes
        self.round_trip_s = round_trip_s
        self.live: dict[int, str] = {}
        self.create_calls: list[list[str]] = []
        self.delete_calls: list[list[int]] = []
        self.parameters = ua.CreateSubscriptionParameters(RequestedPublishingInterval=1000.0)

    async def subscribe_data_change(self, nodes: list[Any], sampling_interval: float):
        ids = [node.nodeid for node in nodes]
        self.create_calls.append(ids)
        self.log.append((self.name, ids))
        await asyncio.sleep(self.round_trip_s)
        if (error := self.create_errors.get(len(self.create_calls))) is not None:
            raise error
        handles = [next(_handle_ids) for _ in ids]
        self.live.update(zip(handles, ids, strict=True))
        return handles

    async def unsubscribe(self, handles: list[int]) -> None:
        self.delete_calls.append(list(handles))
        call = len(self.delete_calls)
        if call in self.lost_deletes:
            raise TimeoutError
        first_known = handles[0] in self.live
        for handle in handles:
            self.live.pop(handle, None)
        if call in self.unanswered_deletes:
            raise TimeoutError
        if not first_known:
            raise ua.UaStatusCodeError(ua.StatusCodes.BadMonitoredItemIdInvalid)

    async def modify_monitored_item(self, handle, new_samp_time, new_queuesize=0, mod_filter_val=-1):
        item = ua.MonitoredItemModifyResult()
        item.RevisedSamplingInterval = new_samp_time
        return [item]

    async def delete(self) -> None:
        pass

    # Iterator mode: the engine drains events itself; none arrive here.
    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


def _paths_engine(paths: list[str], *, limit: int, priority_sub, background_sub) -> DatasourceOpcuaEngine:
    """An engine over *paths* (node id = path) whose server takes *limit* items per call."""
    entry = _FakeDsEntry(registry={p: {"node_id": p, "enabled": True} for p in paths})
    engine = _make_engine(entry, priority_sub=priority_sub, background_sub=background_sub)
    engine._operation_limits = OperationLimits(max_monitored_items_per_call=limit)
    return engine


def _put_on(sub: _ServerSub, tracked: dict[str, list], paths: list[str]) -> list[int]:
    """*paths* live on *sub* and tracked in *tracked* (an engine's handle map);
    returns their handles, in order."""
    for path in paths:
        handle = next(_handle_ids)
        sub.live[handle] = path
        tracked[path] = [handle]
    return [tracked[path][0] for path in paths]


def _paths_of(sub: _ServerSub, handles: list[int]) -> set[str]:
    return {sub.live[h] for h in handles}


def test_promote_and_demote_split_every_request_by_the_per_call_limit():
    paths = ["A", "B", "C", "D", "E"]
    priority_sub, background_sub = _ServerSub(), _ServerSub()
    engine = _paths_engine(paths, limit=2, priority_sub=priority_sub, background_sub=background_sub)
    _put_on(background_sub, engine._bg_path_handles, paths)

    asyncio.run(engine.set_priority_paths(set(paths)))

    assert [len(call) for call in background_sub.delete_calls] == [2, 2, 1]
    assert [len(call) for call in priority_sub.create_calls] == [2, 2, 1]
    assert sorted(priority_sub.live.values()) == paths and background_sub.live == {}

    asyncio.run(engine.set_priority_paths(set()))

    assert [len(call) for call in priority_sub.delete_calls] == [2, 2, 1]
    assert [len(call) for call in background_sub.create_calls] == [2, 2, 1]
    assert sorted(background_sub.live.values()) == paths and priority_sub.live == {}


def test_a_failed_create_request_neither_loses_nor_duplicates_items():
    """The middle one of three promote requests fails: the other two keep
    their items on the priority subscription, the failed ones go back to the
    background, and no item is created twice."""
    paths = ["A", "B", "C", "D", "E"]
    priority_sub = _ServerSub(create_errors={2: ua.UaStatusCodeError(ua.StatusCodes.BadTooManyOperations)})
    background_sub = _ServerSub()
    engine = _paths_engine(paths, limit=2, priority_sub=priority_sub, background_sub=background_sub)
    _put_on(background_sub, engine._bg_path_handles, paths)

    asyncio.run(engine.set_priority_paths(set(paths)))

    # Exactly three requests: the chunks that worked are not retried per path.
    first, failed, last = priority_sub.create_calls
    assert set(engine._priority_path_handles) == {*first, *last}
    assert set(engine._bg_path_handles) == set(failed)
    # The failed chunk goes back to the background in one request, not one per path.
    assert background_sub.create_calls == [failed]
    # Every path is live exactly once, under the handle the engine tracks.
    assert sorted([*priority_sub.live.values(), *background_sub.live.values()]) == paths
    assert {h for hs in engine._priority_path_handles.values() for h in hs} == set(priority_sub.live)
    assert {h for hs in engine._bg_path_handles.values() for h in hs} == set(background_sub.live)


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ua.UaStatusCodeError(ua.StatusCodes.BadTooManyOperations), ua.StatusCodes.BadTooManyOperations),
        (TimeoutError(), ua.StatusCodes.BadTimeout),
    ],
)
def test_create_items_answers_a_refused_or_timed_out_request_per_item(error, code, caplog):
    sub = _ServerSub(create_errors={2: error})
    engine = _paths_engine([], limit=2, priority_sub=None, background_sub=sub)
    items = [(path, _FakeNode(path)) for path in "ABCDE"]

    with caplog.at_level(logging.WARNING):
        handles = asyncio.run(engine._create_items(sub, items, None, -1))

    assert [isinstance(h, int) for h in handles] == [True, True, False, False, True]
    assert handles[2] == handles[3] == ua.StatusCode(code)
    assert sorted(sub.live.values()) == ["A", "B", "E"]
    assert len(caplog.records) == 1 and "(2 items)" in caplog.text


@pytest.mark.parametrize("error", [ConnectionError("Connection is closed"), TypeError("a changed asyncua API")])
def test_create_items_raises_a_lost_session_or_a_bug(error):
    """Neither says anything about the items: a lost session ends the
    caller's work, and a bug must be seen rather than become an item status."""
    sub = _ServerSub(create_errors={2: error})
    engine = _paths_engine([], limit=2, priority_sub=None, background_sub=sub)

    with pytest.raises(type(error)):
        asyncio.run(engine._create_items(sub, [(path, _FakeNode(path)) for path in "ABCDE"], None, -1))


@pytest.mark.parametrize("direction", ["promote", "demote"])
def test_a_timed_out_create_keeps_its_routes(direction):
    """The server has often created a timed-out request's items anyway:
    their notifications must still find a route, on either subscription."""
    paths = ["A", "B"]
    priority_sub = _ServerSub(create_errors={1: TimeoutError()} if direction == "promote" else None)
    background_sub = _ServerSub(create_errors={1: TimeoutError()} if direction == "demote" else None)
    engine = _paths_engine(paths, limit=2, priority_sub=priority_sub, background_sub=background_sub)
    if direction == "promote":
        _put_on(background_sub, engine._bg_path_handles, paths)
        asyncio.run(engine.set_priority_paths(set(paths)))
    else:
        _put_on(priority_sub, engine._priority_path_handles, paths)
        asyncio.run(engine.set_priority_paths(set()))

    assert engine._priority_path_handles == {}
    # A promote that timed out goes back to the background; a demote's waits for the health check.
    assert set(engine._bg_path_handles) == ({"A", "B"} if direction == "promote" else set())
    assert engine._node_to_path == {"A": "A", "B": "B"}
    assert engine._path_to_node_ids == {"A": {"A"}, "B": {"B"}}


def test_a_lost_session_ends_a_promote_without_trying_every_path():
    """A dead session answers every item with an error: the safety net must
    not send any of them to the background."""
    paths = ["A", "B", "C", "D", "E"]
    priority_sub = _ServerSub(create_errors={1: ConnectionError("Connection is closed")})
    background_sub = _ServerSub()
    engine = _paths_engine(paths, limit=2, priority_sub=priority_sub, background_sub=background_sub)
    _put_on(background_sub, engine._bg_path_handles, paths)

    asyncio.run(engine.set_priority_paths(set(paths)))  # does not raise

    assert len(priority_sub.create_calls) == 1
    assert background_sub.create_calls == []


_REFUSED = ua.UaStatusCodeError(ua.StatusCodes.BadTooManyOperations)


@pytest.mark.parametrize("promote_error", [TimeoutError(), _REFUSED], ids=["timed-out", "refused"])
def test_a_transition_left_on_neither_subscription_waits_for_the_health_check(promote_error):
    """A path whose priority create timed out or was refused goes back to the
    background: the user may have moved on before the next recompute, which
    would then never select it again. What the background does not answer
    either — a demote's create too — is not retried at once under the lock,
    the server having often created it all the same, but by the health check."""
    priority_sub = _ServerSub(create_errors={1: promote_error})
    background_sub = _ServerSub(create_errors={1: TimeoutError(), 2: TimeoutError()})
    engine = _paths_engine(["A", "B"], limit=2, priority_sub=priority_sub, background_sub=background_sub)
    _put_on(background_sub, engine._bg_path_handles, ["A"])
    _put_on(priority_sub, engine._priority_path_handles, ["B"])

    asyncio.run(engine.set_priority_paths({"A"}))  # promotes A, demotes B

    assert priority_sub.create_calls == [["A"]] and background_sub.create_calls == [["A"], ["B"]]
    assert engine._priority_path_handles == {} and engine._bg_path_handles == {}
    assert engine._bg_retry == {"A": "A", "B": "B"}


@pytest.mark.asyncio
async def test_a_retry_refused_again_stays_queued_and_backs_off():
    """A server at its monitored-item limit refuses the retry too: the path
    stays queued rather than being dropped with no monitored item, and each
    refusal doubles the health checks before the next retry, up to 16."""
    background_sub = _ServerSub(create_errors={i: _REFUSED for i in range(1, 6)})
    engine = _paths_engine(["A"], limit=2, priority_sub=_ServerSub(), background_sub=background_sub)
    _put_on(engine._priority_sub, engine._priority_path_handles, ["A"])

    await engine.set_priority_paths(set())
    retried_at = []
    for check in range(1, 24):
        before = len(background_sub.create_calls)
        await engine._check_health()
        if len(background_sub.create_calls) > before:
            retried_at.append(check)

    # Refused at 1, 3, 6 and 11; taken at 20.
    assert retried_at == [1, 3, 6, 11, 20]
    assert engine._bg_retry == {} and list(engine._bg_path_handles) == ["A"]


@pytest.mark.asyncio
async def test_a_node_the_server_does_not_know_is_not_retried():
    """No retry cures a refusal of the node itself; retrying it every health
    check would only repeat the warning."""

    class _UnknownNodeSub(_ServerSub):
        async def subscribe_data_change(self, nodes, sampling_interval):
            self.create_calls.append([node.nodeid for node in nodes])
            return [ua.StatusCode(ua.StatusCodes.BadNodeIdUnknown) for _ in nodes]

    engine = _paths_engine(["A"], limit=2, priority_sub=_ServerSub(), background_sub=_UnknownNodeSub())
    _put_on(engine._priority_sub, engine._priority_path_handles, ["A"])

    await engine.set_priority_paths(set())

    assert engine._bg_retry == {} and engine._bg_path_handles == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [_REFUSED, TimeoutError()], ids=["refused", "timed-out"])
async def test_a_failed_demote_is_retried_in_bulk_by_the_next_health_check(error):
    """Every request of the demote fails whole: the paths are on neither
    subscription and in no recompute's delta. Not retried at once — the
    subscription that refused would refuse again, a stalled one holds the
    lock — but by the periodic health check, one request per chunk."""
    paths = ["A", "B", "C", "D", "E"]
    priority_sub = _ServerSub()
    background_sub = _ServerSub(create_errors={1: error, 2: error, 3: error})
    engine = _paths_engine(paths, limit=2, priority_sub=priority_sub, background_sub=background_sub)
    _put_on(priority_sub, engine._priority_path_handles, paths)

    await engine.set_priority_paths(set())
    assert [len(call) for call in background_sub.create_calls] == [2, 2, 1]
    assert engine._bg_path_handles == {} and engine._priority_path_handles == {}

    await engine._check_health()

    assert [len(call) for call in background_sub.create_calls] == [2, 2, 1, 2, 2, 1]
    assert sorted(engine._bg_path_handles) == sorted(background_sub.live.values()) == paths
    assert engine._bg_retry == {}


@pytest.mark.asyncio
async def test_a_promote_the_background_refuses_back_is_retried_by_the_health_check():
    """Refused on the priority subscription, the paths go back to the
    background in bulk; a chunk the background refuses as well waits for
    the health check instead of one request per path."""
    paths = ["A", "B", "C", "D", "E"]
    priority_sub = _ServerSub(create_errors={1: _REFUSED, 2: _REFUSED, 3: _REFUSED})
    background_sub = _ServerSub(create_errors={1: _REFUSED})
    engine = _paths_engine(paths, limit=2, priority_sub=priority_sub, background_sub=background_sub)
    _put_on(background_sub, engine._bg_path_handles, paths)

    await engine.set_priority_paths(set(paths))

    first = background_sub.create_calls[0]
    assert [len(call) for call in background_sub.create_calls] == [2, 2, 1]
    assert set(engine._bg_retry) == set(first)

    await engine._check_health()

    assert background_sub.create_calls[3:] == [first]
    assert engine._priority_path_handles == {} and engine._bg_retry == {}
    assert sorted(engine._bg_path_handles) == sorted(background_sub.live.values()) == paths


def test_a_lost_session_in_the_safety_net_stops_it_at_the_first_request():
    paths = ["A", "B", "C", "D", "E"]
    lost = ConnectionError("Connection is closed")
    priority_sub = _ServerSub(create_errors={1: _REFUSED, 2: _REFUSED, 3: _REFUSED})
    background_sub = _ServerSub(create_errors={1: lost, 2: lost})
    engine = _paths_engine(paths, limit=2, priority_sub=priority_sub, background_sub=background_sub)
    _put_on(background_sub, engine._bg_path_handles, paths)

    asyncio.run(engine.set_priority_paths(set(paths)))  # does not raise

    assert len(background_sub.create_calls) == 1

    # A variable enabled on a dead session waits for the reconnect quietly too.
    asyncio.run(engine.add_subscription_by_path("A", engine._datasource_manager.get("DS")))
    assert len(background_sub.create_calls) == 2


# ── Deletes: every request tried, each path on its own outcome ────────────────


def test_delete_items_asks_again_when_a_request_goes_unanswered():
    """A timed-out delete has usually been carried out; the second answer,
    BadMonitoredItemIdInvalid, says so."""
    sub = _ServerSub(unanswered_deletes={2})
    engine = _paths_engine([], limit=2, priority_sub=None, background_sub=sub)
    handles = _put_on(sub, {}, list("ABCDE"))

    failed = asyncio.run(engine._delete_items(sub, handles))

    assert failed == set() and sub.live == {}
    assert [len(call) for call in sub.delete_calls] == [2, 2, 2, 1]


def test_delete_items_reports_a_request_that_fails_twice():
    sub = _ServerSub(lost_deletes={2, 3})
    engine = _paths_engine([], limit=2, priority_sub=None, background_sub=sub)
    handles = _put_on(sub, {}, list("ABCDE"))

    failed = asyncio.run(engine._delete_items(sub, handles))

    assert failed == set(handles[2:4])
    assert sorted(sub.live.values()) == ["C", "D"]


def test_a_delete_answered_bad_monitored_item_id_invalid_counts_as_done():
    """asyncua raises on a request's first result alone: one item already
    gone says nothing about the rest, which the server deleted all the same."""
    sub = _ServerSub()
    engine = _paths_engine([], limit=2, priority_sub=None, background_sub=sub)
    handles = _put_on(sub, {}, list("ABCDE"))
    del sub.live[handles[2]]  # the second request's first item is gone already

    failed = asyncio.run(engine._delete_items(sub, handles))

    assert failed == set() and sub.live == {}
    assert len(sub.delete_calls) == 3  # not asked again


def test_a_delete_answered_bad_monitored_item_id_invalid_forgets_asyncuas_items():
    """asyncua raises on that first result before it drops the request's
    items from its own map: left there, they stayed until the subscription went."""
    sub = _ServerSub()
    engine = _paths_engine([], limit=5, priority_sub=None, background_sub=sub)
    handles = _put_on(sub, {}, list("ABC"))
    sub._monitored_items = {i: SimpleNamespace(server_handle=h) for i, h in enumerate(handles)}
    del sub.live[handles[0]]

    asyncio.run(engine._delete_items(sub, handles))

    assert sub._monitored_items == {}


def test_a_promote_whose_delete_fails_moves_only_the_other_paths():
    """Each path follows its own delete: the paths of the request that failed
    twice stay on the background until the next recompute, the rest move to
    priority — no path is ever live on both subscriptions."""
    paths = ["A", "B", "C", "D", "E"]
    priority_sub = _ServerSub()
    background_sub = _ServerSub(lost_deletes={2, 3})
    engine = _paths_engine(paths, limit=2, priority_sub=priority_sub, background_sub=background_sub)
    _put_on(background_sub, engine._bg_path_handles, paths)

    asyncio.run(engine.set_priority_paths(set(paths)))

    stuck = _paths_of(background_sub, background_sub.delete_calls[1])
    assert len(stuck) == 2
    assert set(engine._bg_path_handles) == stuck
    assert set(engine._priority_path_handles) == set(paths) - stuck
    assert sorted([*priority_sub.live.values(), *background_sub.live.values()]) == paths


def test_a_demote_whose_delete_fails_moves_only_the_other_paths():
    paths = ["A", "B", "C", "D", "E"]
    priority_sub = _ServerSub(lost_deletes={2, 3})
    background_sub = _ServerSub()
    engine = _paths_engine(paths, limit=2, priority_sub=priority_sub, background_sub=background_sub)
    _put_on(priority_sub, engine._priority_path_handles, paths)

    asyncio.run(engine.set_priority_paths(set()))

    stuck = _paths_of(priority_sub, priority_sub.delete_calls[1])
    assert len(stuck) == 2
    assert set(engine._priority_path_handles) == engine._current_priority_paths == stuck
    assert set(engine._bg_path_handles) == set(paths) - stuck
    assert sorted([*priority_sub.live.values(), *background_sub.live.values()]) == paths


# ── A subscription asyncua would re-create behind the engine's back ──────────


@pytest.mark.asyncio
async def test_a_stale_subscription_reconnects_instead_of_being_recreated():
    """asyncua's stale watchdog would re-create a subscription under server
    handles the engine never learns, leaving every item it later deletes
    live; the client is closed instead, once however often the watchdog asks."""
    sub = _ServerSub()

    class _Client(_FakeClient):
        async def create_subscription(self, params, _handler, queue_maxsize=0):
            return sub

    engine = _paths_engine(["A"], limit=2, priority_sub=None, background_sub=None)
    engine._client = _Client()
    assert await engine._create_subscription(1000.0, priority=0) is sub

    await sub.recreate()
    close = engine._status_close_task
    await sub.recreate()
    assert engine._status_close_task is close

    await close
    assert sub.create_calls == []
    assert engine._connected is False and engine._client is None


# ── The background setup and the priority set ────────────────────────────────


def _skip_subscription_creation(engine: DatasourceOpcuaEngine, paths: list[str]) -> None:
    """_setup_subscriptions with the subscriptions already in place: only
    the background fill of *paths* is left."""
    entry = engine._datasource_manager.get("DS")

    async def setup_locked():
        return entry, [(path, _FakeNode(path), path) for path in paths]

    engine._setup_subscriptions_locked = setup_locked


def test_a_background_fill_request_that_fails_is_tried_once_more():
    paths = ["A", "B", "C", "D", "E"]
    background_sub = _ServerSub(create_errors={2: TimeoutError()})
    engine = _paths_engine(paths, limit=2, priority_sub=_ServerSub(), background_sub=background_sub)
    _skip_subscription_creation(engine, paths)

    asyncio.run(engine._setup_subscriptions())

    assert background_sub.create_calls == [["A", "B"], ["C", "D"], ["E"], ["C", "D"]]
    assert sorted(engine._bg_path_handles) == sorted(background_sub.live.values()) == paths


def test_the_fill_does_not_bring_back_what_a_config_save_changed_meanwhile():
    """A save during the fill swaps the datasource entry, and datasource_sync
    removes a path it disabled. Neither the rest of the fill nor its retry
    may subscribe that path again from the snapshot, or the old node of a
    path the save pointed elsewhere."""
    paths = ["A", "B", "C", "D", "E"]
    background_sub = _ServerSub(create_errors={2: TimeoutError()}, round_trip_s=0.02)
    engine = _paths_engine(paths, limit=2, priority_sub=_ServerSub(), background_sub=background_sub)
    _skip_subscription_creation(engine, paths)

    async def run() -> None:
        setup = asyncio.create_task(engine._setup_subscriptions())
        while "A" not in engine._bg_path_handles:  # the first request is done
            await asyncio.sleep(0.005)
        registry = {path: {"node_id": path, "enabled": True} for path in paths}
        registry["A"]["enabled"] = False
        registry["C"]["node_id"] = "C2"
        engine._datasource_manager._entry = _FakeDsEntry(registry=registry)
        assert await engine.remove_subscription_by_path("DS", "A")
        await setup

    asyncio.run(run())

    # [C, D] timed out; the retry sends D only.
    assert background_sub.create_calls == [["A", "B"], ["C", "D"], ["E"], ["D"]]
    assert sorted(engine._bg_path_handles) == sorted(background_sub.live.values()) == ["B", "D", "E"]


def test_a_path_promoted_and_demoted_during_setup_is_not_subscribed_twice():
    """The background setup subscribes chunk by chunk. A path promoted and
    demoted again before its chunk comes up is back on the background
    already; subscribing it a second time orphaned the first item."""
    paths = ["A1", "A2", "A3", "A4", "B"]
    priority_sub = _ServerSub(round_trip_s=0.01)
    background_sub = _ServerSub(round_trip_s=0.01)
    engine = _paths_engine(paths, limit=1, priority_sub=priority_sub, background_sub=background_sub)
    _skip_subscription_creation(engine, paths)

    async def run() -> None:
        setup = asyncio.create_task(engine._setup_subscriptions())
        await asyncio.sleep(0.001)  # the first background chunk is in flight
        await engine.set_priority_paths({"B"})
        await engine.set_priority_paths(set())
        await setup

    asyncio.run(run())

    assert [h for h, path in background_sub.live.items() if path == "B"] == engine._bg_path_handles["B"]


@pytest.mark.asyncio
async def test_connect_applies_the_priority_set_before_the_background_fill(monkeypatch):
    """The background fill subscribes the whole tree, tens of seconds on a
    large PLC: the page open in a browser must not wait for it."""
    log: list[tuple[str, list[str]]] = []

    class _Client:
        def __init__(self, *_args, **_kwargs) -> None: ...

        async def connect(self) -> None: ...

        async def disconnect(self) -> None: ...

        def get_node(self, node_id: str) -> _FakeNode:
            return _FakeNode(node_id)

        async def create_subscription(self, params, _handler, queue_maxsize=0):
            sub = _ServerSub("priority" if params.Priority == 200 else "background", log)
            sub.parameters = params
            return sub

    monkeypatch.setattr(engine_module, "Client", _Client)
    entry = _FakeDsEntry(registry={p: {"node_id": p, "enabled": True} for p in ("A", "B", "C")})
    engine = DatasourceOpcuaEngine("DS")
    engine._config = {"server_url": "opc.tcp://fake:4840"}
    engine.set_datasource_manager(_FakeDM(entry))

    async def recompute() -> None:
        await engine.set_priority_paths({"B"})

    engine.set_priority_recompute_callback(recompute)

    await engine._do_connect()
    try:
        assert log == [("priority", ["B"]), ("background", ["A", "C"])]
    finally:
        await engine._close_client()


# ── Initial values that arrive before CreateMonitoredItems returns ────────────


class _RecordingDM(_FakeDM):
    def __init__(self, entry: _FakeDsEntry) -> None:
        super().__init__(entry)
        self.updates: dict[str, Any] = {}

    def update(self, _ds: str, path: str, value: Any, priority: bool = False) -> None:
        self.updates[path] = value


def _free_url(suffix: str) -> str:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"opc.tcp://127.0.0.1:{port}/nexthmi/{suffix}/"


@pytest.mark.asyncio
@pytest.mark.parametrize("background", [False, True], ids=["promote", "background-fill"])
async def test_an_initial_value_handled_before_the_create_returns_is_kept(monkeypatch, background):
    """A server publishes a new item's value right after creating it, so the
    notification can be handled before the CreateMonitoredItems response:
    every value of the first page after a connect was dropped unrouted. A
    path the server refuses is left without a route."""
    url = _free_url("initial-values")
    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace("http://nexthmi/initial-values")
    gvl = await server.nodes.objects.add_object(ua.NodeId("GVL", idx), "GVL")
    values = {"A": 10, "B": 11, "C": 12}
    for path, value in values.items():
        await gvl.add_variable(ua.NodeId(f"GVL.{path}", idx), path, value, varianttype=ua.VariantType.Int32)
    registry = {
        path: {"node_id": f"ns={idx};s=GVL.{path}", "data_type": "Int32", "enabled": True}
        for path in [*values, "Missing"]
    }
    dm = _RecordingDM(_FakeDsEntry(registry))
    engine = DatasourceOpcuaEngine("DS")
    engine.set_datasource_manager(dm)

    create = Subscription.create_monitored_items
    held: list[bool] = []

    async def create_answered_late(sub, requests):
        results = await create(sub, requests)
        # The response "arrives" only once the new items' first values are handled.
        created = {r.ItemToMonitor.NodeId for r, res in zip(requests, results, strict=True) if isinstance(res, int)}
        deadline = time.monotonic() + 5
        while not created <= engine._wire_types.keys() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        held.append(created <= engine._wire_types.keys())
        return results

    monkeypatch.setattr(Subscription, "create_monitored_items", create_answered_late)
    await server.start()
    try:
        async with Client(url) as client:
            engine.attach_client(client, {
                "disable_background_sync": not background,
                "bg_publish_interval_ms": 250,
                "priority_publish_interval_ms": 10,
            })
            await engine._setup_subscriptions()
            if not background:
                await engine.set_priority_paths(set(registry))
            routed = set(engine._node_to_path.values())
            routed_nodes = set(engine._path_to_node_ids)
            await engine._teardown_subscriptions()
    finally:
        await server.stop()

    assert held and all(held)
    assert dm.updates == values
    assert routed == routed_nodes == set(values)  # not "Missing", which the server refused


@pytest.mark.asyncio
async def test_a_revised_publishing_interval_keeps_the_two_minute_lifetime(monkeypatch):
    """A PLC whose fastest publishing interval is 100 ms revises the 50 ms
    priority subscription. asyncua answers any revision with a keep-alive of
    75% of the session timeout, and a server must then raise the lifetime to
    three of those: an abandoned subscription held its items for hours."""
    fastest_ms = 100.0
    create = SubscriptionService.create_subscription

    async def create_at_most_this_fast(self, params, *args, **kwargs):
        params.RequestedPublishingInterval = max(params.RequestedPublishingInterval, fastest_ms)
        return await create(self, params, *args, **kwargs)

    def modify_like_the_spec(self, params):
        # asyncua's own server ignores a ModifySubscription; revise as Part 4 § 5.13.3 says.
        data = self.subscriptions[params.SubscriptionId].data
        data.RevisedPublishingInterval = max(params.RequestedPublishingInterval, fastest_ms)
        data.RevisedMaxKeepAliveCount = params.RequestedMaxKeepAliveCount
        data.RevisedLifetimeCount = max(params.RequestedLifetimeCount, 3 * params.RequestedMaxKeepAliveCount)
        return ua.ModifySubscriptionResult(
            RevisedPublishingInterval=data.RevisedPublishingInterval,
            RevisedLifetimeCount=data.RevisedLifetimeCount,
            RevisedMaxKeepAliveCount=data.RevisedMaxKeepAliveCount,
        )

    monkeypatch.setattr(SubscriptionService, "create_subscription", create_at_most_this_fast)
    monkeypatch.setattr(SubscriptionService, "modify_subscription", modify_like_the_spec)
    url = _free_url("revised-interval")
    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    await server.start()
    try:
        async with Client(url) as client:
            engine = DatasourceOpcuaEngine("DS")
            engine.set_datasource_manager(_FakeDM(_FakeDsEntry(registry={})))
            engine.attach_client(client, {"disable_background_sync": True, "priority_publish_interval_ms": 50})
            await engine._setup_subscriptions()
            (sub,) = server.iserver.subscription_service.subscriptions.values()
            revised = sub.data
            await engine._teardown_subscriptions()
    finally:
        await server.stop()

    assert revised.RevisedPublishingInterval == fastest_ms
    assert revised.RevisedMaxKeepAliveCount * fastest_ms == 30_000
    assert revised.RevisedLifetimeCount * fastest_ms == 120_000
