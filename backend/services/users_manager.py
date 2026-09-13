"""
users_manager — persistence layer for users.json.

Responsibilities:
  - Load or create users.json on startup with safe defaults.
  - Expose read/write helpers used by users_api.py.
  - Validate group IDs and usernames (same regex rules as dict names in config_api).
"""

import asyncio
import copy
import logging
import shutil
from datetime import UTC, datetime
from typing import Any

from core import user_auth_throttle
from core.exceptions import RateLimitError
from core.passwords import verify_absent_user, verify_password
from core.storage import active_project_root, read_json, write_json
from core.validation import is_valid_user_id

logger = logging.getLogger(__name__)


def users_path():
    return active_project_root() / "users.json"

# --- Defaults ---------------------------------------------------------------

_DEFAULT_DOCUMENT: dict[str, Any] = {
    "settings": {"autoLoginName": "guest"},
    "groups": [
        {"id": "guest", "label": "Guest"},
        {"id": "operator", "label": "Operator"},
        {"id": "engineer", "label": "Engineer"},
        {"id": "admin", "label": "Admin"},
    ],
    "users": [
        {"id": "guest", "username": "guest", "password": "", "groups": ["guest"]},
    ],
}


# --- Validation helpers -----------------------------------------------------


def valid_id(value: object) -> bool:
    """Return True if value is a safe group/user ID."""
    return is_valid_user_id(value)


def _validate_document(doc: Any) -> bool:
    """Return True if the document passes basic structural validation."""
    if not isinstance(doc, dict):
        return False
    settings = doc.get("settings")
    groups = doc.get("groups")
    users = doc.get("users")
    if not isinstance(settings, dict):
        return False
    if not isinstance(groups, list):
        return False
    if not isinstance(users, list):
        return False
    for g in groups:
        if not isinstance(g, dict) or not valid_id(g.get("id", "")):
            return False
    for u in users:
        if not isinstance(u, dict) or not valid_id(u.get("username", "")):
            return False
        if not isinstance(u.get("groups"), list):
            return False
    return True


# --- Public interface -------------------------------------------------------


def load() -> dict[str, Any]:
    """Return the in-memory users document (fresh read from disk)."""
    if not users_path().exists():
        return _default_copy()
    try:
        raw = read_json(users_path())
    except Exception as exc:
        logger.warning("users.json unreadable (%s); using defaults", exc)
        return _default_copy()
    if not _validate_document(raw):
        logger.warning("users.json is invalid; using defaults (original preserved as backup)")
        return _default_copy()
    return raw


async def authenticate(username: Any, password: Any) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Resolve one project-user identity using the shared password verifier.

    The single funnel every credential path runs through — the WebSocket
    ``login`` message and the REST Basic routes alike — so the throttle and the
    constant-cost miss below cover all of them at once.

    Raises ``RateLimitError`` (HTTP 429) while this username, or the whole
    credential path, is locked out. Returns ``None`` for a credential that does
    not authenticate, including every account with no password set.
    """
    if not isinstance(username, str) or not isinstance(password, str):
        return None
    remaining = user_auth_throttle.lockout_remaining(username)
    if remaining > 0:
        raise RateLimitError(
            f"Too many failed sign-in attempts. Try again in {int(remaining) + 1}s."
        )
    document = load()
    user = next(
        (
            item
            for item in document.get("users", [])
            if isinstance(item, dict) and item.get("username") == username
        ),
        None,
    )
    # A name that misses still pays for a verification. Returning here without
    # one answered ~50x faster than a wrong password and enumerated the roster
    # — on a route an anonymous LAN caller can reach.
    verified = await (
        asyncio.to_thread(verify_absent_user, password)
        if user is None
        else asyncio.to_thread(verify_password, user, password)
    )
    if not verified:
        user_auth_throttle.register_login_failure(username)
        return None
    user_auth_throttle.register_login_success(username)
    identity = {"username": user["username"], "groups": list(user.get("groups", ["guest"]))}
    return identity, document


def load_or_create() -> None:
    """Called at startup: ensure users.json exists and is valid; recreate if not."""
    if not users_path().exists():
        logger.info("users.json not found — creating with defaults")
        _write_defaults()
        return

    try:
        raw = read_json(users_path())
    except Exception as exc:
        logger.warning("users.json unreadable (%s) — backing up and recreating", exc)
        _backup_invalid()
        _write_defaults()
        return

    if not _validate_document(raw):
        logger.warning("users.json failed validation — backing up and recreating")
        _backup_invalid()
        _write_defaults()


def save(doc: dict[str, Any]) -> None:
    """Persist the users document to disk."""
    write_json(users_path(), doc)


# --- Internal helpers -------------------------------------------------------


def _default_copy() -> dict[str, Any]:
    return copy.deepcopy(_DEFAULT_DOCUMENT)


def _write_defaults() -> None:
    write_json(users_path(), _DEFAULT_DOCUMENT)


def _backup_invalid() -> None:
    if users_path().exists():
        ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        backup = users_path().with_name(f"users.json.bak.invalid.{ts}")
        try:
            shutil.copy2(users_path(), backup)
            logger.warning("Backed up invalid users.json to %s", backup.name)
        except Exception as exc:
            logger.warning("Could not back up users.json: %s", exc)
