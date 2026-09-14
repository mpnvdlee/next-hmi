"""Bind-address resolution and banner URLs (``core.net``)."""
from __future__ import annotations

import ipaddress

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
    """Pin the default deliberately: an install is reachable out of the box."""
    monkeypatch.delenv("NEXTHMI_HOST", raising=False)
    assert net.resolve_bind_host() == "0.0.0.0"


def test_nexthmi_host_pins_an_install_back_to_loopback(monkeypatch) -> None:
    monkeypatch.setenv("NEXTHMI_HOST", "127.0.0.1")
    assert net.resolve_bind_host() == "127.0.0.1"


def test_nexthmi_host_may_name_one_interface(monkeypatch) -> None:
    monkeypatch.setenv("NEXTHMI_HOST", "10.0.0.7")
    assert net.resolve_bind_host() == "10.0.0.7"


def test_blank_nexthmi_host_falls_back_to_the_default(monkeypatch) -> None:
    monkeypatch.setenv("NEXTHMI_HOST", "   ")
    assert net.resolve_bind_host() == "0.0.0.0"


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


# ── display_urls ─────────────────────────────────────────────────────────────


def test_display_urls_names_the_ways_into_a_wildcard_bind(monkeypatch) -> None:
    monkeypatch.setattr(net, "hostname", lambda: "panel-pc")
    monkeypatch.setattr(net, "lan_address", lambda: "192.168.1.10")
    assert net.display_urls("http", "0.0.0.0", 8000) == [
        "http://panel-pc:8000",
        "http://192.168.1.10:8000",
        "http://127.0.0.1:8000",
    ]


def test_display_urls_keeps_an_explicit_bind_as_itself(monkeypatch) -> None:
    monkeypatch.setattr(net, "hostname", lambda: "panel-pc")
    assert net.display_urls("https", "127.0.0.1", 8443) == ["https://127.0.0.1:8443"]


def test_display_urls_drops_an_unreadable_hostname(monkeypatch) -> None:
    monkeypatch.setattr(net, "hostname", lambda: "")
    monkeypatch.setattr(net, "lan_address", lambda: "192.168.1.10")
    assert net.display_urls("http", "", 8000) == [
        "http://192.168.1.10:8000",
        "http://127.0.0.1:8000",
    ]


def test_display_urls_never_repeats_an_address(monkeypatch) -> None:
    monkeypatch.setattr(net, "hostname", lambda: "127.0.0.1")
    monkeypatch.setattr(net, "lan_address", lambda: "127.0.0.1")
    assert net.display_urls("http", "0.0.0.0", 8000) == ["http://127.0.0.1:8000"]


def test_display_urls_brackets_an_ipv6_literal() -> None:
    assert net.display_urls("http", "fd00::1", 8000) == ["http://[fd00::1]:8000"]
