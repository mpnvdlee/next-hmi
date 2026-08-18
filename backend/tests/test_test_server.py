"""Tests for the OPC-UA test-server pool's port-conflict handling."""
import errno
from types import SimpleNamespace
from typing import Any

import opcua.test_server as test_server_module
import pytest
from asyncua import ua
from core.exceptions import DatasourceConflictError
from opcua.test_server import TestServerInstance as ServerInstance
from opcua.test_server import TestServerPool as ServerPool


class _FakeServer:
    """Minimal asyncua.Server stand-in whose start() refuses to bind."""

    def __init__(self) -> None:
        self.stopped = False

    async def init(self) -> None: ...
    def set_endpoint(self, _endpoint: str) -> None: ...
    def set_server_name(self, _name: str) -> None: ...
    def set_security_policy(self, _policy) -> None: ...
    async def register_namespace(self, _uri: str) -> int:
        return 2
    def get_objects_node(self):
        return object()
    async def start(self) -> None:
        raise OSError(errno.EADDRINUSE, "address already in use")
    async def stop(self) -> None:
        self.stopped = True


@pytest.fixture()
def fake_server(monkeypatch):
    monkeypatch.setattr(test_server_module, "Server", _FakeServer)


_CONFIG = {
    "name": "ts1",
    "type": "opcua-test-server",
    "settings": {"port": 4855},
    "variables": [],
}


@pytest.mark.asyncio
async def test_start_surfaces_port_conflict(fake_server):
    pool = ServerPool()
    with pytest.raises(DatasourceConflictError) as excinfo:
        await pool.start("ts1", _CONFIG)

    # The failed instance is kept so the status API can report the reason.
    instance = pool.get("ts1")
    assert instance is not None
    assert instance.running is False
    assert "4855" in instance.error
    assert "already in use" in instance.error.lower()
    assert "4855" in str(excinfo.value)


@pytest.mark.asyncio
async def test_start_all_does_not_abort_on_conflict(fake_server):
    pool = ServerPool()
    manager = SimpleNamespace(
        datasources={
            "ts1": SimpleNamespace(ds_type="opcua-test-server", config=_CONFIG),
        }
    )

    # Must not raise even though the only server fails to bind.
    await pool.start_all(manager)

    instance = pool.get("ts1")
    assert instance is not None
    assert instance.running is False
    assert instance.error


# ── _populate_nodes array encoding (§2.6 / D-ARRAY.3) ───────────────────────


class _FakeUaNode:
    def __init__(self, node_id: str) -> None:
        self.nodeid = SimpleNamespace(to_string=lambda: node_id)
        self.attrs: dict[Any, Any] = {}
        self.writable: bool | None = None

    async def write_attribute(self, attr_id, data_value) -> None:
        self.attrs[attr_id] = data_value.Value.Value

    async def set_writable(self, writable: bool) -> None:
        self.writable = writable


class _FakeParentNode:
    def __init__(self) -> None:
        self.added_variables: list[tuple[str, Any, _FakeUaNode]] = []
        self._next_id = 0

    async def add_object(self, _idx, name):
        self._next_id += 1
        return _FakeParentNode()

    async def add_variable(self, _idx, display_name, initial_value):
        self._next_id += 1
        node = _FakeUaNode(f"var-{self._next_id}")
        self.added_variables.append((display_name, initial_value, node))
        return node


@pytest.mark.asyncio
async def test_populate_nodes_dynamic_array_creates_array_node():
    instance = ServerInstance("ts")
    parent = _FakeParentNode()
    variables = [{
        "kind": "variable",
        "display_name": "Dyn",
        "data_type": "Float",
        "is_array": True,
        "writable": False,
    }]
    await instance._populate_nodes(parent, 2, variables, 0)
    _, initial_value, node = parent.added_variables[0]
    assert isinstance(initial_value.Value, list)
    assert len(initial_value.Value) == test_server_module._DYNAMIC_ARRAY_SIM_LENGTH
    assert node.attrs[ua.AttributeIds.ValueRank] == 1
    assert node.attrs[ua.AttributeIds.ArrayDimensions] == [0]


@pytest.mark.asyncio
async def test_populate_nodes_fixed_array_creates_sized_array_node():
    instance = ServerInstance("ts")
    parent = _FakeParentNode()
    variables = [{
        "kind": "variable",
        "display_name": "Fixed",
        "data_type": "Float",
        "is_array": True,
        "array_length": 3,
        "writable": False,
    }]
    await instance._populate_nodes(parent, 2, variables, 0)
    _, initial_value, node = parent.added_variables[0]
    assert initial_value.Value == [0.0, 0.0, 0.0]
    assert node.attrs[ua.AttributeIds.ValueRank] == 1
    assert node.attrs[ua.AttributeIds.ArrayDimensions] == [3]


@pytest.mark.asyncio
async def test_populate_nodes_scalar_creates_scalar_node():
    instance = ServerInstance("ts")
    parent = _FakeParentNode()
    variables = [{
        "kind": "variable",
        "display_name": "Scalar",
        "data_type": "Float",
        "writable": False,
    }]
    await instance._populate_nodes(parent, 2, variables, 0)
    _, initial_value, node = parent.added_variables[0]
    assert initial_value.Value == 0.0
    assert node.attrs == {}


# ── Simulation bounds ─────────────────────────────────────────────────────────


def _sample(vtype, sim_min, sim_max, count=40):
    """Values across a full period, so the assertions see the wave's extremes."""
    return [
        ServerInstance._compute_sim_value(vtype, t / 2.0, 0, sim_min, sim_max)
        for t in range(count)
    ]


def test_sim_bounds_keep_a_double_inside_its_band():
    values = _sample(ua.VariantType.Double, 4.0, 4.4)
    assert values, "expected samples"
    assert min(values) >= 4.0
    assert max(values) <= 4.4
    # And it actually moves — a band that never varies would be no better than
    # the static value it replaced.
    assert len(set(values)) > 1


def test_sim_bounds_round_integer_types_into_the_band():
    values = _sample(ua.VariantType.Int32, 1150, 1210)
    assert all(isinstance(v, int) for v in values)
    assert min(values) >= 1150
    assert max(values) <= 1210


def test_without_bounds_the_index_derived_default_still_applies():
    default = ServerInstance._compute_sim_value(ua.VariantType.Double, 1.0, 3)
    explicit = ServerInstance._compute_sim_value(ua.VariantType.Double, 1.0, 3, None, None)
    assert default == explicit
    # idx 3 -> base 80.0 under the legacy formula; far outside a 4.0-4.4 band.
    assert default > 50.0


@pytest.mark.parametrize(
    "sim_min, sim_max",
    [(4.4, 4.0), (4.0, 4.0), (None, 4.0), (4.0, None)],
)
def test_incomplete_or_inverted_bounds_fall_back_to_the_default_wave(sim_min, sim_max):
    bounded = ServerInstance._compute_sim_value(ua.VariantType.Double, 1.0, 0, sim_min, sim_max)
    assert bounded == ServerInstance._compute_sim_value(ua.VariantType.Double, 1.0, 0)


@pytest.mark.parametrize(
    "raw, expected",
    [(4.2, 4.2), (7, 7.0), ("4.2", None), (True, None), (None, None), ({}, None)],
)
def test_sim_bound_only_accepts_real_numbers(raw, expected):
    assert test_server_module._sim_bound(raw) == expected


def test_array_simulation_applies_the_same_band_to_every_element():
    values = ServerInstance._compute_sim_value_array(
        ua.VariantType.Double, 3.0, 0, 4, 10.0, 20.0
    )
    assert len(values) == 4
    assert all(10.0 <= v <= 20.0 for v in values)
