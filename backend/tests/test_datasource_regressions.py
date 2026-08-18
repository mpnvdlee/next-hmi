import asyncio
from pathlib import Path

import api.datasource_api as datasource_api
import core.storage as storage
import pytest
from asyncua import ua
from conftest import FakeDatasourceEntry, FakeDatasourceManager
from core.exceptions import DatasourceValidationError
from models.datasource import build_var_key
from opcua.client_pool import DatasourceOpcuaEngine, OpcuaPool
from services.datasource_manager import DatasourceEntry, DatasourceManager


def test_indexed_write_rejected_out_of_bounds_for_fixed_array() -> None:
    """§1.9: writing MyArray[10] on a fixed array_length=5 must be rejected,
    leaving the cache untouched (not silently grown to 11 elements)."""
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {
                "display_name": "MyArray",
                "data_type": "Float",
                "is_array": True,
                "array_length": 5,
                "enabled": True,
            }
        ],
    }
    manager = DatasourceManager()
    entry = DatasourceEntry(config)
    manager.datasources["DS"] = entry
    manager._load_static_values(entry)
    key = build_var_key("DS", "MyArray")
    assert entry.cache[key] == [0.0] * 5

    with pytest.raises(DatasourceValidationError):
        manager.update_static_value("DS", "MyArray[10]", 9.0)
    assert entry.cache[key] == [0.0] * 5  # untouched


def test_indexed_write_grows_dynamic_array() -> None:
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {
                "display_name": "Dyn",
                "data_type": "Float",
                "is_array": True,
                "enabled": True,
            }
        ],
    }
    manager = DatasourceManager()
    entry = DatasourceEntry(config)
    manager.datasources["DS"] = entry
    manager._load_static_values(entry)
    key = build_var_key("DS", "Dyn")
    assert entry.cache[key] == []

    manager.update_static_value("DS", "Dyn[2]", 7.0)
    assert entry.cache[key] == [0.0, 0.0, 7.0]


def test_static_dynamic_array_defaults_to_empty_list() -> None:
    """§1.8 / D-ARRAY.3: is_array with no fixed length defaults to [], not [0]."""
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {
                "display_name": "Dyn",
                "data_type": "Float",
                "is_array": True,
                "enabled": True,
            }
        ],
    }
    manager = DatasourceManager()
    entry = DatasourceEntry(config)
    manager.datasources["DS"] = entry
    manager._load_static_values(entry)
    assert entry.cache[build_var_key("DS", "Dyn")] == []


def test_static_fixed_array_defaults_to_sized_zero_list() -> None:
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {
                "display_name": "Fixed",
                "data_type": "Float",
                "is_array": True,
                "array_length": 3,
                "enabled": True,
            }
        ],
    }
    manager = DatasourceManager()
    entry = DatasourceEntry(config)
    manager.datasources["DS"] = entry
    manager._load_static_values(entry)
    assert entry.cache[build_var_key("DS", "Fixed")] == [0.0, 0.0, 0.0]


def test_save_disambiguates_filename_collisions(live_project_root: Path) -> None:
    """§1.4: "PLC 1" and "PLC/1" both sanitize to "PLC_1" — must not collide."""
    storage.active_datasources_dir().mkdir(parents=True, exist_ok=True)
    manager = DatasourceManager()

    manager.save("PLC 1", {"name": "PLC 1", "type": "static", "variables": []})
    manager.save("PLC/1", {"name": "PLC/1", "type": "static", "variables": []})

    files = sorted(storage.active_datasources_dir().glob("*.json"))
    assert len(files) == 2

    manager.load_all()
    assert set(manager.datasources.keys()) == {"PLC 1", "PLC/1"}


def test_save_reuses_same_filename_on_repeat_save(live_project_root: Path) -> None:
    storage.active_datasources_dir().mkdir(parents=True, exist_ok=True)
    manager = DatasourceManager()

    manager.save("PLC 1", {"name": "PLC 1", "type": "static", "variables": []})
    manager.save("PLC/1", {"name": "PLC/1", "type": "static", "variables": []})
    manager.save("PLC 1", {"name": "PLC 1", "type": "static", "settings": {"x": 1}, "variables": []})

    files = sorted(storage.active_datasources_dir().glob("*.json"))
    assert len(files) == 2  # still two files — no new one created on re-save


def test_unknown_data_type_defaults_to_zero_and_warns(caplog) -> None:
    """§1.6: an unrecognized data_type still loads (resilience) but warns."""
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {"display_name": "Weird", "data_type": "Guid", "enabled": True},
        ],
    }
    manager = DatasourceManager()
    entry = DatasourceEntry(config)
    manager.datasources["DS"] = entry
    with caplog.at_level("WARNING"):
        manager._load_static_values(entry)
    assert entry.cache[build_var_key("DS", "Weird")] == 0
    assert any("Guid" in rec.message for rec in caplog.records)


def test_apply_config_preserves_unchanged_static_values() -> None:
    """§1.1: a save that changes an unrelated flag must not wipe runtime values."""
    config = {
        "name": "DS",
        "type": "static",
        "settings": {"flag": False},
        "variables": [
            {"display_name": "Count", "data_type": "Integer", "enabled": True},
        ],
    }
    manager = DatasourceManager()
    manager.apply_config("DS", config)
    key = build_var_key("DS", "Count")
    manager.update_static_value("DS", "Count", 42)
    assert manager.datasources["DS"].cache[key] == 42

    changed_config = {**config, "settings": {"flag": True}}
    manager.apply_config("DS", changed_config)
    assert manager.datasources["DS"].cache[key] == 42


def test_apply_config_zero_inits_new_and_shape_changed_variables() -> None:
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {"display_name": "Count", "data_type": "Integer", "enabled": True},
        ],
    }
    manager = DatasourceManager()
    manager.apply_config("DS", config)
    manager.update_static_value("DS", "Count", 42)

    changed_config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {"display_name": "Count", "data_type": "String", "enabled": True},
            {"display_name": "New", "data_type": "Integer", "enabled": True},
        ],
    }
    manager.apply_config("DS", changed_config)
    entry = manager.datasources["DS"]
    # Type changed (Integer -> String) => zero-reset, not carried forward.
    assert entry.cache[build_var_key("DS", "Count")] == ""
    assert entry.cache[build_var_key("DS", "New")] == 0


def _array_of_struct_static_config() -> dict:
    return {
        "name": "DS",
        "type": "static",
        "variables": [
            {
                "kind": "folder",
                "name": "aAlarms",
                "is_array": True,
                "children": [
                    {
                        "kind": "folder",
                        "name": "[0]",
                        "children": [
                            {"display_name": "bRaised", "data_type": "Boolean", "enabled": True},
                        ],
                    },
                    {
                        "kind": "folder",
                        "name": "[1]",
                        "children": [
                            {"display_name": "bRaised", "data_type": "Boolean", "enabled": True},
                        ],
                    },
                ],
            },
        ],
    }


def test_static_struct_array_write_broadcasts_element_key() -> None:
    """§10.5: writing a struct field on a static array-of-struct element must
    also cache/broadcast that element under its own composite key (not just
    the array's aggregate), so a {path, index} binding on the array resolves
    to the touched element without depending on the whole-array reference."""
    manager = DatasourceManager()
    entry = DatasourceEntry(_array_of_struct_static_config())
    manager.datasources["DS"] = entry
    manager._load_static_values(entry)

    broadcasts: list[tuple[str, object]] = []
    manager.set_enqueue_callback(lambda key, value, priority=False: broadcasts.append((key, value)))

    manager.update_static_value("DS", "aAlarms/[0]/bRaised", True)

    array_key = build_var_key("DS", "aAlarms")
    elem0_key = build_var_key("DS", "aAlarms/[0]")
    elem1_key = build_var_key("DS", "aAlarms/[1]")

    assert entry.cache[array_key] == [{"bRaised": True}, {"bRaised": False}]
    assert entry.cache[elem0_key] == {"bRaised": True}
    # The untouched sibling element's own cache entry is unaffected.
    assert entry.cache[elem1_key] == {"bRaised": False}

    broadcast_keys = [k for k, _ in broadcasts]
    assert array_key in broadcast_keys
    assert elem0_key in broadcast_keys
    assert (elem0_key, {"bRaised": True}) in broadcasts


def test_snapshot_and_get_cached_values_return_defensive_copies() -> None:
    manager = DatasourceManager()
    config = {
        "name": "DS",
        "type": "static",
        "variables": [
            {
                "display_name": "Motor",
                "enabled": True,
            }
        ],
    }
    entry = DatasourceEntry(config)
    manager.datasources["DS"] = entry

    key = build_var_key("DS", "Motor")
    entry.cache[key] = {"nested": [1, 2]}

    snapshot = manager.snapshot()
    cached = manager.get_cached_values({key})

    snapshot[key]["nested"].append(3)
    cached[key]["nested"].append(4)

    assert entry.cache[key] == {"nested": [1, 2]}


def test_delete_datasource_broadcasts_removed_keys(monkeypatch) -> None:
    entry = FakeDatasourceEntry(
        config={},
        ds_type="opcua-client",
        registry={
            "EnabledVar": {"enabled": True},
            "DisabledVar": {"enabled": False},
        },
        folder_registry={
            "FolderStruct": {},
        },
    )
    fake_manager = FakeDatasourceManager(datasources={"DS": entry}, cached={})
    monkeypatch.setattr(datasource_api, "datasource_manager", fake_manager)
    monkeypatch.setattr(datasource_api, "_opcua_pool", None)
    monkeypatch.setattr(datasource_api, "_test_server_pool", None)

    captured_ids: list[str] = []

    async def _fake_broadcast(var_ids: list[str]) -> None:
        captured_ids.extend(var_ids)

    monkeypatch.setattr(
        "services.websocket_manager.websocket_manager.broadcast_var_removed",
        _fake_broadcast,
    )

    result = asyncio.run(datasource_api.delete_datasource("DS"))

    assert result == {"status": "deleted"}
    assert fake_manager.deleted_name == "DS"
    assert set(captured_ids) == {
        build_var_key("DS", "EnabledVar"),
        build_var_key("DS", "FolderStruct"),
    }


def test_subscription_status_reports_fast_sub_tuning() -> None:
    engine = DatasourceOpcuaEngine("DS")
    engine._requested_bg_publish_interval_ms = 1000.0
    engine._revised_bg_publish_interval_ms = 1000.0
    engine._requested_priority_publish_interval_ms = 50.0
    engine._revised_priority_publish_interval_ms = 40.0
    engine._requested_priority_sampling_interval_ms = 20.0
    engine._priority_revised_sampling_count = 2
    engine._priority_revised_sampling_sum_ms = 35.0
    engine._priority_revised_sampling_min_ms = 15.0
    engine._priority_revised_sampling_max_ms = 20.0
    engine._requested_priority_ws_batch_ms = 10.0
    engine._requested_priority_paths = {"Motor/Speed"}
    engine._current_priority_paths = {"Motor/Speed"}
    engine._priority_path_handles = {"Motor/Speed": [2]}
    engine._bg_path_handles = {"Motor/Speed": [1]}

    pool = OpcuaPool()
    pool._engines["DS"] = engine

    assert pool.subscription_status() == {
        "DS": {
            "priority_paths": ["Motor/Speed"],
            "priority_leaf_paths": [],
            "connected": False,
            "bg_enabled": False,
            "bg_publish_interval_ms": 1000.0,
            "bg_publish_interval_revised_ms": 1000.0,
            "priority_publish_interval_ms": 50.0,
            "priority_publish_interval_revised_ms": 40.0,
            "priority_sampling_interval_ms": 20.0,
            "priority_sampling_interval_revised_avg_ms": 17.5,
            "priority_sampling_interval_revised_min_ms": 15.0,
            "priority_sampling_interval_revised_max_ms": 20.0,
            "priority_ws_batch_ms": 10.0,
        }
    }


def test_connection_status_empty_pool_returns_empty_mapping() -> None:
    assert OpcuaPool().connection_status() == {}


def test_connection_status_reports_each_engines_own_connected_bool() -> None:
    # connection_status() only exposes a bool per engine, so "not connected" is
    # indistinguishable between mid-connect and failed here — both engines below
    # are just fresh (unconnected) DatasourceOpcuaEngine instances.
    not_yet_connected = DatasourceOpcuaEngine("NotYetConnected")
    connected = DatasourceOpcuaEngine("Connected")
    connected._connected = True
    also_not_connected = DatasourceOpcuaEngine("AlsoNotConnected")

    pool = OpcuaPool()
    pool._engines["Connecting"] = not_yet_connected
    pool._engines["Connected"] = connected
    pool._engines["Failed"] = also_not_connected

    assert pool.connection_status() == {
        "Connecting": False,
        "Connected": True,
        "Failed": False,
    }


def test_connection_status_is_a_point_in_time_snapshot() -> None:
    engine = DatasourceOpcuaEngine("DS")
    pool = OpcuaPool()
    pool._engines["DS"] = engine

    first = pool.connection_status()
    assert first == {"DS": False}

    # Mutating the returned mapping must not reach back into pool ownership.
    first["DS"] = True
    assert pool.connection_status() == {"DS": False}

    # A later engine-state change is reflected only in a fresh snapshot call.
    engine._connected = True
    assert pool.connection_status() == {"DS": True}

    # Engines added/removed between calls change the reported set too.
    pool._engines.pop("DS")
    pool._engines["New"] = DatasourceOpcuaEngine("New")
    assert pool.connection_status() == {"New": False}


class _FakePrioritySubscription:
    def __init__(self, handles: list[object], raise_on_modify: bool = False) -> None:
        self._handles = handles
        self.raise_on_modify = raise_on_modify

    async def subscribe_data_change(self, nodes: list[object], sampling_interval: float):
        return self._handles

    async def modify_monitored_item(
        self,
        handle: int,
        new_samp_time: float,
        new_queuesize: int = 0,
        mod_filter_val: int = -1,
    ):
        if self.raise_on_modify:
            raise RuntimeError("modify failed")
        item = ua.MonitoredItemModifyResult()
        item.StatusCode = ua.StatusCode(ua.StatusCodes.Good)
        item.RevisedSamplingInterval = 12.5
        return [item]


def test_priority_subscribe_helper_uses_public_api_and_collects_revised_sampling() -> None:
    engine = DatasourceOpcuaEngine("DS")
    engine._requested_priority_sampling_interval_ms = 20.0
    engine._priority_sub = _FakePrioritySubscription([101, ua.StatusCode(ua.StatusCodes.Bad)])

    handles, revised = asyncio.run(
        engine._subscribe_priority_nodes_with_revised_sampling([object()]),
    )

    assert handles[0] == 101
    assert isinstance(handles[1], ua.StatusCode)
    assert revised == [12.5]


def test_priority_subscribe_helper_ignores_modify_failures() -> None:
    engine = DatasourceOpcuaEngine("DS")
    engine._requested_priority_sampling_interval_ms = 20.0
    engine._priority_sub = _FakePrioritySubscription([202], raise_on_modify=True)

    handles, revised = asyncio.run(
        engine._subscribe_priority_nodes_with_revised_sampling([object()]),
    )

    assert handles == [202]
    assert revised == []
