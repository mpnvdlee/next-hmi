"""Tests for core.cert_info — certificate validity reporting."""
import datetime
import logging
from pathlib import Path

from core.cert_info import describe_certificate, log_expiry_warning
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def _certificate(path: Path, *, days: int, encoding: str = "pem") -> Path:
    """Write a self-signed certificate whose validity ends ``days`` from now."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "webhmi-opc-client")])
    now = datetime.datetime.now(datetime.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=abs(days) + 1))
        .not_valid_after(now + datetime.timedelta(days=days, hours=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        .sign(key, hashes.SHA256())
    )
    form = serialization.Encoding.PEM if encoding == "pem" else serialization.Encoding.DER
    path.write_bytes(certificate.public_bytes(form))
    return path


def test_describes_subject_names_and_remaining_validity(tmp_path: Path):
    described = describe_certificate(_certificate(tmp_path / "cert.pem", days=400))

    assert described is not None
    assert described["expiresInDays"] == 400
    assert described["expired"] is False
    assert described["expiring"] is False
    assert described["selfSigned"] is True
    assert described["names"] == ["localhost"]
    assert "webhmi-opc-client" in described["subject"]
    assert len(described["fingerprint"]) == 64


def test_reads_der_as_well_as_pem(tmp_path: Path):
    """A cert/key path is free text — a DER file there is valid, not a mistake."""
    described = describe_certificate(_certificate(tmp_path / "cert.der", days=10, encoding="der"))

    assert described is not None
    assert described["expiresInDays"] == 10


def test_expiry_flags_track_the_remaining_validity(tmp_path: Path):
    near = describe_certificate(_certificate(tmp_path / "near.pem", days=30))
    past = describe_certificate(_certificate(tmp_path / "past.pem", days=-5))

    assert near is not None and near["expiring"] is True and near["expired"] is False
    assert past is not None and past["expiring"] is True and past["expired"] is True
    assert past["expiresInDays"] == -5


def test_unreadable_paths_describe_as_none(tmp_path: Path):
    assert describe_certificate(tmp_path / "absent.pem") is None
    assert describe_certificate(tmp_path) is None

    key_path = tmp_path / "client-key.pem"
    key_path.write_bytes(
        rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    assert describe_certificate(key_path) is None


def test_warns_only_once_the_certificate_is_near_expiry(tmp_path: Path, caplog):
    healthy = _certificate(tmp_path / "healthy.pem", days=400)
    near = _certificate(tmp_path / "near.pem", days=30)
    past = _certificate(tmp_path / "past.pem", days=-5)

    with caplog.at_level(logging.WARNING):
        assert log_expiry_warning(healthy, "opcua client") is None
        near_message = log_expiry_warning(near, "opcua client")
        past_message = log_expiry_warning(past, "opcua client")

    assert near_message is not None and "expires in 30 days" in near_message
    assert past_message is not None and "expired 5 days ago" in past_message
    assert "opcua client" in caplog.text


def test_warning_is_silent_for_an_unreadable_path(tmp_path: Path):
    assert log_expiry_warning(tmp_path / "absent.pem", "opcua client") is None
