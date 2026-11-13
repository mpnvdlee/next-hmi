"""An emitted composite is the cached one, and it never changes once emitted.

Emitting a read struct array deep-copied it every loop turn — a 250-slave
EtherCAT array is 8,000 leaves — plus a deep copy per touched element. Now
the emit hands out the cached value, and a later change copies only the
containers it writes into (copy on write), once per turn: the list, the touched
element, the sub-struct on the way. What a client, the broadcast queue or a
value listener holds stays exactly what was emitted.
"""

import asyncio
import copy
from typing import Any

import pytest
from models.datasource import build_var_key
from services.datasource_manager import DatasourceEntry, DatasourceManager

ARRAY_KEY = build_var_key("DS", "aArr")
STRUCT_KEY = build_var_key("DS", "Motor")


def _elem_key(index: int) -> str:
    return build_var_key("DS", f"aArr/aArr[{index}]")


def _var(name: str) -> dict:
    return {"display_name": name, "node_id": f"ns=2;s={name}", "data_type": "Int32",
            "enabled": True, "writable": False}


def _config() -> dict:
    return {"name": "DS", "type": "opcua-client", "variables": [
        {"kind": "folder", "name": "aArr", "is_array": True, "children": [
            {"kind": "folder", "name": f"aArr[{i}]", "children": [
                _var("x"), {"kind": "folder", "name": "sub", "children": [_var("y")]},
            ]}
            for i in range(3)
        ]},
        {"kind": "folder", "name": "Motor", "children": [
            _var("speed"), {"kind": "folder", "name": "limits", "children": [_var("max")]},
        ]},
    ]}


def _setup() -> tuple[DatasourceManager, DatasourceEntry, list[tuple[str, Any]]]:
    entry = DatasourceEntry(_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    emits: list[tuple[str, Any]] = []
    dm.set_enqueue_callback(lambda key, value, priority=False: emits.append((key, value)))
    dm.set_client_page("c1", {ARRAY_KEY, STRUCT_KEY})
    return dm, entry, emits


def _set(dm: DatasourceManager, index: int, field: str, value: int) -> None:
    dm.update_struct_field(
        "DS", "aArr", (index, *field.split("/")), value, leaf_path=f"aArr/aArr[{index}]/{field}",
    )


def _set_motor(dm: DatasourceManager, field: str, value: int) -> None:
    dm.update_struct_field("DS", "Motor", tuple(field.split("/")), value, leaf_path=f"Motor/{field}")


def _last(emits: list[tuple[str, Any]], key: str) -> Any:
    return [v for k, v in emits if k == key][-1]


@pytest.mark.asyncio
async def test_emitted_composites_never_change_after_the_emit():
    dm, entry, emits = _setup()
    for i in range(3):
        _set(dm, i, "x", i)
        _set(dm, i, "sub/y", 10 + i)
    _set_motor(dm, "speed", 1)
    _set_motor(dm, "limits/max", 2)
    await asyncio.sleep(0)
    held = {key: _last(emits, key) for key in (ARRAY_KEY, STRUCT_KEY, _elem_key(0))}
    as_emitted = copy.deepcopy(held)

    _set(dm, 0, "x", 100)
    _set(dm, 0, "sub/y", 200)
    _set_motor(dm, "limits/max", 300)
    await asyncio.sleep(0)

    assert held == as_emitted
    assert _last(emits, ARRAY_KEY)[0] == {"x": 100, "sub": {"y": 200}}
    assert _last(emits, ARRAY_KEY)[1:] == as_emitted[ARRAY_KEY][1:]
    assert _last(emits, _elem_key(0)) == {"x": 100, "sub": {"y": 200}}
    assert _last(emits, STRUCT_KEY) == {"speed": 1, "limits": {"max": 300}}
    # The element key still holds the aggregate's own element.
    assert entry.cache[_elem_key(0)] is entry.cache[ARRAY_KEY][0]


@pytest.mark.asyncio
async def test_a_listener_keeps_the_part_it_took():
    """An alarm captures a member of an element; a later change must not
    rewrite what it captured."""
    dm, _entry, _emits = _setup()
    taken: list[Any] = []
    dm.register_value_listener(
        lambda key, value: taken.append(value[1]["sub"]) if key == ARRAY_KEY else None,
    )
    _set(dm, 1, "sub/y", 5)
    await asyncio.sleep(0)

    _set(dm, 1, "sub/y", 6)
    await asyncio.sleep(0)

    assert taken == [{"y": 5}, {"y": 6}]


@pytest.mark.asyncio
async def test_a_turn_copies_only_what_it_writes(monkeypatch):
    """No whole-composite copy per emit or per change: untouched elements are
    the very objects the previous emit carried."""
    dm, _entry, emits = _setup()
    for i in range(3):
        _set(dm, i, "x", i)
    await asyncio.sleep(0)
    before = _last(emits, ARRAY_KEY)
    monkeypatch.setattr(
        DatasourceManager, "_snapshot_copy",
        staticmethod(lambda value: pytest.fail("deep copy on the datachange path")),
    )

    _set(dm, 2, "x", 20)
    _set(dm, 2, "x", 21)
    await asyncio.sleep(0)

    after = _last(emits, ARRAY_KEY)
    assert after is not before
    assert after[0] is before[0] and after[1] is before[1]
    assert after[2] == {"x": 21, "sub": {}} and before[2] == {"x": 2, "sub": {}}


def test_off_the_loop_each_emit_keeps_its_value():
    dm, _entry, emits = _setup()

    _set(dm, 0, "x", 1)
    _set(dm, 0, "x", 2)

    assert [v[0]["x"] for k, v in emits if k == ARRAY_KEY] == [1, 2]
    assert [v["x"] for k, v in emits if k == _elem_key(0)] == [1, 2]
