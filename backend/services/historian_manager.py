"""Historian manager — value listener, SQLite storage, batch writer, retention cleanup."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import sqlite3
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_BATCH_INTERVAL = 1.5
_CLEANUP_INTERVAL = 3600
_DEFAULT_RETENTION = 30 * 24 * 3600

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS samples (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    variable  TEXT    NOT NULL,
    timestamp REAL    NOT NULL,
    value     REAL
);
"""
_CREATE_INDEX = """
CREATE INDEX IF NOT EXISTS idx_samples_var_ts ON samples (variable, timestamp);
"""


class HistorianManager:
    def __init__(self) -> None:
        self._config: dict[str, Any] = {"variables": {}}
        # Pre-computed lookup snapshotted whenever set_config runs, so
        # on_variable_change (called from the datasource manager under its
        # own lock) never needs to walk self._config or hold _buffer_lock
        # while the config is being mutated.
        self._var_lookup: dict[str, dict[str, Any]] = {}
        self._buffer: list[tuple[str, float, float | None]] = []
        self._buffer_lock = threading.Lock()
        self._last_sample: dict[str, float] = {}
        # Guards _last_sample read/update in on_variable_change; the value
        # listener can fire from multiple OPC-UA subscription threads.
        self._sample_lock = threading.Lock()
        self._db: sqlite3.Connection | None = None
        # Guards the write connection; query() opens its own short-lived
        # read connection so SELECTs don't block batched inserts.
        self._db_lock = threading.Lock()
        self._db_open_path: Path | None = None
        self._batch_task: asyncio.Task | None = None
        self._cleanup_task: asyncio.Task | None = None
        self._running = False

    def _data_dir(self) -> Path:
        # Resolved per-call so a live-project switch is honoured without
        # restarting the manager — the listener immediately starts writing
        # to and reading from the new project's historian/ tree.
        from core.storage import active_project_root
        return active_project_root() / "historian"

    def _config_path(self) -> Path:
        return self._data_dir() / "config.json"

    def _db_path(self) -> Path:
        return self._data_dir() / "history.db"

    def _open_db(self) -> sqlite3.Connection:
        """Open (or reopen) the SQLite connection at the current project's db path.

        Idempotent — if the existing connection still points at the resolved
        path we keep it; otherwise we close and reopen, and reload the
        in-memory config from the new project's config.json so subsequent
        writes/queries reflect the live project's settings. Caller must hold
        ``_db_lock``.
        """
        path = self._db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        if self._db is not None:
            if self._db_open_path == path:
                return self._db
            try:
                self._db.close()
            except Exception:
                logger.exception("Error closing previous historian db connection")
            self._db = None
            # Project root changed — refresh config from the new project so we
            # don't overwrite it on the next set_config() with the previous
            # project's variable list.
            self._load_config()
        conn = sqlite3.connect(str(path), check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute(_CREATE_TABLE)
        conn.execute(_CREATE_INDEX)
        conn.commit()
        self._db = conn
        self._db_open_path = path
        return conn

    async def start(self) -> None:
        # Side effects: registers a value listener on the datasource manager
        # and opens a SQLite connection. If anything below raises, undo both
        # so the failed manager doesn't keep buffering values into a closed db
        # or a half-initialised manager.
        from services.datasource_manager import datasource_manager

        listener_registered = False
        try:
            self._load_config()
            with self._db_lock:
                self._open_db()

            datasource_manager.register_value_listener(self.on_variable_change)
            listener_registered = True

            self._running = True
            self._batch_task = asyncio.create_task(self._batch_writer())
            self._cleanup_task = asyncio.create_task(self._retention_cleanup())
            logger.info("Historian started — db: %s", self._db_path())
        except Exception:
            self._running = False
            if listener_registered:
                try:
                    datasource_manager.unregister_value_listener(self.on_variable_change)
                except Exception:
                    logger.exception("Failed to unregister historian listener during start cleanup")
            with self._db_lock:
                if self._db is not None:
                    try:
                        self._db.close()
                    except Exception:
                        logger.exception("Failed to close historian db during start cleanup")
                    self._db = None
                    self._db_open_path = None
            raise

    async def stop(self) -> None:
        self._running = False
        from services.datasource_manager import datasource_manager
        datasource_manager.unregister_value_listener(self.on_variable_change)
        for task in (self._batch_task, self._cleanup_task):
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        self._batch_task = None
        self._cleanup_task = None
        self._flush_buffer()
        with self._db_lock:
            if self._db:
                self._db.close()
                self._db = None
                self._db_open_path = None
        logger.info("Historian stopped")

    def on_variable_change(self, key: str, value: Any) -> None:
        if not self._running:
            return
        # _var_lookup is replaced wholesale by set_config(); we read a single
        # reference here so we don't need a lock against concurrent config
        # writes (the previous lookup stays consistent until set_config swaps it).
        var_config = self._var_lookup.get(key)
        if var_config is None or not var_config.get("enabled", True):
            return
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            return

        now = time.time()
        min_interval = var_config.get("minInterval", 0)
        if min_interval > 0:
            # Hold _sample_lock across the read/update window — without it,
            # two threads sampling the same key concurrently can both pass the
            # interval check on a stale ``last`` and double-write.
            with self._sample_lock:
                last = self._last_sample.get(key, 0)
                if now - last < min_interval:
                    return
                self._last_sample[key] = now
        else:
            with self._sample_lock:
                self._last_sample[key] = now

        with self._buffer_lock:
            self._buffer.append((key, now, numeric))

    async def _batch_writer(self) -> None:
        while self._running:
            await asyncio.sleep(_BATCH_INTERVAL)
            await asyncio.to_thread(self._flush_buffer)

    def _flush_buffer(self) -> None:
        with self._buffer_lock:
            if not self._buffer:
                return
            batch = self._buffer[:]
            self._buffer.clear()
        with self._db_lock:
            try:
                conn = self._open_db()
                conn.executemany(
                    "INSERT INTO samples (variable, timestamp, value) VALUES (?, ?, ?)",
                    batch,
                )
                conn.commit()
            except Exception:
                logger.exception("Historian batch write failed (%d rows)", len(batch))

    async def _retention_cleanup(self) -> None:
        while self._running:
            await asyncio.sleep(_CLEANUP_INTERVAL)
            await asyncio.to_thread(self._do_cleanup)

    def _do_cleanup(self) -> None:
        now = time.time()
        variables = self._config.get("variables", {})
        with self._db_lock:
            try:
                conn = self._open_db()
            except Exception:
                logger.exception("Retention cleanup: failed to open db")
                return
            for key, cfg in variables.items():
                retention = cfg.get("retention", _DEFAULT_RETENTION)
                cutoff = now - retention
                try:
                    conn.execute(
                        "DELETE FROM samples WHERE variable = ? AND timestamp < ?",
                        (key, cutoff),
                    )
                except Exception:
                    logger.exception("Retention cleanup failed for %s", key)
            try:
                conn.commit()
            except Exception:
                logger.exception("Retention cleanup commit failed")

    def query(
        self,
        variables: list[str],
        start: str,
        end: str,
        max_points: int = 500,
    ) -> list[dict[str, Any]]:
        start_ts = _parse_time(start)
        end_ts = _parse_time(end)
        db_path = self._db_path()
        if not db_path.exists():
            return []
        # Open a short-lived read connection so the SELECT loop doesn't block
        # the batch writer (which holds self._db_lock during commits).
        read_conn = sqlite3.connect(str(db_path), check_same_thread=False)
        try:
            read_conn.execute("PRAGMA query_only=ON;")
            result = []
            for var in variables:
                var = var.strip()
                if not var:
                    continue
                rows = read_conn.execute(
                    "SELECT timestamp, value FROM samples "
                    "WHERE variable = ? AND timestamp >= ? AND timestamp <= ? "
                    "ORDER BY timestamp",
                    (var, start_ts, end_ts),
                ).fetchall()
                data = _downsample(rows, max_points)
                result.append({"variable": var, "data": data})
            return result
        finally:
            read_conn.close()

    def get_historized_paths_by_datasource(self) -> dict[str, set[str]]:
        """Return {datasource: set-of-paths} for all enabled historian variables.

        Used by the websocket manager to keep historized variables on the
        priority (fast) OPC-UA subscription at all times — otherwise a variable
        that's enabled here but bound by no page and referenced by no alarm
        never gets subscribed, so its values never reach on_variable_change and
        nothing is ever recorded. Reads the snapshotted _var_lookup (swapped
        wholesale by set_config) so no lock is needed.
        """
        from models.datasource import parse_var_key

        result: dict[str, set[str]] = {}
        for key, cfg in self._var_lookup.items():
            if not cfg.get("enabled", True):
                continue
            ds, path = parse_var_key(key)
            if ds and path:
                result.setdefault(ds, set()).add(path)
        return result

    def get_config(self) -> dict[str, Any]:
        return dict(self._config)

    def set_config(self, config: dict[str, Any]) -> None:
        # Build the lookup *before* swapping either field so a concurrent
        # on_variable_change call sees a consistent (_config, _var_lookup)
        # pair — never a new config with the stale lookup, or vice versa.
        new_lookup = dict(config.get("variables", {}) or {})
        self._var_lookup = new_lookup
        self._config = config
        self._save_config()

    def get_status(self) -> dict[str, Any]:
        empty = {"dbSizeBytes": 0, "variableCount": 0, "totalSamples": 0,
                 "oldestSample": None, "newestSample": None}
        db_path = self._db_path()
        if not db_path.exists():
            return empty
        with self._db_lock:
            try:
                conn = self._open_db()
                row = conn.execute(
                    "SELECT COUNT(DISTINCT variable), COUNT(*), MIN(timestamp), MAX(timestamp) "
                    "FROM samples"
                ).fetchone()
            except Exception:
                return empty
        db_size = db_path.stat().st_size if db_path.exists() else 0
        oldest = _ts_to_iso(row[2]) if row[2] else None
        newest = _ts_to_iso(row[3]) if row[3] else None
        return {
            "dbSizeBytes": db_size,
            "variableCount": row[0],
            "totalSamples": row[1],
            "oldestSample": oldest,
            "newestSample": newest,
        }

    def _load_config(self) -> None:
        path = self._config_path()
        if path.exists():
            try:
                from core.storage import read_json
                new_config = read_json(path)
            except Exception:
                logger.exception("Failed to load historian config")
                new_config = {"variables": {}}
        else:
            new_config = {"variables": {}}
        # Swap order matches set_config — lookup first, then config — so
        # any concurrent reader sees a coherent pair.
        new_lookup = dict(new_config.get("variables", {}) or {})
        self._var_lookup = new_lookup
        self._config = new_config

    def _save_config(self) -> None:
        from core.storage import write_json
        self._config_path().parent.mkdir(parents=True, exist_ok=True)
        write_json(self._config_path(), self._config)


_TIME_UNIT_MULTIPLIERS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def _parse_time(s: str) -> float:
    """Parse 'now', '-Nh/Nm/Ns/Nd' relative offsets, or ISO-8601 timestamps.

    Raises ``ValueError`` for malformed input so the FastAPI layer can return
    422 rather than silently substituting time.time() (which would make the
    query return nothing with no clue).
    """
    if s == "now":
        return time.time()
    if s.startswith("-"):
        unit = s[-1]
        if unit not in _TIME_UNIT_MULTIPLIERS:
            raise ValueError(f"Invalid time unit in {s!r}; expected s/m/h/d")
        amount = float(s[1:-1])
        return time.time() - amount * _TIME_UNIT_MULTIPLIERS[unit]
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp()


def _ts_to_iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=UTC).isoformat()


def _downsample(rows: list[tuple[float, float | None]], max_points: int) -> list[dict[str, Any]]:
    if len(rows) <= max_points:
        return [{"t": r[0], "v": r[1]} for r in rows]
    step = len(rows) / max_points
    result = []
    for i in range(max_points):
        idx = int(i * step)
        r = rows[idx]
        result.append({"t": r[0], "v": r[1]})
    return result


historian_manager = HistorianManager()
