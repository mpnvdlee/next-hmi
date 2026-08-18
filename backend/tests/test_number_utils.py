"""Tests for core.number_utils.get_config_float (§2.8 exercises this via
DatasourceOpcuaEngine._reconnect_loop's reconnect_interval_s)."""

from core.number_utils import get_config_float


def test_returns_configured_value_within_bounds():
    assert get_config_float({"x": 42}, "x", 1.0) == 42.0


def test_missing_key_falls_back_to_default():
    assert get_config_float({}, "x", 5.0) == 5.0


def test_non_numeric_value_falls_back_to_default():
    assert get_config_float({"x": "not-a-number"}, "x", 5.0) == 5.0


def test_none_value_falls_back_to_default():
    assert get_config_float({"x": None}, "x", 5.0) == 5.0


def test_clamps_below_minimum():
    assert get_config_float({"x": 0}, "x", 5.0, minimum=1.0) == 1.0
    assert get_config_float({"x": -10}, "x", 5.0, minimum=1.0) == 1.0


def test_clamps_above_maximum():
    assert get_config_float({"x": 10_000}, "x", 5.0, maximum=300.0) == 300.0


def test_non_mapping_config_falls_back_to_default():
    assert get_config_float(None, "x", 5.0) == 5.0
