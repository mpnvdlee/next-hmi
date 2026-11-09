"""Tests for the /api/device/info endpoint."""
from __future__ import annotations

import asyncio
import threading
import time

import api.device_api as device_api
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request


@pytest.fixture(autouse=True)
def _fresh_hostname_cache(monkeypatch) -> None:
    """Each test starts with no cached answer and every lookup thread free."""
    monkeypatch.setattr(device_api, "_hostnames", {})
    monkeypatch.setattr(
        device_api, "_lookup_slots", threading.BoundedSemaphore(device_api._LOOKUP_THREADS)
    )


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(device_api.router)
    return app


@pytest.fixture()
def lookups(monkeypatch) -> list[str]:
    """Stub both lookups, recording every address they were asked about."""
    asked: list[str] = []

    def _host(ip: str) -> str:
        asked.append(ip)
        return f"host-{ip}"

    monkeypatch.setattr(device_api, "_resolve_hostname", _host)
    monkeypatch.setattr(device_api, "_lookup_mac", lambda ip: "aa:bb:cc:dd:ee:ff")
    return asked


def _info(peer: str, headers: dict[str, str] | None = None, app=None) -> dict:
    with TestClient(app or _app(), client=(peer, 50000)) as client:
        resp = client.get("/api/device/info", headers=headers or {})
    assert resp.status_code == 200
    return resp.json()


def test_device_info_reports_the_peer_address(lookups):
    assert _info("10.0.4.12") == {
        "ip": "10.0.4.12",
        "hostname": "host-10.0.4.12",
        "mac": "aa:bb:cc:dd:ee:ff",
    }


def test_device_info_ignores_a_forwarded_for_the_client_wrote(lookups):
    info = _info("10.0.4.12", {"X-Forwarded-For": "203.0.113.7", "X-Real-IP": "203.0.113.8"})
    assert info["ip"] == "10.0.4.12"
    assert lookups == ["10.0.4.12"]


def test_device_info_strips_ipv6_mapped_prefix(lookups):
    assert _info("::ffff:192.168.1.5")["ip"] == "192.168.1.5"


@pytest.mark.parametrize("peer", ["testclient", "-f", "--help", "10.0.0.1; reboot", ""])
def test_device_info_looks_nothing_up_for_a_peer_that_is_no_address(lookups, peer):
    assert _info(peer) == {"ip": None, "hostname": None, "mac": None}
    assert lookups == []


def test_device_info_takes_the_address_the_manager_forwarded():
    """The instance runs under uvicorn's proxy-header handling, which trusts
    loopback: the manager's ``X-Forwarded-For`` becomes ``request.client``,
    while the same header from any other peer is ignored."""
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    app = ProxyHeadersMiddleware(_app(), trusted_hosts="127.0.0.1")
    via_manager = _info("127.0.0.1", {"X-Forwarded-For": "10.0.4.12"}, app)
    assert via_manager["ip"] == "10.0.4.12"
    around_it = _info("10.9.9.9", {"X-Forwarded-For": "10.0.4.12"}, app)
    assert around_it["ip"] == "10.9.9.9"


def test_device_info_returns_nulls_when_lookups_fail(monkeypatch):
    monkeypatch.setattr(device_api, "_resolve_hostname", lambda ip: None)
    monkeypatch.setattr(device_api, "_lookup_mac", lambda ip: None)
    assert _info("203.0.113.7") == {"ip": "203.0.113.7", "hostname": None, "mac": None}


def test_arp_gets_the_address_after_an_end_of_options_marker(monkeypatch, tmp_path):
    calls: list[list[str]] = []

    class _Done:
        stdout = "? (10.0.4.12) at aa:bb:cc:dd:ee:ff on en0\n"

    def _run(args, **kwargs):
        calls.append(args)
        return _Done()

    monkeypatch.setattr(device_api, "_PROC_ARP", tmp_path / "missing")
    monkeypatch.setattr(device_api.subprocess, "run", _run)
    assert device_api._lookup_mac("10.0.4.12") == "aa:bb:cc:dd:ee:ff"
    assert calls == [["arp", "-n", "--", "10.0.4.12"]]


def test_parse_proc_arp_finds_mac():
    text = (
        "IP address       HW type     Flags       HW address            Mask     Device\n"
        "10.0.4.12        0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0\n"
        "10.0.4.99        0x1         0x0         00:00:00:00:00:00     *        eth0\n"
    )
    assert device_api._parse_proc_arp(text, "10.0.4.12") == "aa:bb:cc:dd:ee:ff"
    assert device_api._parse_proc_arp(text, "10.0.4.99") is None
    assert device_api._parse_proc_arp(text, "10.0.4.50") is None


def test_extract_mac_handles_arp_command_output():
    text = "? (10.0.4.12) at aa:bb:cc:dd:ee:ff [ether] on eth0\n"
    assert device_api._extract_mac(text) == "aa:bb:cc:dd:ee:ff"
    assert device_api._extract_mac("(incomplete)") is None


def test_slow_reverse_dns_times_out_without_blocking_the_response(monkeypatch):
    """A PTR-less address must not hold the event loop for the resolver timeout.

    CPython 3.14 reimplemented ``gethostbyaddr`` on top of ``getnameinfo``, so an
    address with no PTR record now waits out the resolver's own timeout (~35s)
    instead of failing fast. Called inline from the async handler that would
    stall every WebSocket update and OPC-UA callback for the duration.
    """
    started = threading.Event()
    release = threading.Event()

    def _never_returns(ip: str) -> str | None:
        started.set()
        release.wait(30)
        return "too-late"

    monkeypatch.setattr(device_api, "_resolve_hostname", _never_returns)
    monkeypatch.setattr(device_api, "_lookup_mac", lambda ip: "aa:bb:cc:dd:ee:ff")
    monkeypatch.setattr(device_api, "_HOSTNAME_TIMEOUT_SECONDS", 0.05)

    with TestClient(_app(), client=("203.0.113.7", 50000)) as client:
        elapsed = time.monotonic()
        resp = client.get("/api/device/info")
        elapsed = time.monotonic() - elapsed
        # Let the abandoned worker finish before teardown joins the pool.
        release.set()

    assert started.is_set()
    assert elapsed < 5
    # The MAC still resolves: a stalled hostname lookup must not take the rest
    # of the payload down with it.
    assert resp.json() == {"ip": "203.0.113.7", "hostname": None, "mac": "aa:bb:cc:dd:ee:ff"}


def _request_from(ip: str) -> Request:
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [], "client": (ip, 50000)})


def test_a_burst_from_unresolvable_addresses_leaves_the_default_pool_free(monkeypatch):
    """Every lookup for a PTR-less address holds its thread for the resolver's
    whole timeout (~35s), long after the request stopped waiting. A burst from
    more addresses than the default executor has threads used to fill it, and
    every ``to_thread`` caller — sign-in, alarm ack, historian flush — waited
    behind them."""
    release = threading.Event()
    started: list[str] = []

    def _hangs(ip: str) -> str | None:
        started.append(ip)
        release.wait(30)
        return None

    monkeypatch.setattr(device_api, "_resolve_hostname", _hangs)
    monkeypatch.setattr(device_api, "_lookup_mac", lambda ip: None)
    monkeypatch.setattr(device_api, "_HOSTNAME_TIMEOUT_SECONDS", 0.05)

    async def scenario() -> float:
        burst = [
            asyncio.create_task(device_api.get_device_info(_request_from(f"203.0.113.{n}")))
            for n in range(1, 81)
        ]
        # Long enough for every request to stop waiting for its host name,
        # while the lookups themselves still hang.
        await asyncio.sleep(0.3)
        elapsed = time.monotonic()
        await asyncio.wait_for(asyncio.to_thread(lambda: None), timeout=10)
        elapsed = time.monotonic() - elapsed
        answers = await asyncio.gather(*burst)
        assert all(answer["hostname"] is None for answer in answers)
        return elapsed

    # The abandoned lookups end after this, so a stalled pool shows as a wait
    # of seconds rather than a hang.
    threading.Timer(3.0, release.set).start()
    try:
        unrelated = asyncio.run(scenario())
    finally:
        release.set()

    assert unrelated < 0.5
    assert len(started) <= device_api._LOOKUP_THREADS


def test_hostname_answers_are_cached_per_address(lookups):
    assert _info("10.0.4.12")["hostname"] == "host-10.0.4.12"
    assert _info("10.0.4.12")["hostname"] == "host-10.0.4.12"
    assert lookups == ["10.0.4.12"]


def test_a_missing_ptr_record_is_cached_too(monkeypatch):
    asked: list[str] = []

    def _none(ip: str) -> None:
        asked.append(ip)

    monkeypatch.setattr(device_api, "_resolve_hostname", _none)
    monkeypatch.setattr(device_api, "_lookup_mac", lambda ip: None)
    assert _info("203.0.113.7")["hostname"] is None
    assert _info("203.0.113.7")["hostname"] is None
    assert asked == ["203.0.113.7"]


def test_a_cached_answer_expires(lookups, monkeypatch):
    monkeypatch.setattr(device_api, "_HOSTNAME_TTL_SECONDS", 0.0)
    _info("10.0.4.12")
    _info("10.0.4.12")
    assert lookups == ["10.0.4.12", "10.0.4.12"]


def test_no_lookup_starts_while_every_lookup_thread_is_busy(monkeypatch):
    release = threading.Event()
    asked: list[str] = []

    def _hangs(ip: str) -> str:
        asked.append(ip)
        release.wait(30)
        return f"host-{ip}"

    monkeypatch.setattr(device_api, "_resolve_hostname", _hangs)
    monkeypatch.setattr(device_api, "_lookup_mac", lambda ip: None)
    monkeypatch.setattr(device_api, "_HOSTNAME_TIMEOUT_SECONDS", 0.05)
    try:
        busy = [f"203.0.113.{n}" for n in range(1, device_api._LOOKUP_THREADS + 1)]
        for ip in busy:
            assert _info(ip)["hostname"] is None
        assert _info("10.0.4.12")["hostname"] is None
        assert asked == busy
    finally:
        release.set()
