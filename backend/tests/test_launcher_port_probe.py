"""``launcher._port_bindable`` / ``_bind_targets`` — parity with what uvicorn binds.

Two independent gaps, both from the LAN-binding release: the probe checked
AF_INET on ``0.0.0.0`` alone while the default bind host is dual-stack, so an
IPv6-only occupant of the port read as free; and the probe skipped
``SO_REUSEADDR`` on Windows with no replacement, when a plain Windows bind
already permits stacking on an active listener without it — the opposite of
the exclusivity the probe is supposed to be checking for.

The Windows branch (``SO_EXCLUSIVEADDRUSE``) cannot be exercised for real on
this machine — that symbol does not exist in this platform's ``socket``
module. It is asserted with a fake socket that records which option was set,
under a faked ``sys.platform``, rather than pretending to run it.
"""
from __future__ import annotations

import socket
from typing import ClassVar

import launcher
import pytest


def test_bind_targets_default_host_is_dual_stack() -> None:
    """The empty host (``core.net.DEFAULT_HOST``) probes both families.

    Matches asyncio's own ``create_server`` split for it — one AF_INET socket
    on the IPv4 wildcard, one AF_INET6 on the IPv6 wildcard.
    """
    assert launcher._bind_targets("") == [
        (socket.AF_INET, "0.0.0.0"),
        (socket.AF_INET6, "::"),
    ]


def test_bind_targets_ipv4_pin_is_af_inet_only() -> None:
    assert launcher._bind_targets("10.0.0.7") == [(socket.AF_INET, "10.0.0.7")]


def test_bind_targets_literal_ipv4_wildcard_is_single_family() -> None:
    """A ``NEXTHMI_HOST=0.0.0.0`` pin binds AF_INET alone, unlike the default.

    Unlike the empty host, ``getaddrinfo("0.0.0.0", ...)`` never returns an
    AF_INET6 result, so probing that family here would fail on an unrelated
    IPv6-only occupant the real bind will never touch.
    """
    assert launcher._bind_targets("0.0.0.0") == [(socket.AF_INET, "0.0.0.0")]


def test_bind_targets_ipv6_pin_is_af_inet6_only() -> None:
    assert launcher._bind_targets("::1") == [(socket.AF_INET6, "::1")]


def test_probe_catches_an_ipv6_only_occupant_of_the_default_host() -> None:
    """The bug this fixes: an AF_INET-only probe missed an AF_INET6 listener.

    A real IPv6-only socket occupies the port; the default (dual-stack) host
    must read as busy even though its IPv4 half is still free.
    """
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as occupant:
        occupant.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        occupant.bind(("::", 0))
        port = occupant.getsockname()[1]
        occupant.listen(1)

        assert launcher._port_bindable("", port) is False


def test_probe_reports_a_genuinely_free_port() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        free_port = probe.getsockname()[1]
    assert launcher._port_bindable("127.0.0.1", free_port) is True


class _FakeSocket:
    """Records the socket options a probe sets; never touches a real port."""

    created: ClassVar[list[_FakeSocket]] = []

    def __init__(self, family, type_):
        self.family = family
        self.opts: list[tuple[int, int, int]] = []
        _FakeSocket.created.append(self)

    def setsockopt(self, level, optname, value) -> None:
        self.opts.append((level, optname, value))

    def bind(self, addr) -> None:
        pass

    def close(self) -> None:
        pass

    def __enter__(self) -> _FakeSocket:
        return self

    def __exit__(self, *exc) -> None:
        self.close()


@pytest.fixture
def fake_socket(monkeypatch):
    _FakeSocket.created = []
    monkeypatch.setattr(launcher.socket, "socket", _FakeSocket)
    return _FakeSocket


def test_windows_probe_sets_exclusiveaddruse_not_reuseaddr(monkeypatch, fake_socket) -> None:
    """Cannot run for real here: SO_EXCLUSIVEADDRUSE doesn't exist off Windows."""
    monkeypatch.setattr(launcher.sys, "platform", "win32")
    # This platform's socket module has no SO_EXCLUSIVEADDRUSE at all.
    monkeypatch.setattr(launcher.socket, "SO_EXCLUSIVEADDRUSE", 0xFFFFFFFF, raising=False)

    assert launcher._port_bindable("127.0.0.1", 12345) is True

    (sock,) = fake_socket.created
    assert (socket.SOL_SOCKET, launcher.socket.SO_EXCLUSIVEADDRUSE, 1) in sock.opts
    assert not any(optname == socket.SO_REUSEADDR for _, optname, _ in sock.opts)


def test_posix_probe_sets_reuseaddr(monkeypatch, fake_socket) -> None:
    monkeypatch.setattr(launcher.sys, "platform", "darwin")

    assert launcher._port_bindable("127.0.0.1", 12345) is True

    (sock,) = fake_socket.created
    assert (socket.SOL_SOCKET, socket.SO_REUSEADDR, 1) in sock.opts


def test_dual_stack_probe_sets_v6only_on_the_af_inet6_socket(monkeypatch, fake_socket) -> None:
    """Without V6ONLY, an unrestricted "::" bind could shadow the AF_INET probe."""
    monkeypatch.setattr(launcher.sys, "platform", "darwin")

    assert launcher._port_bindable("", 12345) is True

    v4_sock, v6_sock = fake_socket.created
    assert v4_sock.family == socket.AF_INET
    assert v6_sock.family == socket.AF_INET6
    assert (socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1) in v6_sock.opts
