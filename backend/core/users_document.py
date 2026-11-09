"""Structural validation of a project's ``users.json``.

The manager and the supervisor both refuse to open a project whose user
document is unreadable or malformed, rather than starting it with an identity
model nothing downstream can evaluate.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from core.passwords import is_valid_hash
from core.storage import read_json
from core.validation import is_valid_user_id


@dataclass(frozen=True)
class DocumentState:
    valid: bool
    error: str | None = None


_VALID = DocumentState(True)


def _invalid(reason: str = "users.json is invalid") -> DocumentState:
    return DocumentState(False, reason)


def state(project_root: Path) -> DocumentState:
    """Read validity without ever repairing or replacing project data."""
    try:
        document = read_json(project_root / "users.json")
    except FileNotFoundError:
        return _invalid("users.json is missing")
    except (OSError, ValueError):
        return _invalid("users.json is unreadable or corrupt")
    return document_state(document)


def document_state(document: Any) -> DocumentState:
    """Classify an already-loaded users document without mutating it."""
    if not isinstance(document, dict):
        return _invalid()
    if not isinstance(document.get("settings"), dict):
        return _invalid()
    if not isinstance(document.get("groups"), list):
        return _invalid()
    if not isinstance(document.get("users"), list):
        return _invalid()
    group_ids: set[str] = set()
    for group in document["groups"]:
        if not isinstance(group, dict) or not is_valid_user_id(group.get("id", "")):
            return _invalid()
        group_id = str(group["id"])
        if group_id in group_ids:
            return _invalid()
        group_ids.add(group_id)

    user_ids: set[str] = set()
    usernames: set[str] = set()
    for user in document["users"]:
        if (
            not isinstance(user, dict)
            or not is_valid_user_id(user.get("id", ""))
            or not is_valid_user_id(user.get("username", ""))
            or not isinstance(user.get("groups"), list)
            or not user["groups"]
            or not all(isinstance(group_id, str) for group_id in user["groups"])
            or any(group_id not in group_ids for group_id in user["groups"])
        ):
            return _invalid()
        if user["id"] in user_ids or user["username"] in usernames:
            return _invalid()
        if "passwordHash" in user and (
            user.get("password", "") != "" or not is_valid_hash(user["passwordHash"])
        ):
            return _invalid()
        user_ids.add(user["id"])
        usernames.add(user["username"])

    return _VALID


def merge_installed_accounts(incoming: dict, installed: dict) -> tuple[dict, list[str]]:
    """``incoming`` with the accounts of ``installed`` in place of its own.

    A project replaced on a machine keeps the accounts operators made there:
    groups and settings are design and come from the incoming project, the
    accounts belong to the installation. A group an installed account still
    names but the new design dropped is put back (label = id) rather than
    stripping access nobody chose to remove; its id is returned so the
    operator hears about it. Both documents must already be valid.
    """
    groups = [dict(group) for group in incoming["groups"]]
    known = {group["id"] for group in groups}
    restored: list[str] = []
    for user in installed["users"]:
        for group_id in user["groups"]:
            if group_id not in known:
                known.add(group_id)
                restored.append(group_id)
                groups.append({"id": group_id, "label": group_id})
    merged = {**incoming, "groups": groups, "users": [dict(user) for user in installed["users"]]}
    return merged, restored
