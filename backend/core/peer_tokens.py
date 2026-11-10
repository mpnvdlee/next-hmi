"""Revocable bearer tokens used only by manager-to-manager project transfer.

Two sides of the same pairing live here: the tokens this manager *issued* to
peers (``.peer-tokens.json``, digests only), and the tokens it *holds* for
peers it paired with when the operator chose "Remember this device"
(``.peer-pairings.json``). A held token is a credential for the other device,
so it is stored in plaintext only because it has to be sent; the file is
written ``0600`` (``write_text_atomic`` creates it through ``mkstemp``) and the
token is only ever handed back for the certificate it was paired over.

An issued token is refused once its pairing has gone 90 days without use. Use
is recorded in memory on every request and written to ``.peer-tokens.json`` at
most once an hour per token, so a busy peer does not rewrite the file on every
call.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from core import manager_auth, runtime_home
from core.storage import write_text_atomic
from core.time_utils import iso_now

_TOKENS_FILENAME = ".peer-tokens.json"
_PAIRINGS_FILENAME = ".peer-pairings.json"
_lock = threading.RLock()

_IDLE_EXPIRY = timedelta(days=90)
_LAST_USED_WRITE_INTERVAL = timedelta(hours=1)
# Newer than what the file holds for a token until the next hourly write.
_last_used: dict[str, datetime] = {}


def tokens_path() -> Path:
    return runtime_home.runtime_home_path() / _TOKENS_FILENAME


def pairings_path() -> Path:
    return runtime_home.runtime_home_path() / _PAIRINGS_FILENAME


def _load() -> dict[str, Any]:
    try:
        raw = json.loads(tokens_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError):
        return {"version": 1, "tokens": []}
    if not isinstance(raw, dict) or not isinstance(raw.get("tokens"), list):
        return {"version": 1, "tokens": []}
    return raw


def _save(data: dict[str, Any]) -> None:
    write_text_atomic(tokens_path(), json.dumps(data, indent=2))


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _used_at(entry: dict[str, Any]) -> datetime | None:
    """When a peer last authenticated with this token, if it ever has."""
    moments = [
        moment
        for moment in (_last_used.get(entry.get("id")), _parse(entry.get("lastUsedAt")))
        if moment is not None
    ]
    return max(moments) if moments else None


def _expires_at(entry: dict[str, Any]) -> datetime | None:
    start = _used_at(entry) or _parse(entry.get("createdAt"))
    return start + _IDLE_EXPIRY if start is not None else None


def _expired(entry: dict[str, Any], now: datetime) -> bool:
    expires = _expires_at(entry)
    return expires is None or expires <= now


def _prune(data: dict[str, Any], now: datetime) -> None:
    """Drop expired pairings, saving only when one was dropped."""
    expired = [entry for entry in data["tokens"] if _expired(entry, now)]
    if not expired:
        return
    for entry in expired:
        _last_used.pop(entry.get("id"), None)
    data["tokens"] = [entry for entry in data["tokens"] if entry not in expired]
    _save(data)


def issue(
    name: str | None = None,
    *,
    hostname: str | None = None,
    runtime_id: str | None = None,
    address: str | None = None,
) -> tuple[str, str]:
    """Return ``(token_id, raw_token)`` while persisting only its digest.

    ``hostname`` and ``runtime_id`` are what the pairing request says about the
    device asking, and ``address`` where it came from; shown to the operator,
    trusted for nothing.
    """
    token_id = secrets.token_urlsafe(12)
    raw_token = f"{token_id}.{secrets.token_urlsafe(32)}"
    with _lock:
        data = _load()
        _prune(data, _now())
        data["tokens"].append(
            {
                "id": token_id,
                "name": (name or "Peer manager").strip() or "Peer manager",
                "hash": _digest(raw_token),
                "authGeneration": manager_auth.credential_generation(),
                "createdAt": iso_now(),
                "hostname": hostname,
                "runtimeId": runtime_id,
                "address": address,
            }
        )
        _save(data)
    return token_id, raw_token


def authenticate(token: str | None) -> str | None:
    """The id of the pairing ``token`` belongs to, or ``None`` when it is refused.

    Refused: unknown, revoked, issued under an earlier device-admin password,
    or expired — an expired one is pruned on the way.
    """
    if not token or "." not in token:
        return None
    token_id = token.split(".", 1)[0]
    candidate = _digest(token)
    generation = manager_auth.credential_generation()
    if generation is None:
        return None
    now = _now()
    with _lock:
        data = _load()
        entry = next(
            (item for item in data["tokens"] if item.get("id") == token_id), None
        )
        if (
            entry is None
            or entry.get("authGeneration") != generation
            or not isinstance(entry.get("hash"), str)
            or not hmac.compare_digest(candidate, entry["hash"])
        ):
            return None
        if _expired(entry, now):
            _prune(data, now)
            return None
        _last_used[token_id] = now
        written = _parse(entry.get("lastUsedAt"))
        if written is None or now - written >= _LAST_USED_WRITE_INTERVAL:
            entry["lastUsedAt"] = _iso(now)
            _save(data)
    return token_id


def verify(token: str | None) -> bool:
    return authenticate(token) is not None


def revoke(token_id: str) -> bool:
    with _lock:
        data = _load()
        before = len(data["tokens"])
        data["tokens"] = [
            entry for entry in data["tokens"] if entry.get("id") != token_id
        ]
        if len(data["tokens"]) == before:
            return False
        _last_used.pop(token_id, None)
        _save(data)
        return True


def revoke_all() -> int:
    with _lock:
        data = _load()
        count = len(data["tokens"])
        _last_used.clear()
        if count:
            data["tokens"] = []
            _save(data)
        return count


def list_tokens() -> list[dict[str, Any]]:
    """Return public metadata; token hashes and bearer values never leave this module."""
    with _lock:
        data = _load()
        _prune(data, _now())
        listed = []
        for entry in data["tokens"]:
            used = _used_at(entry)
            expires = _expires_at(entry)
            listed.append(
                {
                    "id": entry.get("id"),
                    "name": entry.get("name"),
                    "hostname": entry.get("hostname"),
                    "runtimeId": entry.get("runtimeId"),
                    "address": entry.get("address"),
                    "createdAt": entry.get("createdAt"),
                    "lastUsedAt": _iso(used) if used else None,
                    "expiresAt": _iso(expires) if expires else None,
                }
            )
        return listed


def _load_pairings() -> dict[str, Any]:
    try:
        raw = json.loads(pairings_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError):
        return {"version": 1, "pairings": {}}
    if not isinstance(raw, dict) or not isinstance(raw.get("pairings"), dict):
        return {"version": 1, "pairings": {}}
    return raw


def _save_pairings(data: dict[str, Any]) -> None:
    write_text_atomic(pairings_path(), json.dumps(data, indent=2))


def remember(runtime_id: str, token: str, fingerprint: str) -> None:
    """Keep a token issued by the peer ``runtime_id``, bound to its certificate."""
    with _lock:
        data = _load_pairings()
        data["pairings"][runtime_id] = {
            "token": token,
            "fingerprint": fingerprint,
            "pairedAt": iso_now(),
        }
        _save_pairings(data)


def forget_remembered(runtime_id: str) -> bool:
    with _lock:
        data = _load_pairings()
        if data["pairings"].pop(runtime_id, None) is None:
            return False
        _save_pairings(data)
        return True


def remembered(runtime_id: str | None, fingerprint: str | None) -> str | None:
    """The held token for this device, only over the certificate it was paired on.

    The runtimeId is just a claim any host can make; the certificate is what
    proves the device, so a token is never released for a connection anchored
    on any other one.
    """
    if not runtime_id or not fingerprint:
        return None
    with _lock:
        entry = _load_pairings()["pairings"].get(runtime_id)
    if (
        not isinstance(entry, dict)
        or entry.get("fingerprint") != fingerprint
        or not isinstance(entry.get("token"), str)
    ):
        return None
    return entry["token"]
