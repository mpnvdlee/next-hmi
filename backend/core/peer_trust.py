"""Certificate pinning for manager-to-manager HTTPS peer transfer.

Peer managers on a plant LAN almost never have a CA-issued certificate, so
requiring a public chain of trust would make HTTPS transfer unusable. Instead
the operator compares the peer's SHA-256 fingerprint with the one the peer's
own Settings > HTTPS shows, and only a certificate confirmed that way is
pinned (its digest and PEM). Nothing is pinned silently: a certificate seen for
the first time stays unverified, and no password or token is sent to it.

A pin is keyed by the address it was confirmed at and carries the peer's
``runtimeId``, so the same device at a new address is recognised by its
certificate, and a different certificate claiming a pinned address or
``runtimeId`` is reported as changed instead of being re-pinned.

The pinned PEM is used as the sole trust anchor for that peer, so verification
happens during the handshake — before any password, bearer token or project
byte is written to the socket. Hostname checking is off by design: the pin
binds the identity far more tightly than a name in a SAN, and the connection
is made to an already-resolved private address rather than to a name.

A certificate renewal on the peer therefore breaks transfers until the old pin
is dropped (``forget``) and the new one confirmed, which is the intended
tradeoff — an unannounced certificate change is indistinguishable from an
interception.
"""

from __future__ import annotations

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
    runtimeId: str | None = None


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


def _pin_from(key: str, entry: Any) -> Pin | None:
    if not isinstance(entry, dict):
        return None
    fingerprint = entry.get("fingerprint")
    pem = entry.get("pem")
    if not isinstance(fingerprint, str) or not isinstance(pem, str):
        return None
    host, _, port = key.rpartition(":")
    runtime_id = entry.get("runtimeId")
    return Pin(
        host=host,
        port=int(port) if port.isdigit() else 0,
        fingerprint=fingerprint,
        pem=pem,
        pinnedAt=str(entry.get("pinnedAt") or ""),
        runtimeId=runtime_id if isinstance(runtime_id, str) and runtime_id else None,
    )


def _all_pins() -> list[Pin]:
    with _lock:
        pins = _load()["pins"]
    return [pin for key, entry in pins.items() if (pin := _pin_from(key, entry)) is not None]


def load_pin(host: str, port: int) -> Pin | None:
    key = _key(host, port)
    with _lock:
        entry = _load()["pins"].get(key)
    return _pin_from(key, entry)


def _related_pins(host: str, port: int, runtime_id: str | None) -> list[Pin]:
    """Every pin that speaks for this device: by its address, or by its runtimeId."""
    return [
        pin
        for pin in _all_pins()
        if (pin.host == host and pin.port == port)
        or (runtime_id is not None and pin.runtimeId == runtime_id)
    ]


def conflicting_pin(
    host: str, port: int, runtime_id: str | None, fingerprint: str
) -> Pin | None:
    """A pin for this address or runtimeId that names a different certificate."""
    for pin in _related_pins(host, port, runtime_id):
        if pin.fingerprint != fingerprint:
            return pin
    return None


def is_pinned(host: str, port: int, runtime_id: str | None, fingerprint: str) -> bool:
    """Whether this certificate is already confirmed for this address or runtimeId."""
    return any(
        pin.fingerprint == fingerprint for pin in _related_pins(host, port, runtime_id)
    )


def has_runtime_pin(runtime_id: str) -> bool:
    return any(pin.runtimeId == runtime_id for pin in _all_pins())


def save_pin(
    host: str, port: int, fingerprint: str, pem: str, runtime_id: str | None
) -> Pin:
    """Record a certificate the operator confirmed, or one already pinned for it."""
    pinned_at = iso_now()
    with _lock:
        data = _load()
        data["pins"][_key(host, port)] = {
            "fingerprint": fingerprint,
            "pem": pem,
            "pinnedAt": pinned_at,
            "runtimeId": runtime_id,
        }
        _save(data)
    return Pin(
        host=host,
        port=port,
        fingerprint=fingerprint,
        pem=pem,
        pinnedAt=pinned_at,
        runtimeId=runtime_id,
    )


def forget(host: str, port: int, runtime_id: str | None = None) -> bool:
    """Drop the pin for this address, and every pin of the device it belongs to.

    One device pinned at two addresses is one identity: dropping it at one
    address only would leave the stale certificate standing in for it, and the
    next contact would report it as changed all over again.
    """
    with _lock:
        data = _load()
        pins = data["pins"]
        dropped = pins.pop(_key(host, port), None)
        runtime_ids = {runtime_id} if runtime_id else set()
        if isinstance(dropped, dict) and isinstance(dropped.get("runtimeId"), str):
            runtime_ids.add(dropped["runtimeId"])
        siblings = [
            key
            for key, entry in pins.items()
            if isinstance(entry, dict) and entry.get("runtimeId") in runtime_ids
        ]
        for key in siblings:
            del pins[key]
        if dropped is None and not siblings:
            return False
        _save(data)
        return True


def list_pins() -> list[dict[str, Any]]:
    """Public metadata for the manager UI — the PEM stays in this module."""
    return [
        {
            "host": pin.host,
            "port": pin.port,
            "fingerprint": pin.fingerprint,
            "pinnedAt": pin.pinnedAt,
            "runtimeId": pin.runtimeId,
        }
        for pin in sorted(_all_pins(), key=lambda pin: (pin.host, pin.port))
    ]


def fetch_certificate(address: str, port: int) -> tuple[str, str]:
    """Handshake with the peer and return ``(pem, sha256_fingerprint)``.

    Trusts nothing: the result is only something to show the operator, or to
    compare with a fingerprint they already confirmed. ``address`` is the
    already-resolved private address the request itself will connect to, and
    is used verbatim as the SNI name so this probe sees exactly the
    certificate that connection will be offered.
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


def expiry_days(pem: str) -> int | None:
    """Days until the certificate expires (negative if already past).

    ``None`` if the PEM can't be parsed — leaves the caller to fall back to its
    normal "something else went wrong" message.
    """
    from core.cert_info import describe_x509

    try:
        return describe_x509(pem.encode("utf-8"))["expiresInDays"]
    except ValueError:
        return None


def describe_mismatch(host: str, port: int, address: str) -> str | None:
    """Why a request to a pinned peer failed, if the pin explains it.

    A pin rejection surfaces as an opaque verification error, so a fresh probe
    happens here — on the failure path, where one extra round trip buys an
    actionable message. ``None`` means the pin still matches a currently-valid
    certificate and something else (a real connectivity problem) went wrong.
    """
    existing = load_pin(host, port)
    if existing is None:
        return None
    try:
        _, fingerprint = fetch_certificate(address, port)
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
    days = expiry_days(existing.pem)
    if days is not None and days < 0:
        return (
            f"Certificate for peer {host}:{port} expired {abs(days)} days ago. "
            "The peer must renew and reissue a certificate; re-pinning the same "
            "expired certificate will not fix this."
        )
    return None


def ssl_context(pem: str) -> ssl.SSLContext:
    """A context that accepts this certificate and nothing else."""
    context = ssl.create_default_context(cadata=pem)
    # The pin is the identity; the connection is made to a resolved address,
    # so there is no name to check it against.
    context.check_hostname = False
    return context
