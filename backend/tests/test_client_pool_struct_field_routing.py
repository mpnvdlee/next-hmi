"""Tests for the struct/array-of-struct single-field O(1) patch path.

Covers: _struct_field_routes() route computation, _setup_subscriptions()/
set_priority_paths() actually populating _node_to_field (not just
_node_to_path) for struct leaves, and _DsSubHandler.datachange_notification
routing a struct-leaf datachange to DatasourceManager.update_struct_field()
instead of the full-folder-rebuild update() path.
"""

import asyncio
import gc
import weakref
from typing import Any

import opcua.engine as engine_module
import pytest
from models.datasource import build_var_key
from opcua.client_pool import DatasourceOpcuaEngine, _DsSubHandler, _struct_field_routes
from services.datasource_manager import DatasourceEntry, DatasourceManager


def _make_var(name: str, node_id: str | None = None) -> dict:
    return {
        "display_name": name,
        "node_id": node_id or f"ns=2;s={name}",
        "data_type": "Boolean",
        "enabled": True,
        "writable": False,
    }


def _make_folder(name: str, children: list, *, is_array: bool = False) -> dict:
    folder = {"kind": "folder", "name": name, "node_id": f"ns=2;s={name}", "children": children}
    if is_array:
        folder["is_array"] = True
    return folder


def _array_of_struct_config() -> dict:
    return {
        "name": "DS",
        "type": "opcua-client",
        "variables": [
            _make_var("Scalar", "ns=2;s=Scalar"),
            _make_folder("aAlarms", [
                _make_folder("[0]", [
                    _make_var("bRaised", "ns=2;s=Alarm0Raised"),
                    _make_var("sText", "ns=2;s=Alarm0Text"),
                ]),
                _make_folder("[1]", [
                    _make_var("bRaised", "ns=2;s=Alarm1Raised"),
                    _make_var("sText", "ns=2;s=Alarm1Text"),
                ]),
            ], is_array=True),
        ],
    }


def _nested_struct_config() -> dict:
    return {
        "name": "DS",
        "type": "opcua-client",
        "variables": [
            _make_folder("Motor", [
                _make_var("speed", "ns=2;s=Speed"),
                _make_folder("limits", [
                    _make_var("min", "ns=2;s=Min"),
                    _make_var("max", "ns=2;s=Max"),
                ]),
            ]),
        ],
    }


def _array_inside_struct_config() -> dict:
    """A plain struct folder holding an array-of-struct child."""
    return {
        "name": "DS",
        "type": "opcua-client",
        "variables": [
            _make_folder("Root", [
                _make_var("mode", "ns=2;s=Mode"),
                _make_folder("aArr", [
                    _make_folder("[0]", [_make_var("x", "ns=2;s=X0")]),
                    _make_folder("[1]", [_make_var("x", "ns=2;s=X1")]),
                ], is_array=True),
            ]),
        ],
    }


def _deep_nested_struct_config() -> dict:
    """A bindable struct one level *below* the outermost folder.

    This is the shape a real PLC browse produces — everything hangs off a
    single top-level node (``PLC1/gPlc/…/stRobotActualData``), so the
    outermost folder is never the thing a component binds to.
    """
    return {
        "name": "DS",
        "type": "opcua-client",
        "variables": [
            _make_folder("Plant", [
                _make_folder("Motor", [
                    _make_var("speed", "ns=2;s=Speed"),
                    _make_folder("limits", [
                        _make_var("min", "ns=2;s=Min"),
                        _make_var("max", "ns=2;s=Max"),
                    ]),
                ]),
            ]),
        ],
    }


# ── _struct_field_routes() ────────────────────────────────────────────────────


def test_struct_field_routes_array_of_struct():
    entry = DatasourceEntry(_array_of_struct_config())
    routes = _struct_field_routes(entry)

    assert routes["aAlarms/[0]/bRaised"] == ("aAlarms", (0, "bRaised"))
    assert routes["aAlarms/[0]/sText"] == ("aAlarms", (0, "sText"))
    assert routes["aAlarms/[1]/bRaised"] == ("aAlarms", (1, "bRaised"))
    # Plain scalar leaves are not struct fields.
    assert "Scalar" not in routes


def test_struct_field_routes_nested_struct_inside_array_element():
    """A sub-struct inside an array element patches the aggregate in place
    like a direct field, instead of rebuilding the whole array per change."""
    config = _array_of_struct_config()
    config["variables"][1]["children"][0]["children"].append(
        _make_folder("detail", [_make_var("code", "ns=2;s=Alarm0Code")]),
    )
    entry = DatasourceEntry(config)
    routes = _struct_field_routes(entry)

    assert routes["aAlarms/[0]/detail/code"] == ("aAlarms", (0, "detail", "code"))

    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    dm.set_client_page("c1", {build_var_key("DS", "aAlarms")})
    broadcasts: list[Any] = []
    dm.set_enqueue_callback(lambda key, value, priority=False: broadcasts.append((key, value)))
    dm.update_struct_field("DS", *routes["aAlarms/[0]/detail/code"], 42, leaf_path="aAlarms/[0]/detail/code")

    assert dict(broadcasts)[build_var_key("DS", "aAlarms")][0] == {"detail": {"code": 42}}


def test_struct_field_routes_nested_struct_steps_through_it():
    entry = DatasourceEntry(_nested_struct_config())
    routes = _struct_field_routes(entry)

    assert routes["Motor/speed"] == ("Motor", ("speed",))
    assert routes["Motor/limits/min"] == ("Motor", ("limits", "min"))
    assert routes["Motor/limits/max"] == ("Motor", ("limits", "max"))


def test_struct_field_routes_an_array_inside_a_struct():
    """An array-of-struct nested in a struct routes its own leaves.

    The struct walk stops at the array, so they fell back to `update()`, which
    rebuilt the whole array per datachange — 8 ms per notification on a real
    PLC's 8,000-leaf EtherCAT slave array.
    """
    entry = DatasourceEntry(_array_inside_struct_config())
    routes = _struct_field_routes(entry)

    assert routes["Root/mode"] == ("Root", ("mode",))
    assert routes["Root/aArr/[0]/x"] == ("Root/aArr", (0, "x"))
    assert routes["Root/aArr/[1]/x"] == ("Root/aArr", (1, "x"))


# ── Walks cached per entry (DatasourceEntry.derived) ──────────────────────────


def test_field_routes_are_built_once_per_entry(monkeypatch):
    built: list[DatasourceEntry] = []
    build = engine_module._struct_field_routes
    monkeypatch.setattr(engine_module, "_struct_field_routes", lambda e: built.append(e) or build(e))
    engine = DatasourceOpcuaEngine("DS")
    entry = DatasourceEntry(_array_of_struct_config())

    routes = engine._field_routes(entry)
    assert engine._field_routes(entry) is routes
    # A config edit replaces the entry: the new one builds its own.
    edited = DatasourceEntry(_array_of_struct_config())
    assert engine._field_routes(edited) == routes
    assert built == [entry, edited]


def test_a_bound_folder_is_walked_once_per_entry(monkeypatch):
    """Every recompute expands the bound folders; only a new entry walks one again."""
    walked: list[dict] = []
    walk = engine_module._composite_leaf_steps
    monkeypatch.setattr(
        engine_module, "_composite_leaf_steps",
        lambda folder, registry: walked.append(folder) or walk(folder, registry),
    )
    expand = DatasourceOpcuaEngine._expand_priority_paths
    leaves = {"Root/mode", "Root/aArr/[0]/x", "Root/aArr/[1]/x"}
    entry = DatasourceEntry(_array_inside_struct_config())

    assert expand({"Root"}, entry) == leaves
    assert expand({"Root", "Root/mode"}, entry) == leaves
    assert len(walked) == 1
    assert expand({"Root"}, DatasourceEntry(_array_inside_struct_config())) == leaves
    assert len(walked) == 2


def test_the_engine_keeps_no_replaced_entry_alive():
    """The walks are cached on the entry, not the engine: a replaced entry
    (registry, cache and metadata, tens of MB on a large PLC) is freed at
    once, not held until the next priority change."""
    engine = DatasourceOpcuaEngine("DS")
    entry = DatasourceEntry(_array_of_struct_config())
    engine._field_routes(entry)
    engine._expand_priority_paths({"aAlarms"}, entry)
    released = weakref.ref(entry)

    del entry
    gc.collect()

    assert released() is None


# ── _setup_subscriptions() actually wires _node_to_field ──────────────────────


class _FakeParams:
    RequestedPublishingInterval = 1000.0


class _FakeSub:
    def __init__(self) -> None:
        self.parameters = _FakeParams()
        self._next_handle = 1

    async def subscribe_data_change(self, nodes: list[Any], sampling_interval: float = -1):
        handles = []
        for _ in nodes:
            handles.append(self._next_handle)
            self._next_handle += 1
        return handles

    async def unsubscribe(self, handles: Any) -> None:
        pass

    async def delete(self) -> None:
        pass

    # Iterator mode (engine drains events itself); nothing to deliver here.
    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class _FakeNode:
    def __init__(self, node_id: str) -> None:
        self.nodeid = node_id


class _FakeClient:
    def __init__(self) -> None:
        self.bg_sub = _FakeSub()
        self.priority_sub = _FakeSub()

    def get_node(self, node_id: str) -> _FakeNode:
        return _FakeNode(node_id)

    async def create_subscription(self, params: Any, handler: Any = None, **_kw: Any):
        sub = self.priority_sub if params.Priority == 200 else self.bg_sub
        sub.parameters = params
        return sub

    async def read_values(self, nodes: list[_FakeNode]) -> list[Any]:
        values = {
            "ns=2;s=Alarm0Raised": True,
            "ns=2;s=Alarm0Text": "first",
            "ns=2;s=Alarm1Raised": False,
            "ns=2;s=Alarm1Text": "second",
        }
        return [values[node.nodeid] for node in nodes]


def _make_engine(entry: DatasourceEntry) -> DatasourceOpcuaEngine:
    engine = DatasourceOpcuaEngine("DS")
    engine._client = _FakeClient()
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    engine.set_datasource_manager(dm)
    return engine


@pytest.mark.asyncio
async def test_setup_subscriptions_routes_struct_leaves_to_node_to_field():
    entry = DatasourceEntry(_array_of_struct_config())
    engine = _make_engine(entry)

    await engine._setup_subscriptions()

    assert engine._node_to_path["ns=2;s=Scalar"] == "Scalar"
    assert "ns=2;s=Scalar" not in engine._node_to_field

    assert engine._node_to_field["ns=2;s=Alarm0Raised"] == ("aAlarms", (0, "bRaised"), "aAlarms/[0]/bRaised")
    assert engine._node_to_field["ns=2;s=Alarm1Text"] == ("aAlarms", (1, "sText"), "aAlarms/[1]/sText")
    # Struct leaves must NOT also be routed through the full-rebuild path —
    # the if/elif in datachange_notification means only one map may claim them.
    assert "ns=2;s=Alarm0Raised" not in engine._node_to_path
    assert "ns=2;s=Alarm1Text" not in engine._node_to_path


@pytest.mark.asyncio
async def test_set_priority_paths_promote_routes_struct_leaves_to_node_to_field():
    """disable_background_sync=True skips _setup_subscriptions'
    population entirely, so promotion via set_priority_paths must wire the
    routing maps itself."""
    entry = DatasourceEntry(_array_of_struct_config())
    engine = _make_engine(entry)
    engine._connected = True
    engine._priority_sub = engine._client.priority_sub
    engine._background_sub = engine._client.bg_sub

    await engine.set_priority_paths({"aAlarms"})

    assert engine._node_to_field["ns=2;s=Alarm0Raised"] == ("aAlarms", (0, "bRaised"), "aAlarms/[0]/bRaised")
    assert "ns=2;s=Alarm0Raised" not in engine._node_to_path


@pytest.mark.asyncio
async def test_read_current_values_returns_struct_array_aggregate_and_element_keys():
    entry = DatasourceEntry(_array_of_struct_config())
    engine = _make_engine(entry)
    engine._connected = True

    values = await engine.read_current_values({"aAlarms"})

    expected = [
        {"bRaised": True, "sText": "first"},
        {"bRaised": False, "sText": "second"},
    ]
    assert values["DS:aAlarms"] == expected
    assert values["DS:aAlarms/[0]"] == expected[0]
    assert values["DS:aAlarms/[1]"] == expected[1]


# ── _DsSubHandler routes struct-leaf datachange to update_struct_field ────────


def test_datachange_notification_uses_struct_field_patch_not_full_rebuild():
    entry = DatasourceEntry(_array_of_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    engine = DatasourceOpcuaEngine("DS")
    engine.set_datasource_manager(dm)
    engine._node_to_field["ns=2;s=Alarm0Raised"] = ("aAlarms", (0, "bRaised"), "aAlarms/[0]/bRaised")

    update_calls: list[Any] = []
    patch_calls: list[Any] = []
    dm.update = lambda *a, **kw: update_calls.append((a, kw))
    real_patch = dm.update_struct_field

    def spy_patch(*a, **kw):
        patch_calls.append((a, kw))
        return real_patch(*a, **kw)

    dm.update_struct_field = spy_patch

    broadcasts: list[Any] = []
    dm.set_enqueue_callback(lambda key, value, priority=False: broadcasts.append((key, value)))

    key = build_var_key("DS", "aAlarms")
    leaf_key = build_var_key("DS", "aAlarms/[0]/bRaised")
    elem_key = build_var_key("DS", "aAlarms/[0]")
    # An AlarmList binds the array itself, so a client page carries its key.
    dm.set_client_page("c1", {key})

    handler = _DsSubHandler(engine)
    handler.datachange_notification(_FakeNode("ns=2;s=Alarm0Raised"), True, None)

    assert update_calls == []
    assert len(patch_calls) == 1

    # Built whole on its first leaf: element [1] has reported nothing yet.
    assert entry.cache[key] == [{"bRaised": True}, {}]
    assert entry.cache[leaf_key] is True
    assert entry.cache[elem_key] == {"bRaised": True}
    # Leaf's own composite key and the touched element's own composite key
    # both broadcast alongside the folder-level rollup — the datasource
    # variable table's per-row "Show Live" column reads a struct leaf's live
    # value directly under its own key (not just the folder's aggregate
    # snapshot), and a {path, index} binding on the array resolves to the
    # element's own key.
    assert broadcasts == [
        (leaf_key, True), (key, [{"bRaised": True}, {}]), (elem_key, {"bRaised": True}),
    ]

    # Same value again -> no-op, no broadcast, no second cache mutation.
    handler.datachange_notification(_FakeNode("ns=2;s=Alarm0Raised"), True, None)
    assert len(patch_calls) == 2
    assert len(broadcasts) == 3

    # A real change re-broadcasts with the updated snapshot (leaf + folder + element).
    handler.datachange_notification(_FakeNode("ns=2;s=Alarm0Raised"), False, None)
    assert len(broadcasts) == 6
    assert broadcasts[-3] == (leaf_key, False)
    assert broadcasts[-2] == (key, [{"bRaised": False}, {}])
    assert broadcasts[-1] == (elem_key, {"bRaised": False})
    assert entry.cache[key] == [{"bRaised": False}, {}]
    assert entry.cache[leaf_key] is False
    assert entry.cache[elem_key] == {"bRaised": False}


def test_datachange_notification_nested_struct_field_patch():
    entry = DatasourceEntry(_nested_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    engine = DatasourceOpcuaEngine("DS")
    engine.set_datasource_manager(dm)
    engine._node_to_field["ns=2;s=Min"] = ("Motor", ("limits", "min"), "Motor/limits/min")

    handler = _DsSubHandler(engine)
    handler.datachange_notification(_FakeNode("ns=2;s=Min"), 12.5, None)

    key = build_var_key("DS", "Motor")
    leaf_key = build_var_key("DS", "Motor/limits/min")
    assert entry.cache[key] == {"limits": {"min": 12.5}}
    assert entry.cache[leaf_key] == 12.5


def test_struct_array_fast_patch_preserves_nested_field_shape():
    config = {
        "name": "DS",
        "type": "opcua-client",
        "variables": [
            _make_folder("Items", [
                _make_folder("[0]", [
                    _make_folder("details", [
                        _make_var("value", "ns=2;s=NestedValue"),
                    ]),
                ]),
            ], is_array=True),
        ],
    }
    entry = DatasourceEntry(config)
    dm = DatasourceManager()
    dm.datasources["DS"] = entry

    dm.update_struct_field(
        "DS",
        "Items",
        (0, "details", "value"),
        42,
        leaf_path="Items/[0]/details/value",
    )

    assert entry.cache["DS:Items"] == [{"details": {"value": 42}}]
    assert entry.cache["DS:Items/[0]"] == {"details": {"value": 42}}


# ── Bound intermediate structs stay live (not just the outermost folder) ──────


def test_nested_leaf_change_broadcasts_the_bound_intermediate_struct():
    """A component binding `Plant/Motor` must keep receiving updates.

    The leaf that changes (`Plant/Motor/limits/min`) rolls up to the
    outermost folder `Plant`; without the subscription-aware roll-up the
    intermediate `Plant/Motor` composite is only ever built by the initial
    snapshot and then goes stale forever.
    """
    entry = DatasourceEntry(_deep_nested_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry

    bound_key = build_var_key("DS", "Plant/Motor")
    dm.set_client_page("c1", {bound_key})

    broadcasts: list[Any] = []
    dm.set_enqueue_callback(lambda key, value, priority=False: broadcasts.append((key, value)))

    routes = _struct_field_routes(entry)
    dm.update_struct_field("DS", *routes["Plant/Motor/limits/min"], 7, leaf_path="Plant/Motor/limits/min")

    by_key = dict(broadcasts)
    assert bound_key in by_key, f"bound struct never broadcast; got {sorted(by_key)}"
    assert by_key[bound_key] == {"limits": {"min": 7}}
    # The cache must agree, so a later snapshot() serves the same value.
    assert entry.cache[bound_key] == {"limits": {"min": 7}}


def test_unbound_outer_folder_is_not_broadcast():
    """Nobody binds `Plant`, so its (potentially enormous) composite should
    not be rebuilt and shipped on every leaf change — that rollup is what
    made a 35k-leaf PLC copy its whole tree per datachange."""
    entry = DatasourceEntry(_deep_nested_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    dm.set_client_page("c1", {build_var_key("DS", "Plant/Motor")})

    broadcasts: list[Any] = []
    dm.set_enqueue_callback(lambda key, value, priority=False: broadcasts.append((key, value)))

    routes = _struct_field_routes(entry)
    dm.update_struct_field("DS", *routes["Plant/Motor/limits/min"], 7, leaf_path="Plant/Motor/limits/min")

    assert build_var_key("DS", "Plant") not in dict(broadcasts)


def test_unbound_intermediate_struct_is_not_left_half_built():
    """A composite nobody reads must not be *patched* into existence.

    snapshot() serves cache entries verbatim, so a struct holding only the
    leaves that happened to tick since boot would be handed to the next client
    that connects — a widget with `requiredFields` on it renders wrong or flags
    a bad binding. Absent is correct: set_context reads it fresh.
    """
    entry = DatasourceEntry(_deep_nested_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    dm.set_client_page("c1", set())

    routes = _struct_field_routes(entry)
    dm.update_struct_field("DS", *routes["Plant/Motor/limits/min"], 7, leaf_path="Plant/Motor/limits/min")

    assert build_var_key("DS", "Plant/Motor") not in entry.cache
    assert build_var_key("DS", "Plant/Motor/limits") not in entry.cache


def test_bound_intermediate_struct_is_built_whole_not_patched():
    """The first change under a bound intermediate folder builds the whole
    composite from the child caches, rather than starting a fresh dict from the
    one field that happened to change."""
    entry = DatasourceEntry(_deep_nested_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    bound_key = build_var_key("DS", "Plant/Motor")
    dm.set_client_page("c1", {bound_key})
    # Leaf values already known, with no folder rollup built for them yet.
    dm.seed_cached_values({
        build_var_key("DS", "Plant/Motor/speed"): 1500,
        build_var_key("DS", "Plant/Motor/limits/max"): 99,
    })

    routes = _struct_field_routes(entry)
    dm.update_struct_field("DS", *routes["Plant/Motor/limits/min"], 7, leaf_path="Plant/Motor/limits/min")

    assert entry.cache[bound_key] == {"speed": 1500, "limits": {"min": 7, "max": 99}}


# ── Who a composite is broadcast for ─────────────────────────────────────────


def _alarm_array_setup():
    """A datasource whose array-of-struct folder holds one element."""
    entry = DatasourceEntry(_array_of_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    broadcasts: list[Any] = []
    dm.set_enqueue_callback(lambda key, value, priority=False: broadcasts.append((key, value)))
    return dm, entry, broadcasts


def test_array_aggregate_is_not_broadcast_when_nothing_reads_it():
    """The array folder used to be broadcast unconditionally.

    On a wide array that is a full rebuild plus a deep copy of every element on
    every datachange, for a composite no page binds and no consumer watches.
    The element and the leaf still go out, so `{path, index}` bindings and the
    variable table are unaffected.
    """
    dm, entry, broadcasts = _alarm_array_setup()

    dm.update_struct_field("DS", "aAlarms", (0, "bRaised"), True, leaf_path="aAlarms/[0]/bRaised")

    key = build_var_key("DS", "aAlarms")
    assert key not in [k for k, _ in broadcasts]
    # ...but the cache is still correct for the next client to connect.
    assert entry.cache[key] == [{"bRaised": True}, {}]
    assert build_var_key("DS", "aAlarms/[0]") in [k for k, _ in broadcasts]


def _route_with_arrays_config() -> dict:
    """A root struct whose plain member routes to it, while each array routes
    its own members: ``aCfg`` is static recipe data."""
    def array(name: str, field: str) -> dict:
        return _make_folder(name, [
            _make_folder(f"[{i}]", [_make_var(field, f"ns=2;s={name}{i}")]) for i in (0, 1)
        ], is_array=True)

    return {"name": "DS", "type": "opcua-client", "variables": [
        _make_folder("Root", [_make_var("mode", "ns=2;s=Mode"), array("aArr", "x"), array("aCfg", "p")]),
    ]}


def _route_setup(monkeypatch):
    entry = DatasourceEntry(_route_with_arrays_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    broadcasts: list[Any] = []
    dm.set_enqueue_callback(lambda key, value, priority=False: broadcasts.append((key, value)))
    enqueued: list[str] = []
    monkeypatch.setattr(dm, "_enqueue_folder_struct", lambda _ds, _e, path, *a, **k: enqueued.append(path))
    routes = _struct_field_routes(entry)

    def notify(leaf: str, value: Any) -> None:
        dm.update_struct_field("DS", *routes[leaf], value, leaf_path=leaf)

    return dm, entry, broadcasts, enqueued, notify


@pytest.mark.asyncio
async def test_a_route_enters_the_cache_whole(monkeypatch):
    """The background subscription reports the array members first, then
    ``mode`` brings its route ``Root`` into the cache. Patched in from that
    one member, ``Root`` lacked every member that reported before it — the
    static ``aCfg`` for good — and a page binding it later was served that.
    Built whole from the leaf caches instead, without an emit: nothing reads
    it."""
    dm, entry, broadcasts, enqueued, notify = _route_setup(monkeypatch)
    root = build_var_key("DS", "Root")

    for leaf, value in [("Root/aArr/[0]/x", 1), ("Root/aArr/[1]/x", 2),
                        ("Root/aCfg/[0]/p", 10), ("Root/aCfg/[1]/p", 11), ("Root/mode", 3)]:
        notify(leaf, value)
    await asyncio.sleep(0)
    for value in (20, 21):
        notify("Root/aArr/[1]/x", value)
        await asyncio.sleep(0)

    whole = {"mode": 3, "aArr": [{"x": 1}, {"x": 21}], "aCfg": [{"p": 10}, {"p": 11}]}
    assert entry.cache[root] == whole
    assert root not in [k for k, _ in broadcasts]
    assert enqueued == []
    dm.set_client_page("c1", {root})
    assert dm.get_cached_values({root}) == {root: whole}


@pytest.mark.asyncio
async def test_a_read_route_built_whole_goes_out_once_with_the_turn(monkeypatch):
    dm, _entry, broadcasts, enqueued, notify = _route_setup(monkeypatch)
    root = build_var_key("DS", "Root")
    dm.set_client_page("c1", {root})

    notify("Root/mode", 3)
    notify("Root/aArr/[0]/x", 1)
    assert root not in [k for k, _ in broadcasts]
    await asyncio.sleep(0)

    assert [v for k, v in broadcasts if k == root] == [
        {"mode": 3, "aArr": [{"x": 1}, {}], "aCfg": [{}, {}]},
    ]
    assert enqueued == []


def test_a_cached_composite_is_never_left_stale_after_its_reader_leaves():
    """Cached means never stale, whether or not anyone is still reading it.

    `snapshot()`/`set_context` serve cache entries verbatim, so a composite
    left behind when the last client that bound it disconnected would be handed
    to the next client to bind it — showing the value the variable had when the
    previous session ended. Once unread, an `update()` evicts it rather than
    rebuilding it, and `set_context` reads it fresh.
    """
    entry = DatasourceEntry(_deep_nested_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    key = build_var_key("DS", "Plant/Motor")
    dm.set_client_page("c1", {key})
    broadcasts: list[Any] = []
    dm.set_enqueue_callback(lambda k, value, priority=False: broadcasts.append((k, value)))

    dm.update("DS", "Plant/Motor/speed", 1500)
    assert entry.cache[key]["speed"] == 1500

    dm.set_client_page("c1", set())
    broadcasts.clear()
    dm.update("DS", "Plant/Motor/speed", 9999)

    assert key not in entry.cache
    assert key not in [k for k, _ in broadcasts]


def test_an_uncached_unwanted_ancestor_is_still_left_absent():
    """The other half of the rule: nobody reads it and nothing has cached it,
    so it stays out of the cache entirely — that is what keeps a deep browse
    from holding one full copy of the value tree per ancestor level."""
    entry = DatasourceEntry(_deep_nested_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry

    dm.update("DS", "Plant/Motor/speed", 1500)

    assert build_var_key("DS", "Plant/Motor") not in entry.cache


def test_ancestor_targets_cross_an_array_by_position():
    """A plain-struct ancestor above an array-of-struct holds `aArr` as a
    *list*, so its steps name the element by position, not by its folder
    name: a "[0]" dict key would turn that list into a dict holding only the
    element being written."""
    entry = DatasourceEntry(_array_inside_struct_config())

    assert entry.ancestor_field_targets("Root/aArr/[0]/x") == (
        ("Root/aArr/[0]", ("x",)),
        ("Root/aArr", (0, "x")),
        ("Root", ("aArr", 0, "x")),
    )
    assert entry.ancestor_field_targets("Root/mode") == (("Root", ("mode",)),)


def test_a_struct_holding_an_array_keeps_the_array_a_list():
    """The corruption the check above prevents, end to end."""
    entry = DatasourceEntry(_array_inside_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    root_key = build_var_key("DS", "Root")
    dm.set_client_page("c1", {root_key})
    dm.seed_cached_values({
        build_var_key("DS", "Root/mode"): 3,
        build_var_key("DS", "Root/aArr/[0]/x"): 10,
        build_var_key("DS", "Root/aArr/[1]/x"): 20,
    })
    dm._enqueue_folder_struct("DS", entry, "Root")
    assert entry.cache[root_key] == {"mode": 3, "aArr": [{"x": 10}, {"x": 20}]}

    dm.update_struct_field("DS", "Root/aArr", (0, "x"), 99, leaf_path="Root/aArr/[0]/x")

    assert entry.cache[root_key] == {"mode": 3, "aArr": [{"x": 99}, {"x": 20}]}


def test_a_static_write_refreshes_a_struct_holding_the_array():
    """A static write rebuilt only the composite `_var_to_folder` names — the
    array — and left a struct holding that array stale, which `update()` has
    always refreshed."""
    entry = DatasourceEntry({**_array_inside_struct_config(), "type": "static"})
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    root_key = build_var_key("DS", "Root")
    dm.set_client_page("c1", {root_key})
    dm.seed_cached_values({
        build_var_key("DS", "Root/mode"): 3,
        build_var_key("DS", "Root/aArr/[0]/x"): 10,
        build_var_key("DS", "Root/aArr/[1]/x"): 20,
    })
    dm._enqueue_folder_struct("DS", entry, "Root")

    dm.update_static_value("DS", "Root/aArr/[0]/x", 99)

    assert entry.cache[root_key] == {"mode": 3, "aArr": [{"x": 99}, {"x": 20}]}


def test_an_unread_cached_ancestor_across_an_array_is_patched_in_place(monkeypatch):
    """A cached composite nobody reads, above an array, is patched like any
    other: a whole rebuild per datachange cost its whole subtree (with a large
    PLC's root folder cached, an 800-leaf alarm array blocked the event loop
    for ~30 s), and evicting it instead left `set_context` to read it again."""
    entry = DatasourceEntry(_array_inside_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    root_key = build_var_key("DS", "Root")
    dm.seed_cached_values({
        build_var_key("DS", "Root/mode"): 3,
        build_var_key("DS", "Root/aArr/[0]/x"): 10,
        build_var_key("DS", "Root/aArr/[1]/x"): 20,
    })
    dm._enqueue_folder_struct("DS", entry, "Root")
    before = entry.cache[root_key]

    built: list[str] = []
    real_build = dm._enqueue_folder_struct
    monkeypatch.setattr(
        dm, "_enqueue_folder_struct",
        lambda ds, e, path, *a, **k: (built.append(path), real_build(ds, e, path, *a, **k)),
    )
    dm.update_struct_field("DS", "Root/aArr", (0, "x"), 99, leaf_path="Root/aArr/[0]/x")

    assert entry.cache[root_key] == {"mode": 3, "aArr": [{"x": 99}, {"x": 20}]}
    assert entry.cache[root_key]["aArr"][1] is before["aArr"][1]
    assert built == []


def test_a_server_side_consumer_keeps_its_key_broadcast():
    """An alarm trigger on a composite no client page binds must still be fed.

    The consumer sits on `_value_listeners`, which `_emit_cache_update` only
    reaches for keys that pass the interest test — so a manager that does not
    register its keys silently stops evaluating.
    """
    dm, _entry, broadcasts = _alarm_array_setup()
    key = build_var_key("DS", "aAlarms")
    dm.set_interest_keys("alarms", {key})

    dm.update_struct_field("DS", "aAlarms", (0, "bRaised"), True, leaf_path="aAlarms/[0]/bRaised")

    assert key in [k for k, _ in broadcasts]

    # An empty set deregisters, and the key goes quiet again.
    dm.set_interest_keys("alarms", set())
    broadcasts.clear()
    dm.update_struct_field("DS", "aAlarms", (0, "bRaised"), False, leaf_path="aAlarms/[0]/bRaised")
    assert key not in [k for k, _ in broadcasts]


@pytest.mark.asyncio
async def test_a_read_composite_is_emitted_once_per_loop_turn():
    """A burst under a read composite copies and ships it once, not per leaf.

    A page subscribing a wide array gets an initial value from every leaf at
    once; a copy of the whole array per leaf cost 6 s of event loop on an
    8,000-leaf array, and the broadcast keeps only the last copy per batch.
    """
    dm, _entry, broadcasts = _alarm_array_setup()
    key = build_var_key("DS", "aAlarms")
    dm.set_client_page("c1", {key})

    dm.update_struct_field("DS", "aAlarms", (0, "bRaised"), True, leaf_path="aAlarms/[0]/bRaised")
    dm.update_struct_field("DS", "aAlarms", (1, "sText"), "hot", leaf_path="aAlarms/[1]/sText")
    assert key not in [k for k, _ in broadcasts]

    await asyncio.sleep(0)

    assert [v for k, v in broadcasts if k == key] == [[{"bRaised": True}, {"sText": "hot"}]]


@pytest.mark.asyncio
async def test_a_read_ancestor_across_an_array_is_built_once_then_patched(monkeypatch):
    """A read struct above an array that nothing has cached is built whole
    on the first change under it, and patched by every change after."""
    entry = DatasourceEntry(_array_inside_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    root_key = build_var_key("DS", "Root")
    dm.set_client_page("c1", {root_key})
    built: list[str] = []
    real_build = dm._enqueue_folder_struct
    monkeypatch.setattr(
        dm, "_enqueue_folder_struct",
        lambda ds, e, path, *a, **k: (built.append(path), real_build(ds, e, path, *a, **k)),
    )

    dm.update_struct_field("DS", "Root/aArr", (0, "x"), 1, leaf_path="Root/aArr/[0]/x")
    dm.update_struct_field("DS", "Root/aArr", (1, "x"), 2, leaf_path="Root/aArr/[1]/x")
    await asyncio.sleep(0)

    assert built.count("Root") == 1
    assert entry.cache[root_key] == {"aArr": [{"x": 1}, {"x": 2}]}
