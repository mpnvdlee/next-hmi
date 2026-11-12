"""Array elements and `update()` rebuilds are emitted once per event-loop turn.

A just-subscribed array of structs reports every leaf at once: 8,000 initial
values for a 50-slave EtherCAT array. Copying and emitting the touched element
per leaf cost ~220 ms of event loop for that burst, and `update()` rebuilt the
whole folder per leaf. Both now ride `_emit_composite_soon`.
"""

import asyncio
from typing import Any

import pytest
from models.datasource import build_var_key
from services.datasource_manager import DatasourceEntry, DatasourceManager

N_ELEMENTS = 50
N_FIELDS = 160
ARRAY_KEY = build_var_key("DS", "aSlaves")


def _elem_key(index: int) -> str:
    return build_var_key("DS", f"aSlaves/[{index}]")


def _config() -> dict:
    elements = [
        {
            "kind": "folder",
            "name": f"[{i}]",
            "node_id": f"ns=2;s=Slave{i}",
            "children": [
                {
                    "display_name": f"f{j}",
                    "node_id": f"ns=2;s=Slave{i}.f{j}",
                    "data_type": "Int32",
                    "enabled": True,
                    "writable": False,
                }
                for j in range(N_FIELDS)
            ],
        }
        for i in range(N_ELEMENTS)
    ]
    return {
        "name": "DS",
        "type": "opcua-client",
        "variables": [
            {
                "kind": "folder",
                "name": "aSlaves",
                "node_id": "ns=2;s=aSlaves",
                "is_array": True,
                "children": elements,
            },
        ],
    }


def _setup() -> tuple[DatasourceManager, DatasourceEntry, list[tuple[str, Any]]]:
    entry = DatasourceEntry(_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    emits: list[tuple[str, Any]] = []
    dm.set_enqueue_callback(lambda key, value, priority=False: emits.append((key, value)))
    return dm, entry, emits


def _set_field(dm: DatasourceManager, index: int, field: int, value: int) -> None:
    dm.update_struct_field(
        "DS", "aSlaves", (index, f"f{field}"), value,
        leaf_path=f"aSlaves/[{index}]/f{field}",
    )


def _composite_emits(emits: list[tuple[str, Any]]) -> list[str]:
    """Emitted folder/element keys, leaving out the per-leaf ones."""
    return [k for k, _ in emits if k == ARRAY_KEY or k.endswith("]")]


@pytest.mark.asyncio
@pytest.mark.parametrize("elements", [1, N_ELEMENTS])
async def test_a_burst_emits_each_element_and_read_composite_once_per_turn(elements):
    dm, entry, emits = _setup()
    dm.set_client_page("c1", {ARRAY_KEY})
    # 8,000 leaf changes whichever way they spread across the elements.
    rounds = 8000 // (elements * N_FIELDS)
    for r in range(1, rounds + 1):
        for i in range(elements):
            for j in range(N_FIELDS):
                _set_field(dm, i, j, r)
    assert _composite_emits(emits) == []

    await asyncio.sleep(0)

    assert sorted(_composite_emits(emits)) == sorted(
        [ARRAY_KEY] + [_elem_key(i) for i in range(elements)]
    )
    expected = {f"f{j}": rounds for j in range(N_FIELDS)}
    for i in range(elements):
        # The element key holds the aggregate's element, and was emitted as such.
        assert entry.cache[_elem_key(i)] == entry.cache[ARRAY_KEY][i] == expected
        assert dict(emits)[_elem_key(i)] == expected
        assert dm.get_cached_values({_elem_key(i)})[_elem_key(i)] == expected


@pytest.mark.asyncio
async def test_an_emitted_element_does_not_change_after_the_emit():
    """The cache shares the element with the aggregate; the emit is a copy."""
    dm, _entry, emits = _setup()
    _set_field(dm, 0, 0, 1)
    await asyncio.sleep(0)
    emitted = dict(emits)[_elem_key(0)]

    _set_field(dm, 0, 0, 2)

    assert emitted == {"f0": 1}


@pytest.mark.asyncio
async def test_a_value_listener_hears_the_element_at_turn_end():
    dm, _entry, _emits = _setup()
    heard: list[tuple[str, Any]] = []
    dm.register_value_listener(lambda key, value: heard.append((key, value)))

    _set_field(dm, 3, 0, 7)
    _set_field(dm, 3, 1, 8)
    assert _elem_key(3) not in [k for k, _ in heard]

    await asyncio.sleep(0)

    assert [v for k, v in heard if k == _elem_key(3)] == [{"f0": 7, "f1": 8}]


@pytest.mark.asyncio
async def test_a_failing_emit_does_not_drop_the_rest_of_the_turn():
    """The due set is swapped out before emitting, so an emit that raises
    must not take the composites queued after it down with it."""
    dm, _entry, _emits = _setup()
    dm.set_client_page("c1", {ARRAY_KEY})
    emitted: list[str] = []

    def enqueue(key: str, value: Any, priority: bool = False) -> None:
        if key == _elem_key(0):
            raise RuntimeError("boom")
        emitted.append(key)

    dm.set_enqueue_callback(enqueue)
    _set_field(dm, 0, 0, 1)
    _set_field(dm, 1, 0, 1)

    await asyncio.sleep(0)

    assert ARRAY_KEY in emitted
    assert _elem_key(1) in emitted


def test_off_the_loop_an_element_is_emitted_at_once():
    """No running loop (a worker thread, a sync caller): no turn to wait for."""
    dm, entry, emits = _setup()

    _set_field(dm, 0, 0, 1)
    _set_field(dm, 0, 1, 2)

    assert [v for k, v in emits if k == _elem_key(0)] == [{"f0": 1}, {"f0": 1, "f1": 2}]
    assert entry.cache[_elem_key(0)] == {"f0": 1, "f1": 2}


@pytest.mark.asyncio
async def test_update_rebuilds_its_folder_once_per_turn(monkeypatch):
    """`update()` (a leaf the node map does not route) rebuilt and copied the
    whole folder per leaf; now once per turn, its element keys included."""
    dm, entry, emits = _setup()
    built: list[str] = []
    real_build = dm._enqueue_folder_struct
    monkeypatch.setattr(
        dm, "_enqueue_folder_struct",
        lambda ds, e, path, *a, **k: (built.append(path), real_build(ds, e, path, *a, **k)),
    )

    for j in range(N_FIELDS):
        dm.update("DS", f"aSlaves/[0]/f{j}", j)
    assert built == []

    await asyncio.sleep(0)

    assert built == ["aSlaves"]
    expected = {f"f{j}": j for j in range(N_FIELDS)}
    assert entry.cache[ARRAY_KEY][0] == expected
    assert [v for k, v in emits if k == _elem_key(0)] == [expected]
    assert [k for k, _ in emits].count(ARRAY_KEY) == 1
