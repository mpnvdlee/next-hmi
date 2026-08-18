"""Operator-managed HTTPS for the manager front door.

Everything a browser talks to is served by the manager — the dashboard, and
each project's HMI and editor through the reverse proxy — so one certificate
here covers the whole installation.

Turning HTTPS on cannot require a certificate authority: the runtimes that most
need it are on plant networks with no CA and no operator who could drive one. So
the manager generates its own certificate. Browsers warn on first visit until it
is trusted on each machine; that is the honest cost of a self-signed
certificate, and still strictly better than passwords crossing the LAN in the
clear.

``NEXTHMI_SSL_CERTFILE`` / ``NEXTHMI_SSL_KEYFILE`` continue to win over
anything set here, so a Docker or proxy deployment with a real CA-issued
certificate keeps working and the UI reports the setting as externally owned.
"""

from __future__ import annotations

import datetime
import hashlib
import ipaddress
import json
import logging
import os
import socket
import ssl
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from core import runtime_home
from core.storage import write_bytes_atomic, write_text_atomic

logger = logging.getLogger(__name__)

_TLS_SUBDIR = "tls"
_CONFIG_FILENAME = "config.json"
# Machine lifetime, not web-PKI lifetime. The 398-day ceiling browsers enforce
# applies to certificates chaining to a *publicly trusted* root; Apple and
# Chrome both exempt user-added and enterprise-managed roots, which is the only
# way this certificate is ever trusted. A panel that outlives its certificate
# by 18 years is the worse failure.
_VALIDITY_DAYS = 365 * 20
# Long enough before expiry that a plant can schedule the swap into a planned
# stop rather than discovering it from an operator's browser warning.
EXPIRY_WARNING_DAYS = 90
MAX_PEM_BYTES = 64 * 1024

# Generated and uploaded material sit side by side so switching between them
# never destroys the other, and switching back needs no re-upload.
_FILENAMES = {
    "generated": ("cert.pem", "key.pem"),
    "custom": ("custom-cert.pem", "custom-key.pem"),
}
Mode = Literal["generated", "custom"]
_lock = threading.RLock()

# What the running listener actually bound at startup — set once by the
# launcher right before ``uvicorn.run``. The admin endpoint compares this
# against the stored setting to decide whether a restart is needed, instead
# of guessing from a request's (possibly proxy-controlled) scheme. Defaults
# to "serving plain HTTP", which is correct for every context that never
# calls :func:`mark_served` (dev's `uvicorn manager:app --reload`, tests).
_served_enabled = False
_served_fingerprint: str | None = None


def mark_served(enabled: bool, fingerprint: str | None) -> None:
    global _served_enabled, _served_fingerprint
    _served_enabled = enabled
    _served_fingerprint = fingerprint


def served() -> tuple[bool, str | None]:
    """``(enabled, fingerprint)`` last recorded by :func:`mark_served`."""
    return _served_enabled, _served_fingerprint


class TlsError(Exception):
    """A certificate could not be generated, stored, or read."""


@dataclass(frozen=True)
class TlsPaths:
    certfile: Path
    keyfile: Path


def tls_dir(home: Path | None = None) -> Path:
    return (home or runtime_home.runtime_home_path()) / _TLS_SUBDIR


def paths(home: Path | None = None, mode: Mode = "generated") -> TlsPaths:
    base = tls_dir(home)
    cert_name, key_name = _FILENAMES[mode]
    return TlsPaths(certfile=base / cert_name, keyfile=base / key_name)


def _config_path(home: Path | None = None) -> Path:
    return tls_dir(home) / _CONFIG_FILENAME


def env_override() -> TlsPaths | None:
    """Certificate pair pinned by the environment, if both variables are set.

    Ownership, not usability: the variables being set is what makes the setting
    externally owned and this UI read-only, whether or not the files behind them
    exist. Use :func:`missing_files` for the second question.
    """
    certfile = (os.environ.get("NEXTHMI_SSL_CERTFILE") or "").strip()
    keyfile = (os.environ.get("NEXTHMI_SSL_KEYFILE") or "").strip()
    if not certfile or not keyfile:
        return None
    return TlsPaths(certfile=Path(certfile).expanduser(), keyfile=Path(keyfile).expanduser())


def missing_files(pair: TlsPaths) -> list[str]:
    """Which half of the pair is not on disk — empty when both are."""
    return [str(path) for path in (pair.certfile, pair.keyfile) if not path.is_file()]


def _read_config(home: Path | None = None) -> dict[str, Any]:
    try:
        raw = json.loads(_config_path(home).read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def is_enabled(home: Path | None = None) -> bool:
    return _read_config(home).get("enabled") is True


def _normalize_mode(stored: Any) -> Mode:
    return "custom" if stored == "custom" else "generated"


def mode(home: Path | None = None) -> Mode:
    return _normalize_mode(_read_config(home).get("mode"))


def set_config(
    home: Path | None = None, *, enabled: bool | None = None, mode: Mode | None = None
) -> None:
    with _lock:
        current = _read_config(home)
        payload = {
            "version": 1,
            "enabled": current.get("enabled") is True if enabled is None else bool(enabled),
            "mode": _normalize_mode(current.get("mode") if mode is None else mode),
        }
        write_text_atomic(_config_path(home), json.dumps(payload, indent=2))


def resolve(home: Path | None = None) -> TlsPaths | None:
    """The certificate pair to serve with, or ``None`` for plain HTTP."""
    override = env_override()
    if override is not None:
        return override
    if not is_enabled(home):
        return None
    pair = paths(home, mode(home))
    if not pair.certfile.is_file() or not pair.keyfile.is_file():
        return None
    return pair


def log_expiry_warning(home: Path | None = None) -> str | None:
    """Warn the log when the certificate being served is near or past expiry.

    The admin page shows the same thing, but nobody opens Settings on a running
    line — years later this log line is what explains the browser warning.
    Never raises and never blocks startup: an expired certificate still
    encrypts, and refusing to serve would take a panel offline over a
    browser-trust problem.
    """
    if env_override() is not None or resolve(home) is None:
        return None
    described = _describe_quietly(home, mode(home))
    if described is None or not described["expiring"]:
        return None
    days = described["expiresInDays"]
    message = (
        f"tls: the HTTPS certificate expired {abs(days)} days ago"
        if described["expired"]
        else f"tls: the HTTPS certificate expires in {days} days"
    )
    message += " — replace it in Settings → HTTPS."
    logger.warning(message)
    return message


def _san_entries() -> tuple[list[str], list[str]]:
    """Names and addresses this runtime is likely to be reached at.

    Best-effort: a certificate missing an address the operator happens to use
    is a browser warning, which self-signed certificates produce anyway, so
    resolution failures here are not worth failing generation over.
    """
    names = {"localhost"}
    addresses = {"127.0.0.1"}
    try:
        hostname = socket.gethostname()
    except OSError:
        hostname = ""
    if hostname:
        names.add(hostname)
        names.add(f"{hostname}.local")
        try:
            for info in socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM):
                addresses.add(info[4][0])
        except OSError:
            pass
    return sorted(names), sorted(addresses)


def generate_self_signed(home: Path | None = None) -> dict[str, Any]:
    """Write a fresh self-signed certificate pair, replacing any existing one."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    names, addresses = _san_entries()
    common_name = names[0] if names else "nexthmi"
    alt: list[Any] = [x509.DNSName(name) for name in names]
    for address in addresses:
        try:
            alt.append(x509.IPAddress(ipaddress.ip_address(address)))
        except ValueError:
            continue

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "NEXT HMI"),
        ]
    )
    now = datetime.datetime.now(datetime.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=_VALIDITY_DAYS))
        .add_extension(x509.SubjectAlternativeName(alt), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    key_bytes = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    _write_pair(
        paths(home, "generated"),
        certificate.public_bytes(serialization.Encoding.PEM),
        key_bytes,
    )
    logger.info("tls: generated self-signed certificate for %s", ", ".join(names))
    return describe(home, "generated") or {}


def _write_pair(pair: TlsPaths, cert_bytes: bytes, key_bytes: bytes) -> None:
    with _lock:
        pair.certfile.parent.mkdir(parents=True, exist_ok=True)
        # Create the key unreadable to other users before any bytes land in it;
        # writing first and chmod-ing after leaves a window where it is not.
        descriptor = os.open(pair.keyfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(descriptor, key_bytes)
        finally:
            os.close(descriptor)
        os.chmod(pair.keyfile, 0o600)
        write_bytes_atomic(pair.certfile, cert_bytes)


def install_custom(cert_pem: bytes, key_pem: bytes, home: Path | None = None) -> dict[str, Any]:
    """Store an operator-supplied certificate pair after proving it can serve.

    Validated by loading it exactly as uvicorn will, in a temporary directory,
    so a mismatched key or an encrypted one is rejected here with a readable
    message instead of at the next startup, when the manager would already be
    committed to binding an HTTPS socket it cannot serve.
    """
    for label, blob in (("certificate", cert_pem), ("private key", key_pem)):
        if not blob.strip():
            raise TlsError(f"The {label} is empty.")
        if len(blob) > MAX_PEM_BYTES:
            raise TlsError(f"The {label} is larger than {MAX_PEM_BYTES // 1024} KB.")
        if b"-----BEGIN" not in blob:
            raise TlsError(f"The {label} is not PEM — expected a -----BEGIN block.")

    with tempfile.TemporaryDirectory(prefix="nexthmi-tls-") as staging:
        candidate = TlsPaths(
            certfile=Path(staging) / "cert.pem", keyfile=Path(staging) / "key.pem"
        )
        _write_pair(candidate, cert_pem, key_pem)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        try:
            context.load_cert_chain(str(candidate.certfile), str(candidate.keyfile))
        except ssl.SSLError as exc:
            raise TlsError(
                "The certificate and private key could not be loaded together — check that "
                "they are a matching pair and that the key is not passphrase-protected. "
                f"({exc.reason or exc})"
            ) from exc
        except OSError as exc:
            raise TlsError(f"The certificate or private key could not be read: {exc}") from exc

    _write_pair(paths(home, "custom"), cert_pem, key_pem)
    described = describe(home, "custom")
    logger.info("tls: installed operator-supplied certificate")
    return described or {}


def has_custom(home: Path | None = None) -> bool:
    pair = paths(home, "custom")
    return pair.certfile.is_file() and pair.keyfile.is_file()


def describe(home: Path | None = None, mode: Mode = "generated") -> dict[str, Any] | None:
    """Fingerprint and validity of a stored certificate, if it exists."""
    pair = paths(home, mode)
    try:
        pem = pair.certfile.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return None

    from cryptography import x509

    try:
        der = ssl.PEM_cert_to_DER_cert(pem)
        certificate = x509.load_der_x509_certificate(der)
    except ValueError as exc:
        raise TlsError(f"Stored certificate is not readable: {exc}") from exc
    try:
        names = [
            str(entry.value)
            for entry in certificate.extensions.get_extension_for_class(
                x509.SubjectAlternativeName
            ).value
        ]
    except x509.ExtensionNotFound:
        names = []
    # Signed, so an already-expired certificate reads as a negative number
    # rather than collapsing into the same "0 days" as one expiring today.
    remaining = certificate.not_valid_after_utc - datetime.datetime.now(datetime.UTC)
    expires_in_days = remaining.days
    return {
        "fingerprint": hashlib.sha256(der).hexdigest(),
        "expiresAt": certificate.not_valid_after_utc.isoformat(),
        "expiresInDays": expires_in_days,
        "expired": expires_in_days < 0,
        "expiring": expires_in_days < EXPIRY_WARNING_DAYS,
        "names": names,
    }


def _describe_quietly(home: Path | None, which: Mode) -> dict[str, Any] | None:
    try:
        return describe(home, which)
    except TlsError as exc:
        logger.warning("tls: %s", exc)
        return None


def status(home: Path | None = None) -> dict[str, Any]:
    """What the HTTPS admin section renders."""
    override = env_override()
    if override is not None:
        # The launcher refuses to bind when a pinned file is absent, so
        # reporting HTTPS here would tell the operator the opposite of what
        # their next restart does.
        missing = missing_files(override)
        return {
            "enabled": not missing,
            "source": "env",
            "mode": "custom",
            "generatedCertificate": None,
            "customCertificate": None,
            "error": (
                "NEXTHMI_SSL_CERTFILE / NEXTHMI_SSL_KEYFILE point at files that do not "
                f"exist: {', '.join(missing)}. This device cannot start with HTTPS until "
                "they are in place."
                if missing
                else None
            ),
        }
    return {
        "enabled": is_enabled(home),
        "source": "managed",
        "mode": mode(home),
        "generatedCertificate": _describe_quietly(home, "generated"),
        "customCertificate": _describe_quietly(home, "custom"),
        "error": None,
    }
