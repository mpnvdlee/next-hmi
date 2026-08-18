"""Unit tests for the ``is_subscribable`` variable predicate."""

from models.datasource import (
    DatasourceUpsertBody,
    is_present_on_server,
    is_subscribable,
)


def test_is_present_on_server_absent_is_present() -> None:
    assert is_present_on_server({}) is True
    assert is_present_on_server({"enabled": True}) is True
    assert is_present_on_server({"present_on_server": True}) is True


def test_is_present_on_server_explicit_false_is_stale() -> None:
    assert is_present_on_server({"present_on_server": False}) is False


def test_enabled_and_present_is_subscribable() -> None:
    assert is_subscribable({"enabled": True}) is True
    assert is_subscribable({"enabled": True, "present_on_server": True}) is True


def test_disabled_is_not_subscribable() -> None:
    assert is_subscribable({"enabled": False}) is False
    assert is_subscribable({}) is False


def test_stale_overrides_enabled() -> None:
    """A stale (present_on_server=False) variable must never be subscribed,
    regardless of the enabled flag."""
    assert is_subscribable({"enabled": True, "present_on_server": False}) is False
    assert is_subscribable({"enabled": False, "present_on_server": False}) is False


def test_present_on_server_default_is_truthy() -> None:
    """Omitted ``present_on_server`` is treated as present (legacy data)."""
    assert is_subscribable({"enabled": True}) is True


def test_present_on_server_survives_upsert_roundtrip() -> None:
    """``present_on_server`` is a field the model doesn't know about; it must
    pass through ``DatasourceUpsertBody`` unchanged so the stale-variable
    contract holds across save/load."""
    body = DatasourceUpsertBody.model_validate(
        {
            "type": "opcua-client",
            "variables": [
                {
                    "kind": "variable",
                    "node_id": "ns=1;i=1",
                    "display_name": "A",
                    "data_type": "Int32",
                    "enabled": True,
                    "present_on_server": False,
                }
            ],
        }
    )
    stored = body.to_storage_dict("plc1")
    assert stored["variables"][0]["present_on_server"] is False
    assert stored["variables"][0]["enabled"] is True
