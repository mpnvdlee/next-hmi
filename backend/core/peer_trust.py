"""Certificate pinning for manager-to-manager HTTPS peer transfer.

Peer managers on a plant LAN almost never have a CA-issued certificate, so
requiring a public chain of trust would make HTTPS transfer unusable. Instead
this module trusts a peer's certificate the first time it is seen (recording
its SHA-256 digest and PEM), and from then on requires that exact certificate.
That is the SSH host-key model: the first contact is as exposed as plain HTTP
was, every later one is not.

The pinned PEM is used as the sole trust anchor for that peer, so verification
happens during the handshake — before any bearer token or project bytes are
written to the socket. Hostname checking is off by design: the pin binds the
identity far more tightly than a name in a SAN, and the connection is made to
an already-resolved private address rather than to a name.

A certificate renewal on the peer therefore breaks transfers until the old pin
is dropped (``forget``) and re-established, which is the intended tradeoff — an
unannounced certificate change is indistinguishable from an interception.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import socket
import ssl
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from core import runtime_home
from core.storage import write_text_atomic
from core.time_utils import iso_now

_TRUST_FILENAME = ".peer-trust.json"
_HANDSHAKE_TIMEOUT_SECONDS = 10.0
_lock = threading.RLock()


class CertificateMismatch(Exception):
    """The peer presented a certificate other than the pinned one."""


@dataclass(frozen=True)
class Pin:
    host: str
    port: int
    fingerprint: str
    pem: str
    pinnedAt: str


def _trust_path() -> Path:
    return runtime_home.runtime_home_path() / _TRUST_FILENAME


def _key(host: str, port: int) -> str:
    return f"{host}:{port}"


def _load() -> dict[str, Any]:
    try:
        raw = json.loads(_trust_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError):
        return {"version": 1, "pins": {}}
    if not isinstance(raw, dict) or not isinstance(raw.get("pins"), dict):
        return {"version": 1, "pins": {}}
    return raw


def _save(data: dict[str, Any]) -> None:
    write_text_atomic(_trust_path(), json.dumps(data, indent=2))


def load_pin(host: str, port: int) -> Pin | None:
    with _lock:
        entry = _load()["pins"].get(_key(host, port))
    if not isinstance(entry, dict):
        return None
    fingerprint = entry.get("fingerprint")
    pem = entry.get("pem")
    if not isinstance(fingerprint, str) or not isinstance(pem, str):
        return None
    return Pin(
        host=host,
        port=port,
        fingerprint=fingerprint,
        pem=pem,
        pinnedAt=str(entry.get("pinnedAt") or ""),
    )


def _save_pin(host: str, port: int, fingerprint: str, pem: str) -> Pin:
    pinned_at = iso_now()
    with _lock:
        data = _load()
        data["pins"][_key(host, port)] = {
            "fingerprint": fingerprint,
            "pem": pem,
            "pinnedAt": pinned_at,
        }
        _save(data)
    return Pin(host=host, port=port, fingerprint=fingerprint, pem=pem, pinnedAt=pinned_at)


def forget(host: str, port: int) -> bool:
    with _lock:
        data = _load()
        if data["pins"].pop(_key(host, port), None) is None:
            return False
        _save(data)
        return True


def list_pins() -> list[dict[str, Any]]:
    """Public metadata for the manager UI — the PEM stays in this module."""
    with _lock:
        pins = _load()["pins"]
    out: list[dict[str, Any]] = []
    for key, entry in sorted(pins.items()):
        if not isinstance(entry, dict):
            continue
        host, _, port = key.rpartition(":")
        out.append(
            {
                "host": host,
                "port": int(port) if port.isdigit() else 0,
                "fingerprint": entry.get("fingerprint"),
                "pinnedAt": entry.get("pinnedAt"),
            }
        )
    return out


def _fetch_leaf_certificate(address: str, port: int) -> tuple[str, str]:
    """Handshake with the peer and return ``(pem, sha256_fingerprint)``.

    ``address`` is the already-resolved private address the transfer itself
    will connect to, and is used verbatim as the SNI name so this probe sees
    exactly the certificate the transfer connection will be offered.
    """
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    with socket.create_connection((address, port), timeout=_HANDSHAKE_TIMEOUT_SECONDS) as raw:  # noqa: SIM117 -- no autofix offered; inner context expr depends on `raw`, left as-is per the mechanical-only policy for this family
        with context.wrap_socket(raw, server_hostname=address) as tls:
            der = tls.getpeercert(binary_form=True)
    if not der:
        raise CertificateMismatch(f"Peer at {address}:{port} presented no certificate")
    return ssl.DER_cert_to_PEM_cert(der), hashlib.sha256(der).hexdigest()


def ensure_pin(host: str, port: int, address: str) -> Pin:
    """Pin the peer's certificate on first contact, and return the pin to use.

    Only the first contact needs a probe. Once a pin exists :func:`ssl_context`
    makes it the sole trust anchor, so the request's own handshake rejects any
    other certificate before a byte of the token or the project is written.
    Probing again up front would buy a second connect and a second handshake for
    every transfer — and up to ``_HANDSHAKE_TIMEOUT_SECONDS`` of dead wait
    against an unresponsive peer — to learn what the handshake already enforces.
    """
    existing = load_pin(host, port)
    if existing is not None:
        return existing
    pem, fingerprint = _fetch_leaf_certificate(address, port)
    return _save_pin(host, port, fingerprint, pem)


def _pin_expiry_days(pin: Pin) -> int | None:
    """Days until the pinned certificate expires (negative if already past).

    ``None`` if the stored PEM can't be parsed — leaves the caller to fall
    back to its normal "something else went wrong" message.
    """
    from cryptography import x509

    try:
        certificate = x509.load_pem_x509_certificate(pin.pem.encode("utf-8"))
    except ValueError:
        return None
    remaining = certificate.not_valid_after_utc - datetime.datetime.now(datetime.UTC)
    return remaining.days


def describe_mismatch(host: str, port: int, address: str) -> str | None:
    """Why a request to a pinned peer failed, if the pin explains it.

    A pin rejection surfaces as an opaque verification error, so the probe
    :func:`ensure_pin` no longer does up front happens here instead — on the
    failure path, where one extra round trip buys an actionable message.
    ``None`` means the pin still matches a currently-valid certificate and
    something else (a real connectivity problem) went wrong.
    """
    existing = load_pin(host, port)
    if existing is None:
        return None
    try:
        _, fingerprint = _fetch_leaf_certificate(address, port)
    except (OSError, CertificateMismatch):
        return None
    if fingerprint != existing.fingerprint:
        return (
            f"Certificate for peer {host}:{port} changed. Pinned "
            f"{existing.fingerprint[:16]}…, peer now presents {fingerprint[:16]}…. "
            "If the peer's certificate was renewed, forget the pin and pair again; "
            "otherwise the connection is being intercepted."
        )
    # The probe above ignores validity dates (it only needs the leaf bytes to
    # compare fingerprints), but the real request uses the pin as a strict
    # trust anchor, which does enforce them — so a same-fingerprint pin that
    # has since expired explains a handshake failure the fingerprint check
    # alone would otherwise call "no mismatch".
    days = _pin_expiry_days(existing)
    if days is not None and days < 0:
        return (
            f"Certificate for peer {host}:{port} expired {abs(days)} days ago. "
            "The peer must renew and reissue a certificate; re-pinning the same "
            "expired certificate will not fix this."
        )
    return None


def ssl_context(pin: Pin) -> ssl.SSLContext:
    """A context that accepts the pinned certificate and nothing else."""
    context = ssl.create_default_context(cadata=pin.pem)
    # The pin is the identity; the connection is made to a resolved address,
    # so there is no name to check it against.
    context.check_hostname = False
    return context
