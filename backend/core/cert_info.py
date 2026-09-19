"""core.cert_info — validity of a stored X.509 certificate file.

An OPC-UA client certificate is generated once and then forgotten. Years later
its expiry is what takes a panel's secured connection down, and the handshake
failure a server reports says nothing about which side aged out. Describing the
file lets the editor show the date before that happens, and the connect path log
it when it already has.
"""

from __future__ import annotations

import datetime
import hashlib
import logging
import ssl
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Long enough before expiry that a plant can schedule the swap into a planned
# stop rather than discovering it from a dropped connection.
EXPIRY_WARNING_DAYS = 90


def describe_certificate(path: Path) -> dict[str, Any] | None:
    """Subject, fingerprint and validity of a certificate file.

    ``None`` when the file is missing or is not a certificate at all — a
    private key, or the operator's path typo. Callers surface that as "unknown"
    rather than an error: a certificate this process cannot read is still one
    the OPC-UA server may accept.
    """
    try:
        raw = path.read_bytes()
    except OSError:
        return None

    from cryptography import x509

    try:
        if b"-----BEGIN" in raw[:64]:
            der = ssl.PEM_cert_to_DER_cert(raw.decode("utf-8"))
        else:
            der = raw
        certificate = x509.load_der_x509_certificate(der)
    except (ValueError, UnicodeDecodeError):
        return None

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
        "subject": certificate.subject.rfc4514_string(),
        "fingerprint": hashlib.sha256(der).hexdigest(),
        "issuedAt": certificate.not_valid_before_utc.isoformat(),
        "expiresAt": certificate.not_valid_after_utc.isoformat(),
        "expiresInDays": expires_in_days,
        "expired": expires_in_days < 0,
        "expiring": expires_in_days < EXPIRY_WARNING_DAYS,
        "selfSigned": certificate.issuer == certificate.subject,
        "names": names,
    }


# Re-check at most this often per file: long enough that a reconnect loop
# retrying once a second doesn't re-parse and re-hash the cert on every
# attempt, short enough that a certificate drifting into the expiry window
# on a long-lived connection still gets caught without a restart.
_EXPIRY_CHECK_TTL_S = 3600.0

# (path, label) -> (mtime at last check, monotonic time of last check, message)
_expiry_check_cache: dict[tuple[str, str], tuple[float, float, str | None]] = {}


def log_expiry_warning(path: Path, label: str) -> str | None:
    """Log that ``path``'s certificate is near or past expiry, if it is.

    Never raises: an expired client certificate is the server's call to refuse,
    not a reason for this process to fail a connect it was asked to make.

    Memoized per ``(path, label)`` for :data:`_EXPIRY_CHECK_TTL_S`, invalidated
    early if the file's mtime changes. The OPC-UA connect path calls this on
    every reconnect attempt — as often as once a second while a datasource
    stays disconnected — and re-reading and re-parsing the file synchronously,
    on the event loop, each attempt would be wasted work.
    """
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0

    cache_key = (str(path), label)
    now = time.monotonic()
    cached = _expiry_check_cache.get(cache_key)
    if cached is not None:
        cached_mtime, checked_at, message = cached
        if cached_mtime == mtime and now - checked_at < _EXPIRY_CHECK_TTL_S:
            return message

    described = describe_certificate(path)
    message = None
    if described is not None and described["expiring"]:
        days = described["expiresInDays"]
        message = (
            f"{label}: certificate {path.name} expired {abs(days)} days ago"
            if described["expired"]
            else f"{label}: certificate {path.name} expires in {days} days"
        )
        logger.warning(message)
    _expiry_check_cache[cache_key] = (mtime, now, message)
    return message
