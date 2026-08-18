"""Tests for /api/http-request — the outbound proxy behind the $http source."""
from __future__ import annotations

import api.http_source_api as http_source_api
import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


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
