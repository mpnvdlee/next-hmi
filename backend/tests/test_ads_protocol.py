"""AMS/TCP framing and ADS command payloads (ads.protocol)."""

import struct

import pytest
from ads import protocol as p


def test_net_id_round_trips() -> None:
    raw = p.parse_net_id("5.12.82.20.1.1")
    assert raw == bytes([5, 12, 82, 20, 1, 1])
    assert p.format_net_id(raw) == "5.12.82.20.1.1"


@pytest.mark.parametrize("text", ["5.12.82.20.1", "5.12.82.20.1.1.1", "5.12.82.256.1.1", "a.b.c.d.e.f", ""])
def test_net_id_rejects_malformed(text: str) -> None:
    with pytest.raises(ValueError):
        p.parse_net_id(text)


def test_frame_layout_matches_the_spec() -> None:
    frame = p.encode_frame(
        p.AmsAddress(p.parse_net_id("5.1.2.3.1.1"), 851),
        p.AmsAddress(p.parse_net_id("192.168.0.10.1.1"), 30000),
        p.Command.READ,
        7,
        b"\x01\x02",
    )
    assert frame == bytes.fromhex(
        "0000" "22000000"              # AMS/TCP: reserved, length 32 + 2
        "050102030101" "5303"          # target NetID, port 851
        "c0a8000a0101" "3075"          # source NetID, port 30000
        "0200" "0400"                  # command Read, state flags request
        "02000000" "00000000" "07000000"  # data length, error, invoke id
        "0102"
    )
    packet = p.decode_packet(frame[p.TCP_HEADER_SIZE:])
    assert packet.command == p.Command.READ
    assert packet.invoke_id == 7
    assert packet.target.port == 851
    assert packet.data == b"\x01\x02"
    assert p.frame_length(frame[:p.TCP_HEADER_SIZE]) == 34


def test_result_codes_raise_with_their_meaning() -> None:
    with pytest.raises(p.AdsError) as info:
        p.decode_data_response(struct.pack("<II", 0x710, 0))
    assert info.value.code == 0x710
    assert "symbol not found" in str(info.value)
    assert "0x9999" in str(p.AdsError(0x9999))


def test_read_response_returns_its_data() -> None:
    assert p.decode_data_response(struct.pack("<II", 0, 3) + b"abcX") == b"abc"


def test_device_info_and_state() -> None:
    info = p.decode_device_info(struct.pack("<IBBH", 0, 3, 1, 4024) + b"Plc30 App".ljust(16, b"\0"))
    assert info == p.DeviceInfo("Plc30 App", "3.1.4024")
    assert p.decode_read_state(struct.pack("<IHH", 0, 5, 0)) == (5, 0)


def test_notification_times_travel_in_100ns_units() -> None:
    payload = p.encode_add_notification(0x4040, 8, 4, p.TransMode.SERVER_ON_CHANGE, 50, 20)
    assert len(payload) == 40
    assert struct.unpack_from("<IIIIII", payload) == (0x4040, 8, 4, 4, 500_000, 200_000)


def test_notification_samples_across_stamps() -> None:
    stamp1 = struct.pack("<QI", 1, 2) + struct.pack("<II", 10, 2) + b"ab" + struct.pack("<II", 11, 1) + b"c"
    stamp2 = struct.pack("<QI", 2, 1) + struct.pack("<II", 10, 2) + b"de"
    data = struct.pack("<II", len(stamp1) + len(stamp2), 2) + stamp1 + stamp2
    assert list(p.iter_notification_samples(data)) == [(10, b"ab"), (11, b"c"), (10, b"de")]


def test_sum_read_keeps_failed_items_in_place() -> None:
    payload, read_length = p.encode_sum_read([(0x4040, 0, 2), (0x4040, 8, 4)])
    assert payload == struct.pack("<IIIIII", 0x4040, 0, 2, 0x4040, 8, 4)
    assert read_length == 8 + 6
    response = struct.pack("<II", 0, 0x703) + b"\x01\x00" + b"\0\0\0\0"
    assert p.decode_sum_read(response, [2, 4]) == [(0, b"\x01\x00"), (0x703, b"\0\0\0\0")]


def test_sum_write_layout() -> None:
    payload, read_length = p.encode_sum_write([(0x4040, 0, b"\x01"), (0x4040, 8, b"\x02\x03")])
    assert payload == struct.pack("<IIIIII", 0x4040, 0, 1, 0x4040, 8, 2) + b"\x01\x02\x03"
    assert read_length == 8
    assert p.decode_sum_write(struct.pack("<II", 0, 0x704), 2) == [0, 0x704]
