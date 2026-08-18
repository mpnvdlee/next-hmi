"""Phase 6 — peer_discovery unit tests.

Skipped on hosts where the mDNS responder can't bind (CI sandboxes, Docker
without host networking). The live loopback test is opt-in via
``NEXTHMI_RUN_MDNS_TESTS=1`` because a stray multicast responder on the
build machine can flake. The structural tests run unconditionally.
"""
from __future__ import annotations

import asyncio
import os

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
