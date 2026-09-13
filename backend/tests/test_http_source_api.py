"""Tests for /api/http-request — the outbound proxy behind the $http source.

Every request the proxy performs has to name an origin the project configures
(see test_http_origin_allowlist.py), so these behaviour tests run against a
live project whose config.json declares the two origins they use.
"""
from __future__ import annotations

import api.http_source_api as http_source_api
import core.http_origins as http_origins
import httpx
import pytest
from core.storage import write_json
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _configured_origins(live_project_root):
    """A project whose $http sources name the origins these tests call."""
    write_json(
        live_project_root / "config.json",
        {
            "globalEvents": {
                "onLoad": [
                    {"type": "setProperty", "value": {"$http": {"url": "https://api.example.com/x"}}},
                    {"type": "setProperty", "value": {"$http": {"url": "http://plc.local/temp"}}},
                ]
            }
        },
    )
    http_origins.invalidate_http_origin_cache()
    yield
    http_origins.invalidate_http_origin_cache()


@pytest.fixture()
def proxy_client():
    app = FastAPI()
    app.include_router(http_source_api.router)
    with TestClient(app) as client:
        yield client


def _stub_transport(monkeypatch, handler):
    """Route every outbound httpx request through `handler`."""
    original = httpx.AsyncClient.__init__

    def patched(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        original(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched)


def test_returns_parsed_json_body(proxy_client, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-token"] == "abc"
        return httpx.Response(200, json={"data": [{"value": 42}]})

    _stub_transport(monkeypatch, handler)

    resp = proxy_client.post(
        "/api/http-request",
        json={"url": "https://api.example.com/x", "headers": {"X-Token": "abc"}},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "status": 200, "body": {"data": [{"value": 42}]}, "error": None}


def test_posts_the_body_through(proxy_client, monkeypatch):
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["content"] = request.content.decode()
        return httpx.Response(200, json={"ok": 1})

    _stub_transport(monkeypatch, handler)

    resp = proxy_client.post(
        "/api/http-request",
        json={"url": "https://api.example.com/x", "method": "POST", "body": '{"id": "abc"}'},
    )
    assert resp.status_code == 200
    assert seen == {"method": "POST", "content": '{"id": "abc"}'}


def test_non_json_body_is_returned_as_text(proxy_client, monkeypatch):
    _stub_transport(monkeypatch, lambda request: httpx.Response(200, text="17.4 degC"))

    resp = proxy_client.post("/api/http-request", json={"url": "http://plc.local/temp"})
    assert resp.json()["body"] == "17.4 degC"


def test_upstream_error_status_is_reported_in_the_body(proxy_client, monkeypatch):
    _stub_transport(monkeypatch, lambda request: httpx.Response(503, text="down"))

    resp = proxy_client.post("/api/http-request", json={"url": "http://plc.local/temp"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": False, "status": 503, "body": None, "error": "HTTP 503"}


def test_transport_failure_is_reported_in_the_body(proxy_client, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    _stub_transport(monkeypatch, handler)

    resp = proxy_client.post("/api/http-request", json={"url": "http://plc.local/temp"})
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["ok"] is False
    assert payload["status"] == 0
    assert "no route to host" in payload["error"]


def test_oversized_response_is_rejected(proxy_client, monkeypatch):
    oversized = "x" * (http_source_api._MAX_BODY_BYTES + 1)
    _stub_transport(monkeypatch, lambda request: httpx.Response(200, text=oversized))

    resp = proxy_client.post("/api/http-request", json={"url": "http://plc.local/big"})
    assert resp.json()["ok"] is False
    assert "exceeds" in resp.json()["error"]


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://host/x", "not-a-url"])
def test_non_http_schemes_are_refused(proxy_client, url):
    resp = proxy_client.post("/api/http-request", json={"url": url})
    payload = resp.json()
    assert payload["ok"] is False
    assert payload["status"] == 0


# ── Redirects ─────────────────────────────────────────────────────────────────


def test_caller_headers_do_not_follow_a_cross_origin_redirect(proxy_client, monkeypatch):
    """httpx strips only Authorization and Cookie across origins; an $http
    source's key rides in a header the author named, so none of them may go."""
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.host, request.headers.get("x-api-key")))
        if request.url.host == "api.example.com":
            return httpx.Response(302, headers={"location": "http://plc.local/temp"})
        return httpx.Response(200, json={"v": 1})

    _stub_transport(monkeypatch, handler)

    resp = proxy_client.post(
        "/api/http-request",
        json={"url": "https://api.example.com/x", "headers": {"X-Api-Key": "s3cret"}},
    )
    assert resp.json()["ok"] is True
    assert seen == [("api.example.com", "s3cret"), ("plc.local", None)]


def test_caller_headers_survive_a_same_origin_redirect(proxy_client, monkeypatch):
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("x-api-key"))
        if request.url.path == "/x":
            return httpx.Response(302, headers={"location": "/moved"})
        return httpx.Response(200, json={"v": 1})

    _stub_transport(monkeypatch, handler)

    resp = proxy_client.post(
        "/api/http-request",
        json={"url": "https://api.example.com/x", "headers": {"X-Api-Key": "s3cret"}},
    )
    assert resp.json()["ok"] is True
    assert seen == ["s3cret", "s3cret"]


def test_a_relative_location_is_resolved_against_the_previous_hop(proxy_client, monkeypatch):
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if request.url.path == "/deep/x":
            return httpx.Response(302, headers={"location": "../moved?q=1"})
        return httpx.Response(200, json={"v": 1})

    _stub_transport(monkeypatch, handler)

    resp = proxy_client.post("/api/http-request", json={"url": "https://api.example.com/deep/x"})
    assert resp.json()["ok"] is True
    assert seen == ["https://api.example.com/deep/x", "https://api.example.com/moved?q=1"]


def test_a_redirect_chain_is_capped(proxy_client, monkeypatch):
    hops: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hops.append(str(request.url))
        return httpx.Response(302, headers={"location": f"/hop{len(hops)}"})

    _stub_transport(monkeypatch, handler)

    resp = proxy_client.post("/api/http-request", json={"url": "https://api.example.com/x"})
    payload = resp.json()
    assert payload["ok"] is False
    assert payload["status"] == 0
    assert "redirect" in payload["error"]
    assert len(hops) == http_source_api._MAX_REDIRECTS + 1


def test_a_redirect_without_a_location_is_the_response(proxy_client, monkeypatch):
    _stub_transport(monkeypatch, lambda request: httpx.Response(302, text="gone"))

    payload = proxy_client.post(
        "/api/http-request", json={"url": "https://api.example.com/x"}
    ).json()
    assert payload == {"ok": False, "status": 302, "body": None, "error": "HTTP 302"}


# ── Nothing reaches the caller as a 500 ───────────────────────────────────────


def test_a_url_httpx_rejects_is_reported_in_the_body(proxy_client, monkeypatch):
    """The tab is stripped by urlsplit, so the origin check passes it — and then
    httpx raises InvalidURL, which is not an httpx.HTTPError."""
    _stub_transport(monkeypatch, lambda request: httpx.Response(200, json={"v": 1}))

    resp = proxy_client.post("/api/http-request", json={"url": "http://plc.lo\tcal/temp"})
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["ok"] is False
    assert payload["status"] == 0
    assert payload["error"]


def test_a_header_value_httpx_cannot_encode_is_reported_in_the_body(proxy_client, monkeypatch):
    """httpx encodes header values as ASCII and raises UnicodeEncodeError —
    also outside the HTTPError tree."""
    _stub_transport(monkeypatch, lambda request: httpx.Response(200, json={"v": 1}))

    resp = proxy_client.post(
        "/api/http-request",
        json={"url": "http://plc.local/temp", "headers": {"X-Token": "caf\u00e9"}},
    )
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["ok"] is False
    assert payload["status"] == 0
