"""Revocable bearer tokens for the workspace MCP transport and the external API.

Mirrors ``core.peer_tokens`` (hashed-at-rest, paired once with the device-admin
password, revocable, bound to the current password generation) but adds the
scope a peer token doesn't need: each MCP token grants ``read`` or ``write``
access to exactly one project. ``write`` implies ``read``. Binding
``authGeneration`` at issue time — and rejecting on verify once it no longer
matches ``manager_auth.credential_generation()`` — revokes every outstanding
token the instant the device-admin password changes, independent of the
explicit ``revoke_all()`` the password-change endpoint also calls.

The same store holds the external API's tokens (``/api/v1``, see
``api.v1_api``): an entry with ``"kind": "api"`` carries a list of ``scopes``
instead of an ``access`` level. An entry without ``kind`` is an MCP token, so
a file written before API tokens existed reads unchanged. Each kind resolves
only through its own function — an MCP token never opens ``/api/v1`` and an API
token never opens ``/mcp``.
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

# ``sessions:write`` (signing users in and out on named panels) is the next scope.
API_SCOPES = ("history:read", "alarms:read", "recipes:read", "users:read", "users:write")

_TOKENS_FILENAME = ".mcp-tokens.json"
_lock = threading.RLock()


@dataclass(frozen=True)
class TokenScope:
    token_id: str
    project_id: str
    access: Access
    name: str


@dataclass(frozen=True)
class ApiTokenScope:
    token_id: str
    project_id: str
    scopes: frozenset[str]
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


def _append(entry: dict[str, Any]) -> tuple[str, str]:
    token_id = secrets.token_urlsafe(12)
    raw_token = f"{token_id}.{secrets.token_urlsafe(32)}"
    with _lock:
        data = _load()
        data["tokens"].append(
            {
                "id": token_id,
                **entry,
                "hash": _digest(raw_token),
                "authGeneration": manager_auth.credential_generation(),
                "createdAt": iso_now(),
            }
        )
        _save(data)
    return token_id, raw_token


def issue(*, project_id: str, access: Access, name: str | None = None) -> tuple[str, str]:
    """Return ``(token_id, raw_token)`` while persisting only its digest."""
    if access not in ("read", "write"):
        raise ValueError(f"Invalid access level: {access!r}")
    return _append(
        {
            "name": (name or "MCP client").strip() or "MCP client",
            "projectId": project_id,
            "access": access,
        }
    )


def issue_api(*, project_id: str, scopes: list[str], name: str | None = None) -> tuple[str, str]:
    """Mint an ``/api/v1`` token for *project_id* holding exactly *scopes*."""
    unknown = set(scopes) - set(API_SCOPES)
    if not scopes or unknown:
        raise ValueError(f"Invalid API scopes: {sorted(unknown) or 'none given'}")
    return _append(
        {
            "kind": "api",
            "name": (name or "API client").strip() or "API client",
            "projectId": project_id,
            "scopes": sorted(set(scopes)),
        }
    )


def _find(token: str | None) -> dict[str, Any] | None:
    """The stored entry *token* matches under the current password generation."""
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
                and isinstance(entry.get("projectId"), str)
            ):
                return entry
    return None


def resolve(token: str | None) -> TokenScope | None:
    """Return the scope for a valid, unrevoked MCP token, or ``None``."""
    entry = _find(token)
    if entry is None or entry.get("kind", "mcp") != "mcp":
        return None
    access = entry.get("access")
    if access not in ("read", "write"):
        return None
    return TokenScope(
        token_id=entry["id"],
        project_id=entry["projectId"],
        access=access,
        name=str(entry.get("name") or "MCP client"),
    )


def resolve_api(token: str | None) -> ApiTokenScope | None:
    """Return the scope for a valid, unrevoked API token, or ``None``."""
    entry = _find(token)
    if entry is None or entry.get("kind") != "api" or not isinstance(entry.get("scopes"), list):
        return None
    return ApiTokenScope(
        token_id=entry["id"],
        project_id=entry["projectId"],
        scopes=frozenset(s for s in entry["scopes"] if s in API_SCOPES),
        name=str(entry.get("name") or "API client"),
    )


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


def revoke_project(project_id: str) -> int:
    """Revoke every token issued for *project_id*: a later project reusing a
    deleted one's id must not inherit them."""
    with _lock:
        data = _load()
        kept = [entry for entry in data["tokens"] if entry.get("projectId") != project_id]
        revoked = len(data["tokens"]) - len(kept)
        if revoked:
            data["tokens"] = kept
            _save(data)
        return revoked


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
                "kind": entry.get("kind", "mcp"),
                "name": entry.get("name"),
                "projectId": entry.get("projectId"),
                **(
                    {"scopes": entry.get("scopes", [])}
                    if entry.get("kind") == "api"
                    else {"access": entry.get("access")}
                ),
                "createdAt": entry.get("createdAt"),
            }
            for entry in _load()["tokens"]
        ]
