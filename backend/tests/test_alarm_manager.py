"""Tests for AlarmManager's priority-recompute callback wiring (A9).

Config saves must trigger a recompute request and must persist even if the
recompute callback raises or is entirely unset.
"""
from pathlib import Path

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
