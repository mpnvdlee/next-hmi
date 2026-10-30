"""Tests for AlarmManager's priority-recompute callback wiring (A9).

Config saves must trigger a recompute request and must persist even if the
recompute callback raises or is entirely unset.
"""
from pathlib import Path

import pytest
from models.alarm import AlarmConfig, AlarmDefinition, AlarmGroup, AlarmTrigger
from services.alarm_manager import AlarmManager


def _config_with_trigger(path: str = "Overheat") -> AlarmConfig:
    return AlarmConfig(
        groups=[
            AlarmGroup(
                title="Pumps",
                alarms=[
                    AlarmDefinition(
                        code="P1",
                        title="Pump overheat",
                        trigger=AlarmTrigger(
                            type="bool",
                            source_value={"$var": {"path": f"DS:{path}"}},
                            on_true=True,
                        ),
                    )
                ],
            )
        ]
    )


def test_set_config_triggers_recompute_callback(live_project_root: Path):
    manager = AlarmManager()
    calls = []
    manager.set_recompute_callback(lambda: calls.append(1))

    manager.set_config(_config_with_trigger())

    assert calls == [1]


def test_apply_config_triggers_recompute_callback(live_project_root: Path):
    manager = AlarmManager()
    calls = []
    manager.set_recompute_callback(lambda: calls.append(1))

    manager.apply_config(_config_with_trigger())

    assert calls == [1]


def test_set_config_persists_even_if_recompute_callback_raises(live_project_root: Path):
    manager = AlarmManager()

    def _boom():
        raise RuntimeError("simulated scheduling failure")

    manager.set_recompute_callback(_boom)

    # Must not raise — the save already succeeded before the callback runs.
    manager.set_config(_config_with_trigger())

    assert manager.get_config().groups[0].title == "Pumps"

    # A fresh manager loading from disk sees the persisted config.
    reloaded = AlarmManager()
    reloaded.load()
    assert reloaded.get_config().groups[0].title == "Pumps"


def test_set_config_without_recompute_callback_is_a_noop(live_project_root: Path):
    manager = AlarmManager()
    # No set_recompute_callback() call at all.
    manager.set_config(_config_with_trigger())
    assert manager.get_config().groups[0].title == "Pumps"


def test_trigger_paths_reflect_edit_and_delete(live_project_root: Path):
    """Add/edit/delete against the trigger map the recompute callback reads."""
    manager = AlarmManager()
    manager.set_config(_config_with_trigger())
    assert manager.get_trigger_paths_by_datasource() == {"DS": {"Overheat"}}

    manager.set_config(_config_with_trigger("Overtemp"))
    assert manager.get_trigger_paths_by_datasource() == {"DS": {"Overtemp"}}

    manager.set_config(AlarmConfig(groups=[]))
    assert manager.get_trigger_paths_by_datasource() == {}


def test_value_range_trigger_reads_a_counter_beyond_two_to_the_53():
    # The cache holds such a counter as its decimal string, the form a browser
    # carries exactly; the threshold compare still sees a number.
    trigger = AlarmTrigger(
        type="value_range", source_value={"$var": {"path": "DS:Count"}}, min=2**60,
    )
    manager = AlarmManager()
    assert manager._evaluate_trigger(trigger, str(2**63)) is True
    assert manager._evaluate_trigger(trigger, str(2**59)) is False


@pytest.mark.parametrize(
    "value, fires",
    [(79.9, False), (80, True), (95, True), (100, True), (100.1, False)],
)
def test_value_range_trigger_fires_inside_min_and_max(value, fires):
    # Min / Max bound the alarm range, both included — the documented meaning.
    trigger = AlarmTrigger(
        type="value_range", source_value={"$var": {"path": "DS:Temp"}}, min=80, max=100,
    )
    assert AlarmManager()._evaluate_trigger(trigger, value) is fires


def test_fire_captures_values_and_clear_keeps_them(live_project_root: Path, monkeypatch):
    from services.datasource_manager import datasource_manager

    cache = {"DS:Temp": 81.5, "DS:Arr": [1, 2, 3]}
    monkeypatch.setattr(
        datasource_manager, "get_cached_values", lambda keys: {k: cache[k] for k in keys if k in cache}
    )
    config = _config_with_trigger()
    config.groups[0].alarms[0].values = [
        {"$var": {"path": "DS:Temp"}},
        {"$var": {"path": "DS:Arr", "index": 2}},
        {"$var": {"path": "DS:Missing"}},
    ]
    manager = AlarmManager()
    manager.set_config(config)
    assert manager.get_trigger_paths_by_datasource() == {"DS": {"Overheat", "Temp", "Arr", "Missing"}}

    manager.on_variable_change("DS:Overheat", True)
    cache["DS:Temp"] = 20.0  # a later change must not reach the captured value
    [active] = manager.get_active()
    assert active.values == [81.5, 3, None]
    assert active.value_refs == config.groups[0].alarms[0].values

    manager.on_variable_change("DS:Overheat", False)
    [entry] = manager.get_history()
    assert entry.values == [81.5, 3, None]

    reloaded = AlarmManager()
    reloaded.load()
    assert reloaded.get_history()[0].values == [81.5, 3, None]


def test_a_value_missing_at_fire_time_is_filled_by_its_next_update(
    live_project_root: Path, monkeypatch
):
    from services.datasource_manager import datasource_manager

    cache = {"DS:Temp": 81.5}
    monkeypatch.setattr(
        datasource_manager, "get_cached_values", lambda keys: {k: cache[k] for k in keys if k in cache}
    )
    config = _config_with_trigger()
    config.groups[0].alarms[0].values = [
        {"$var": {"path": "DS:Temp"}},
        {"$var": {"path": "DS:Arr", "index": 1}},
    ]
    manager = AlarmManager()
    manager.set_config(config)
    manager.on_variable_change("DS:Overheat", True)
    assert manager.get_active()[0].values == [81.5, None]

    manager.on_variable_change("DS:Arr", [7, 8])
    manager.on_variable_change("DS:Temp", 90.0)  # captured already: not overwritten
    manager.on_variable_change("DS:Arr", [0, 0])
    assert manager.get_active()[0].values == [81.5, 8]

    manager.on_variable_change("DS:Overheat", False)
    assert manager.get_history()[0].values == [81.5, 8]


def _stations_datasource(monkeypatch):
    """A static datasource as the cache holds it: a struct array counted from 1
    (each element under its own folder, each member under its own leaf key), a
    scalar array, and an Integer to index it with."""
    from services.datasource_manager import DatasourceEntry, datasource_manager

    entry = DatasourceEntry({
        "name": "DS",
        "type": "static",
        "variables": [
            {"kind": "folder", "name": "Stations", "is_array": True, "children": [
                {"kind": "folder", "name": f"Stations[{i}]", "children": [
                    {"display_name": "Temp", "data_type": "Float", "enabled": True},
                ]}
                for i in (1, 2, 3)
            ]},
            {"display_name": "Arr", "data_type": "Float", "is_array": True, "array_length": 4, "enabled": True},
            {"display_name": "Idx", "data_type": "Integer", "enabled": True},
        ],
    })
    monkeypatch.setitem(datasource_manager.datasources, "DS", entry)
    datasource_manager._load_static_values(entry)
    datasource_manager.update_static_value("DS", "Stations/Stations[3]/Temp", 33.0)
    datasource_manager.update_static_value("DS", "Arr", [0.5, 1.5, 2.5, 3.5])
    datasource_manager.update_static_value("DS", "Idx", 1)
    return datasource_manager


def test_fire_captures_a_struct_array_member_and_array_elements(live_project_root: Path, monkeypatch):
    dm = _stations_datasource(monkeypatch)
    config = _config_with_trigger()
    config.groups[0].alarms[0].values = [
        # The binding picker's shape for a member of a struct-array element: its leaf key.
        {"$var": {"path": "DS:Stations/Stations[3]/Temp"}},
        {"$var": {"path": "DS:Arr", "index": 2}},
        {"$var": {"path": "DS:Arr", "index": {"$static": 3}}},
        {"$var": {"path": "DS:Arr", "index": {"$var": {"path": "DS:Idx"}}}},
        {"$var": {"path": "DS:Arr", "index": {"$componentProp": "device"}}},
    ]
    manager = AlarmManager()
    manager.set_config(config)
    assert manager.get_trigger_paths_by_datasource() == {
        "DS": {"Overheat", "Stations/Stations[3]/Temp", "Arr", "Idx"}
    }

    manager.on_variable_change("DS:Overheat", True)
    dm.update_static_value("DS", "Idx", 0)  # the element was picked when it fired
    assert manager.get_active()[0].values == [33.0, 2.5, 3.5, 1.5, None]
    manager.on_variable_change("DS:Overheat", False)
    assert manager.get_history()[0].values == [33.0, 2.5, 3.5, 1.5, None]


def test_an_element_whose_bound_index_arrives_late_is_filled_in(live_project_root: Path, monkeypatch):
    dm = _stations_datasource(monkeypatch)
    dm.datasources["DS"].cache.pop("DS:Idx")
    config = _config_with_trigger()
    config.groups[0].alarms[0].values = [
        {"$var": {"path": "DS:Arr", "index": {"$var": {"path": "DS:Idx"}}}},
    ]
    manager = AlarmManager()
    manager.set_config(config)
    manager.on_variable_change("DS:Overheat", True)
    assert manager.get_active()[0].values == [None]

    manager.on_variable_change("DS:Idx", 2)
    assert manager.get_active()[0].values == [2.5]
