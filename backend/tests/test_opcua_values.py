"""OPC-UA values are normalized where they leave asyncua.

``opcua.values.normalize_value`` turns a server value into the form the cache,
the alarm/historian listeners and the browser carry. The datachange handler and
``read_current_values`` apply it; ``DatasourceManager`` stays free of asyncua.
"""

from __future__ import annotations

import ast
import datetime
from pathlib import Path
from typing import Any

import pytest
from asyncua import ua
from opcua.engine import DatasourceOpcuaEngine, _DsSubHandler
from opcua.values import normalize_value
from services.datasource_manager import DatasourceEntry, DatasourceManager

_UTC = datetime.UTC


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (datetime.datetime(2026, 1, 2, 3, 4, 5, 678901, tzinfo=_UTC), "2026-01-02T03:04:05.678Z"),
        # asyncua's DateTime is UTC whether or not it carries a tzinfo.
        (datetime.datetime(2026, 1, 2, 3, 4, 5), "2026-01-02T03:04:05.000Z"),
        (
            datetime.datetime(2026, 1, 2, 5, 4, 5, tzinfo=datetime.timezone(datetime.timedelta(hours=2))),
            "2026-01-02T03:04:05.000Z",
        ),
        (2**53 - 1, 2**53 - 1),
        (-(2**53 - 1), -(2**53 - 1)),
        (2**53, "9007199254740992"),
        (-(2**63), "-9223372036854775808"),
        (2**64 - 1, "18446744073709551615"),
        (True, True),
        (0.1, 0.1),
        (None, None),
        ("x", "x"),
        (ua.LocalizedText("Hallo", "nl"), "Hallo"),
        (ua.LocalizedText(None, "nl"), ""),
        (ua.NodeId("Tag", 3), "ns=3;s=Tag"),
        (ua.QualifiedName("Speed", 2), "2:Speed"),
        (b"\x00\x01", "AAE="),
        ([2**63, 1, ua.LocalizedText("a")], ["9223372036854775808", 1, "a"]),
    ],
)
def test_normalize_value_gives_the_cache_form(value: Any, expected: Any) -> None:
    result = normalize_value(value)
    assert result == expected
    assert type(result) is type(expected)


def _scalar_config() -> dict:
    return {
        "name": "DS",
        "type": "opcua-client",
        "variables": [
            {"display_name": name, "node_id": f"ns=2;s={name}", "data_type": data_type,
             "enabled": True, "writable": False}
            for name, data_type in (("Text", "LocalizedText"), ("Stamp", "DateTime"), ("Count", "UInt64"))
        ],
    }


class _Node:
    def __init__(self, node_id: str) -> None:
        self.nodeid = node_id


_SERVER_VALUES: dict[str, Any] = {
    "ns=2;s=Text": ua.LocalizedText("Tür offen", "de"),
    "ns=2;s=Stamp": datetime.datetime(2026, 1, 2, 3, 4, 5, 678901, tzinfo=_UTC),
    "ns=2;s=Count": 2**63,
}
_CACHE_FORMS = {
    "DS:Text": "Tür offen",
    "DS:Stamp": "2026-01-02T03:04:05.678Z",
    "DS:Count": "9223372036854775808",
}


class _Client:
    def get_node(self, node_id: str) -> _Node:
        return _Node(node_id)

    async def read_values(self, nodes: list[_Node]) -> list[Any]:
        return [_SERVER_VALUES[node.nodeid] for node in nodes]


def _engine() -> tuple[DatasourceOpcuaEngine, DatasourceManager, DatasourceEntry]:
    entry = DatasourceEntry(_scalar_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    engine = DatasourceOpcuaEngine("DS")
    engine.set_datasource_manager(dm)
    return engine, dm, entry


def test_datachange_reaches_the_cache_and_listeners_normalized() -> None:
    engine, dm, entry = _engine()
    for name in ("Text", "Stamp", "Count"):
        engine._node_to_path[f"ns=2;s={name}"] = name
    heard: dict[str, Any] = {}
    dm.register_value_listener(lambda key, value: heard.__setitem__(key, value))

    handler = _DsSubHandler(engine)
    for node_id, value in _SERVER_VALUES.items():
        handler.datachange_notification(_Node(node_id), value, None)

    assert entry.cache == _CACHE_FORMS
    assert heard == _CACHE_FORMS


@pytest.mark.asyncio
async def test_read_current_values_returns_the_cache_form_unless_raw() -> None:
    engine, _dm, _entry = _engine()
    engine._client = _Client()
    engine._connected = True

    assert await engine.read_current_values({"Text", "Stamp", "Count"}) == _CACHE_FORMS
    raw = await engine.read_current_values({"Text", "Stamp", "Count"}, raw=True)
    assert raw == {f"DS:{path.removeprefix('ns=2;s=')}": v for path, v in _SERVER_VALUES.items()}


def test_datasource_manager_does_not_import_asyncua() -> None:
    source = Path(__file__).resolve().parents[1] / "services" / "datasource_manager.py"
    imported = set()
    for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert "asyncua" not in imported
