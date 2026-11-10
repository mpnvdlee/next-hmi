"""Tests for the OPC-UA test-server pool's port-conflict handling."""
import errno
import socket
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import opcua.test_server as test_server_module
import pytest
from asyncua import Client, ua
from asyncua.ua.uaerrors import BadIdentityTokenRejected, BadUserAccessDenied
from core.exceptions import DatasourceConflictError, DatasourceValidationError
from opcua.test_server import TestServerInstance as ServerInstance
from opcua.test_server import TestServerPool as ServerPool


class _FakeServer:
    """Minimal asyncua.Server stand-in whose start() refuses to bind."""

    def __init__(self) -> None:
        self.stopped = False

    async def init(self) -> None: ...
    def set_endpoint(self, _endpoint: str) -> None: ...
    def set_server_name(self, _name: str) -> None: ...
    def set_identity_tokens(self, _tokens) -> None: ...
    def allow_remote_admin(self, _allow: bool) -> None: ...
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
async def test_start_refuses_a_type_it_cannot_simulate(fake_server):
    pool = ServerPool()
    config = {
        **_CONFIG,
        "variables": [{"kind": "variable", "display_name": "Level", "data_type": "Duration"}],
    }
    with pytest.raises(DatasourceValidationError) as excinfo:
        await pool.start("ts1", config)

    instance = pool.get("ts1")
    assert instance is not None
    assert instance.running is False
    assert instance.error == str(excinfo.value)
    assert "Level" in instance.error
    assert "Duration" in instance.error


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


# ── Security endpoints (`security_policies` setting) ────────────────────────


def test_resolve_security_policies_defaults_to_no_security_only():
    assert test_server_module._resolve_security_policies(None) == [
        ua.SecurityPolicyType.NoSecurity,
    ]
    assert test_server_module._resolve_security_policies([]) == [
        ua.SecurityPolicyType.NoSecurity,
    ]


def test_resolve_security_policies_adds_valid_entries_and_ignores_bad_ones():
    policies = test_server_module._resolve_security_policies([
        "Basic256Sha256/Sign",
        "Aes256Sha256RsaPss/SignAndEncrypt",
        "Basic256Sha256/Sign",  # duplicate, kept once
        "Unsupported/Sign",  # unsupported policy name
        "Basic256Sha256/Whatever",  # unsupported mode
        "malformed",  # no "/"
    ])
    assert policies == [
        ua.SecurityPolicyType.NoSecurity,
        ua.SecurityPolicyType.Basic256Sha256_Sign,
        ua.SecurityPolicyType.Aes256Sha256RsaPss_SignAndEncrypt,
    ]


class _FakeSecureServer(_FakeServer):
    """A `_FakeServer` whose start() succeeds and records security setup."""

    def __init__(self) -> None:
        super().__init__()
        self.security_policy: list[Any] = []
        self.certificate_path: str | None = None
        self.private_key_path: str | None = None

    def set_security_policy(self, policy) -> None:
        self.security_policy = policy

    async def load_certificate(self, path: str) -> None:
        self.certificate_path = path

    async def load_private_key(self, path: str) -> None:
        self.private_key_path = path

    async def start(self) -> None:
        pass


@pytest.mark.asyncio
async def test_start_with_no_secured_policies_skips_certificate_loading(monkeypatch):
    monkeypatch.setattr(test_server_module, "Server", _FakeSecureServer)
    instance = ServerInstance("ts-plain")
    await instance.start(_CONFIG)
    try:
        server = instance._server
        assert server.security_policy == [ua.SecurityPolicyType.NoSecurity]
        assert server.certificate_path is None
        assert server.private_key_path is None
    finally:
        await instance.stop()


@pytest.mark.asyncio
async def test_start_with_secured_policy_loads_a_generated_certificate(monkeypatch, tmp_path):
    monkeypatch.setattr(test_server_module, "Server", _FakeSecureServer)
    monkeypatch.setattr(test_server_module, "active_certs_dir", lambda: tmp_path)
    config = {
        "name": "ts-secure",
        "type": "opcua-test-server",
        "settings": {
            "port": 4857,
            "security_policies": ["Basic256Sha256/SignAndEncrypt"],
        },
        "variables": [],
    }
    instance = ServerInstance("ts-secure")
    await instance.start(config)
    try:
        server = instance._server
        assert server.security_policy == [
            ua.SecurityPolicyType.NoSecurity,
            ua.SecurityPolicyType.Basic256Sha256_SignAndEncrypt,
        ]
        assert server.certificate_path == str(tmp_path / "test-server-ts-secure-cert.pem")
        assert server.private_key_path == str(tmp_path / "test-server-ts-secure-key.pem")
        assert (tmp_path / "test-server-ts-secure-cert.pem").exists()
        assert (tmp_path / "test-server-ts-secure-key.pem").exists()
    finally:
        await instance.stop()


@pytest.mark.asyncio
async def test_start_sanitizes_the_datasource_name_into_the_cert_path(monkeypatch, tmp_path):
    """FastAPI's {name} blocks "/" but not "\\", so an unsanitized name would
    steer a Windows install out of certs/."""
    monkeypatch.setattr(test_server_module, "Server", _FakeSecureServer)
    monkeypatch.setattr(test_server_module, "active_certs_dir", lambda: tmp_path)
    name = "..\\..\\evil"
    config = {
        "name": name,
        "type": "opcua-test-server",
        "settings": {
            "port": 4858,
            "security_policies": ["Basic256Sha256/SignAndEncrypt"],
        },
        "variables": [],
    }
    instance = ServerInstance(name)
    await instance.start(config)
    try:
        server = instance._server
        assert server.certificate_path == str(tmp_path / "test-server-..-..-evil-cert.pem")
        assert Path(server.certificate_path).parent == tmp_path
        assert Path(server.private_key_path).parent == tmp_path
    finally:
        await instance.stop()


# ── Reach and sign-in (real asyncua server) ─────────────────────────────────


def _free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _live_config(port: int, **settings: Any) -> dict:
    return {
        "name": "ts-live",
        "type": "opcua-test-server",
        "settings": {"port": port, "endpoint_path": "/nexthmi/test/", **settings},
        "variables": [
            {"kind": "variable", "display_name": "Setpoint", "data_type": "Double", "writable": True},
            {"kind": "variable", "display_name": "Level", "data_type": "Double", "writable": False},
        ],
    }


def _bound_hosts(instance: ServerInstance) -> set[str]:
    return {sock.getsockname()[0] for sock in instance._server.bserver._server.sockets}


@pytest.mark.asyncio
async def test_listens_on_loopback_only_by_default():
    instance = ServerInstance("ts-live")
    await instance.start(_live_config(_free_port()))
    try:
        assert _bound_hosts(instance) == {"127.0.0.1"}
    finally:
        await instance.stop()


@pytest.mark.asyncio
async def test_reachable_from_the_network_binds_every_interface():
    instance = ServerInstance("ts-live")
    await instance.start(_live_config(_free_port(), reachable_from_network=True))
    try:
        assert _bound_hosts(instance) == {"0.0.0.0"}
    finally:
        await instance.stop()


@pytest.mark.asyncio
async def test_signing_in_as_admin_with_any_password_is_refused():
    """asyncua's default user manager made ``admin`` + anything an Admin, which
    writes past AccessLevel and may add or delete nodes."""
    port = _free_port()
    instance = ServerInstance("ts-live")
    await instance.start(_live_config(port))
    client = Client(f"opc.tcp://127.0.0.1:{port}/nexthmi/test/")
    client.set_user("admin")
    client.set_password("anything")
    try:
        with pytest.raises(BadIdentityTokenRejected):
            await client.connect()
    finally:
        await instance.stop()


@pytest.mark.asyncio
async def test_an_anonymous_client_writes_only_what_access_levels_allow():
    port = _free_port()
    config = _live_config(port)
    instance = ServerInstance("ts-live")
    await instance.start(config)
    setpoint_id, level_id = (entry["node_id"] for entry in config["variables"])
    try:
        async with Client(f"opc.tcp://127.0.0.1:{port}/nexthmi/test/") as client:
            await client.get_node(setpoint_id).write_value(ua.Variant(4.2, ua.VariantType.Double))
            assert await client.get_node(setpoint_id).read_value() == 4.2

            with pytest.raises(ua.UaStatusCodeError):
                await client.get_node(level_id).write_value(ua.Variant(1.0, ua.VariantType.Double))
            with pytest.raises(BadUserAccessDenied):
                await client.nodes.objects.add_variable(2, "Injected", 1.0)
            with pytest.raises(BadUserAccessDenied):
                await client.delete_nodes([client.get_node(level_id)])
    finally:
        await instance.stop()


@pytest.mark.asyncio
async def test_the_paired_client_reaches_a_loopback_server(monkeypatch):
    started: list[tuple[str, dict]] = []

    class _RecordingPool:
        async def start(self, name, settings):
            started.append((name, settings))

        async def stop(self, _name): ...

    port = _free_port()
    pool = ServerPool()
    pool.set_opcua_pool(_RecordingPool())
    await pool.start("ts-live", _live_config(port))
    try:
        [(_name, client_settings)] = started
        async with Client(client_settings["server_url"]) as client:
            assert await client.get_namespace_array()
    finally:
        await pool.stop("ts-live")


# ── _populate_nodes array encoding ──────────────────────────────────────────


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
