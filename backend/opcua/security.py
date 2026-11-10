"""
opcua.security — secure-channel settings and client certificates.

Shared by the live engine's connect, the connection probe and the test
server, so all three resolve, contain and generate certificates the same way.
"""

import datetime
import hashlib
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

from asyncua import Client, ua
from asyncua.crypto import security_policies, uacrypto
from asyncua.crypto.uacrypto import CertProperties
from core.cert_info import log_expiry_warning
from core.exceptions import DatasourceValidationError
from core.storage import active_certs_dir, active_project_root, write_bytes_atomic
from cryptography.hazmat.primitives.serialization import Encoding

logger = logging.getLogger(__name__)

# The secured policies and modes a datasource may request, matching the
# connection wizard's "Security Policy" / "Security Mode" dropdowns. An
# allowlist rather than a `getattr` lookup: asyncua also exposes
# `SecurityPolicyNone` and `MessageSecurityMode.None_`, so resolving the
# client's string by attribute name would let a datasource that reads as
# secured in the UI negotiate an unsecured channel.
SECURE_POLICY_NAMES = ("Basic256Sha256", "Aes128Sha256RsaOaep", "Aes256Sha256RsaPss")
SECURITY_MODES = ("Sign", "SignAndEncrypt")


def _resolve_security_path(raw_path: str) -> str:
    """Resolve a datasource-relative cert/key path against the active project.

    Contained, not merely documented: the caller creates and truncates
    whatever this returns, so a path that escapes the project is a write to an
    arbitrary file on the host.
    """
    certs_root = active_certs_dir().resolve()
    target = (active_project_root() / raw_path).resolve()
    if target != certs_root and not target.is_relative_to(certs_root):
        raise DatasourceValidationError(
            f"Certificate path must stay inside the project's certs folder: {raw_path!r}"
        )
    return str(target)


def ensure_client_certificate(
    cert_path: str, key_path: str, *, common_name: str = "webhmi-opc-client",
) -> None:
    """Generate a self-signed OPC-UA certificate pair if it is missing.

    The dev/test project ships datasource configs that request a secured
    policy, so the certificate pair is generated on first connect rather than
    committed — no private key lives in the repository. A deployment pointing
    a secured datasource at a real server should replace the generated pair
    with a server-trusted certificate of its own.

    ``common_name`` defaults to the client identity but is overridden by the
    OPC-UA test server, which reuses this generator for its own server-role
    certificate.
    """
    cert = Path(cert_path)
    key = Path(key_path)
    if cert.exists() and key.exists():
        return
    generate_self_signed_client_certificate(cert_path, key_path, common_name=common_name)


def generate_self_signed_client_certificate(
    cert_path: str,
    key_path: str,
    *,
    common_name: str = "webhmi-opc-client",
    validity_days: int = 3650,
    cert_encoding: str = "pem",
) -> None:
    """Write a fresh self-signed OPC-UA certificate + private key pair.

    Unconditional — overwrites whatever is at ``cert_path`` / ``key_path``.
    Shared by the connect-time auto-generate fallback above, the wizard's
    "Generate certificate" action, and the test server's server-certificate
    generation, so all three produce the same kind of pair by default.

    ``cert_encoding`` selects the certificate's own encoding ("pem" or
    "der") — the wizard's generator uses "der" to match the format an
    imported OPC-UA cert store (e.g. UaExpert/Optix) uses. The private key is
    always written as PEM regardless, matching what asyncua/cryptography
    expect for a key file.
    """
    cert = Path(cert_path)

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "DE"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "WebHMI"),
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
        ]
    )
    now = datetime.datetime.now(datetime.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=validity_days))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(private_key, hashes.SHA256())
    )

    key_bytes = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    cert.parent.mkdir(parents=True, exist_ok=True)
    # Atomic: this overwrites a pair the reconnect loop may be reading, so a
    # truncate-then-write would expose a half-written key. NamedTemporaryFile
    # creates at 0600, so the key is never readable by others either.
    write_bytes_atomic(key_path, key_bytes)
    os.chmod(key_path, 0o600)
    cert_encoding_value = serialization.Encoding.DER if cert_encoding == "der" else serialization.Encoding.PEM
    write_bytes_atomic(cert_path, certificate.public_bytes(cert_encoding_value))
    logger.info("opcua: generated self-signed client certificate at %s", cert_path)


@dataclass(frozen=True)
class SecuritySettings:
    """A datasource's secure-channel settings with cert paths resolved."""

    policy: str
    mode: str
    certificate: str
    private_key: str
    private_key_password: str = field(repr=False)
    server_certificate: str


def _pem_or_der(path: str) -> str:
    """Whether a cert/key file holds PEM text or raw DER bytes.

    Decided by content, not by filename: asyncua infers the format from the
    file extension, so an operator-supplied PEM key named ``client.key`` would
    be handed to the DER parser and fail with an opaque ASN.1 tag error.
    """
    try:
        with open(path, "rb") as handle:
            head = handle.read(64)
    except OSError as exc:
        raise RuntimeError(f"OPC security file could not be read: {path} ({exc})") from exc
    return "pem" if b"-----BEGIN" in head else "der"


def _resolve_security_settings(config: dict) -> SecuritySettings | None:
    """Normalize a datasource's security settings, resolving cert/key paths.

    Returns ``None`` for ``NoSecurity`` (no secure channel). Raises when a
    secured policy is requested without a client certificate + key.
    """
    security_value = str(config.get("security_policy", "NoSecurity") or "NoSecurity")
    if security_value == "NoSecurity":
        return None

    security_mode = str(config.get("security_mode", "") or "")
    security_policy = security_value
    if ":" in security_value:
        maybe_mode, maybe_policy = security_value.split(":", 1)
        if maybe_mode in SECURITY_MODES and maybe_policy:
            if not security_mode:
                security_mode = maybe_mode
            security_policy = maybe_policy
    if not security_mode:
        security_mode = "SignAndEncrypt"

    if security_policy not in SECURE_POLICY_NAMES:
        raise DatasourceValidationError(
            f"Unsupported OPC-UA security policy: {security_policy!r}",
        )
    if security_mode not in SECURITY_MODES:
        raise DatasourceValidationError(
            f"Unsupported OPC-UA security mode: {security_mode!r}",
        )

    cert_path = str(config.get("client_certificate", "") or "")
    key_path = str(config.get("client_private_key", "") or "")
    key_password = str(config.get("client_private_key_password", "") or "")
    server_cert_path = str(config.get("server_certificate", "") or "")

    if not cert_path or not key_path:
        raise RuntimeError(
            "OPC security requires 'client_certificate' and 'client_private_key' settings",
        )

    cert = _resolve_security_path(cert_path)
    key = _resolve_security_path(key_path)
    if not key_password:
        ensure_client_certificate(cert, key)

    return SecuritySettings(
        policy=security_policy,
        mode=security_mode,
        certificate=cert,
        private_key=key,
        private_key_password=key_password,
        server_certificate=_resolve_security_path(server_cert_path) if server_cert_path else "",
    )


@dataclass(frozen=True)
class ServerCertificate:
    """The certificate a secured endpoint presented, judged against the pin.

    ``status`` is ``"trusted"`` when it is the datasource's
    ``server_certificate``, ``"changed"`` when a different one is pinned, and
    ``"untrusted"`` when none is.
    """

    der: bytes
    status: str

    @property
    def fingerprint(self) -> str:
        return hashlib.sha256(self.der).hexdigest()


class ServerCertificateNotTrusted(RuntimeError):
    """A connect stopped before its session: the server is not the trusted one."""

    def __init__(self, certificate: ServerCertificate) -> None:
        self.certificate = certificate
        super().__init__(
            "The server certificate changed since it was trusted. The connection stays "
            "stopped until you review the new certificate in the datasource properties."
            if certificate.status == "changed"
            else "The server certificate is not trusted yet. The username and password "
            "are sent only after you trust it in the datasource properties."
        )


async def _presented_certificate(
    client: Client, policy_uri: str, mode: ua.MessageSecurityMode,
) -> bytes:
    """The leaf certificate the endpoint advertises, as DER.

    Fetched over an unsecured GetEndpoints, the only way to learn it, so
    nothing about it is authentic until it is compared with the pin.
    """
    endpoints = await client.connect_and_get_server_endpoints()
    endpoint = Client.find_endpoint(endpoints, mode, policy_uri)
    certificate = uacrypto.x509_from_der(endpoint.ServerCertificate)
    if certificate is None:
        raise RuntimeError("The server advertises no certificate for this secured endpoint")
    return certificate.public_bytes(Encoding.DER)


async def _pinned_certificate(path: str) -> bytes | None:
    # Missing reads as never pinned: an exported project leaves certs/ behind,
    # and the trust card is how the receiver pins the server again.
    if not path or not Path(path).is_file():
        return None
    certificate = await uacrypto.load_certificate(path, _pem_or_der(path))
    return certificate.public_bytes(Encoding.DER)


async def apply_client_security(client: Client, config: dict) -> ServerCertificate | None:
    """Put a client into secure-channel mode from datasource settings.

    Returns ``None`` when the datasource runs unsecured, else the server's
    certificate and whether it is the trusted one. Bypasses asyncua's
    ``set_security_string`` so each file's format comes from its bytes rather
    than its extension — see :func:`_pem_or_der`.

    Raises :class:`ServerCertificateNotTrusted`, before any session exists,
    when the certificate differs from the pinned one, or when none is pinned
    and the datasource signs in with a username: that password must only ever
    be encrypted to a server an engineer confirmed. An anonymous session to an
    unpinned server still connects — it carries no secret, and refusing it
    would take down every anonymous secured connection on update for no gain
    over the NoSecurity a datasource may use anyway.
    """
    settings = _resolve_security_settings(config)
    if settings is None:
        return None

    log_expiry_warning(Path(settings.certificate), "opcua client")
    if settings.server_certificate:
        log_expiry_warning(Path(settings.server_certificate), "opcua server")

    policy_class = getattr(security_policies, f"SecurityPolicy{settings.policy}")
    mode = getattr(ua.MessageSecurityMode, settings.mode)

    presented = await _presented_certificate(client, policy_class.URI, mode)
    pinned = await _pinned_certificate(settings.server_certificate)
    if pinned is None:
        status = "untrusted"
    else:
        status = "trusted" if presented == pinned else "changed"
    server_certificate = ServerCertificate(presented, status)
    if status == "changed" or (status == "untrusted" and config.get("username")):
        raise ServerCertificateNotTrusted(server_certificate)

    await client.set_security(
        policy_class,
        CertProperties(settings.certificate, extension=_pem_or_der(settings.certificate)),
        CertProperties(
            settings.private_key,
            extension=_pem_or_der(settings.private_key),
            password=settings.private_key_password or None,
        ),
        # The certificate just judged, not a fresh fetch: asyncua encrypts the
        # OpenSecureChannel to it and refuses a CreateSession answered with any
        # other, so a server swapped in after the check never sees credentials.
        server_certificate=presented,
        mode=mode,
    )
    return server_certificate
