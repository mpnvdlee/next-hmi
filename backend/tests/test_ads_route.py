"""Creating a static AMS route on a PLC over the ADS UDP service (ads.route)."""

import asyncio
import struct
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from ads.protocol import parse_net_id
from ads.route import RouteError, add_route, decode_add_route, encode_add_route
from tests.ads_fake_plc import FakePlc

NET_ID = parse_net_id("192.168.1.20.1.1")


def _tags(data: bytes) -> dict[int, bytes]:
    (count,) = struct.unpack_from("<I", data, 20)
    tags, pos = {}, 24
    for _ in range(count):
        tag, length = struct.unpack_from("<HH", data, pos)
        tags[tag] = data[pos + 4:pos + 4 + length]
        pos += 4 + length
    return tags


def _answer(*tags: tuple[int, bytes], service: int = 0x80000006) -> bytes:
    body = b"".join(struct.pack("<HH", t, len(v)) + v for t, v in tags)
    return b"\x03\x66\x14\x71" + struct.pack("<II", 0, service) + bytes(6) + struct.pack("<HI", 10000, len(tags)) + body


def test_encode_add_route_matches_the_wire_format() -> None:
    data = encode_add_route("panel-nexthmi", NET_ID, "192.168.1.20", "Administrator", "1")
    assert data[:4] == b"\x03\x66\x14\x71"
    assert struct.unpack_from("<II", data, 4) == (0, 6)
    assert data[12:18] == NET_ID
    assert struct.unpack_from("<H", data, 18) == (10000,)
    assert _tags(data) == {
        12: b"panel-nexthmi\0", 7: NET_ID, 13: b"Administrator\0", 2: b"1\0", 5: b"192.168.1.20\0",
    }
    # Tag order as TwinCAT's own dialog sends them.
    assert [struct.unpack_from("<H", data, pos)[0] for pos in (24, 42, 52, 70, 76)] == [12, 7, 13, 2, 5]


def test_decode_add_route_reads_the_status() -> None:
    assert decode_add_route(_answer((1, struct.pack("<I", 0)))) == 0
    # The status need not be the first tag.
    assert decode_add_route(_answer((7, NET_ID), (1, struct.pack("<I", 0x704)))) == 0x704


@pytest.mark.parametrize("data", [
    b"",
    b"\x00" * 30,
    _answer((1, struct.pack("<I", 0)), service=6),
    _answer((7, NET_ID)),
    _answer((1, struct.pack("<I", 0)))[:26],
])
def test_decode_add_route_rejects_a_malformed_answer(data: bytes) -> None:
    with pytest.raises(ValueError):
        decode_add_route(data)


@pytest_asyncio.fixture
async def plc() -> AsyncIterator[FakePlc]:
    fake = FakePlc()
    await fake.start()
    yield fake
    await fake.stop()


async def _add(plc: FakePlc, password: str, *, udp_port: int | None = None, timeout_s: float = 2.0) -> None:
    await add_route(
        "127.0.0.1", net_id=NET_ID, address="192.168.1.20", user="Administrator", password=password,
        route_name="panel-nexthmi", udp_port=udp_port or plc.udp_port, timeout_s=timeout_s,
    )


@pytest.mark.asyncio
async def test_add_route_adds_the_route(plc: FakePlc) -> None:
    await _add(plc, "1")
    assert plc.routes == {NET_ID}
    assert plc.route_requests[0][12] == b"panel-nexthmi\0"


@pytest.mark.asyncio
async def test_a_refused_route_says_to_check_the_credentials(plc: FakePlc) -> None:
    with pytest.raises(RouteError) as caught:
        await _add(plc, "wrong")
    assert str(caught.value).startswith("Route refused by the PLC: check the PLC user name and password")
    assert "wrong" not in str(caught.value)
    assert plc.routes == set()


@pytest.mark.asyncio
async def test_no_answer_times_out() -> None:
    class Silent(asyncio.DatagramProtocol):
        pass

    transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(Silent, local_addr=("127.0.0.1", 0))
    try:
        port = transport.get_extra_info("sockname")[1]
        with pytest.raises(RouteError, match=f"No answer from 127.0.0.1 on UDP {port}"):
            await add_route(
                "127.0.0.1", net_id=NET_ID, address="192.168.1.20", user="u", password="p",
                route_name="r", udp_port=port, timeout_s=0.2,
            )
    finally:
        transport.close()


@pytest.mark.asyncio
async def test_the_answer_may_come_from_another_address_after_noise() -> None:
    """A multi-homed PLC may answer from another interface; stray datagrams
    in between are ignored."""
    loop = asyncio.get_running_loop()
    answer_from, _ = await loop.create_datagram_endpoint(asyncio.DatagramProtocol, local_addr=("127.0.0.1", 0))

    class Responder(asyncio.DatagramProtocol):
        def datagram_received(self, data: bytes, addr) -> None:
            answer_from.sendto(b"not an answer", addr)
            answer_from.sendto(_answer((1, struct.pack("<I", 0)), service=6), addr)
            answer_from.sendto(_answer((1, struct.pack("<I", 0))), addr)

    listener, _ = await loop.create_datagram_endpoint(Responder, local_addr=("127.0.0.1", 0))
    try:
        await add_route(
            "127.0.0.1", net_id=NET_ID, address="192.168.1.20", user="u", password="p",
            route_name="r", udp_port=listener.get_extra_info("sockname")[1], timeout_s=2.0,
        )
    finally:
        listener.close()
        answer_from.close()
