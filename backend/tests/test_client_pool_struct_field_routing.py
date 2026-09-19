"""Tests for the struct/array-of-struct single-field O(1) patch path (§2.7/§7.1).

Covers: _struct_field_routes() route computation, _setup_subscriptions()/
set_priority_paths() actually populating _node_to_field (not just
_node_to_path) for struct leaves, and _DsSubHandler.datachange_notification
routing a struct-leaf datachange to DatasourceManager.update_struct_field()
instead of the full-folder-rebuild update() path.
"""

from typing import Any

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

    assert routes["aAlarms/[0]/bRaised"] == ("aAlarms", "0:bRaised")
    assert routes["aAlarms/[0]/sText"] == ("aAlarms", "0:sText")
    assert routes["aAlarms/[1]/bRaised"] == ("aAlarms", "1:bRaised")
    # Plain scalar leaves are not struct fields.
    assert "Scalar" not in routes


def test_struct_field_routes_nested_struct_uses_dotted_path():
    entry = DatasourceEntry(_nested_struct_config())
    routes = _struct_field_routes(entry)

    assert routes["Motor/speed"] == ("Motor", "speed")
    assert routes["Motor/limits/min"] == ("Motor", "limits/min")
    assert routes["Motor/limits/max"] == ("Motor", "limits/max")


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


class _FakeNode:
    def __init__(self, node_id: str) -> None:
        self.nodeid = node_id


class _FakeClient:
    def __init__(self) -> None:
        self.bg_sub = _FakeSub()
        self.priority_sub = _FakeSub()

    def get_node(self, node_id: str) -> _FakeNode:
        return _FakeNode(node_id)

    async def create_subscription(self, params: Any, handler: Any):
        return self.priority_sub if params.Priority == 200 else self.bg_sub

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

    assert engine._node_to_field["ns=2;s=Alarm0Raised"] == ("aAlarms", "0:bRaised", "aAlarms/[0]/bRaised")
    assert engine._node_to_field["ns=2;s=Alarm1Text"] == ("aAlarms", "1:sText", "aAlarms/[1]/sText")
    # Struct leaves must NOT also be routed through the full-rebuild path —
    # the if/elif in datachange_notification means only one map may claim them.
    assert "ns=2;s=Alarm0Raised" not in engine._node_to_path
    assert "ns=2;s=Alarm1Text" not in engine._node_to_path


@pytest.mark.asyncio
async def test_set_priority_paths_promote_routes_struct_leaves_to_node_to_field():
    """§7.1 comment: disable_background_sync=True skips _setup_subscriptions'
    population entirely, so promotion via set_priority_paths must wire the
    routing maps itself."""
    entry = DatasourceEntry(_array_of_struct_config())
    engine = _make_engine(entry)
    engine._connected = True
    engine._priority_sub = engine._client.priority_sub
    engine._background_sub = engine._client.bg_sub

    await engine.set_priority_paths({"aAlarms"})

    assert engine._node_to_field["ns=2;s=Alarm0Raised"] == ("aAlarms", "0:bRaised", "aAlarms/[0]/bRaised")
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
    engine._node_to_field["ns=2;s=Alarm0Raised"] = ("aAlarms", "0:bRaised", "aAlarms/[0]/bRaised")

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

    assert entry.cache[key] == [{"bRaised": True}]
    assert entry.cache[leaf_key] is True
    assert entry.cache[elem_key] == {"bRaised": True}
    # Leaf's own composite key and the touched element's own composite key
    # both broadcast alongside the folder-level rollup — the datasource
    # variable table's per-row "Show Live" column reads a struct leaf's live
    # value directly under its own key (not just the folder's aggregate
    # snapshot), and a {path, index} binding on the array resolves to the
    # element's own key (§10.5).
    assert broadcasts == [
        (leaf_key, True), (key, [{"bRaised": True}]), (elem_key, {"bRaised": True}),
    ]

    # Same value again -> no-op, no broadcast, no second cache mutation.
    handler.datachange_notification(_FakeNode("ns=2;s=Alarm0Raised"), True, None)
    assert len(patch_calls) == 2
    assert len(broadcasts) == 3

    # A real change re-broadcasts with the updated snapshot (leaf + folder + element).
    handler.datachange_notification(_FakeNode("ns=2;s=Alarm0Raised"), False, None)
    assert len(broadcasts) == 6
    assert broadcasts[-3] == (leaf_key, False)
    assert broadcasts[-2] == (key, [{"bRaised": False}])
    assert broadcasts[-1] == (elem_key, {"bRaised": False})
    assert entry.cache[key] == [{"bRaised": False}]
    assert entry.cache[leaf_key] is False
    assert entry.cache[elem_key] == {"bRaised": False}


def test_datachange_notification_nested_struct_field_patch():
    entry = DatasourceEntry(_nested_struct_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    engine = DatasourceOpcuaEngine("DS")
    engine.set_datasource_manager(dm)
    engine._node_to_field["ns=2;s=Min"] = ("Motor", "limits/min", "Motor/limits/min")

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
        "0:details/value",
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
    folder_path, field_name = routes["Plant/Motor/limits/min"]
    dm.update_struct_field(
        "DS", folder_path, field_name, 7, leaf_path="Plant/Motor/limits/min",
    )

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
    folder_path, field_name = routes["Plant/Motor/limits/min"]
    dm.update_struct_field(
        "DS", folder_path, field_name, 7, leaf_path="Plant/Motor/limits/min",
    )

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
    folder_path, field_name = routes["Plant/Motor/limits/min"]
    dm.update_struct_field(
        "DS", folder_path, field_name, 7, leaf_path="Plant/Motor/limits/min",
    )

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
    folder_path, field_name = routes["Plant/Motor/limits/min"]
    dm.update_struct_field(
        "DS", folder_path, field_name, 7, leaf_path="Plant/Motor/limits/min",
    )

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

    dm.update_struct_field("DS", "aAlarms", "0:bRaised", True, leaf_path="aAlarms/[0]/bRaised")

    key = build_var_key("DS", "aAlarms")
    assert key not in [k for k, _ in broadcasts]
    # ...but the cache is still correct for the next client to connect.
    assert entry.cache[key] == [{"bRaised": True}]
    assert build_var_key("DS", "aAlarms/[0]") in [k for k, _ in broadcasts]


def test_a_cached_composite_stays_correct_after_its_reader_leaves():
    """Cached means kept correct, whether or not anyone is still reading it.

    `snapshot()`/`set_context` serve cache entries verbatim, so a composite
    left behind when the last client that bound it disconnected would be handed
    to the next client to bind it — showing the value the variable had when the
    previous session ended. Only the broadcast is skipped.
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

    assert entry.cache[key]["speed"] == 9999
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


def test_ancestor_targets_skip_a_field_path_that_crosses_an_array():
    """A plain-struct ancestor above an array-of-struct has no field encoding.

    Its cache holds `aArr` as a *list*; patching it through the dict walker
    ("aArr/[0]/x") would replace that list with a dict and drop every element
    but the one being written. Such an ancestor is left out and refreshed by
    the full rebuild instead.
    """
    entry = DatasourceEntry(_array_inside_struct_config())

    targets = entry.ancestor_field_targets("Root/aArr/[0]/x")

    assert ("Root/aArr", "0:x") in targets
    # Reported, but with no field name: the caller rebuilds it whole.
    assert ("Root", None) in targets
    # A leaf that reaches the same ancestor without crossing the array is
    # still addressed field-wise.
    assert ("Root", "mode") in entry.ancestor_field_targets("Root/mode")


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

    dm.update_struct_field("DS", "Root/aArr", "0:x", 99, leaf_path="Root/aArr/[0]/x")

    assert entry.cache[root_key] == {"mode": 3, "aArr": [{"x": 99}, {"x": 20}]}


def test_a_server_side_consumer_keeps_its_key_broadcast():
    """An alarm trigger on a composite no client page binds must still be fed.

    The consumer sits on `_value_listeners`, which `_emit_cache_update` only
    reaches for keys that pass the interest test — so a manager that does not
    register its keys silently stops evaluating.
    """
    dm, _entry, broadcasts = _alarm_array_setup()
    key = build_var_key("DS", "aAlarms")
    dm.set_interest_keys("alarms", {key})

    dm.update_struct_field("DS", "aAlarms", "0:bRaised", True, leaf_path="aAlarms/[0]/bRaised")

    assert key in [k for k, _ in broadcasts]

    # An empty set deregisters, and the key goes quiet again.
    dm.set_interest_keys("alarms", set())
    broadcasts.clear()
    dm.update_struct_field("DS", "aAlarms", "0:bRaised", False, leaf_path="aAlarms/[0]/bRaised")
    assert key not in [k for k, _ in broadcasts]
