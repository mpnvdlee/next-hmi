import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest


def _ensure_backend_on_path() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    backend_dir = repo_root / "backend"
    backend_str = str(backend_dir)
    if backend_str not in sys.path:
        sys.path.insert(0, backend_str)


_ensure_backend_on_path()


@pytest.fixture(autouse=True)
def _no_telemetry(monkeypatch) -> None:
    """No test may phone home — every manager lifespan would otherwise ping."""
    monkeypatch.setenv("NEXTHMI_TELEMETRY", "off")


@pytest.fixture
def live_project_root(monkeypatch, tmp_path: Path) -> Path:
    """Point ``storage._active_project_path`` at a tmp folder for the test.

    Returns the flat project root. Tests that need specific subdirectories
    should call ``storage.ensure_active_project_dirs()`` after taking this
    fixture.
    """
    import core.storage as storage

    project_root = tmp_path / "live-project"
    project_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(storage, "_active_project_path", lambda: project_root)
    return project_root


@dataclass
class FakeDatasourceEntry:
    config: dict[str, Any] = field(default_factory=lambda: {"settings": {"priority_ws_batch_ms": 7}})
    ds_type: str = "opcua-client"
    registry: dict[str, dict[str, Any]] = field(default_factory=dict)
    folder_registry: dict[str, dict[str, Any]] = field(default_factory=dict)
    cache: dict[str, Any] = field(default_factory=dict)


class FakeDatasourceManager:
    def __init__(
        self,
        *,
        datasources: dict[str, FakeDatasourceEntry] | None = None,
        cached: dict[str, Any] | None = None,
        snapshot_values: dict[str, Any] | None = None,
        metadata: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.datasources = (
            datasources if datasources is not None else {"DS": FakeDatasourceEntry()}
        )
        self.cached = cached if cached is not None else {"DS:Cached": 1}
        self.snapshot_values = snapshot_values if snapshot_values is not None else {}
        self.metadata = metadata if metadata is not None else {}
        self.seeded: dict[str, Any] = {}
        self._client_keys: set[str] = set()
        self.deleted_name: str | None = None
        self.static_updates: list[tuple[str, str, Any]] = []
        self.cleared_clients: list[str] = []

    def get(self, name: str) -> FakeDatasourceEntry | None:
        return self.datasources.get(name)

    def get_entry(self, ds_name: str, path: str) -> dict[str, Any] | None:
        ds = self.datasources.get(ds_name)
        if ds is None:
            return None
        return ds.registry.get(path)

    def update_static_value(self, ds_name: str, path: str, value: Any) -> None:
        self.static_updates.append((ds_name, path, value))

    def get_cached_values(self, keys: set[str]) -> dict[str, Any]:
        return {key: self.cached[key] for key in keys if key in self.cached}

    def seed_cached_values(self, updates: dict[str, Any]) -> None:
        self.seeded.update(updates)

    def set_client_page(self, client_id: str, keys: set[str]) -> None:
        self._client_keys = set(keys)

    def get_priority_keys(self) -> set[str]:
        return set(self._client_keys)

    def delete(self, name: str) -> None:
        self.deleted_name = name

    def snapshot(self) -> dict[str, Any]:
        return dict(self.snapshot_values)

    def variable_metadata(self) -> dict[str, dict[str, Any]]:
        return dict(self.metadata)

    def clear_client(self, client_id: str) -> None:
        self.cleared_clients.append(client_id)


class FakeWebSocket:
    def __init__(self, *, fail_after: int | None = None) -> None:
        self.messages: list[dict[str, Any]] = []
        self.accepted = False
        self._fail_after = fail_after

    async def accept(self) -> None:
        self.accepted = True

    async def send_text(self, message: str) -> None:
        if self._fail_after is not None and len(self.messages) >= self._fail_after:
            raise RuntimeError("simulated send failure")
        self.messages.append(json.loads(message))


class FakeEngine:
    def __init__(self, *, raises: bool = False) -> None:
        self.priority_paths: list[set[str]] = []
        self.read_calls = 0
        self.write_calls: list[tuple[str, Any]] = []
        self.raises = raises

    async def read_current_values(self, paths: set[str]) -> dict[str, object]:
        self.read_calls += 1
        if paths == {"Fresh"}:
            return {"DS:Fresh": 2}
        return {}

    async def set_priority_paths(self, paths: set[str]) -> None:
        self.priority_paths.append(set(paths))

    async def write_node(self, node_id: str, value: Any, _variant_type: Any) -> None:
        self.write_calls.append((node_id, value))
        if self.raises:
            raise RuntimeError("simulated OPC-UA write failure")


class FakePool:
    def __init__(self, engine: FakeEngine | None, *, statuses: dict[str, bool] | None = None) -> None:
        self._engine = engine
        self._statuses = statuses if statuses is not None else {}

    def get(self, _name: str) -> FakeEngine | None:
        return self._engine

    def connection_status(self) -> dict[str, bool]:
        return dict(self._statuses)
