"""Certificate pinning for HTTPS peer transfer (TOFU + no silent downgrade)."""
from __future__ import annotations

import asyncio
import socket
import ssl
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


def test_first_contact_pins_the_certificate(tls_server) -> None:
    server = tls_server()
    pin = peer_trust.ensure_pin("peer.test", server.port, "127.0.0.1")
    assert len(pin.fingerprint) == 64
    assert "BEGIN CERTIFICATE" in pin.pem
    assert peer_trust.load_pin("peer.test", server.port).fingerprint == pin.fingerprint


def test_same_certificate_keeps_the_pin(tls_server) -> None:
    server = tls_server()
    first = peer_trust.ensure_pin("peer.test", server.port, "127.0.0.1")
    second = peer_trust.ensure_pin("peer.test", server.port, "127.0.0.1")
    assert first.fingerprint == second.fingerprint
    assert first.pinnedAt == second.pinnedAt


def _impersonate(tls_server, host: str, pinned_from) -> _TlsServer:
    """Stand up a second server and move the first one's pin onto its address."""
    impostor = tls_server(serial=2)
    peer_trust._save_pin(host, impostor.port, pinned_from.fingerprint, pinned_from.pem)
    return impostor


def test_a_pinned_peer_is_not_probed_again(tls_server, monkeypatch) -> None:
    """The pinned context enforces the certificate; a second handshake buys nothing."""
    server = tls_server()
    peer_trust.ensure_pin("peer.test", server.port, "127.0.0.1")

    def fail(*_args):
        raise AssertionError("ensure_pin probed a peer it had already pinned")

    monkeypatch.setattr(peer_trust, "_fetch_leaf_certificate", fail)
    assert peer_trust.ensure_pin("peer.test", server.port, "127.0.0.1") is not None


def test_a_changed_certificate_is_described_for_the_operator(tls_server) -> None:
    """The handshake refuses it; this is the message that says why."""
    original = tls_server(serial=1)
    pin = peer_trust.ensure_pin("peer.test", original.port, "127.0.0.1")
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
        peer_trust._save_pin("peer.test", server.port, fingerprint, pem)

        described = peer_trust.describe_mismatch("peer.test", server.port, "127.0.0.1")
        assert described is not None and "expired" in described
    finally:
        server.close()


def test_a_matching_certificate_describes_no_mismatch(tls_server) -> None:
    server = tls_server()
    peer_trust.ensure_pin("peer.test", server.port, "127.0.0.1")
    assert peer_trust.describe_mismatch("peer.test", server.port, "127.0.0.1") is None


def test_forget_allows_repinning(tls_server) -> None:
    original = tls_server(serial=1)
    pin = peer_trust.ensure_pin("peer.test", original.port, "127.0.0.1")
    original.close()

    impostor = _impersonate(tls_server, "peer.test", pin)
    assert peer_trust.forget("peer.test", impostor.port) is True
    assert peer_trust.forget("peer.test", impostor.port) is False

    repinned = peer_trust.ensure_pin("peer.test", impostor.port, "127.0.0.1")
    assert repinned.fingerprint != pin.fingerprint


def test_pinned_context_accepts_only_that_certificate(tls_server) -> None:
    server = tls_server()
    pin = peer_trust.ensure_pin("peer.test", server.port, "127.0.0.1")
    context = peer_trust.ssl_context(pin)
    with socket.create_connection(("127.0.0.1", server.port), timeout=5) as raw:  # noqa: SIM117 -- no autofix offered; inner context expr depends on `raw`, left as-is per the mechanical-only policy for this family
        with context.wrap_socket(raw, server_hostname="peer.test") as tls:
            assert tls.getpeercert(binary_form=True)

    impostor = tls_server(serial=2)
    with pytest.raises(ssl.SSLError):  # noqa: SIM117 -- no autofix offered, left as-is per the mechanical-only policy for this family
        with socket.create_connection(("127.0.0.1", impostor.port), timeout=5) as raw:
            context.wrap_socket(raw, server_hostname="peer.test")


def test_list_pins_omits_the_certificate_body(tls_server) -> None:
    server = tls_server()
    peer_trust.ensure_pin("peer.test", server.port, "127.0.0.1")
    listed = peer_trust.list_pins()
    assert len(listed) == 1
    assert listed[0]["host"] == "peer.test"
    assert listed[0]["port"] == server.port
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


def test_pairs_with_a_real_tls_peer(tls_peer) -> None:
    from fastapi.testclient import TestClient

    app, port, _ = tls_peer
    with TestClient(app) as client:
        response = client.post(
            "/api/manager/peer-pair",
            json={
                "host": "127.0.0.1",
                "port": port,
                "scheme": "https",
                "password": "destination-admin",
                "name": "TLS peer",
            },
        )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["token"]
    assert body["certificateFingerprint"] == peer_trust.load_pin("127.0.0.1", port).fingerprint


def test_pushes_a_project_over_tls(tls_peer) -> None:
    from fastapi.testclient import TestClient

    app, port, root = tls_peer
    with TestClient(app) as client:
        paired = client.post(
            "/api/manager/peer-pair",
            json={
                "host": "127.0.0.1",
                "port": port,
                "scheme": "https",
                "password": "destination-admin",
            },
        )
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
        paired = client.post(
            "/api/manager/peer-pair",
            json={
                "host": "127.0.0.1",
                "port": port,
                "scheme": "https",
                "password": "destination-admin",
            },
        )
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
    endpoint = manager_peers_api._resolve_private_peer("127.0.0.1", server.port, "https")
    assert endpoint.base_url == f"https://127.0.0.1:{server.port}"
    assert isinstance(endpoint.verify, ssl.SSLContext)


def test_pinned_peer_is_never_contacted_over_plain_http(allow_loopback_peers, tls_server) -> None:
    """An mDNS TXT record is forgeable, so a known-TLS peer must not be downgraded."""
    server = tls_server()
    manager_peers_api._resolve_private_peer("127.0.0.1", server.port, "https")
    endpoint = manager_peers_api._resolve_private_peer("127.0.0.1", server.port, "http")
    assert endpoint.base_url.startswith("https://")


def test_certificate_change_is_explained_when_the_request_fails(
    allow_loopback_peers, tls_server
) -> None:
    """Resolution still succeeds — the stale pin is what makes the handshake fail."""
    original = tls_server(serial=1)
    manager_peers_api._resolve_private_peer("127.0.0.1", original.port, "https")
    original.close()

    impostor = _impersonate(tls_server, "127.0.0.1", peer_trust.load_pin("127.0.0.1", original.port))
    endpoint = manager_peers_api._resolve_private_peer("127.0.0.1", impostor.port, "https")
    explained = asyncio.run(endpoint.unreachable(httpx.ConnectError("certificate verify failed")))
    assert "changed" in str(explained)
