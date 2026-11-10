"""Tests for the historian manager — buffer, flush, query, config."""
from __future__ import annotations

import asyncio
import sqlite3
import threading
import time
import tracemalloc
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import httpx
import pytest
from api import historian_api
from fastapi import FastAPI
from fastapi.testclient import TestClient
from services.historian_manager import (
    _CREATE_INDEX,
    _CREATE_TABLE,
    MAX_QUERY_POINTS,
    MAX_QUERY_VARIABLES,
    HistorianManager,
    historian_manager,
)


def _make_manager(tmp_path: Path, variables: dict[str, Any] | None = None) -> HistorianManager:
    mgr = HistorianManager()
    # Pin the data dir to tmp_path so _db_path() / _config_path() resolve
    # locally without needing a live project bootstrap.
    mgr._data_dir = lambda: tmp_path  # type: ignore[method-assign]
    db_path = tmp_path / "history.db"
    mgr._db = sqlite3.connect(str(db_path), check_same_thread=False)
    mgr._db_open_path = db_path
    mgr._db.execute("PRAGMA journal_mode=WAL;")
    mgr._db.execute(_CREATE_TABLE)
    mgr._db.execute(_CREATE_INDEX)
    mgr._db.commit()
    vars_map = variables or {}
    mgr._config = {"variables": vars_map}
    mgr._var_lookup = dict(vars_map)
    mgr._running = True
    return mgr


class TestOnVariableChange:
    def test_buffers_configured_variable(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={"PLC1:Temp": {"enabled": True, "minInterval": 0}})
        mgr.on_variable_change("PLC1:Temp", 42.5)
        assert len(mgr._buffer) == 1
        assert mgr._buffer[0][0] == "PLC1:Temp"
        assert mgr._buffer[0][2] == 42.5

    def test_ignores_unconfigured_variable(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={"PLC1:Temp": {"enabled": True}})
        mgr.on_variable_change("PLC1:Other", 10)
        assert len(mgr._buffer) == 0

    def test_ignores_disabled_variable(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={"PLC1:Temp": {"enabled": False}})
        mgr.on_variable_change("PLC1:Temp", 10)
        assert len(mgr._buffer) == 0

    def test_ignores_non_numeric(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={"PLC1:Temp": {"enabled": True}})
        mgr.on_variable_change("PLC1:Temp", "hello")
        assert len(mgr._buffer) == 0

    def test_buffers_a_counter_beyond_two_to_the_53_as_a_number(self, tmp_path):
        # The cache holds such a counter as its decimal string.
        mgr = _make_manager(tmp_path, variables={"PLC1:Count": {"enabled": True, "minInterval": 0}})
        mgr.on_variable_change("PLC1:Count", "9223372036854775808")
        assert mgr._buffer[0][2] == 9223372036854775808.0

    def test_min_interval_filter(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={"PLC1:Temp": {"enabled": True, "minInterval": 10}})
        mgr.on_variable_change("PLC1:Temp", 1.0)
        mgr.on_variable_change("PLC1:Temp", 2.0)
        assert len(mgr._buffer) == 1


class TestFlushAndQuery:
    def test_flush_writes_to_db(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={"PLC1:Temp": {"enabled": True, "minInterval": 0}})
        mgr.on_variable_change("PLC1:Temp", 10.0)
        mgr.on_variable_change("PLC1:Temp", 20.0)
        mgr._flush_buffer()

        with mgr._db_lock:
            count = mgr._db.execute("SELECT COUNT(*) FROM samples").fetchone()[0]
        assert count == 2

    def test_query_returns_data(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={"PLC1:Temp": {"enabled": True, "minInterval": 0}})
        now = time.time()
        with mgr._buffer_lock:
            mgr._buffer.append(("PLC1:Temp", now - 10, 42.0))
            mgr._buffer.append(("PLC1:Temp", now - 5, 43.0))
        mgr._flush_buffer()

        result = mgr.query(variables=["PLC1:Temp"], start="-1h", end="now", max_points=100)
        assert len(result) == 1
        assert result[0]["variable"] == "PLC1:Temp"
        assert len(result[0]["data"]) == 2

    def test_query_empty_db(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={})
        result = mgr.query(variables=["PLC1:Temp"], start="-1h", end="now")
        assert result == [{"variable": "PLC1:Temp", "data": []}]

    def test_downsampling(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={})
        now = time.time()
        with mgr._buffer_lock:
            for i in range(100):
                mgr._buffer.append(("PLC1:Temp", now - 100 + i, float(i)))
        mgr._flush_buffer()

        result = mgr.query(variables=["PLC1:Temp"], start="-1h", end="now", max_points=10)
        assert len(result[0]["data"]) == 10


def _insert(mgr: HistorianManager, rows: Iterable[tuple[str, float, float]]) -> None:
    with mgr._db_lock:
        mgr._db.executemany("INSERT INTO samples (variable, timestamp, value) VALUES (?, ?, ?)", rows)
        mgr._db.commit()


class TestQueryBounds:
    """The query endpoint is public: no request may make the server hold an
    unbounded number of samples."""

    def test_memory_does_not_grow_with_the_samples_in_range(self, tmp_path):
        mgr = _make_manager(tmp_path)
        now = time.time()
        _insert(mgr, (("PLC1:Temp", now - 100_000 + i, float(i)) for i in range(100_000)))

        tracemalloc.start()
        try:
            result = mgr.query(variables=["PLC1:Temp"], start="-100000d", end="now", max_points=500)
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()

        assert len(result[0]["data"]) == 500
        # Reading the whole range held ~12 MB of rows; downsampling in SQL
        # stays well under one.
        assert peak < 4_000_000

    def test_downsampled_points_span_the_range_in_time_order(self, tmp_path):
        mgr = _make_manager(tmp_path)
        _insert(mgr, (("PLC1:Temp", 1000.0 + i, float(i)) for i in range(1000)))

        data = mgr.query(
            variables=["PLC1:Temp"], start="1970-01-01T00:00:00", end="now", max_points=10,
        )[0]["data"]

        # Ten equal time buckets over 1000..1999, each giving its first sample.
        assert data == [{"t": 1000.0 + 100 * k, "v": 100.0 * k} for k in range(10)]

    def test_a_range_within_max_points_comes_back_whole(self, tmp_path):
        mgr = _make_manager(tmp_path)
        _insert(mgr, (("PLC1:Temp", 1000.0 + i, float(i)) for i in range(10)))

        data = mgr.query(
            variables=["PLC1:Temp"], start="1970-01-01T00:00:00", end="now", max_points=10,
        )[0]["data"]

        assert data == [{"t": 1000.0 + i, "v": float(i)} for i in range(10)]

    def test_repeated_variables_are_read_once(self, tmp_path):
        mgr = _make_manager(tmp_path)
        _insert(mgr, [("PLC1:Temp", time.time() - 5, 1.0)])

        result = mgr.query(variables=["PLC1:Temp", " PLC1:Temp", "", "PLC1:Temp "], start="-1h", end="now")

        assert [s["variable"] for s in result] == ["PLC1:Temp"]

    def test_too_many_variables_is_refused(self, tmp_path):
        mgr = _make_manager(tmp_path)
        keys = [f"PLC1:T{i}" for i in range(MAX_QUERY_VARIABLES + 1)]
        with pytest.raises(ValueError, match="Too many variables"):
            mgr.query(variables=keys, start="-1h", end="now", max_points=1)
        assert len(mgr.query(variables=keys[:-1], start="-1h", end="now", max_points=1)) == len(keys) - 1

    def test_too_many_points_is_refused(self, tmp_path):
        mgr = _make_manager(tmp_path)
        keys = [f"PLC1:T{i}" for i in range(MAX_QUERY_POINTS // 10_000 + 1)]
        with pytest.raises(ValueError, match="Too many points"):
            mgr.query(variables=keys, start="-1h", end="now", max_points=10_000)
        mgr.query(variables=keys[:-1], start="-1h", end="now", max_points=10_000)

    def test_the_endpoint_answers_a_refusal_with_a_readable_422(self):
        app = FastAPI()
        app.include_router(historian_api.router)
        keys = ",".join(f"PLC1:T{i}" for i in range(MAX_QUERY_VARIABLES + 1))

        response = TestClient(app).get("/api/historian/query", params={"variables": keys, "start": "-1h"})

        assert response.status_code == 422
        assert response.json()["detail"].startswith("Too many variables")


class TestQueryThreads:
    """The query endpoint is public: a burst of queries must not hold up the
    default thread pool other work needs (a sign-in's password check runs there)."""

    @pytest.mark.asyncio
    async def test_a_query_burst_leaves_the_default_pool_free(self, monkeypatch):
        release = threading.Event()
        lock = threading.Lock()
        running = peak = 0

        def stuck_query(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
            nonlocal running, peak
            with lock:
                running += 1
                peak = max(peak, running)
            release.wait(10)
            with lock:
                running -= 1
            return []

        monkeypatch.setattr(historian_manager, "query", stuck_query)
        app = FastAPI()
        app.include_router(historian_api.router)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://hmi") as client:
            # More than the default pool's workers (at most 32), all stuck.
            burst = [
                asyncio.create_task(client.get("/api/historian/query", params={"variables": "PLC1:T", "start": "-1h"}))
                for _ in range(64)
            ]
            await asyncio.sleep(0.2)
            try:
                started = time.perf_counter()
                await asyncio.wait_for(asyncio.to_thread(int), timeout=5)
                waited = time.perf_counter() - started
            finally:
                release.set()
            responses = await asyncio.gather(*burst)

        assert waited < 0.5
        assert peak <= 2
        assert {r.status_code for r in responses} == {200}


class TestStatus:
    def test_status_empty(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={})
        status = mgr.get_status()
        assert status["totalSamples"] == 0
        assert status["variableCount"] == 0

    def test_status_with_data(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={"PLC1:Temp": {"enabled": True, "minInterval": 0}})
        now = time.time()
        with mgr._buffer_lock:
            mgr._buffer.append(("PLC1:Temp", now, 42.0))
        mgr._flush_buffer()

        status = mgr.get_status()
        assert status["totalSamples"] == 1
        assert status["variableCount"] == 1
        assert status["dbSizeBytes"] > 0


class TestConfig:
    def test_get_set_config(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={})
        new_config = {"variables": {"PLC1:Temp": {"enabled": True, "minInterval": 1}}}
        mgr.set_config(new_config)
        assert mgr.get_config() == new_config


class TestHistorizedPathsByDatasource:
    def test_groups_enabled_paths_by_datasource(self, tmp_path):
        mgr = _make_manager(
            tmp_path,
            variables={
                "LegacyPLC:Pump1/Flow": {"enabled": True},
                "LegacyPLC:Pump1/Fault": {"enabled": True},
                "PLC1:Temp": {"enabled": True},
            },
        )
        assert mgr.get_historized_paths_by_datasource() == {
            "LegacyPLC": {"Pump1/Flow", "Pump1/Fault"},
            "PLC1": {"Temp"},
        }

    def test_excludes_disabled(self, tmp_path):
        mgr = _make_manager(
            tmp_path,
            variables={
                "LegacyPLC:Pump1/Flow": {"enabled": True},
                "LegacyPLC:Pump1/Fault": {"enabled": False},
            },
        )
        assert mgr.get_historized_paths_by_datasource() == {"LegacyPLC": {"Pump1/Flow"}}

    def test_empty_when_no_variables(self, tmp_path):
        mgr = _make_manager(tmp_path, variables={})
        assert mgr.get_historized_paths_by_datasource() == {}
