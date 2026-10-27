"""
ads.route — create a static AMS route on a PLC over the ADS UDP service.

A PLC answers ADS requests only from an AMS NetID it has a route for; a
direct connection without one opens TCP and then times out on every request.
TwinCAT's "Add Route" dialog creates the route over UDP port 48899,
authorised by a user account on the PLC; ``add_route`` sends the same
request. Every integer is little-endian.

A request is the magic, an invoke id, the service (6: add route), the
sender's NetID and AMS port 10000, then ``(tag, length, value)`` tags: route
name, NetID, user, password and address. The answer carries service
0x80000006 and a status tag (0: route added).
"""

from __future__ import annotations

import asyncio
import socket
import struct

from . import protocol as p

ADS_UDP_PORT = 48899
_UDP_MAGIC = b"\x03\x66\x14\x71"
_UDP_ADD_ROUTE = 6
_UDP_RESPONSE = 0x80000000
_SYSTEM_SERVICE_PORT = 10000
_TAG_STATUS = 1
_TAG_PASSWORD = 2
_TAG_ADDRESS = 5
_TAG_NET_ID = 7
_TAG_ROUTE_NAME = 12
_TAG_USER = 13


class RouteError(Exception):
    """The route could not be created; the message says why, never the password."""


class RouteRefused(RouteError):
    """The PLC answered and refused the route (wrong user name or password)."""


def default_route_name() -> str:
    return f"{socket.gethostname()}-nexthmi"


def local_ip(host: str) -> str:
    """This machine's IPv4 address on the way to *host* (no packet is sent).

    Blocking: a host name is resolved first.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect((host, ADS_UDP_PORT))
        return sock.getsockname()[0]


def _tag(tag: int, value: bytes) -> bytes:
    return struct.pack("<HH", tag, len(value)) + value


def encode_add_route(route_name: str, net_id: bytes, address: str, user: str, password: str) -> bytes:
    """A static route on the PLC to *net_id* at *address*, authorised by a
    user account on the PLC."""
    tags = [
        _tag(_TAG_ROUTE_NAME, route_name.encode() + b"\0"),
        _tag(_TAG_NET_ID, net_id),
        _tag(_TAG_USER, user.encode() + b"\0"),
        _tag(_TAG_PASSWORD, password.encode() + b"\0"),
        _tag(_TAG_ADDRESS, address.encode() + b"\0"),
    ]
    header = _UDP_MAGIC + struct.pack("<II", 0, _UDP_ADD_ROUTE) + net_id
    return header + struct.pack("<HI", _SYSTEM_SERVICE_PORT, len(tags)) + b"".join(tags)


def decode_add_route(data: bytes) -> int:
    """The PLC's status code for an add-route request (0: route added);
    ValueError for anything that is not such an answer."""
    try:
        if data[:4] != _UDP_MAGIC or struct.unpack_from("<I", data, 8)[0] != _UDP_RESPONSE | _UDP_ADD_ROUTE:
            raise ValueError("not an answer to the route request")
        (count,) = struct.unpack_from("<I", data, 20)
        pos = 24
        for _ in range(count):
            tag, length = struct.unpack_from("<HH", data, pos)
            if tag == _TAG_STATUS:
                return struct.unpack_from("<I", data, pos + 4)[0]
            pos += 4 + length
    except struct.error:
        raise ValueError("truncated answer to the route request") from None
    raise ValueError("the PLC answered the route request without a status")


class _Reply(asyncio.DatagramProtocol):
    """The first add-route answer's status, from any source address: a PLC
    with several interfaces may answer from another one. Anything else that
    arrives is ignored."""

    def __init__(self) -> None:
        self.status: asyncio.Future[int] = asyncio.get_running_loop().create_future()

    def datagram_received(self, data: bytes, addr: object) -> None:
        try:
            status = decode_add_route(data)
        except ValueError:
            return
        if not self.status.done():
            self.status.set_result(status)


async def add_route(
    host: str,
    *,
    net_id: bytes,
    address: str,
    user: str,
    password: str,
    route_name: str,
    udp_port: int = ADS_UDP_PORT,
    timeout_s: float = 5.0,
) -> None:
    """Ask the PLC at *host* for a static route to *net_id* at *address*.

    Raises ``RouteRefused`` when the PLC says no, ``RouteError`` with a short
    reason for any other failure.
    """
    request = encode_add_route(route_name, net_id, address, user, password)
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, udp_port, family=socket.AF_INET, type=socket.SOCK_DGRAM)
        transport, reply = await loop.create_datagram_endpoint(
            _Reply, local_addr=("0.0.0.0", 0), family=socket.AF_INET,
        )
    except OSError as exc:
        raise RouteError(f"Route request to {host} failed: {exc}") from None
    try:
        transport.sendto(request, infos[0][4])
        status = await asyncio.wait_for(reply.status, timeout=timeout_s)
    except TimeoutError:
        raise RouteError(f"No answer from {host} on UDP {udp_port}: check a firewall lets it through") from None
    except OSError as exc:
        raise RouteError(f"Route request to {host} failed: {exc}") from None
    finally:
        transport.close()
    if status:
        raise RouteRefused(f"Route refused by the PLC: check the PLC user name and password ({p.AdsError(status)})")
