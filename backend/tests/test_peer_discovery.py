"""Phase 6 — peer_discovery unit tests.

Skipped on hosts where the mDNS responder can't bind (CI sandboxes, Docker
without host networking). The live loopback test is opt-in via
``NEXTHMI_RUN_MDNS_TESTS=1`` because a stray multicast responder on the
build machine can flake. The structural tests run unconditionally.
"""
from __future__ import annotations

import asyncio
import os
import socket
from types import SimpleNamespace
from typing import Any

import pytest
from core import peer_discovery as pd_mod
from core.peer_discovery import PeerDiscovery


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
