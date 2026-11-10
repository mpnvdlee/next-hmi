"""Client device info — best-effort hostname / IP / MAC lookup for the requesting browser."""
from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/device", tags=["device"])

_PROC_ARP = Path("/proc/net/arp")
_MAC_RE = re.compile(r"([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})")
# An address with no PTR record makes gethostbyaddr wait out the resolver's own
# timeout — 35s on CPython 3.14, which reimplemented it on top of getnameinfo.
# The lookup is best-effort, so cap it rather than hold the response open.
_HOSTNAME_TIMEOUT_SECONDS = 1.0
# Lookups run on their own threads, never the default executor: each one for
# such an address holds its thread for that whole timeout, and a handful of
# them in the default pool stalls every ``to_thread`` caller (sign-in, alarm
# acks, historian flushes). While every thread is busy a new address gets no
# host name rather than a place in a queue that grows with each caller.
_LOOKUP_THREADS = 2
_LOOKUP_EXECUTOR = ThreadPoolExecutor(
    max_workers=_LOOKUP_THREADS, thread_name_prefix="nexthmi-device-lookup"
)
_lookup_slots = threading.BoundedSemaphore(_LOOKUP_THREADS)
# Answers, a missing PTR record included, are kept per address so one caller
# cannot start a lookup per request.
_HOSTNAME_TTL_SECONDS = 60.0
_HOSTNAME_CACHE_MAX = 1024
_hostnames: dict[str, tuple[float, Future[str | None]]] = {}
_hostnames_guard = threading.Lock()


def _client_ip(request: Request) -> str | None:
    """The requesting client's IP address, or ``None`` when it is not one.

    Only ``request.client`` counts: uvicorn has already rewritten it from
    ``X-Forwarded-For`` when the peer is a trusted proxy (here, the manager on
    loopback, which sets that header to the address it saw). A header the
    client sent itself is never read, so nobody can point the lookups below at
    an address of their choosing.
    """
    if request.client is None:
        return None
    try:
        address = ipaddress.ip_address(request.client.host)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return str(address)


def _resolve_hostname(ip: str) -> str | None:
    try:
        return socket.gethostbyaddr(ip)[0]
    except OSError:
        return None


def _hostname_lookup(ip: str) -> Future[str | None] | None:
    """The cached or running lookup for *ip*, a new one, or ``None`` when all threads are busy."""
    now = time.monotonic()
    with _hostnames_guard:
        cached = _hostnames.get(ip)
        if cached is not None and cached[0] > now:
            return cached[1]
        slots = _lookup_slots
        if not slots.acquire(blocking=False):
            return None
        future = _LOOKUP_EXECUTOR.submit(_resolve_hostname, ip)
        future.add_done_callback(lambda _: slots.release())
        _hostnames.pop(ip, None)
        _hostnames[ip] = (now + _HOSTNAME_TTL_SECONDS, future)
        if len(_hostnames) > _HOSTNAME_CACHE_MAX:
            del _hostnames[next(iter(_hostnames))]
        return future


async def _resolve_hostname_async(ip: str) -> str | None:
    """Reverse-resolve ``ip`` on the lookup threads, giving up after the timeout.

    The lookup keeps running until the resolver returns, and its answer serves
    later requests; only this one stops waiting for it.
    """
    future = _hostname_lookup(ip)
    if future is None:
        return None
    # ``asyncio.wait`` rather than ``wait_for``: a timeout must not cancel the
    # shared lookup, which every later caller for this address would then get.
    waiter = asyncio.wrap_future(future)
    done, _ = await asyncio.wait({waiter}, timeout=_HOSTNAME_TIMEOUT_SECONDS)
    return waiter.result() if done else None


def _lookup_mac(ip: str) -> str | None:
    """Look up the MAC for an IP via the OS ARP table.

    Only works when the client is on the same L2 segment as the server.
    Returns None on any failure or when the entry is incomplete.
    """
    if sys.platform.startswith("linux") and _PROC_ARP.exists():
        try:
            text = _PROC_ARP.read_text()
        except OSError:
            return None
        return _parse_proc_arp(text, ip)

    try:
        result = subprocess.run(
            ["arp", "-n", "--", ip],
            capture_output=True,
            text=True,
            timeout=1.0,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return _extract_mac(result.stdout)


def _parse_proc_arp(text: str, ip: str) -> str | None:
    for line in text.splitlines()[1:]:
        cols = line.split()
        if len(cols) >= 4 and cols[0] == ip:
            mac = cols[3]
            if mac and mac != "00:00:00:00:00:00":
                return mac.lower()
    return None


def _extract_mac(text: str) -> str | None:
    match = _MAC_RE.search(text)
    if not match:
        return None
    mac = match.group(1).lower()
    return None if mac == "00:00:00:00:00:00" else mac


@router.get("/info")
async def get_device_info(request: Request) -> dict[str, str | None]:
    """Return best-effort identification for the client making this request.

    Hostname relies on reverse-DNS; MAC relies on the OS ARP table — both can
    return null when unavailable (e.g. no PTR record, client off-LAN).
    """
    ip = _client_ip(request)
    if ip is None:
        return {"ip": None, "hostname": None, "mac": None}
    hostname, mac = await asyncio.gather(
        _resolve_hostname_async(ip),
        asyncio.to_thread(_lookup_mac, ip),
    )
    return {"ip": ip, "hostname": hostname, "mac": mac}
