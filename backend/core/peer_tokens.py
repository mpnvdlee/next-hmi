"""Revocable bearer tokens used only by manager-to-manager project transfer.

Two sides of the same pairing live here: the tokens this manager *issued* to
peers (``.peer-tokens.json``, digests only), and the tokens it *holds* for
peers it paired with when the operator chose "Remember this device"
(``.peer-pairings.json``). A held token is a credential for the other device,
so it is stored in plaintext only because it has to be sent; the file is
written ``0600`` (``write_text_atomic`` creates it through ``mkstemp``) and the
token is only ever handed back for the certificate it was paired over.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
from pathlib import Path
from typing import Any

from core import manager_auth, runtime_home
from core.storage import write_text_atomic
from core.time_utils import iso_now

_TOKENS_FILENAME = ".peer-tokens.json"
_PAIRINGS_FILENAME = ".peer-pairings.json"
_lock = threading.RLock()


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


def issue(name: str | None = None) -> tuple[str, str]:
    """Return ``(token_id, raw_token)`` while persisting only its digest."""
    token_id = secrets.token_urlsafe(12)
    raw_token = f"{token_id}.{secrets.token_urlsafe(32)}"
    with _lock:
        data = _load()
        data["tokens"].append(
            {
                "id": token_id,
                "name": (name or "Peer manager").strip() or "Peer manager",
                "hash": _digest(raw_token),
                "authGeneration": manager_auth.credential_generation(),
                "createdAt": iso_now(),
            }
        )
        _save(data)
    return token_id, raw_token


def verify(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    token_id = token.split(".", 1)[0]
    candidate = _digest(token)
    generation = manager_auth.credential_generation()
    if generation is None:
        return False
    with _lock:
        for entry in _load()["tokens"]:
            if (
                entry.get("id") == token_id
                and entry.get("authGeneration") == generation
                and isinstance(entry.get("hash"), str)
            ):
                return hmac.compare_digest(candidate, entry["hash"])
    return False


def revoke(token_id: str) -> bool:
    with _lock:
        data = _load()
        before = len(data["tokens"])
        data["tokens"] = [
            entry for entry in data["tokens"] if entry.get("id") != token_id
        ]
        if len(data["tokens"]) == before:
            return False
        _save(data)
        return True


def revoke_all() -> int:
    with _lock:
        data = _load()
        count = len(data["tokens"])
        if count:
            data["tokens"] = []
            _save(data)
        return count


def list_tokens() -> list[dict[str, Any]]:
    """Return public metadata; token hashes and bearer values never leave this module."""
    with _lock:
        return [
            {
                "id": entry.get("id"),
                "name": entry.get("name"),
                "createdAt": entry.get("createdAt"),
            }
            for entry in _load()["tokens"]
        ]


def _load_pairings() -> dict[str, Any]:
    try:
        raw = json.loads(pairings_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError):
        return {"version": 1, "pairings": {}}
    if not isinstance(raw, dict) or not isinstance(raw.get("pairings"), dict):
        return {"version": 1, "pairings": {}}
    return raw


def remember(runtime_id: str, token: str, fingerprint: str) -> None:
    """Keep a token issued by the peer ``runtime_id``, bound to its certificate."""
    with _lock:
        data = _load_pairings()
        data["pairings"][runtime_id] = {
            "token": token,
            "fingerprint": fingerprint,
            "pairedAt": iso_now(),
        }
        write_text_atomic(pairings_path(), json.dumps(data, indent=2))


def forget_remembered(runtime_id: str) -> None:
    with _lock:
        data = _load_pairings()
        if data["pairings"].pop(runtime_id, None) is not None:
            write_text_atomic(pairings_path(), json.dumps(data, indent=2))


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
