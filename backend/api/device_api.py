"""Client device info — best-effort hostname / IP / MAC lookup for the requesting browser."""
from __future__ import annotations

import asyncio
import re
import socket
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/device", tags=["device"])

_PROC_ARP = Path("/proc/net/arp")
_MAC_RE = re.compile(r"([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})")
# An address with no PTR record makes gethostbyaddr wait out the resolver's own
# timeout — 35s on CPython 3.14, which reimplemented it on top of getnameinfo.
# The lookup is best-effort, so cap it rather than hold the response open.
_HOSTNAME_TIMEOUT_SECONDS = 1.0


def _client_ip(request: Request) -> str | None:
    """Return the originating client IP, honouring X-Forwarded-For when present."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        ip = fwd.split(",")[0].strip()
        if ip:
            return _strip_ipv6_mapped(ip)
    if request.client and request.client.host:
        return _strip_ipv6_mapped(request.client.host)
    return None


def _strip_ipv6_mapped(ip: str) -> str:
    return ip[7:] if ip.startswith("::ffff:") else ip


def _resolve_hostname(ip: str) -> str | None:
    try:
        return socket.gethostbyaddr(ip)[0]
    except OSError:
        return None


async def _resolve_hostname_async(ip: str) -> str | None:
    """Reverse-resolve ``ip`` off the event loop, giving up after the timeout.

    The worker thread keeps running until the resolver returns; only this
    request stops waiting for it.
    """
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_resolve_hostname, ip), _HOSTNAME_TIMEOUT_SECONDS
        )
    except TimeoutError:
        return None


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
            ["arp", "-n", ip],
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
