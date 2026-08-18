"""Tests for WebSocketManager.schedule_priority_recompute (A9 coalescing).

alarm_manager (and other config writers) call this after every config save,
possibly in a fast concurrent burst. It must coalesce overlapping calls into
one running recompute plus at most one trailing rerun, and must never let a
recompute failure propagate to the caller.
"""
from __future__ import annotations

import asyncio

import pytest
from conftest import FakeDatasourceManager, FakeEngine, FakePool
from services.websocket_manager import WebSocketManager


def _manager(engine: FakeEngine) -> WebSocketManager:
    manager = WebSocketManager()
    manager.set_datasource_manager(FakeDatasourceManager())
    manager.set_opcua_pool(FakePool(engine))
    return manager


@pytest.mark.asyncio
async def test_schedule_runs_recompute_once():
    engine = FakeEngine()
    manager = _manager(engine)

    manager.schedule_priority_recompute()
    await manager._priority_recompute_task

    assert len(engine.priority_paths) == 1


@pytest.mark.asyncio
async def test_concurrent_schedules_coalesce_into_one_rerun():
    """A burst of calls while a recompute is running must not stack one task
    per call — the in-flight run absorbs them into a single trailing rerun."""
    engine = FakeEngine()
    manager = _manager(engine)

    run_count = 0
    real_recompute = manager.recompute_priority_subscriptions

    async def counting_recompute():
        nonlocal run_count
        run_count += 1
        await asyncio.sleep(0)  # yield so callers actually overlap
        await real_recompute()

    manager.recompute_priority_subscriptions = counting_recompute  # type: ignore[method-assign]

    manager.schedule_priority_recompute()
    # Fired while the first run is still in flight — must coalesce, not queue.
    manager.schedule_priority_recompute()
    manager.schedule_priority_recompute()
    manager.schedule_priority_recompute()

    await manager._priority_recompute_task

    assert run_count == 2  # one in-flight run + exactly one trailing rerun
    assert manager._priority_recompute_rerun is False


@pytest.mark.asyncio
async def test_per_engine_recompute_failure_is_contained(caplog):
    """An OPC-UA engine failure (e.g. offline) must not fail the recompute task
    as a whole — recompute_priority_subscriptions() already gathers with
    return_exceptions=True and logs a warning per failing datasource."""
    class RaisingEngine(FakeEngine):
        async def set_priority_paths(self, paths: set[str]) -> None:
            raise RuntimeError("simulated OPC-UA failure")

    manager = _manager(RaisingEngine())

    with caplog.at_level("WARNING"):
        manager.schedule_priority_recompute()
        await manager._priority_recompute_task

    assert manager._priority_recompute_task.exception() is None
    assert "simulated OPC-UA failure" in caplog.text


@pytest.mark.asyncio
async def test_recompute_failure_is_logged_not_raised(caplog):
    """If recompute_priority_subscriptions() itself raises (not just a
    per-engine failure), the background task must still swallow it."""
    manager = _manager(FakeEngine())

    async def boom():
        raise RuntimeError("simulated recompute failure")

    manager.recompute_priority_subscriptions = boom  # type: ignore[method-assign]

    with caplog.at_level("ERROR"):
        manager.schedule_priority_recompute()
        await manager._priority_recompute_task

    assert manager._priority_recompute_task.exception() is None
    assert "recompute failed" in caplog.text.lower()


@pytest.mark.asyncio
async def test_rerun_reflects_state_mutated_during_in_flight_run():
    """The trailing rerun must read live state, not a snapshot taken when it
    was scheduled — a save that lands mid-recompute must still be reflected."""
    engine = FakeEngine()
    manager = _manager(engine)
    real_recompute = manager.recompute_priority_subscriptions

    first_run_started = asyncio.Event()
    proceed = asyncio.Event()

    async def gated_recompute():
        first_run_started.set()
        await proceed.wait()
        await real_recompute()

    manager.recompute_priority_subscriptions = gated_recompute  # type: ignore[method-assign]

    manager.schedule_priority_recompute()
    await first_run_started.wait()

    # A second save lands while the first run is still gated in flight.
    manager._datasource_manager.set_client_page("c1", {"DS:Fresh"})
    manager.schedule_priority_recompute()
    assert manager._priority_recompute_rerun is True

    manager.recompute_priority_subscriptions = real_recompute  # type: ignore[method-assign]
    proceed.set()
    await manager._priority_recompute_task

    # The rerun (second call) must have seen the newly saved key.
    assert {"Fresh"} in engine.priority_paths


@pytest.mark.asyncio
async def test_schedule_after_completion_starts_a_new_task():
    engine = FakeEngine()
    manager = _manager(engine)

    manager.schedule_priority_recompute()
    await manager._priority_recompute_task
    first_task = manager._priority_recompute_task

    manager.schedule_priority_recompute()
    second_task = manager._priority_recompute_task
    await second_task

    assert first_task is not second_task
    assert len(engine.priority_paths) == 2
