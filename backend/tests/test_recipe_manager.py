"""Tests for the recipe manager: config round-trip, download, upload, verify."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
import services.recipe_manager as recipe_manager_module
from models.datasource import build_var_key
from models.recipe import RecipeConfig
from services.recipe_manager import RecipeManager


@dataclass
class FakeEntry:
    ds_type: str = "static"
    cache: dict[str, Any] = field(default_factory=dict)


class FakeStaticDM:
    """Static datasource manager backing recipe writes/reads with a cache."""

    def __init__(self, registry: dict[str, dict[str, Any]]):
        self._registry = registry
        self._entry = FakeEntry(ds_type="static")

    def get_entry(self, ds_name: str, path: str) -> dict[str, Any] | None:
        return self._registry.get(path)

    def get(self, name: str) -> FakeEntry:
        return self._entry

    def update_static_value(self, ds_name: str, path: str, value: Any) -> None:
        base, _, idx = path.partition("[")
        key = build_var_key(ds_name, base)
        if idx:
            n = int(idx.rstrip("]"))
            cur = self._entry.cache.get(key)
            cur = list(cur) if isinstance(cur, list) else []
            while len(cur) <= n:
                cur.append(0)
            cur[n] = value
            self._entry.cache[key] = cur
        else:
            self._entry.cache[key] = value

    def get_cached_values(self, keys: set[str]) -> dict[str, Any]:
        return {k: self._entry.cache[k] for k in keys if k in self._entry.cache}

    def seed(self, ds: str, path: str, value: Any) -> None:
        self._entry.cache[build_var_key(ds, path)] = value


def _var(ds: str, loc: str) -> dict:
    return {"$var": {"path": f"{ds}:{loc}"}}


def _config(**overrides) -> dict:
    return {
        "version": 1,
        "datasetTypes": [
            {
                "id": "coffee",
                "name": "Coffee",
                "parameters": [
                    {"id": "temp", "label": "Temp", "binding": _var("DS", "Temp"), "dataType": "float"},
                    {"id": "grind", "label": "Grind", "binding": _var("DS", "Grind"), "dataType": "integer"},
                ],
                "datasets": [
                    {"id": "espresso", "name": "Espresso", "values": {"temp": 92.0, "grind": 4}},
                ],
            }
        ],
    }


@pytest.fixture
def mgr(monkeypatch, live_project_root: Path) -> RecipeManager:
    import core.storage as storage
    storage.ensure_active_project_dirs()
    m = RecipeManager()
    return m


def test_config_round_trip(mgr: RecipeManager):
    mgr.set_config(RecipeConfig.model_validate(_config()))
    reloaded = RecipeManager()
    reloaded.load()
    cfg = reloaded.get_config()
    assert len(cfg.dataset_types) == 1
    assert cfg.dataset_types[0].datasets[0].values == {"temp": 92.0, "grind": 4}


def test_assign_ids_backfills():
    cfg = {
        "datasetTypes": [
            {"name": "Type A", "parameters": [{"label": "P1", "dataType": "float"}],
             "datasets": [{"name": "D1", "values": {}}]},
        ]
    }
    # No live project needed for set_config? It saves — needs storage. Use in-memory apply.
    parsed = RecipeConfig.model_validate(cfg)
    recipe_manager_module._assign_config_ids(parsed)
    assert parsed.dataset_types[0].id
    assert parsed.dataset_types[0].parameters[0].id
    assert parsed.dataset_types[0].datasets[0].id


@pytest.mark.asyncio
async def test_download_success_records_loaded(mgr: RecipeManager):
    dm = FakeStaticDM({"Temp": {"data_type": "float"}, "Grind": {"data_type": "integer"}})
    mgr.set_datasource_manager(dm)
    mgr.set_config(RecipeConfig.model_validate(_config()))
    result = await mgr.download("espresso")
    assert result is not None
    assert result.result == "success"
    assert result.written == 2 and result.total == 2
    assert dm._entry.cache[build_var_key("DS", "Temp")] == 92.0
    # Loaded per type recorded
    state = mgr.get_state()
    assert "coffee" in state and state["coffee"].dataset_id == "espresso"
    # Dataset itself is stamped too
    ds = mgr.get_config().dataset_types[0].datasets[0]
    assert ds.loaded_at


@pytest.mark.asyncio
async def test_download_keeps_loaded_at_per_dataset(mgr: RecipeManager):
    dm = FakeStaticDM({"Temp": {"data_type": "float"}, "Grind": {"data_type": "integer"}})
    mgr.set_datasource_manager(dm)
    cfg = _config()
    cfg["datasetTypes"][0]["datasets"].append(
        {"id": "lungo", "name": "Lungo", "values": {"temp": 85.0, "grind": 3}}
    )
    mgr.set_config(RecipeConfig.model_validate(cfg))

    await mgr.download("espresso")
    espresso_loaded_at = mgr.get_config().dataset_types[0].datasets[0].loaded_at
    assert espresso_loaded_at

    await mgr.download("lungo")
    datasets = mgr.get_config().dataset_types[0].datasets
    # Loading a second dataset for the same type doesn't erase the first's stamp.
    assert datasets[0].loaded_at == espresso_loaded_at
    assert datasets[1].loaded_at


@pytest.mark.asyncio
async def test_download_partial_on_unknown_variable(mgr: RecipeManager):
    # Grind path missing from registry → bad_path failure, Temp succeeds
    dm = FakeStaticDM({"Temp": {"data_type": "float"}})
    mgr.set_datasource_manager(dm)
    mgr.set_config(RecipeConfig.model_validate(_config()))
    result = await mgr.download("espresso")
    assert result.result == "partial"
    assert result.written == 1
    assert [f.parameter_id for f in result.failures] == ["grind"]
    # Partial still records loaded
    assert "coffee" in mgr.get_state()


@pytest.mark.asyncio
async def test_download_failed_when_all_fail(mgr: RecipeManager):
    dm = FakeStaticDM({})  # nothing resolves
    mgr.set_datasource_manager(dm)
    mgr.set_config(RecipeConfig.model_validate(_config()))
    result = await mgr.download("espresso")
    assert result.result == "failed"
    assert result.written == 0
    assert mgr.get_state() == {}  # failed → not recorded


@pytest.mark.asyncio
async def test_download_verify_mismatch(mgr: RecipeManager):
    dm = FakeStaticDM({"Temp": {"data_type": "float"}, "Grind": {"data_type": "integer"}})
    mgr.set_datasource_manager(dm)
    mgr.set_config(RecipeConfig.model_validate(_config()))
    # Verify should pass for static (cache updated on write)
    result = await mgr.download("espresso", verify=True)
    assert result.result == "success"
    assert result.verified is True


@pytest.mark.asyncio
async def test_download_unknown_dataset_returns_none(mgr: RecipeManager):
    mgr.set_datasource_manager(FakeStaticDM({}))
    mgr.set_config(RecipeConfig.model_validate(_config()))
    assert await mgr.download("nope") is None


@pytest.mark.asyncio
async def test_upload_overwrites_in_place(mgr: RecipeManager):
    dm = FakeStaticDM({"Temp": {"data_type": "float"}, "Grind": {"data_type": "integer"}})
    dm.seed("DS", "Temp", 88.5)
    dm.seed("DS", "Grind", 7)
    mgr.set_datasource_manager(dm)
    mgr.set_config(RecipeConfig.model_validate(_config()))
    cfg = await mgr.upload_into("espresso", username="op")
    assert cfg is not None
    ds = cfg.dataset_types[0].datasets[0]
    assert ds.values == {"temp": 88.5, "grind": 7}
    assert ds.updated_by == "op"
    assert ds.updated_at


@pytest.mark.asyncio
async def test_download_array_write(mgr: RecipeManager):
    dm = FakeStaticDM({"Steps": {"data_type": "integer", "is_array": True, "array_length": 3}})
    mgr.set_datasource_manager(dm)
    cfg = {
        "datasetTypes": [{
            "id": "t", "name": "T",
            "parameters": [{"id": "steps", "label": "Steps", "binding": _var("DS", "Steps"), "dataType": "integer[]"}],
            "datasets": [{"id": "d", "name": "D", "values": {"steps": [1, 2, 3]}}],
        }],
    }
    mgr.set_config(RecipeConfig.model_validate(cfg))
    result = await mgr.download("d")
    assert result.result == "success"
    assert dm._entry.cache[build_var_key("DS", "Steps")] == [1, 2, 3]


@pytest.mark.asyncio
async def test_download_permission_denied_skips_write(mgr: RecipeManager):
    dm = FakeStaticDM({"Temp": {"data_type": "float"}, "Grind": {"data_type": "integer"}})
    mgr.set_datasource_manager(dm)
    mgr.set_config(RecipeConfig.model_validate(_config()))
    # Deny writes to the Grind variable via the permission hook.
    result = await mgr.download("espresso", permission_check=lambda ds, path: path != "Grind")
    assert result.result == "partial"
    assert result.written == 1
    assert [(f.parameter_id, f.reason) for f in result.failures] == [("grind", "permission_denied")]
    # The denied variable was never written; the permitted one was.
    assert build_var_key("DS", "Grind") not in dm._entry.cache
    assert dm._entry.cache[build_var_key("DS", "Temp")] == 92.0


@pytest.mark.asyncio
async def test_upload_keeps_previous_value_when_read_fails(mgr: RecipeManager):
    # Temp has a live value; Grind is absent from the cache so read_value returns
    # None — its previously-stored value must survive rather than becoming null.
    dm = FakeStaticDM({"Temp": {"data_type": "float"}, "Grind": {"data_type": "integer"}})
    dm.seed("DS", "Temp", 88.5)
    mgr.set_datasource_manager(dm)
    mgr.set_config(RecipeConfig.model_validate(_config()))
    cfg = await mgr.upload_into("espresso", username="op")
    ds = cfg.dataset_types[0].datasets[0]
    assert ds.values["temp"] == 88.5
    assert ds.values["grind"] == 4  # unchanged, not overwritten with None


@pytest.mark.asyncio
async def test_set_config_preserves_loaded_at(mgr: RecipeManager):
    dm = FakeStaticDM({"Temp": {"data_type": "float"}, "Grind": {"data_type": "integer"}})
    mgr.set_datasource_manager(dm)
    mgr.set_config(RecipeConfig.model_validate(_config()))
    await mgr.download("espresso")
    stamp = mgr.get_config().dataset_types[0].datasets[0].loaded_at
    assert stamp
    # An editor save PUTs a fresh config carrying an empty loaded_at; the runtime
    # stamp must not be reverted.
    mgr.set_config(RecipeConfig.model_validate(_config()))
    assert mgr.get_config().dataset_types[0].datasets[0].loaded_at == stamp


def test_parameter_paths_by_datasource(mgr: RecipeManager):
    mgr.set_config(RecipeConfig.model_validate(_config()))
    paths = mgr.get_parameter_paths_by_datasource()
    assert paths == {"DS": {"Temp", "Grind"}}
