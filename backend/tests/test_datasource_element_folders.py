"""An array element folder is known by the array it sits in, not by its name.

TwinCAT names the elements of ``stSetupPosition : ARRAY[1..6] OF ST_…``
``stSetupPosition[1]`` … ``stSetupPosition[6]``; other servers name them
``[0]``, ``[1]``, …. The element order, each element's ``position``, the field
routes and the steps that patch a plain struct across an array element must
all read the same tree the same way, whatever the names.
"""

import asyncio
import copy
import socket
import time
from types import SimpleNamespace

import opcua.engine as engine_module
import pytest
from asyncua import Client, Server, ua
from core.value_types import _place
from models.datasource import build_var_key
from opcua.engine import DatasourceOpcuaEngine
from opcua.routing import _composite_leaf_steps, _struct_field_routes
from services.datasource_manager import DatasourceEntry, DatasourceManager


def _var(name: str) -> dict:
    return {"display_name": name, "node_id": f"ns=4;s={name}", "data_type": "Int16",
            "enabled": True, "writable": False}


def _folder(name: str, children: list, *, is_array: bool = False) -> dict:
    folder = {"kind": "folder", "name": name, "node_id": f"ns=4;s={name}", "children": children}
    if is_array:
        folder["is_array"] = True
    return folder


def _config() -> dict:
    """A plain struct holding a TwinCAT ARRAY[1..10], listed out of order."""
    return {"name": "DS", "type": "opcua-client", "variables": [
        _folder("Root", [
            _var("mode"),
            _folder("aArr", [
                _folder(f"aArr[{i}]", [_var("x"), _folder("sub", [_var("y")])])
                for i in (10, 2, 1, 3, 4, 5, 6, 7, 8, 9)
            ], is_array=True),
        ]),
    ]}


def test_order_position_routes_and_ancestors_agree_on_twincat_elements():
    entry = DatasourceEntry(_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry

    # Sorted by the trailing [N], so position 0 is ARRAY[1] and [10] is last.
    assert entry.folder_registry["Root/aArr"]["_element_paths"][:3] == [
        "Root/aArr/aArr[1]", "Root/aArr/aArr[2]", "Root/aArr/aArr[3]",
    ]
    meta = dm.variable_metadata()
    assert meta[build_var_key("DS", "Root/aArr/aArr[1]")]["position"] == 0
    assert meta[build_var_key("DS", "Root/aArr/aArr[10]")]["position"] == 9

    routes = _struct_field_routes(entry)
    assert routes["Root/aArr/aArr[10]/x"] == ("Root/aArr", (9, "x"))
    assert routes["Root/aArr/aArr[10]/sub/y"] == ("Root/aArr", (9, "sub", "y"))

    targets = entry.ancestor_field_targets("Root/aArr/aArr[10]/sub/y")
    assert targets == (
        ("Root/aArr/aArr[10]/sub", ("y",)),
        ("Root/aArr/aArr[10]", ("sub", "y")),
        ("Root/aArr", (9, "sub", "y")),
        ("Root", ("aArr", 9, "sub", "y")),
    )
    assert entry.ancestor_field_targets("Root/mode") == (("Root", ("mode",)),)


def _nested_arrays_config() -> dict:
    """``aAxes : ARRAY[1..2] OF ST_Axis``, each holding ``aCams : ARRAY[1..2]``."""
    return {"name": "DS", "type": "opcua-client", "variables": [
        _folder("aAxes", [
            _folder(f"aAxes[{i}]", [_var("pos"), _folder("aCams", [
                _folder(f"aCams[{j}]", [_var("x")]) for j in (1, 2)
            ], is_array=True)])
            for i in (1, 2)
        ], is_array=True),
    ]}


def test_an_outer_array_keeps_its_inner_array_a_list():
    """An outer array's steps cross its element's ``aCams`` by position, so
    the patch keeps that list a list, its other element untouched."""
    entry = DatasourceEntry(_nested_arrays_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    leaf = "aAxes/aAxes[1]/aCams/aCams[2]/x"
    assert entry.ancestor_field_targets(leaf) == (
        ("aAxes/aAxes[1]/aCams/aCams[2]", ("x",)),
        ("aAxes/aAxes[1]/aCams", (1, "x")),
        ("aAxes/aAxes[1]", ("aCams", 1, "x")),
        ("aAxes", (0, "aCams", 1, "x")),
    )
    axes = build_var_key("DS", "aAxes")
    dm.set_client_page("c1", {axes})
    dm.seed_cached_values({
        build_var_key("DS", f"aAxes/aAxes[{i}]/aCams/aCams[{j}]/x"): 0 for i in (1, 2) for j in (1, 2)
    })
    # Built whole, as the page's read delivers it.
    dm._enqueue_folder_struct("DS", entry, "aAxes")
    untouched = entry.cache[axes][0]["aCams"][0]
    dm.update_struct_field("DS", "aAxes", (0, "pos"), 1, leaf_path="aAxes/aAxes[1]/pos")

    dm.update_struct_field("DS", "aAxes/aAxes[1]/aCams", (1, "x"), 7, leaf_path=leaf)

    assert entry.cache[axes][0] == {"pos": 1, "aCams": [{"x": 0}, {"x": 7}]}
    assert entry.cache[axes][0]["aCams"][0] is untouched
    assert entry.cache[build_var_key("DS", "aAxes/aAxes[1]")] is entry.cache[axes][0]


def test_a_struct_holding_a_twincat_named_array_keeps_the_array_a_list():
    """The bound parent struct must not turn ``aArr`` into a dict keyed
    ``aArr[1]`` … after one element leaf changes."""
    entry = DatasourceEntry(_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    root_key = build_var_key("DS", "Root")
    dm.set_client_page("c1", {root_key})
    dm.seed_cached_values({
        build_var_key("DS", "Root/mode"): 3,
        **{build_var_key("DS", f"Root/aArr/aArr[{i}]/x"): i for i in range(1, 11)},
    })
    dm._enqueue_folder_struct("DS", entry, "Root")
    assert isinstance(entry.cache[root_key]["aArr"], list)

    dm.update_struct_field("DS", "Root/aArr", (0, "x"), 99, leaf_path="Root/aArr/aArr[1]/x")

    arr = entry.cache[root_key]["aArr"]
    assert isinstance(arr, list)
    assert [element["x"] for element in arr] == [99, *range(2, 11)]


def _plant_config(name) -> dict:
    """``Plant`` holding ``Lines : ARRAY OF ST_Line``, each line holding
    ``Motors : ARRAY OF ST_Motor``: elements listed out of order, the one at
    each position named ``name(array, position)``."""
    return {"name": "DS", "type": "opcua-client", "variables": [
        _folder("Plant", [_var("id"), _folder("Lines", [
            _folder(name("Lines", i), [_var("rate"), _folder("Motors", [
                _folder(name("Motors", j), [_var("Speed")]) for j in (2, 0, 1)
            ], is_array=True)])
            for i in (1, 0)
        ], is_array=True)]),
    ]}


@pytest.mark.asyncio
@pytest.mark.parametrize("name", [
    lambda _array, position: f"[{position}]",
    lambda array, position: f"{array}[{position + 1}]",
], ids=["bare-from-0", "twincat-from-1"])
async def test_a_read_struct_two_arrays_up_is_patched_in_place(name, monkeypatch):
    """A change two arrays below a read struct lands at the elements'
    positions in its cached value, copying only the containers on the way
    and building nothing whole; each touched element someone holds is
    emitted once, after the leaf."""
    entry = DatasourceEntry(_plant_config(name))
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    line = f"Plant/Lines/{name('Lines', 1)}"
    motor = f"{line}/Motors/{name('Motors', 2)}"
    leaf = f"{motor}/Speed"
    key = {path: build_var_key("DS", path) for path in ("Plant", "Plant/Lines", line, motor, leaf)}
    dm.set_client_page("c1", {key["Plant"], key[line]})
    dm.seed_cached_values({
        build_var_key("DS", path): 0
        for _steps, path in _composite_leaf_steps(entry.folder_registry["Plant"], entry.folder_registry)
    })
    # As the page's read, an earlier binding of the array and the leaf's own
    # route, built whole on its first leaf, left them.
    for path in ("Plant", "Plant/Lines", f"{line}/Motors"):
        dm._enqueue_folder_struct("DS", entry, path)
    before = entry.cache[key["Plant"]]
    emits: list = []
    dm.set_enqueue_callback(lambda k, value, priority=False: emits.append((k, value)))
    built: list[str] = []
    build = dm._build_folder_fields_snapshot
    monkeypatch.setattr(dm, "_build_folder_fields_snapshot", lambda e, f: built.append(f) or build(e, f))

    routes = _struct_field_routes(entry)
    assert routes[leaf] == (f"{line}/Motors", (2, "Speed"))
    assert entry.ancestor_field_targets(leaf)[-1] == ("Plant", ("Lines", 1, "Motors", 2, "Speed"))
    dm.update_struct_field("DS", *routes[leaf], 99, leaf_path=leaf)
    await asyncio.sleep(0)

    plant = entry.cache[key["Plant"]]
    expected = copy.deepcopy(before)
    expected["Lines"][1]["Motors"][2]["Speed"] = 99
    assert plant == expected
    assert plant["Lines"][0] is before["Lines"][0]
    assert plant["Lines"][1]["Motors"][0] is before["Lines"][1]["Motors"][0]
    assert built == []
    assert emits[0] == (key[leaf], 99)
    assert sorted(k for k, _ in emits[1:]) == sorted([key["Plant"], key[line], key[motor]])
    assert dict(emits)[key[line]] == plant["Lines"][1]
    assert dict(emits)[key[motor]] == {"Speed": 99}
    # The outer array, cached though unread, is patched too, and its element
    # key holds its own element.
    assert entry.cache[key[line]] is entry.cache[key["Plant/Lines"]][1]


def _free_url(suffix: str) -> str:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"opc.tcp://127.0.0.1:{port}/nexthmi/{suffix}/"


async def _until(check, timeout_s: float = 5.0) -> None:
    deadline = time.monotonic() + timeout_s
    while not check() and time.monotonic() < deadline:
        await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_a_bound_struct_subscribes_and_delivers_its_nested_arrays(monkeypatch):
    """``sstDev`` holds ``Func.stSetupPosition : ARRAY[1..6] OF ST_…``, its
    elements named ``stSetupPosition[1]`` …. Binding the struct alone must
    subscribe the leaves inside that array and deliver it as a list in
    position order — a scalar array inside each element included — and a
    change inside an element must reach that element of the list.

    Its initial values are not handled in one loop turn (577 leaves pass
    ``CONSUME_YIELD_EVERY``): a struct rebuilt from the leaf caches each turn
    went out holding only the leaves that had reported so far. Patched into
    the struct the read seeded, they send out nothing but that struct."""
    monkeypatch.setattr(engine_module, "CONSUME_YIELD_EVERY", 1)
    url = _free_url("nested-arrays")
    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace("urn:nexthmi:nested-arrays")
    plc = await server.nodes.objects.add_object(ua.NodeId("Root", idx), "Root")
    server_nodes = {}

    def leaf(name: str, node_id: str, value, *, array_length: int | None = None) -> dict:
        server_nodes[node_id] = value
        entry = {"display_name": name, "node_id": f"ns={idx};s={node_id}", "data_type": "Int16",
                 "enabled": True, "writable": False}
        if array_length is not None:
            entry.update(is_array=True, array_length=array_length)
        return entry

    # Listed out of order: position follows the trailing [N], not the list.
    elements = [
        _folder(f"aArr[{i}]", [leaf("x", f"Root.Func.aArr[{i}].x", 10 * i),
                               leaf("aY", f"Root.Func.aArr[{i}].aY", [i, -i], array_length=2)])
        for i in (3, 1, 2)
    ]
    config = {"name": "DS", "type": "opcua-client", "variables": [
        _folder("Root", [
            leaf("mode", "Root.mode", 7),
            _folder("Func", [_folder("aArr", elements, is_array=True)]),
        ]),
    ]}
    nodes = {}
    for node_id, value in server_nodes.items():
        nodes[node_id] = await plc.add_variable(
            ua.NodeId(node_id, idx), node_id, ua.Variant(value, ua.VariantType.Int16))

    entry = DatasourceEntry(config)
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    root_key = build_var_key("DS", "Root")
    emitted: list = []
    dm.set_enqueue_callback(
        lambda key, value, priority=False: emitted.append(copy.deepcopy(value)) if key == root_key else None)
    notified: set[str] = set()
    patch = dm.update_struct_field
    dm.update_struct_field = lambda *a, **k: (notified.add(k["leaf_path"]), patch(*a, **k))[1]
    engine = DatasourceOpcuaEngine("DS")
    engine.set_datasource_manager(dm)
    expected = {"mode": 7, "Func": {"aArr": [
        {"x": 10, "aY": [1, -1]}, {"x": 20, "aY": [2, -2]}, {"x": 30, "aY": [3, -3]},
    ]}}
    changed = copy.deepcopy(expected)
    changed["Func"]["aArr"][1]["x"] = 99

    await server.start()
    try:
        async with Client(url) as client:
            engine.attach_client(client, {"disable_background_sync": True, "priority_publish_interval_ms": 10})
            await engine._setup_subscriptions()
            # The client opens the page: set_context answers a bound key
            # nothing has cached with a read, then the page's keys are promoted.
            # Bound only now, since setting up the subscriptions promotes the
            # bound keys at once: this isolates the read path. A promote that
            # races ahead of the read can still emit fragments until the
            # leaves report — known, and so on main.
            dm.set_client_page("c1", {root_key})
            first = await engine.read_current_values({"Root"})
            dm.seed_cached_values(first)
            await engine.set_priority_paths({"Root"})
            subscribed = set(engine._priority_path_handles)
            # The initial values patch the struct in place, arrays crossed.
            await _until(lambda: notified >= subscribed)
            await asyncio.sleep(0)
            subscribed_values = list(emitted)

            await nodes["Root.Func.aArr[2].x"].write_value(ua.Variant(99, ua.VariantType.Int16))
            await _until(lambda: bool(emitted) and emitted[-1] == changed)
            await engine._teardown_subscriptions()
    finally:
        await server.stop()

    assert first[root_key] == expected
    assert subscribed == {"Root/mode", *(f"Root/Func/aArr/aArr[{i}]/{f}" for i in (1, 2, 3) for f in ("x", "aY"))}
    assert notified == subscribed
    assert all(value == expected for value in subscribed_values)
    assert emitted[-1] == changed
    assert dm.get_cached_values({root_key})[root_key] == changed


def test_an_array_of_arrays_is_read_and_built_as_nested_lists():
    """``ARRAY OF ARRAY OF ST``: an element that is itself an array is a list
    in the outer one, in the read and in the build a change inside it causes
    alike — never an empty struct."""
    entry = DatasourceEntry({"name": "DS", "type": "opcua-client", "variables": [
        _folder("M", [
            _folder(f"M[{i}]", [_folder(f"[{j}]", [_var("x")]) for j in (0, 1)], is_array=True)
            for i in (0, 1)
        ], is_array=True),
    ]})
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    m = build_var_key("DS", "M")
    dm.set_client_page("c1", {m})
    dm.seed_cached_values({build_var_key("DS", f"M/M[{i}]/[{j}]/x"): 10 * i + j for i in (0, 1) for j in (0, 1)})
    read: dict = {}
    for steps, leaf_path in _composite_leaf_steps(entry.folder_registry["M"], entry.folder_registry):
        _place(read, (m, *steps), entry.cache[build_var_key("DS", leaf_path)])

    dm.update_struct_field("DS", "M/M[1]", (0, "x"), 99, leaf_path="M/M[1]/[0]/x")

    assert read[m] == [[{"x": 0}, {"x": 1}], [{"x": 10}, {"x": 11}]]
    assert entry.cache[m] == [[{"x": 0}, {"x": 1}], [{"x": 99}, {"x": 11}]]


@pytest.mark.asyncio
async def test_a_read_leaves_a_leaf_cached_while_it_was_in_flight_as_it_is():
    """The page's read and the promote of its keys run concurrently. A leaf
    whose newer value arrived while the read was in flight keeps it, and the
    struct the read delivers takes it too: patched in place from then on, it
    would hold the read's older value until that leaf changed again."""
    entry = DatasourceEntry(_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    root = build_var_key("DS", "Root")
    dm.set_client_page("c1", {root})
    routes = _struct_field_routes(entry)

    def notify(leaf: str, value) -> None:
        dm.update_struct_field("DS", *routes[leaf], value, leaf_path=leaf)

    class _Client:
        def get_node(self, node_id: str):
            return SimpleNamespace(nodeid=node_id)

        async def read_values(self, nodes):
            notify("Root/mode", 8)  # the PLC changed after the read sampled it
            return [{"ns=4;s=mode": 7, "ns=4;s=x": 1, "ns=4;s=y": 2}[node.nodeid] for node in nodes]

    engine = DatasourceOpcuaEngine("DS")
    engine.set_datasource_manager(dm)
    engine._client = _Client()
    engine._connected = True
    dm.seed_cached_values(await engine.read_current_values({"Root"}))
    notify("Root/aArr/aArr[1]/x", 5)
    await asyncio.sleep(0)

    assert dm.get_cached_values({build_var_key("DS", "Root/mode")}) == {"DS:Root/mode": 8}
    assert dm.get_cached_values({root})[root]["mode"] == 8


@pytest.mark.asyncio
async def test_a_leaf_read_under_its_own_path_takes_a_value_that_arrived_in_flight():
    """A page binding ``Motors`` and ``Motors/[1]/Speed`` reads both. Speed
    turning 6 while the read is in flight must reach the leaf's own key in the
    result too, not only the array: the result is seeded over the cache, and
    the client applies the frame's leaf over the member it fills in from the
    element."""
    entry = DatasourceEntry({"name": "DS", "type": "opcua-client", "variables": [
        _folder("Motors", [_folder(f"[{i}]", [{**_var("Speed"), "node_id": f"ns=4;s=S{i}"}]) for i in (0, 1)],
                is_array=True),
    ]})
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    leaf = "Motors/[1]/Speed"
    routes = _struct_field_routes(entry)

    class _Client:
        def get_node(self, node_id: str):
            return SimpleNamespace(nodeid=node_id)

        async def read_values(self, nodes):
            dm.update_struct_field("DS", *routes[leaf], 6, leaf_path=leaf)
            return [{"ns=4;s=S0": 1, "ns=4;s=S1": 5}[node.nodeid] for node in nodes]

    engine = DatasourceOpcuaEngine("DS")
    engine.set_datasource_manager(dm)
    engine._client = _Client()
    engine._connected = True
    read = await engine.read_current_values({"Motors", leaf})
    dm.seed_cached_values(read)

    leaf_key = build_var_key("DS", leaf)
    assert read[leaf_key] == 6
    assert read[build_var_key("DS", "Motors")] == [{"Speed": 1}, {"Speed": 6}]
    assert dm.get_cached_values({leaf_key}) == {leaf_key: 6}
