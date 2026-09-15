"""Bind-address resolution and banner URLs (``core.net``)."""
from __future__ import annotations

import asyncio
import ipaddress
import socket

import pytest
from core import net


class _NoRouteSocket:
    """Stand-in for a machine with nowhere to send: an unplugged NIC."""

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    def __enter__(self) -> _NoRouteSocket:
        return self

    def __exit__(self, *_exc) -> bool:
        return False

    def connect(self, _address) -> None:
        raise OSError(51, "Network is unreachable")

    def getsockname(self):  # pragma: no cover - the probe never gets this far
        raise AssertionError("getsockname() after a failed connect()")


# ── resolve_bind_host ────────────────────────────────────────────────────────


def test_default_bind_host_is_every_interface(monkeypatch) -> None:
    """Pin the default deliberately: an install is reachable out of the box.

    The empty string rather than ``0.0.0.0``: that one is the *IPv4* wildcard,
    and `localhost` resolves to ``::1`` first in every browser, so an install
    bound to it refuses the one URL everyone types.
    """
    monkeypatch.delenv("NEXTHMI_HOST", raising=False)
    assert net.resolve_bind_host() == ""


def test_nexthmi_host_pins_an_install_back_to_loopback(monkeypatch) -> None:
    monkeypatch.setenv("NEXTHMI_HOST", "127.0.0.1")
    assert net.resolve_bind_host() == "127.0.0.1"


def test_nexthmi_host_may_name_one_interface(monkeypatch) -> None:
    monkeypatch.setenv("NEXTHMI_HOST", "10.0.0.7")
    assert net.resolve_bind_host() == "10.0.0.7"


def test_blank_nexthmi_host_falls_back_to_the_default(monkeypatch) -> None:
    monkeypatch.setenv("NEXTHMI_HOST", "   ")
    assert net.resolve_bind_host() == ""


def test_default_bind_host_answers_on_both_loopbacks(monkeypatch) -> None:
    """The regression this default exists for: bind it and dial both families.

    ``0.0.0.0`` binds one AF_INET socket and ``::`` one AF_INET6 socket —
    asyncio sets ``IPV6_V6ONLY`` on it — so either alone refuses half of
    `localhost`. Only the empty host makes asyncio bind the pair.
    """
    monkeypatch.delenv("NEXTHMI_HOST", raising=False)

    async def exercise() -> list[str]:
        async def handle(_reader, writer) -> None:
            writer.close()
            # Awaited, not fire-and-forget: an accepted transport still
            # attached to the server when the GC reaches it raises out of
            # ``__del__`` on 3.14, and pytest pins that on whichever test is
            # running at the time.
            await writer.wait_closed()

        server = await asyncio.start_server(
            handle, host=net.resolve_bind_host(), port=0
        )
        reached = []
        async with server:
            # Each socket is dialled on its own port: asked for port 0, asyncio
            # binds the two independently and they land on *different*
            # ephemeral ports. A real listener names a port and both share it.
            for sock in server.sockets:
                address = "127.0.0.1" if sock.family is socket.AF_INET else "::1"
                port = sock.getsockname()[1]
                try:
                    _, writer = await asyncio.wait_for(
                        asyncio.open_connection(address, port), 5
                    )
                except OSError:
                    continue
                writer.close()
                await writer.wait_closed()
                reached.append(address)
        return sorted(reached)

    assert asyncio.run(exercise()) == ["127.0.0.1", "::1"]


# ── lan_address ──────────────────────────────────────────────────────────────


def test_lan_address_returns_a_usable_ipv4_address() -> None:
    address = net.lan_address()
    assert ipaddress.ip_address(address).version == 4


def test_lan_address_falls_back_to_loopback_without_a_route(monkeypatch) -> None:
    monkeypatch.setattr(net.socket, "socket", _NoRouteSocket)
    assert net.lan_address() == "127.0.0.1"


def test_lan_address_rejects_an_unbound_source_address(monkeypatch) -> None:
    """A kernel that answers ``0.0.0.0`` has told us nothing openable."""

    class _Unbound(_NoRouteSocket):
        def connect(self, _address) -> None:
            return None

        def getsockname(self):
            return ("0.0.0.0", 0)

    monkeypatch.setattr(net.socket, "socket", _Unbound)
    assert net.lan_address() == "127.0.0.1"


# ── advertised_address ───────────────────────────────────────────────────────


def test_advertised_address_is_the_routed_one_on_a_wildcard_bind(monkeypatch) -> None:
    monkeypatch.delenv("NEXTHMI_HOST", raising=False)
    monkeypatch.setattr(net, "lan_address", lambda: "192.168.1.10")
    assert net.advertised_address() == "192.168.1.10"


def test_advertised_address_follows_a_pinned_bind_host(monkeypatch) -> None:
    """A pinned host answers on that interface and nowhere else."""
    monkeypatch.setenv("NEXTHMI_HOST", "127.0.0.1")
    monkeypatch.setattr(net, "lan_address", lambda: "192.168.1.10")
    assert net.advertised_address() == "127.0.0.1"


def test_advertised_address_keeps_an_explicit_interface(monkeypatch) -> None:
    monkeypatch.setenv("NEXTHMI_HOST", "10.0.0.7")
    monkeypatch.setattr(net, "lan_address", lambda: "192.168.1.10")
    assert net.advertised_address() == "10.0.0.7"


def test_advertised_address_falls_back_for_a_non_ipv4_pin(monkeypatch) -> None:
    """Only an IPv4 literal can go in the A record this feeds."""
    monkeypatch.setenv("NEXTHMI_HOST", "panel-pc")
    monkeypatch.setattr(net, "lan_address", lambda: "192.168.1.10")
    assert net.advertised_address() == "192.168.1.10"


# ── is_wildcard ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("host", ["", "0.0.0.0"])
def test_is_wildcard_covers_both_spellings_of_every_interface(host) -> None:
    assert net.is_wildcard(host)


@pytest.mark.parametrize("host", ["127.0.0.1", "10.0.0.7", "panel-pc", "localhost"])
def test_is_wildcard_rejects_a_named_interface(host) -> None:
    assert not net.is_wildcard(host)


# ── display_url ──────────────────────────────────────────────────────────────


def test_display_url_names_localhost_for_a_wildcard_bind(monkeypatch) -> None:
    """The splash is read on the machine that printed it."""
    monkeypatch.setattr(net, "hostname", lambda: "panel-pc")
    monkeypatch.setattr(net, "lan_address", lambda: "192.168.1.10")
    assert net.display_url("http", "0.0.0.0", 8000) == "http://localhost:8000"


def test_display_url_keeps_an_explicit_bind_as_itself(monkeypatch) -> None:
    """A pin binds that address alone, and `localhost` is whichever of ::1 and
    127.0.0.1 the browser tries first — so it is never substituted in."""
    monkeypatch.setattr(net, "hostname", lambda: "panel-pc")
    assert net.display_url("https", "127.0.0.1", 8443) == "https://127.0.0.1:8443"
    assert net.display_url("http", "10.0.0.7", 8000) == "http://10.0.0.7:8000"


def test_display_url_brackets_an_ipv6_literal() -> None:
    assert net.display_url("http", "fd00::1", 8000) == "http://[fd00::1]:8000"


# ── network_urls ─────────────────────────────────────────────────────────────


def test_network_urls_give_the_name_then_the_address(monkeypatch) -> None:
    """Both: the name outlives a DHCP lease, the address works where name
    resolution does not, and which one a network has is not knowable here."""
    monkeypatch.setattr(net, "hostname", lambda: "panel-pc")
    monkeypatch.setattr(net, "lan_address", lambda: "192.168.1.10")
    assert net.network_urls("http", "", 8000) == [
        "http://panel-pc:8000",
        "http://192.168.1.10:8000",
    ]


def test_network_urls_drop_an_unreadable_hostname(monkeypatch) -> None:
    monkeypatch.setattr(net, "hostname", lambda: "")
    monkeypatch.setattr(net, "lan_address", lambda: "192.168.1.10")
    assert net.network_urls("http", "0.0.0.0", 8000) == ["http://192.168.1.10:8000"]


def test_network_urls_never_repeat_an_address(monkeypatch) -> None:
    monkeypatch.setattr(net, "hostname", lambda: "192.168.1.10")
    monkeypatch.setattr(net, "lan_address", lambda: "192.168.1.10")
    assert net.network_urls("http", "", 8000) == ["http://192.168.1.10:8000"]


def test_network_urls_are_empty_with_no_route_off_box(monkeypatch) -> None:
    """An unplugged NIC: no address here is reachable from elsewhere, so the
    banner says nothing rather than naming one that is not."""
    monkeypatch.setattr(net, "hostname", lambda: "panel-pc")
    monkeypatch.setattr(net, "lan_address", lambda: net.LOOPBACK)
    assert net.network_urls("http", "", 8000) == []


def test_network_urls_are_empty_for_a_pinned_bind(monkeypatch) -> None:
    """That address is the one display_url printed, and the only one listening."""
    monkeypatch.setattr(net, "hostname", lambda: "panel-pc")
    monkeypatch.setattr(net, "lan_address", lambda: "192.168.1.10")
    assert net.network_urls("http", "10.0.0.7", 8000) == []
