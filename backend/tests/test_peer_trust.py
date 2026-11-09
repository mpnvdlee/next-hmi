"""Certificate pinning for HTTPS peer transfer.

Pins only what the operator confirmed, never sends a password or token to an
unconfirmed or changed certificate, and never downgrades a pinned peer.
"""
from __future__ import annotations

import asyncio
import os
import socket
import ssl
import stat
import threading
import time
from pathlib import Path

import httpx
import pytest
from api import manager_peers_api
from core import peer_trust, runtime_home


@pytest.fixture(autouse=True)
def home(monkeypatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: tmp_path)
    return tmp_path


def _self_signed(tmp_path: Path, common_name: str, serial: int) -> tuple[Path, Path]:
    """Write a throwaway cert/key pair; two calls give two distinct certificates."""
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    now = datetime.datetime.now(datetime.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(serial)
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    cert_path = tmp_path / f"{common_name}-{serial}-cert.pem"
    key_path = tmp_path / f"{common_name}-{serial}-key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    return cert_path, key_path


def _expired_self_signed(tmp_path: Path, common_name: str, serial: int) -> tuple[Path, Path]:
    """Same as :func:`_self_signed` but already past ``not_valid_after``."""
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    now = datetime.datetime.now(datetime.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(serial)
        .not_valid_before(now - datetime.timedelta(days=10))
        .not_valid_after(now - datetime.timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    cert_path = tmp_path / f"{common_name}-{serial}-expired-cert.pem"
    key_path = tmp_path / f"{common_name}-{serial}-expired-key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    return cert_path, key_path


class _TlsServer:
    """Single-connection TLS listener on loopback, just enough to hand out a cert."""

    def __init__(self, cert: Path, key: Path) -> None:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cert), str(key))
        self._context = context
        self._sock = socket.socket()
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(8)
        self.port = self._sock.getsockname()[1]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                raw, _ = self._sock.accept()
            except OSError:
                return
            try:
                with self._context.wrap_socket(raw, server_side=True):
                    pass
            except OSError:
                pass

    def close(self) -> None:
        self._stop.set()
        self._sock.close()


@pytest.fixture
def tls_server(tmp_path: Path):
    servers: list[_TlsServer] = []

    def factory(serial: int = 1) -> _TlsServer:
        cert, key = _self_signed(tmp_path, "peer.test", serial)
        server = _TlsServer(cert, key)
        servers.append(server)
        return server

    yield factory
    for server in servers:
        server.close()


def _confirm(host: str, port: int, runtime_id: str | None = None) -> peer_trust.Pin:
    """What the operator's confirmation records: the certificate the peer presents."""
    pem, fingerprint = peer_trust.fetch_certificate("127.0.0.1", port)
    return peer_trust.save_pin(host, port, fingerprint, pem, runtime_id)


def test_fetching_a_certificate_pins_nothing(tls_server) -> None:
    """Seeing a certificate is not trusting it; only a confirmation pins."""
    server = tls_server()
    pem, fingerprint = peer_trust.fetch_certificate("127.0.0.1", server.port)
    assert len(fingerprint) == 64
    assert "BEGIN CERTIFICATE" in pem
    assert peer_trust.load_pin("peer.test", server.port) is None
    assert peer_trust.list_pins() == []


def test_a_pin_speaks_for_its_address_and_its_runtime_id(tls_server) -> None:
    server = tls_server()
    pin = _confirm("10.0.0.4", server.port, runtime_id="rid-a")

    assert peer_trust.is_pinned("10.0.0.4", server.port, None, pin.fingerprint)
    # The same device at a new address: recognised by its runtimeId.
    assert peer_trust.is_pinned("10.0.0.9", 8443, "rid-a", pin.fingerprint)
    assert peer_trust.conflicting_pin("10.0.0.9", 8443, "rid-a", pin.fingerprint) is None
    # Another certificate claiming either the address or the runtimeId.
    assert peer_trust.conflicting_pin("10.0.0.4", server.port, None, "f" * 64) is not None
    assert peer_trust.conflicting_pin("10.0.0.9", 8443, "rid-a", "f" * 64) is not None
    # An unrelated device at an unrelated address is simply new.
    assert peer_trust.conflicting_pin("10.0.0.9", 8443, "rid-b", "f" * 64) is None
    assert not peer_trust.is_pinned("10.0.0.9", 8443, "rid-b", "f" * 64)


def test_forgetting_a_device_drops_its_pins_at_every_address(tls_server) -> None:
    server = tls_server()
    pin = _confirm("10.0.0.4", server.port, runtime_id="rid-a")
    peer_trust.save_pin("10.0.0.9", 8443, pin.fingerprint, pin.pem, "rid-a")
    peer_trust.save_pin("10.0.0.7", 8443, pin.fingerprint, pin.pem, "rid-other")

    assert peer_trust.forget("10.0.0.4", server.port) is True
    assert [entry["host"] for entry in peer_trust.list_pins()] == ["10.0.0.7"]
    assert peer_trust.forget("10.0.0.4", server.port) is False
    # By runtimeId alone, for a device pinned somewhere this address never was.
    assert peer_trust.forget("10.0.0.1", 8000, runtime_id="rid-other") is True
    assert peer_trust.list_pins() == []


def test_a_pinned_peer_is_not_probed_again(allow_loopback_peers, tls_server, monkeypatch) -> None:
    """The pinned context enforces the certificate; a second handshake buys nothing."""
    server = tls_server()
    _confirm("127.0.0.1", server.port)

    def fail(*_args):
        raise AssertionError("resolving a pinned peer probed it again")

    monkeypatch.setattr(peer_trust, "fetch_certificate", fail)
    endpoint = manager_peers_api._resolve_private_peer("127.0.0.1", server.port, "https")
    assert isinstance(endpoint.verify, ssl.SSLContext)


def _impersonate(tls_server, host: str, pinned_from) -> _TlsServer:
    """Stand up a second server and move the first one's pin onto its address."""
    impostor = tls_server(serial=2)
    peer_trust.save_pin(host, impostor.port, pinned_from.fingerprint, pinned_from.pem, None)
    return impostor


def test_a_changed_certificate_is_described_for_the_operator(tls_server) -> None:
    """The handshake refuses it; this is the message that says why."""
    original = tls_server(serial=1)
    pin = _confirm("peer.test", original.port)
    original.close()

    impostor = _impersonate(tls_server, "peer.test", pin)
    described = peer_trust.describe_mismatch("peer.test", impostor.port, "127.0.0.1")
    assert described is not None and "changed" in described


def test_an_expired_pinned_certificate_is_described_for_the_operator(tmp_path: Path) -> None:
    """Same fingerprint, but the pin itself has lapsed — not a silent 'no mismatch'."""
    cert, key = _expired_self_signed(tmp_path, "peer.test", 1)
    server = _TlsServer(cert, key)
    try:
        pem = cert.read_text(encoding="utf-8")
        fingerprint = peer_trust.hashlib.sha256(
            ssl.PEM_cert_to_DER_cert(pem)
        ).hexdigest()
        peer_trust.save_pin("peer.test", server.port, fingerprint, pem, None)

        described = peer_trust.describe_mismatch("peer.test", server.port, "127.0.0.1")
        assert described is not None and "expired" in described
    finally:
        server.close()


def test_a_matching_certificate_describes_no_mismatch(tls_server) -> None:
    server = tls_server()
    _confirm("peer.test", server.port)
    assert peer_trust.describe_mismatch("peer.test", server.port, "127.0.0.1") is None


def test_pinned_context_accepts_only_that_certificate(tls_server) -> None:
    server = tls_server()
    pin = _confirm("peer.test", server.port)
    context = peer_trust.ssl_context(pin.pem)
    with socket.create_connection(("127.0.0.1", server.port), timeout=5) as raw:  # noqa: SIM117 -- no autofix offered; inner context expr depends on `raw`, left as-is per the mechanical-only policy for this family
        with context.wrap_socket(raw, server_hostname="peer.test") as tls:
            assert tls.getpeercert(binary_form=True)

    impostor = tls_server(serial=2)
    with pytest.raises(ssl.SSLError):  # noqa: SIM117 -- no autofix offered, left as-is per the mechanical-only policy for this family
        with socket.create_connection(("127.0.0.1", impostor.port), timeout=5) as raw:
            context.wrap_socket(raw, server_hostname="peer.test")


def test_list_pins_omits_the_certificate_body(tls_server) -> None:
    server = tls_server()
    _confirm("peer.test", server.port, runtime_id="rid-a")
    listed = peer_trust.list_pins()
    assert len(listed) == 1
    assert listed[0]["host"] == "peer.test"
    assert listed[0]["port"] == server.port
    assert listed[0]["runtimeId"] == "rid-a"
    assert "pem" not in listed[0]


@pytest.fixture
def allow_loopback_peers(monkeypatch):
    monkeypatch.setenv("NEXTHMI_ALLOW_LOOPBACK_PEERS", "1")


@pytest.fixture
def tls_peer(tmp_path: Path, allow_loopback_peers):
    """A manager app served over TLS on loopback, plus one local project to send.

    Sender and receiver are the same process and share one runtime home, so a
    transfer lands beside its own source — enough to drive the real HTTPS
    upload path end to end.
    """
    import uvicorn
    from api.manager_auth_api import router as auth_router
    from api.manager_peers_api import manager_router, public_router
    from core import manager_auth
    from core.exceptions import register_exception_handlers
    from core.manifest import (
        ManifestV1,
        ProjectEntry,
        ProjectMetadata,
        load_manifest,
        save_manifest,
        write_project_metadata,
    )
    from fastapi import FastAPI

    root = tmp_path / "Projects"
    root.mkdir()
    save_manifest(ManifestV1(defaultProjectsRoot=str(root)))
    manager_auth.set_password("destination-admin")

    source = root / "to-send"
    source.mkdir()
    write_project_metadata(source, ProjectMetadata(id="source-id", name="Source"))
    (source / "pages.json").write_text('{"pages": []}', encoding="utf-8")
    (source / "users.json").write_text('{"users": []}', encoding="utf-8")
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="source-id", name="Source", path=str(source), addedAt="2026-01-01T00:00:00Z"
        )
    )
    save_manifest(manifest)

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(auth_router)
    app.include_router(public_router)
    app.include_router(manager_router)

    cert, key = _self_signed(tmp_path, "peer.test", 7)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            ssl_certfile=str(cert),
            ssl_keyfile=str(key),
            log_level="error",
        )
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        assert server.started, "TLS peer did not start"
        yield app, port, root
    finally:
        server.should_exit = True
        thread.join(timeout=10)


@pytest.fixture
def password_checks(monkeypatch) -> list[str]:
    """Every device-admin password the peer side was asked to check."""
    from core import manager_auth

    seen: list[str] = []
    real = manager_auth.verify_password

    def spy(password: str) -> bool:
        seen.append(password)
        return real(password)

    monkeypatch.setattr(manager_auth, "verify_password", spy)
    return seen


def _probe(client, port: int) -> dict:
    response = client.post(
        "/api/manager/peer-probe",
        json={"host": "127.0.0.1", "port": port, "scheme": "https"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _pair(client, port: int, fingerprint: str | None, **extra):
    return client.post(
        "/api/manager/peer-pair",
        json={
            "host": "127.0.0.1",
            "port": port,
            "scheme": "https",
            "password": "destination-admin",
            "fingerprint": fingerprint,
            **extra,
        },
    )


def test_probe_shows_the_certificate_and_identity_without_sending_a_password(
    tls_peer, password_checks, monkeypatch
) -> None:
    from core.peer_discovery import peer_discovery
    from fastapi.testclient import TestClient

    monkeypatch.setattr(peer_discovery, "_runtime_id", "rid-peer")
    monkeypatch.setattr(peer_discovery, "_hostname", "line-2-panel")
    app, port, _ = tls_peer
    with TestClient(app) as client:
        probed = _probe(client, port)

    _, presented = peer_trust.fetch_certificate("127.0.0.1", port)
    assert probed["fingerprint"] == presented
    assert probed["runtimeId"] == "rid-peer"
    assert probed["hostname"] == "line-2-panel"
    assert probed["trust"] == "new"
    assert probed["remembered"] is False
    assert password_checks == []
    # Nothing is trusted until the operator confirms it.
    assert peer_trust.list_pins() == []


def test_pairs_with_a_real_tls_peer_after_the_fingerprint_is_confirmed(tls_peer) -> None:
    from fastapi.testclient import TestClient

    app, port, _ = tls_peer
    with TestClient(app) as client:
        response = _pair(client, port, _probe(client, port)["fingerprint"], name="TLS peer")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["token"]
    assert body["certificateFingerprint"] == peer_trust.load_pin("127.0.0.1", port).fingerprint


@pytest.mark.parametrize("fingerprint", [None, "0" * 64], ids=["unconfirmed", "wrong"])
def test_pairing_sends_no_password_without_the_confirmed_certificate(
    tls_peer, password_checks, fingerprint
) -> None:
    from fastapi.testclient import TestClient

    app, port, _ = tls_peer
    with TestClient(app) as client:
        response = _pair(client, port, fingerprint)

    assert response.status_code in {409, 422}, response.text
    assert "No password was sent" in response.json()["detail"]
    assert password_checks == []
    assert peer_trust.list_pins() == []


def test_a_changed_certificate_stops_pairing_even_once_confirmed(
    tls_peer, tls_server, password_checks
) -> None:
    """Never a silent re-pin: the operator has to forget the old pin first."""
    from fastapi.testclient import TestClient

    app, port, _ = tls_peer
    other = tls_server(serial=3)
    stale = _confirm("127.0.0.1", other.port)
    peer_trust.save_pin("127.0.0.1", port, stale.fingerprint, stale.pem, None)

    with TestClient(app) as client:
        probed = _probe(client, port)
        assert probed["trust"] == "changed"
        response = _pair(client, port, probed["fingerprint"])

    assert response.status_code == 409, response.text
    assert response.json()["detail"].startswith("Certificate changed: pairing stopped.")
    assert "No password was sent" in response.json()["detail"]
    assert password_checks == []
    assert peer_trust.load_pin("127.0.0.1", port).fingerprint == stale.fingerprint


def test_a_device_claiming_a_pinned_runtime_id_with_another_certificate_is_stopped(
    tls_peer, tls_server, password_checks, monkeypatch
) -> None:
    from core.peer_discovery import peer_discovery
    from fastapi.testclient import TestClient

    monkeypatch.setattr(peer_discovery, "_runtime_id", "rid-real")
    app, port, _ = tls_peer
    real = tls_server(serial=4)
    # The real device, paired earlier at another address.
    pinned = _confirm("10.0.0.4", real.port, runtime_id="rid-real")

    with TestClient(app) as client:
        probed = _probe(client, port)
        response = _pair(client, port, probed["fingerprint"])

    assert probed["trust"] == "changed"
    assert response.status_code == 409, response.text
    assert password_checks == []
    assert [pin["fingerprint"] for pin in peer_trust.list_pins()] == [pinned.fingerprint]


def test_the_same_device_at_a_new_address_keeps_its_pin(tls_peer, monkeypatch) -> None:
    from core.peer_discovery import peer_discovery
    from fastapi.testclient import TestClient

    monkeypatch.setattr(peer_discovery, "_runtime_id", "rid-moved")
    app, port, _ = tls_peer
    pem, fingerprint = peer_trust.fetch_certificate("127.0.0.1", port)
    peer_trust.save_pin("10.0.0.4", 8443, fingerprint, pem, "rid-moved")

    with TestClient(app) as client:
        probed = _probe(client, port)

    assert probed["trust"] == "pinned"
    moved = peer_trust.load_pin("127.0.0.1", port)
    assert moved is not None
    assert (moved.fingerprint, moved.runtimeId) == (fingerprint, "rid-moved")


def test_a_remembered_device_needs_no_password_next_time(
    tls_peer, password_checks, monkeypatch
) -> None:
    from core import peer_tokens
    from core.peer_discovery import peer_discovery
    from fastapi.testclient import TestClient

    monkeypatch.setattr(peer_discovery, "_runtime_id", "rid-kept")
    app, port, _ = tls_peer
    with TestClient(app) as client:
        paired = _pair(client, port, _probe(client, port)["fingerprint"], remember=True)
        assert paired.status_code == 200, paired.text
        assert paired.json()["remembered"] is True
        assert len(password_checks) == 1

        again = _probe(client, port)
        assert (again["trust"], again["remembered"]) == ("pinned", True)
        listed = client.post(
            "/api/manager/peer-projects",
            json={"host": "127.0.0.1", "port": port, "scheme": "https", "runtimeId": "rid-kept"},
        )

    assert listed.status_code == 200, listed.text
    assert [project["id"] for project in listed.json()["projects"]] == ["source-id"]
    assert len(password_checks) == 1
    if os.name == "posix":
        assert stat.S_IMODE(peer_tokens.pairings_path().stat().st_mode) == 0o600
    assert peer_tokens.pairings_path().parent == peer_trust._trust_path().parent


def test_pairing_without_remember_keeps_no_pairing_key(tls_peer, monkeypatch) -> None:
    from core import peer_tokens
    from core.peer_discovery import peer_discovery
    from fastapi.testclient import TestClient

    monkeypatch.setattr(peer_discovery, "_runtime_id", "rid-once")
    peer_tokens.remember("rid-once", "stale.token", "f" * 64)
    app, port, _ = tls_peer
    with TestClient(app) as client:
        paired = _pair(client, port, _probe(client, port)["fingerprint"], remember=False)
        assert paired.status_code == 200, paired.text
        assert _probe(client, port)["remembered"] is False
    assert paired.json()["remembered"] is False
    assert peer_tokens.remembered("rid-once", "f" * 64) is None


def test_a_remembered_token_only_goes_to_the_certificate_it_was_paired_over(
    allow_loopback_peers, tls_server
) -> None:
    from core import peer_tokens
    from core.exceptions import ValidationError

    server = tls_server()
    pin = _confirm("127.0.0.1", server.port, runtime_id="rid-a")
    peer_tokens.remember("rid-a", "id.secret", "f" * 64)

    endpoint = manager_peers_api._resolve_private_peer("127.0.0.1", server.port, "https")
    assert endpoint.fingerprint == pin.fingerprint
    with pytest.raises(ValidationError):
        manager_peers_api._auth_headers(endpoint, None, "rid-a")

    peer_tokens.remember("rid-a", "id.secret", pin.fingerprint)
    headers = manager_peers_api._auth_headers(endpoint, None, "rid-a")
    assert headers["Authorization"] == "Bearer id.secret"


def test_pushes_a_project_over_tls(tls_peer) -> None:
    from fastapi.testclient import TestClient

    app, port, root = tls_peer
    with TestClient(app) as client:
        paired = _pair(client, port, _probe(client, port)["fingerprint"])
        assert paired.status_code == 200, paired.text

        begun = client.post(
            "/api/manager/transfers",
            json={
                "sourceProjectId": "source-id",
                "destinationProjectId": "received-id",
                "destinationFolder": "landing",
                "collisionPolicy": "copy",
                "peerHost": "127.0.0.1",
                "peerPort": port,
                "peerScheme": "https",
                "token": paired.json()["token"],
                "transferId": "tx-over-tls",
            },
        )
        assert begun.status_code == 202, begun.text

        deadline = time.monotonic() + 30
        status: dict = {}
        while time.monotonic() < deadline:
            status = client.get("/api/manager/transfers/tx-over-tls").json()
            if status.get("status") != "active":
                break
            time.sleep(0.1)

    assert status.get("status") == "complete", status
    assert (root / "landing" / "pages.json").is_file()


def test_push_refuses_a_peer_whose_certificate_changed(tls_peer, tls_server) -> None:
    from fastapi.testclient import TestClient

    app, port, _ = tls_peer
    with TestClient(app) as client:
        paired = _pair(client, port, _probe(client, port)["fingerprint"])
        assert paired.status_code == 200, paired.text

        # Same address, different certificate: what an interception looks like.
        impostor = _impersonate(tls_server, "127.0.0.1", peer_trust.load_pin("127.0.0.1", port))
        begun = client.post(
            "/api/manager/transfers",
            json={
                "sourceProjectId": "source-id",
                "destinationProjectId": "received-id",
                "destinationFolder": "landing",
                "collisionPolicy": "copy",
                "peerHost": "127.0.0.1",
                "peerPort": impostor.port,
                "peerScheme": "https",
                "token": paired.json()["token"],
                "transferId": "tx-mitm",
            },
        )
        assert begun.status_code == 202, begun.text

        deadline = time.monotonic() + 30
        status: dict = {}
        while time.monotonic() < deadline:
            status = client.get("/api/manager/transfers/tx-mitm").json()
            if status.get("status") != "active":
                break
            time.sleep(0.1)

    assert status.get("status") == "error", status
    assert "changed" in (status.get("message") or "")


def test_http_peer_resolves_without_tls(allow_loopback_peers) -> None:
    endpoint = manager_peers_api._resolve_private_peer("127.0.0.1", 8000, "http")
    assert endpoint.base_url == "http://127.0.0.1:8000"
    assert endpoint.headers == {"Host": "127.0.0.1:8000"}
    assert endpoint.verify is True


def test_https_peer_resolves_with_the_pinned_context(allow_loopback_peers, tls_server) -> None:
    server = tls_server()
    _confirm("127.0.0.1", server.port)
    endpoint = manager_peers_api._resolve_private_peer("127.0.0.1", server.port, "https")
    assert endpoint.base_url == f"https://127.0.0.1:{server.port}"
    assert isinstance(endpoint.verify, ssl.SSLContext)


def test_an_unverified_https_peer_gets_no_token(allow_loopback_peers, tls_server) -> None:
    """No trust on first use: a token only travels to a confirmed certificate."""
    from core.exceptions import ValidationError

    server = tls_server()
    with pytest.raises(ValidationError, match="has not been verified"):
        manager_peers_api._resolve_private_peer("127.0.0.1", server.port, "https")
    assert peer_trust.list_pins() == []


def test_pinned_peer_is_never_contacted_over_plain_http(allow_loopback_peers, tls_server) -> None:
    """An mDNS TXT record is forgeable, so a known-TLS peer must not be downgraded."""
    server = tls_server()
    _confirm("127.0.0.1", server.port)
    endpoint = manager_peers_api._resolve_private_peer("127.0.0.1", server.port, "http")
    assert endpoint.base_url.startswith("https://")


def test_certificate_change_is_explained_when_the_request_fails(
    allow_loopback_peers, tls_server
) -> None:
    """Resolution still succeeds — the stale pin is what makes the handshake fail."""
    original = tls_server(serial=1)
    pin = _confirm("127.0.0.1", original.port)
    original.close()

    impostor = _impersonate(tls_server, "127.0.0.1", pin)
    endpoint = manager_peers_api._resolve_private_peer("127.0.0.1", impostor.port, "https")
    explained = asyncio.run(endpoint.unreachable(httpx.ConnectError("certificate verify failed")))
    assert "changed" in str(explained)
