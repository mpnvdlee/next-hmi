"""Tests for the /api/device/info endpoint."""
from __future__ import annotations

import threading
import time

import api.device_api as device_api
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def device_client(monkeypatch):
    monkeypatch.setattr(device_api, "_resolve_hostname", lambda ip: f"host-{ip}")
    monkeypatch.setattr(device_api, "_lookup_mac", lambda ip: "aa:bb:cc:dd:ee:ff")

    app = FastAPI()
    app.include_router(device_api.router)
    with TestClient(app) as client:
        yield client


def test_device_info_uses_x_forwarded_for(device_client):
    resp = device_client.get(
        "/api/device/info",
        headers={"X-Forwarded-For": "10.0.4.12, 10.0.0.1"},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "ip": "10.0.4.12",
        "hostname": "host-10.0.4.12",
        "mac": "aa:bb:cc:dd:ee:ff",
    }


def test_device_info_strips_ipv6_mapped_prefix(device_client):
    resp = device_client.get(
        "/api/device/info",
        headers={"X-Forwarded-For": "::ffff:192.168.1.5"},
    )
    assert resp.status_code == 200
    assert resp.json()["ip"] == "192.168.1.5"


def test_device_info_returns_nulls_when_lookups_fail(monkeypatch):
    monkeypatch.setattr(device_api, "_resolve_hostname", lambda ip: None)
    monkeypatch.setattr(device_api, "_lookup_mac", lambda ip: None)

    app = FastAPI()
    app.include_router(device_api.router)
    with TestClient(app) as client:
        resp = client.get(
            "/api/device/info",
            headers={"X-Forwarded-For": "203.0.113.7"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"ip": "203.0.113.7", "hostname": None, "mac": None}


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

    app = FastAPI()
    app.include_router(device_api.router)
    with TestClient(app) as client:
        elapsed = time.monotonic()
        resp = client.get("/api/device/info", headers={"X-Forwarded-For": "203.0.113.7"})
        elapsed = time.monotonic() - elapsed
        # Let the abandoned worker finish before teardown joins the pool.
        release.set()

    assert started.is_set()
    assert elapsed < 5
    # The MAC still resolves: a stalled hostname lookup must not take the rest
    # of the payload down with it.
    assert resp.json() == {"ip": "203.0.113.7", "hostname": None, "mac": "aa:bb:cc:dd:ee:ff"}
