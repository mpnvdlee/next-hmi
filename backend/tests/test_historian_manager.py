"""Tests for the historian manager — buffer, flush, query, config."""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any

from services.historian_manager import (
    _CREATE_INDEX,
    _CREATE_TABLE,
    HistorianManager,
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
