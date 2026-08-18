"""Launcher TLS env resolution (NEXTHMI_SSL_*)."""
from __future__ import annotations

from pathlib import Path

import launcher
import pytest


@pytest.fixture(autouse=True)
def _clear_tls_env(monkeypatch):
    for name in (
        "NEXTHMI_SSL_CERTFILE",
        "NEXTHMI_SSL_KEYFILE",
        "NEXTHMI_SSL_KEYFILE_PASSWORD",
    ):
        monkeypatch.delenv(name, raising=False)


def _write_self_signed(
    tmp_path: Path, *, password: str | None = None
) -> tuple[Path, Path]:
    """A real, matching cert/key pair — ``_resolve_tls`` now loads it like uvicorn will."""
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "launcher.test")])
    now = datetime.datetime.now(datetime.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=30))
        .sign(key, hashes.SHA256())
    )
    encryption = (
        serialization.BestAvailableEncryption(password.encode("utf-8"))
        if password
        else serialization.NoEncryption()
    )
    cert = tmp_path / "cert.pem"
    key_path = tmp_path / "key.pem"
    cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=encryption,
        )
    )
    return cert, key_path


@pytest.fixture
def pem(tmp_path: Path) -> tuple[Path, Path]:
    return _write_self_signed(tmp_path)


def test_restart_argv_does_not_duplicate_the_frozen_executable(monkeypatch) -> None:
    """sys.executable IS argv[0] in a PyInstaller build; re-exec must not repeat it."""
    monkeypatch.setattr(launcher.sys, "frozen", True, raising=False)
    monkeypatch.setattr(launcher.sys, "argv", ["/opt/nexthmi/nexthmi", "-v"])
    assert launcher._restart_argv() == ["-v"]


def test_restart_argv_keeps_the_script_path_from_source(monkeypatch) -> None:
    monkeypatch.delattr(launcher.sys, "frozen", raising=False)
    monkeypatch.setattr(launcher.sys, "argv", ["launcher.py", "-v"])
    assert launcher._restart_argv() == ["launcher.py", "-v"]


def test_no_tls_env_serves_plain_http() -> None:
    assert launcher._resolve_tls() == {}


def test_cert_and_key_resolve(monkeypatch, pem) -> None:
    cert, key = pem
    monkeypatch.setenv("NEXTHMI_SSL_CERTFILE", str(cert))
    monkeypatch.setenv("NEXTHMI_SSL_KEYFILE", str(key))
    assert launcher._resolve_tls() == {
        "ssl_certfile": str(cert),
        "ssl_keyfile": str(key),
    }


def test_keyfile_password_passed_through(monkeypatch, tmp_path: Path) -> None:
    cert, key = _write_self_signed(tmp_path, password="hunter2")
    monkeypatch.setenv("NEXTHMI_SSL_CERTFILE", str(cert))
    monkeypatch.setenv("NEXTHMI_SSL_KEYFILE", str(key))
    monkeypatch.setenv("NEXTHMI_SSL_KEYFILE_PASSWORD", "hunter2")
    assert launcher._resolve_tls()["ssl_keyfile_password"] == "hunter2"


def test_corrupt_pair_is_rejected_at_startup_not_at_bind(monkeypatch, tmp_path: Path) -> None:
    """A truncated/mismatched pair must fail here, before uvicorn.run() binds the socket."""
    cert = tmp_path / "cert.pem"
    key = tmp_path / "key.pem"
    cert.write_text("not a certificate", encoding="utf-8")
    key.write_text("not a key", encoding="utf-8")
    monkeypatch.setenv("NEXTHMI_SSL_CERTFILE", str(cert))
    monkeypatch.setenv("NEXTHMI_SSL_KEYFILE", str(key))
    with pytest.raises(launcher.TlsConfigError, match="could not be loaded together"):
        launcher._resolve_tls()


def test_mismatched_key_is_rejected_at_startup(monkeypatch, tmp_path: Path) -> None:
    other_dir = tmp_path / "other"
    other_dir.mkdir()
    cert, _ = _write_self_signed(tmp_path)
    _, other_key = _write_self_signed(other_dir)
    monkeypatch.setenv("NEXTHMI_SSL_CERTFILE", str(cert))
    monkeypatch.setenv("NEXTHMI_SSL_KEYFILE", str(other_key))
    with pytest.raises(launcher.TlsConfigError, match="could not be loaded together"):
        launcher._resolve_tls()


@pytest.mark.parametrize("present", ["NEXTHMI_SSL_CERTFILE", "NEXTHMI_SSL_KEYFILE"])
def test_half_configured_tls_is_rejected(monkeypatch, pem, present: str) -> None:
    cert, key = pem
    monkeypatch.setenv(present, str(cert if present.endswith("CERTFILE") else key))
    with pytest.raises(launcher.TlsConfigError, match="must both be set"):
        launcher._resolve_tls()


def test_missing_file_is_rejected_at_startup(monkeypatch, tmp_path: Path, pem) -> None:
    cert, _ = pem
    monkeypatch.setenv("NEXTHMI_SSL_CERTFILE", str(cert))
    monkeypatch.setenv("NEXTHMI_SSL_KEYFILE", str(tmp_path / "absent.pem"))
    with pytest.raises(launcher.TlsConfigError, match="not found"):
        launcher._resolve_tls()
