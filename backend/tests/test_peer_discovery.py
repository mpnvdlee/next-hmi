"""peer_discovery unit tests.

Skipped on hosts where the mDNS responder can't bind (CI sandboxes, Docker
without host networking). The live loopback test is opt-in via
``NEXTHMI_RUN_MDNS_TESTS=1`` because a stray multicast responder on the
build machine can flake. The structural tests run unconditionally.
"""
from __future__ import annotations

import asyncio
import os
import socket
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar

import pytest
from core import peer_discovery as pd_mod
from core import runtime_home
from core.peer_discovery import PeerDiscovery


@pytest.fixture(autouse=True)
def home(monkeypatch, tmp_path: Path) -> Path:
    """``start()`` persists the runtimeId; never into the developer's runtime home."""
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: tmp_path)
    return tmp_path


def test_discovered_excludes_own_runtime_id() -> None:
    """Even if a stray entry matches our runtime_id, ``discovered()`` hides it."""
    pd = PeerDiscovery()
    own_id = pd.runtime_id
    pd._peers["self"] = pd_mod.DiscoveredPeer(
        name="self-host", host="127.0.0.1", port=8000, runtime_id=own_id,
    )
    pd._peers["other"] = pd_mod.DiscoveredPeer(
        name="other-host", host="10.0.0.5", port=8001, runtime_id="rid-other",
    )
    listed = pd.discovered()
    assert {p["runtimeId"] for p in listed} == {"rid-other"}


def test_start_is_idempotent_and_noop_without_zeroconf(monkeypatch) -> None:
    pd = PeerDiscovery()
    monkeypatch.setattr(pd_mod, "_ZEROCONF_AVAILABLE", False)
    asyncio.run(pd.start(port=8000))
    assert pd._started is False
    # A second call doesn't blow up either.
    asyncio.run(pd.start(port=8000))


def test_runtime_id_survives_a_restart(monkeypatch) -> None:
    """Peers pin this device's certificate and remember its pairing by it."""
    monkeypatch.setattr(pd_mod, "_ZEROCONF_AVAILABLE", False)
    first = PeerDiscovery()
    asyncio.run(first.start(port=8000))
    restarted = PeerDiscovery()
    asyncio.run(restarted.start(port=8000))
    assert restarted.runtime_id == first.runtime_id


def test_runtime_id_stable_per_instance() -> None:
    pd = PeerDiscovery()
    first = pd.runtime_id
    # Reading again returns the same value — no regen.
    assert pd.runtime_id == first


def _stub_zeroconf(monkeypatch) -> dict[str, Any]:
    """Run ``start()`` against a fake responder and capture what it advertises."""
    recorded: dict[str, Any] = {}

    class _FakeServiceInfo:
        def __init__(self, **kwargs: Any) -> None:
            recorded.update(kwargs)

    class _FakeAsyncZeroconf:
        def __init__(self, **_kwargs: Any) -> None:
            self.zeroconf = object()

        async def async_register_service(self, _info: Any) -> None:
            return None

        async def async_close(self) -> None:
            return None

    monkeypatch.setattr(pd_mod, "_ZEROCONF_AVAILABLE", True)
    monkeypatch.setattr(pd_mod, "IPVersion", SimpleNamespace(V4Only=object()))
    monkeypatch.setattr(pd_mod, "ServiceInfo", _FakeServiceInfo)
    monkeypatch.setattr(pd_mod, "AsyncZeroconf", _FakeAsyncZeroconf)
    monkeypatch.setattr(pd_mod, "AsyncServiceBrowser", lambda *_a, **_k: object())
    monkeypatch.setattr(pd_mod, "_own_scheme", lambda: "http")
    monkeypatch.delenv("NEXTHMI_HOST", raising=False)
    return recorded


def test_advertises_the_address_the_banner_prints(monkeypatch) -> None:
    """One resolver for both, or a peer dials somewhere we never answer.

    ``gethostbyname(gethostname())`` reads /etc/hosts and answers ``127.0.1.1``
    on a stock Debian, and on a host with wired, wifi and a VPN adapter it
    picks whichever the name happens to map to — not the one the kernel routes
    off-box, which is what the banner tells the operator to type.
    """
    recorded = _stub_zeroconf(monkeypatch)
    monkeypatch.setattr(pd_mod.net, "lan_address", lambda: "192.168.1.10")

    pd = PeerDiscovery()
    asyncio.run(pd.start(port=8000, host_label="panel-pc"))

    assert recorded["addresses"] == [socket.inet_aton("192.168.1.10")]


def test_advertises_the_pinned_bind_host_not_the_lan_address(monkeypatch) -> None:
    """``NEXTHMI_HOST=127.0.0.1`` binds loopback and nothing else.

    Advertising the routed address there publishes one the runtime never
    listens on: a peer discovers it, ``PeerTransferModal`` fills the IP in, and
    pairing hangs to a connect timeout. Loopback is advertised as loopback so
    ``_resolve_private_peer`` rejects it with a readable error instead — and so
    ``NEXTHMI_ALLOW_LOOPBACK_PEERS=1`` still has something to accept.
    """
    recorded = _stub_zeroconf(monkeypatch)
    monkeypatch.setenv("NEXTHMI_HOST", "127.0.0.1")
    monkeypatch.setattr(pd_mod.net, "lan_address", lambda: "192.168.1.10")

    pd = PeerDiscovery()
    asyncio.run(pd.start(port=8000, host_label="panel-pc"))

    assert recorded["addresses"] == [socket.inet_aton("127.0.0.1")]


def test_advertises_loopback_when_there_is_no_route(monkeypatch) -> None:
    """A machine off the network still registers — as the one address it has."""
    recorded = _stub_zeroconf(monkeypatch)
    monkeypatch.setattr(pd_mod.net, "lan_address", lambda: "127.0.0.1")

    pd = PeerDiscovery()
    asyncio.run(pd.start(port=8000, host_label="panel-pc"))

    assert recorded["addresses"] == [socket.inet_aton("127.0.0.1")]


class _FloodedServiceInfo:
    """Stands in for ``AsyncServiceInfo``: resolves when the test lets it, and
    records how many resolves ran at once."""

    gate: asyncio.Event
    resolvable: ClassVar[set[str]] = set()
    running = 0
    most_at_once = 0
    started = 0

    def __init__(self, service_type: str, name: str) -> None:
        self._name = name
        self.properties = {b"runtimeId": name.encode(), b"hostname": b"fake"}
        self.port = 8000

    async def async_request(self, _zeroconf: Any, _timeout: int) -> bool:
        cls = type(self)
        cls.started += 1
        cls.running += 1
        cls.most_at_once = max(cls.most_at_once, cls.running)
        try:
            await cls.gate.wait()
        finally:
            cls.running -= 1
        return self._name in cls.resolvable

    def parsed_addresses(self) -> list[str]:
        return ["10.0.0.9"] if self._name in type(self).resolvable else []


@pytest.fixture
def flooded(monkeypatch) -> type[_FloodedServiceInfo]:
    from zeroconf import ServiceStateChange

    monkeypatch.setattr(pd_mod, "ServiceStateChange", ServiceStateChange)
    monkeypatch.setattr(pd_mod, "AsyncServiceInfo", _FloodedServiceInfo)
    _FloodedServiceInfo.resolvable = set()
    _FloodedServiceInfo.running = 0
    _FloodedServiceInfo.most_at_once = 0
    _FloodedServiceInfo.started = 0
    return _FloodedServiceInfo


def _announce(pd: PeerDiscovery, names: list[str], change: str = "Added") -> None:
    for name in names:
        pd._on_service_state_change(
            object(), pd_mod.SERVICE_TYPE, name, getattr(pd_mod.ServiceStateChange, change)
        )


async def _until_resolved(pd: PeerDiscovery) -> None:
    for _ in range(500):
        if not pd._resolving:
            return
        await asyncio.sleep(0.001)
    raise AssertionError(f"{len(pd._resolving)} resolves still running")


def test_a_flood_of_announcements_keeps_bounded_state(flooded) -> None:
    """Anything on the LAN can announce; what it costs this manager is capped."""

    async def scenario() -> None:
        flooded.gate = asyncio.Event()
        pd = PeerDiscovery()
        names = [f"fake-{index}.{pd_mod.SERVICE_TYPE}" for index in range(5000)]
        _announce(pd, names)
        await asyncio.sleep(0.05)

        assert len(pd._resolving) + len(pd._peers) <= pd_mod._MAX_NAMES
        # The newest names are the ones still waiting; the oldest were dropped.
        assert names[-1] in pd._resolving
        assert names[0] not in pd._resolving
        assert flooded.most_at_once == pd_mod._MAX_CONCURRENT_RESOLVES

        # None of them resolves: every one is dropped, none is listed.
        flooded.gate.set()
        await _until_resolved(pd)
        assert pd.discovered() == []
        assert len(pd._backoff) <= pd_mod._MAX_NAMES
        assert flooded.most_at_once == pd_mod._MAX_CONCURRENT_RESOLVES

        # Announced again at once, a name that just failed is not resolved again.
        started = flooded.started
        _announce(pd, names[-10:])
        assert pd._resolving == {}
        assert flooded.started == started

    asyncio.run(scenario())


def test_resolved_peers_are_capped_oldest_first(flooded) -> None:
    async def scenario() -> None:
        flooded.gate = asyncio.Event()
        flooded.gate.set()
        pd = PeerDiscovery()
        names = [f"peer-{index}.{pd_mod.SERVICE_TYPE}" for index in range(pd_mod._MAX_NAMES + 50)]
        flooded.resolvable = set(names)
        for start in range(0, len(names), 16):
            _announce(pd, names[start : start + 16])
            await _until_resolved(pd)

        assert len(pd._peers) == pd_mod._MAX_NAMES
        assert names[0] not in pd._peers
        assert names[-1] in pd._peers

    asyncio.run(scenario())


def test_a_peer_that_stops_resolving_is_dropped(flooded) -> None:
    async def scenario() -> None:
        flooded.gate = asyncio.Event()
        flooded.gate.set()
        pd = PeerDiscovery()
        name = f"panel.{pd_mod.SERVICE_TYPE}"
        flooded.resolvable = {name}
        _announce(pd, [name])
        await _until_resolved(pd)
        assert [peer["runtimeId"] for peer in pd.discovered()] == [name]

        flooded.resolvable = set()
        _announce(pd, [name], "Updated")
        await _until_resolved(pd)
        assert pd.discovered() == []

    asyncio.run(scenario())


@pytest.mark.skipif(
    os.environ.get("NEXTHMI_RUN_MDNS_TESTS") != "1",
    reason="opt-in: mDNS loopback test (set NEXTHMI_RUN_MDNS_TESTS=1)",
)
def test_loopback_advertise_and_browse() -> None:
    """Two PeerDiscovery instances on the same host should see each other."""
    async def _scenario() -> None:
        a = PeerDiscovery()
        b = PeerDiscovery()
        await a.start(port=18000, host_label="alpha")
        await b.start(port=18001, host_label="beta")
        try:
            # Wait up to 5 s for cross-discovery to settle.
            for _ in range(50):
                if any(p["runtimeId"] == b.runtime_id for p in a.discovered()) and any(
                    p["runtimeId"] == a.runtime_id for p in b.discovered()
                ):
                    break
                await asyncio.sleep(0.1)
            a_sees = [p["runtimeId"] for p in a.discovered()]
            b_sees = [p["runtimeId"] for p in b.discovered()]
            assert b.runtime_id in a_sees
            assert a.runtime_id in b_sees
        finally:
            await a.stop()
            await b.stop()

    asyncio.run(_scenario())
