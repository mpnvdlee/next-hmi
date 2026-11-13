"""A datasource's variable metadata is built off the event loop.

Describing a large PLC's 72,000 variables took the first `set_context` after a
start or a save 180-530 ms of event loop. An entry is replaced on every edit and
never mutated, so the description is built in a worker thread as soon as the
entry exists; a `set_context` that comes first builds it itself, or waits for
the build already running instead of making a second one.
"""

import threading
import time
from pathlib import Path

import pytest
from core import storage
from models.datasource import build_var_key
from services.datasource_manager import DatasourceEntry, DatasourceManager

SPEED = build_var_key("DS", "Speed")


def _config() -> dict:
    return {"name": "DS", "type": "opcua-client", "settings": {}, "variables": [
        {"display_name": "Speed", "node_id": "ns=2;s=Speed", "data_type": "Float", "enabled": True},
    ]}


def _built(entry: DatasourceEntry) -> bool:
    return entry._metadata_index is not None


def _record_builds(monkeypatch, delay: float = 0.0) -> list[threading.Thread]:
    builders: list[threading.Thread] = []
    real = DatasourceEntry._build_metadata_index

    def build(entry: DatasourceEntry):
        builders.append(threading.current_thread())
        time.sleep(delay)
        return real(entry)

    monkeypatch.setattr(DatasourceEntry, "_build_metadata_index", build)
    return builders


def test_load_all_builds_the_metadata_in_a_worker_thread(monkeypatch, live_project_root: Path):
    storage.active_datasources_dir().mkdir(parents=True, exist_ok=True)
    storage.write_json(storage.active_datasources_dir() / "DS.json", _config())
    builders = _record_builds(monkeypatch)
    manager = DatasourceManager()

    manager.load_all()

    entry = manager.get("DS")
    deadline = time.monotonic() + 5
    while not _built(entry) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert _built(entry)
    assert builders and threading.main_thread() not in builders


@pytest.mark.asyncio
async def test_save_async_returns_with_the_metadata_built(monkeypatch, live_project_root: Path):
    builders = _record_builds(monkeypatch)
    manager = DatasourceManager()

    await manager.save_async("DS", _config())

    assert _built(manager.get("DS"))
    assert threading.main_thread() not in builders
    assert manager.variable_metadata({SPEED})[SPEED]["type"]["base"] == "Float"


def test_a_context_before_the_warm_up_builds_it_itself():
    manager = DatasourceManager()
    manager.datasources["DS"] = DatasourceEntry(_config())

    assert manager.variable_metadata({SPEED})[SPEED]["type"]["base"] == "Float"


def test_a_context_during_the_warm_up_waits_for_it(monkeypatch):
    builders = _record_builds(monkeypatch, delay=0.2)
    manager = DatasourceManager()
    entry = DatasourceEntry(_config())
    manager.datasources["DS"] = entry
    warm = threading.Thread(target=lambda: entry.metadata_index)
    warm.start()
    while not builders:
        time.sleep(0.001)

    meta = manager.variable_metadata({SPEED})
    warm.join()

    assert meta[SPEED]["type"]["base"] == "Float"
    assert builders == [warm]
