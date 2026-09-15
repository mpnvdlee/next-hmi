"""Which address to bind the HTTP listener on, and what to print for it.

Deliberately not part of ``core.banner``: that module documents itself as
importing nothing else from ``backend/`` so ``start-dev.py`` can pick it up by
prepending ``backend/`` to ``sys.path``, and probing the network is not a
renderer's job anyway. ``start-dev.py`` already puts ``backend/`` on the path,
so both entry points import this module directly.
"""
from __future__ import annotations

import os
import socket

# The empty host, not ``0.0.0.0``. asyncio binds one socket per address
# ``getaddrinfo`` returns, and sets ``IPV6_V6ONLY`` on every AF_INET6 one it
# opens, so a wildcard that names a family answers on that family alone:
# ``0.0.0.0`` refuses ``::1`` and ``::`` refuses ``127.0.0.1``. Only the empty
# host resolves to both, giving the AF_INET + AF_INET6 pair that makes
# `localhost` — which browsers resolve to ``::1`` first — actually answer.
DEFAULT_HOST = ""
LOOPBACK = "127.0.0.1"
# The name, not the literal: it resolves to whichever family answers, and a
# wildcard bind answers on both. It is also a secure context in every browser,
# which `127.0.0.1` is too but a LAN address over plain HTTP is not.
LOCALHOST = "localhost"

# RFC 5737 TEST-NET-1, reserved for documentation and never routed on the
# public Internet — the probe below can therefore never reach a real host.
_PROBE_TARGET = ("192.0.2.1", 9)

# The two spellings of "bind everywhere" that can actually arrive here — the
# default above, and the literal IPv4 wildcard someone may still pin
# NEXTHMI_HOST to — which are also the two `getsockname()` can report for a
# socket with no source address. Both mean "every interface" to the callers
# below, which only ask so they can name a reachable address instead of an
# unopenable one; the family difference matters to the listener, not to them.
# An IPv6 wildcard is deliberately absent: nothing in the tree sets it, and
# ``launcher._port_bindable`` probes with an AF_INET socket, so it would fail
# there as a phantom port conflict long before reaching this module.
_WILDCARD_HOSTS = frozenset({"", "0.0.0.0"})


def is_wildcard(host: str) -> bool:
    """True when *host* means "every interface" rather than one of them."""
    return host in _WILDCARD_HOSTS


def resolve_bind_host() -> str:
    """The address to bind on: ``NEXTHMI_HOST``, else every interface.

    Reachable by default. A panel is opened from the machines around it, and
    authentication — not the bind address — is what keeps strangers out: the
    dashboard, every editor route and ``/mcp`` each demand a credential
    whichever interface the request arrived on. What binding wide does cost is
    confidentiality, so turn HTTPS on wherever the network is not trusted.
    ``NEXTHMI_HOST=127.0.0.1`` holds an install on loopback.

    The default is the empty host — the dual-stack wildcard. See DEFAULT_HOST
    for why naming a family instead would refuse half of `localhost`.
    """
    return os.environ.get("NEXTHMI_HOST", "").strip() or DEFAULT_HOST


def lan_address() -> str:
    """Best guess at the address other machines reach this host on.

    Asks the kernel which source address it would pick for a route off-box:
    ``connect()`` on a UDP socket only records a peer and selects an
    interface, so nothing is ever sent, and the answer arrives the same way on
    Windows as on Linux — unlike enumerating interfaces, which is neither
    portable nor ordered usefully. Falls back to loopback when the probe finds
    no route: an unplugged NIC, a machine with no network, and an IPv6-only
    host too, since the probe is AF_INET. Loopback is then the honest answer —
    it is the one address such a host is certainly reachable on.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(_PROBE_TARGET)
            address = probe.getsockname()[0]
    except OSError:
        return LOOPBACK
    return address if address and address not in _WILDCARD_HOSTS else LOOPBACK


def advertised_address() -> str:
    """The IPv4 address to publish for this runtime — mDNS, and anything else
    that hands a bare address to another machine.

    Follows the binding rather than the routing table, which is what makes it
    agree with the banner: a wildcard bind answers on every interface, so the
    routed address is the useful one to name, but ``NEXTHMI_HOST=127.0.0.1``
    answers on loopback and nowhere else. Publishing the routed address there
    would advertise one nothing is listening on, and the peer dialling it gets
    a connect timeout instead of a refusal. Loopback is advertised as loopback:
    the connecting side rejects it with a readable error, and the
    ``NEXTHMI_ALLOW_LOOPBACK_PEERS=1`` path for local testing still works.

    A pin that is not an IPv4 literal — a name, an IPv6 literal — cannot go in
    an A record at all, so the routed address is the closest honest answer.
    """
    host = resolve_bind_host()
    if is_wildcard(host):
        return lan_address()
    try:
        socket.inet_aton(host)
    except OSError:
        return lan_address()
    return host


def hostname() -> str:
    """This machine's own name, or an empty string when it cannot be read."""
    try:
        return socket.gethostname().strip()
    except OSError:
        return ""


def display_url(scheme: str, host: str, port: int) -> str:
    """The address to open a listener on *host* at, from this machine.

    A wildcard bind answers on every interface and ``http://0.0.0.0:8000`` is
    not a URL a browser can open, so the banner names ``localhost``: the splash
    is read on the machine it was printed on, and loopback is where the
    shortest and most private route in is. ``network_urls`` is what the other
    machines get.

    A pinned ``NEXTHMI_HOST`` is printed as itself, never as ``localhost``:
    a pin binds that address alone, so ``127.0.0.1`` leaves ``::1`` unbound and
    a LAN pin leaves loopback unbound — and ``localhost`` is whichever of those
    the browser resolves first.
    """
    return _url(scheme, LOCALHOST if is_wildcard(host) else host, port)


def network_urls(scheme: str, host: str, port: int) -> list[str]:
    """The same listener as another machine reaches it: this host's name first,
    then its routed address.

    The name is what survives a DHCP lease; the address is what works where
    name resolution does not. Both, because which one a given network has is
    not knowable from here.

    Empty when the bind names one interface — ``display_url`` already printed
    that address, and it is the only one answering — and empty when the probe
    finds no route off-box, where "reachable from elsewhere" is not true of
    any address this machine has.
    """
    if not is_wildcard(host):
        return []
    address = lan_address()
    if address == LOOPBACK:
        return []
    name = hostname()
    urls = [_url(scheme, name, port)] if name and name != address else []
    urls.append(_url(scheme, address, port))
    return urls


def _url(scheme: str, host: str, port: int) -> str:
    # A bare IPv6 literal has to be bracketed, or the port reads as one more group.
    literal = f"[{host}]" if ":" in host else host
    return f"{scheme}://{literal}:{port}"
