"""Revocable bearer tokens for the multi-project workspace MCP transport.

Mirrors ``core.peer_tokens`` (hashed-at-rest, paired once with the device-admin
password, revocable, bound to the current password generation) but adds the
scope a peer token doesn't need: each MCP token grants ``read`` or ``write``
access to exactly one project. ``write`` implies ``read``. Binding
``authGeneration`` at issue time — and rejecting on verify once it no longer
matches ``manager_auth.credential_generation()`` — revokes every outstanding
token the instant the device-admin password changes, independent of the
explicit ``revoke_all()`` the password-change endpoint also calls.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from core import manager_auth, runtime_home
from core.storage import write_text_atomic
from core.time_utils import iso_now

Access = Literal["read", "write"]

_TOKENS_FILENAME = ".mcp-tokens.json"
_lock = threading.RLock()


@dataclass(frozen=True)
class TokenScope:
    token_id: str
    project_id: str
    access: Access
    name: str


def tokens_path() -> Path:
    return runtime_home.runtime_home_path() / _TOKENS_FILENAME


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


def issue(*, project_id: str, access: Access, name: str | None = None) -> tuple[str, str]:
    """Return ``(token_id, raw_token)`` while persisting only its digest."""
    if access not in ("read", "write"):
        raise ValueError(f"Invalid access level: {access!r}")
    token_id = secrets.token_urlsafe(12)
    raw_token = f"{token_id}.{secrets.token_urlsafe(32)}"
    with _lock:
        data = _load()
        data["tokens"].append(
            {
                "id": token_id,
                "name": (name or "MCP client").strip() or "MCP client",
                "projectId": project_id,
                "access": access,
                "hash": _digest(raw_token),
                "authGeneration": manager_auth.credential_generation(),
                "createdAt": iso_now(),
            }
        )
        _save(data)
    return token_id, raw_token


def resolve(token: str | None) -> TokenScope | None:
    """Return the scope for a valid, unrevoked token, or ``None``."""
    if not token or "." not in token:
        return None
    token_id = token.split(".", 1)[0]
    candidate = _digest(token)
    generation = manager_auth.credential_generation()
    if generation is None:
        return None
    with _lock:
        for entry in _load()["tokens"]:
            if (
                entry.get("id") == token_id
                and entry.get("authGeneration") == generation
                and isinstance(entry.get("hash"), str)
                and hmac.compare_digest(candidate, entry["hash"])
            ):
                project_id = entry.get("projectId")
                access = entry.get("access")
                if not isinstance(project_id, str) or access not in ("read", "write"):
                    return None
                return TokenScope(
                    token_id=token_id,
                    project_id=project_id,
                    access=access,
                    name=str(entry.get("name") or "MCP client"),
                )
    return None


def revoke(token_id: str) -> bool:
    with _lock:
        data = _load()
        before = len(data["tokens"])
        data["tokens"] = [entry for entry in data["tokens"] if entry.get("id") != token_id]
        if len(data["tokens"]) == before:
            return False
        _save(data)
        return True


def retarget_project(old_project_id: str, new_project_id: str) -> int:
    """Re-scope every token issued for *old_project_id* onto *new_project_id*.

    Renaming a project's id keeps the same project, so the tokens an operator
    already handed out have to follow it — otherwise they'd resolve to a scope
    no project answers to, and a later project reusing the old id would inherit
    them.
    """
    with _lock:
        data = _load()
        moved = 0
        for entry in data["tokens"]:
            if entry.get("projectId") == old_project_id:
                entry["projectId"] = new_project_id
                moved += 1
        if moved:
            _save(data)
        return moved


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
                "projectId": entry.get("projectId"),
                "access": entry.get("access"),
                "createdAt": entry.get("createdAt"),
            }
            for entry in _load()["tokens"]
        ]
