"""Trust on first use for a secured OPC-UA connection's server certificate.

Against a real secured ``asyncua`` server whose user manager records every
credential that reaches it: a username and password must never arrive at a
server whose certificate an engineer has not trusted.
"""
import socket
from contextlib import asynccontextmanager
from pathlib import Path

import opcua.security as security_module
import pytest
from asyncua import Client, Server, ua
from asyncua.crypto.permission_rules import User, UserRole
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding
from opcua.discovery import probe_connection
from opcua.engine import DatasourceOpcuaEngine
from opcua.security import (
    ServerCertificateNotTrusted,
    apply_client_security,
    generate_self_signed_client_certificate,
)


class _RecordingUserManager:
    def __init__(self) -> None:
        self.credentials: list[tuple[str | None, str | None]] = []

    def get_user(self, iserver, username=None, password=None, certificate=None):
        self.credentials.append((username, password))
        return User(role=UserRole.User)


def _free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _server_pair(directory: Path, name: str) -> tuple[Path, Path]:
    cert, key = directory / f"{name}-cert.pem", directory / f"{name}-key.pem"
    generate_self_signed_client_certificate(str(cert), str(key), common_name=name)
    return cert, key


def _der(cert_path: Path) -> bytes:
    return x509.load_pem_x509_certificate(cert_path.read_bytes()).public_bytes(Encoding.DER)


@asynccontextmanager
async def _secured_server(cert: Path, key: Path):
    users = _RecordingUserManager()
    server = Server(user_manager=users)
    await server.init()
    url = f"opc.tcp://127.0.0.1:{_free_port()}/trust/"
    server.set_endpoint(url)
    server.set_security_policy([ua.SecurityPolicyType.Basic256Sha256_SignAndEncrypt])
    await server.load_certificate(str(cert))
    await server.load_private_key(str(key))
    await server.start()
    try:
        yield url, users
    finally:
        await server.stop()


@pytest.fixture()
def server_a(tmp_path: Path) -> tuple[Path, Path]:
    return _server_pair(tmp_path, "server-a")


@pytest.fixture()
def server_b(tmp_path: Path) -> tuple[Path, Path]:
    return _server_pair(tmp_path, "server-b")


def _settings(url: str, *, username: str = "", pin: str = "") -> dict:
    return {
        "server_url": url,
        "username": username,
        "password": "secret" if username else "",
        "security_policy": "Basic256Sha256",
        "security_mode": "SignAndEncrypt",
        "client_certificate": "certs/client-cert.pem",
        "client_private_key": "certs/client-key.pem",
        "server_certificate": pin,
    }


def _pin(project_root: Path, cert: Path) -> str:
    target = project_root / "certs" / "pinned-server.der"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(_der(cert))
    return "certs/pinned-server.der"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "pin",
    [
        "",  # every secured datasource with a login, right after the update
        "certs/plc-server.der",  # a pin whose file stayed behind on a project export
    ],
)
async def test_credentials_wait_until_the_certificate_is_trusted(live_project_root, server_a, pin):
    async with _secured_server(*server_a) as (url, users):
        engine = DatasourceOpcuaEngine("plc")
        engine._config = _settings(url, username="operator", pin=pin)
        with pytest.raises(ServerCertificateNotTrusted, match="not trusted yet"):
            await engine._do_connect()

        assert users.credentials == []
        assert engine.connected is False
        assert engine.server_certificate is not None
        assert engine.server_certificate.status == "untrusted"
        assert engine.server_certificate.der == _der(server_a[0])


@pytest.mark.asyncio
async def test_the_connection_probe_sends_no_credentials_either(live_project_root, server_a):
    async with _secured_server(*server_a) as (url, users):
        result = await probe_connection(_settings(url, username="operator"))

    assert result["ok"] is False
    assert "not trusted yet" in result["error"]
    assert users.credentials == []


@pytest.mark.asyncio
async def test_a_trusted_certificate_signs_in(live_project_root, server_a):
    async with _secured_server(*server_a) as (url, users):
        settings = _settings(url, username="operator", pin=_pin(live_project_root, server_a[0]))
        client = Client(url)
        checked = await apply_client_security(client, settings)
        client.set_user("operator")
        client.set_password("secret")
        await client.connect()
        await client.disconnect()

    assert checked is not None
    assert checked.status == "trusted"
    assert users.credentials == [("operator", "secret")]


@pytest.mark.asyncio
async def test_a_changed_certificate_stops_even_an_anonymous_connection(
    live_project_root, server_a, server_b
):
    async with _secured_server(*server_b) as (url, users):
        pin = _pin(live_project_root, server_a[0])
        with pytest.raises(ServerCertificateNotTrusted, match="changed") as excinfo:
            await apply_client_security(Client(url), _settings(url, pin=pin))

    assert excinfo.value.certificate.status == "changed"
    assert excinfo.value.certificate.der == _der(server_b[0])
    assert users.credentials == []


@pytest.mark.asyncio
async def test_anonymous_connects_to_an_unpinned_server_but_reports_it_untrusted(
    live_project_root, server_a
):
    async with _secured_server(*server_a) as (url, users):
        client = Client(url)
        checked = await apply_client_security(client, _settings(url))
        await client.connect()
        await client.disconnect()

    assert checked is not None
    assert checked.status == "untrusted"
    assert users.credentials == [(None, None)]


@pytest.mark.asyncio
async def test_the_handshake_refuses_a_server_swapped_in_after_the_check(
    live_project_root, monkeypatch, server_a, server_b
):
    """The check reads an unauthenticated GetEndpoints. Whatever answers the
    session afterwards must still hold the trusted key, or nothing is sent."""
    async def _looks_like_a(*_args) -> bytes:
        return _der(server_a[0])

    monkeypatch.setattr(security_module, "_presented_certificate", _looks_like_a)
    async with _secured_server(*server_b) as (url, users):
        settings = _settings(url, username="operator", pin=_pin(live_project_root, server_a[0]))
        client = Client(url, timeout=1)
        checked = await apply_client_security(client, settings)
        client.set_user("operator")
        client.set_password("secret")
        # The OpenSecureChannel is encrypted to the trusted key, which this
        # server cannot decrypt: the channel never opens.
        with pytest.raises((TimeoutError, ConnectionError, ua.UaError)):
            await client.connect()

    assert checked is not None
    assert checked.status == "trusted"
    assert users.credentials == []


@pytest.mark.parametrize("prefix", ["runtime", "editor"])
def test_trusting_needs_a_device_admin_session(prefix):
    """The live view serves some routes with no session; trust is not one."""
    import manager

    path = f"/{prefix}/plant/api/datasources/plc/server-certificate/trust"
    assert manager._is_gated(path, "POST", path) is True
    read = f"/{prefix}/plant/api/datasources/plc/server-certificate"
    assert manager._is_gated(read, "GET", read) is True
