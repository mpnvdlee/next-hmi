"""Integration tests for the connection-wizard discovery + probe helpers.

These exercise ``discover_endpoints`` / ``probe_connection`` against a real
NoSecurity ``asyncua`` server bound to an ephemeral port.
"""
import socket
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from asyncua import Server, ua
from opcua.client_pool import (
    _build_security_string,
    _ensure_client_certificate,
    discover_endpoints,
    probe_connection,
)


def _free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


@asynccontextmanager
async def _running_server():
    port = _free_port()
    url = f"opc.tcp://127.0.0.1:{port}/nexthmi/test/"
    server = Server()
    await server.init()
    server.set_endpoint(url)
    server.set_server_name("NextHMI Discovery Test")
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace("http://nexthmi/test")
    await server.nodes.objects.add_variable(idx, "Answer", 42)
    await server.start()
    try:
        yield url
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_discover_lists_nosecurity_anonymous_endpoint():
    async with _running_server() as url:
        result = await discover_endpoints(url)

    assert result["ok"] is True
    assert result["error"] is None
    assert result["endpoints"]
    assert any(
        ep["security_mode"] == "None"
        and ep["security_policy"] == "NoSecurity"
        and "Anonymous" in ep["user_tokens"]
        for ep in result["endpoints"]
    )


@pytest.mark.asyncio
async def test_discover_accepts_host_port_without_scheme():
    async with _running_server() as url:
        authority = url.split("://", 1)[1].split("/", 1)[0]
        result = await discover_endpoints(authority)

    assert result["ok"] is True
    assert result["endpoints"]


@pytest.mark.asyncio
async def test_probe_connection_ok_reports_server():
    async with _running_server() as url:
        result = await probe_connection({"server_url": url})

    assert result["ok"] is True
    assert result["error"] is None
    assert result["namespace_count"] and result["namespace_count"] >= 1


@pytest.mark.asyncio
async def test_discover_bad_address_returns_error():
    result = await discover_endpoints(f"opc.tcp://127.0.0.1:{_free_port()}/", timeout_s=2.0)
    assert result["ok"] is False
    assert result["error"]
    assert result["endpoints"] == []


@pytest.mark.asyncio
async def test_probe_bad_url_returns_error():
    result = await probe_connection(
        {"server_url": f"opc.tcp://127.0.0.1:{_free_port()}/"}, timeout_s=2.0
    )
    assert result["ok"] is False
    assert result["error"]
    assert result["server_name"] is None


def test_security_paths_are_resolved_relative_to_project_root(monkeypatch, tmp_path: Path):
    """Absolute cert paths are not supported — every path is resolved against
    the active project root, matching the project-relative ``certs/...`` form a
    datasource stores."""
    monkeypatch.setattr("opcua.client_pool.active_project_root", lambda: tmp_path)

    security = _build_security_string(
        {
            "security_policy": "Basic256Sha256",
            "security_mode": "SignAndEncrypt",
            "client_certificate": "certs/client.pem",
            "client_private_key": "certs/client-key.pem",
            "server_certificate": "certs/server.pem",
        }
    )

    assert security == ",".join(
        [
            "Basic256Sha256",
            "SignAndEncrypt",
            str((tmp_path / "certs/client.pem").resolve()),
            str((tmp_path / "certs/client-key.pem").resolve()),
            str((tmp_path / "certs/server.pem").resolve()),
        ]
    )


def test_ensure_client_certificate_generates_missing_pair(tmp_path: Path):
    """No client key is committed; a secured datasource generates a self-signed
    pair on first connect instead."""
    from cryptography import x509

    cert = tmp_path / "certs" / "webhmi-client-cert.pem"
    key = tmp_path / "certs" / "webhmi-client-key.pem"
    assert not cert.exists() and not key.exists()

    _ensure_client_certificate(str(cert), str(key))

    assert cert.exists() and key.exists()
    # Key is written owner-read/write only.
    assert (key.stat().st_mode & 0o777) == 0o600
    loaded = x509.load_pem_x509_certificate(cert.read_bytes())
    assert "CN=webhmi-opc-client" in loaded.subject.rfc4514_string()
    assert not loaded.extensions.get_extension_for_class(
        x509.BasicConstraints
    ).value.ca


def test_ensure_client_certificate_is_idempotent(tmp_path: Path):
    cert = tmp_path / "certs" / "webhmi-client-cert.pem"
    key = tmp_path / "certs" / "webhmi-client-key.pem"
    _ensure_client_certificate(str(cert), str(key))
    first = (cert.read_bytes(), key.read_bytes())

    _ensure_client_certificate(str(cert), str(key))

    assert (cert.read_bytes(), key.read_bytes()) == first


def test_build_security_string_skips_generation_when_key_password_set(
    monkeypatch, tmp_path: Path
):
    """A configured key password means the operator supplies their own
    encrypted key — never silently generate over it."""
    monkeypatch.setattr("opcua.client_pool.active_project_root", lambda: tmp_path)

    _build_security_string(
        {
            "security_policy": "Basic256Sha256",
            "security_mode": "SignAndEncrypt",
            "client_certificate": "certs/client.pem",
            "client_private_key": "certs/client-key.pem",
            "client_private_key_password": "secret",
        }
    )

    assert not (tmp_path / "certs" / "client-key.pem").exists()
