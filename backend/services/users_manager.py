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

from core import user_auth_throttle, users_document
from core.exceptions import RateLimitError, UserConflictError, UserValidationError
from core.passwords import hash_password, verify_absent_user, verify_password
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
    user = find_user(document, username)
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


# --- Normalization (shared by the REST routes and runtime management) ---------

DEFAULT_ADMIN_GROUPS = ["admin"]
LOCK_KEYS = ("delete", "password", "groups")
_MAX_LANGUAGE_LENGTH = 32


def _credential_fields(item: dict, current_by_id: dict[str, dict]) -> dict[str, Any]:
    if "passwordHash" in item:
        raise UserValidationError("passwordHash is a server-managed field")
    submitted = str(item.get("password", ""))
    current = current_by_id.get(str(item.get("id", "")))
    existing_plaintext = str(current.get("password", "")) if current is not None else ""
    if current is not None and (
        submitted == ""
        or ("passwordHash" not in current and submitted == existing_plaintext)
    ):
        fields: dict[str, Any] = {"password": existing_plaintext}
        if "passwordHash" in current:
            fields["passwordHash"] = current["passwordHash"]
        return fields
    if submitted == "":
        return {"password": ""}
    if len(submitted) > 512:
        raise UserValidationError("Password must be at most 512 characters")
    return {"password": "", "passwordHash": hash_password(submitted)}


def _profile_fields(item: dict, current: dict | None, username: str) -> dict[str, Any]:
    """``language`` and ``locked``: a key the item omits keeps the stored value,
    so a writer that knows nothing of them (API v1, an older editor) never
    clears them."""
    source = item if "language" in item else (current or {})
    language = source.get("language", "")
    if not isinstance(language, str) or len(language) > _MAX_LANGUAGE_LENGTH:
        raise UserValidationError(f"User '{username}' language must be a short string")
    source = item if "locked" in item else (current or {})
    locked = source.get("locked", {})
    if not isinstance(locked, dict) or any(
        key not in LOCK_KEYS or not isinstance(value, bool) for key, value in locked.items()
    ):
        raise UserValidationError(
            f"User '{username}' locked must map {list(LOCK_KEYS)} to booleans"
        )
    fields: dict[str, Any] = {}
    if language:
        fields["language"] = language
    flags = {key: True for key in LOCK_KEYS if locked.get(key)}
    if flags:
        fields["locked"] = flags
    return fields


def normalize_users(
    users: list, group_ids: set[str], current_users: list
) -> list[dict[str, Any]]:
    current_by_id = {str(u.get("id")): u for u in current_users if isinstance(u, dict)}
    seen_ids: set[str] = set()
    seen_usernames: set[str] = set()
    normalized: list[dict[str, Any]] = []
    guest: dict[str, Any] | None = None
    for item in users:
        if not isinstance(item, dict):
            raise UserValidationError("Each user must be an object")
        user_id = require_valid_id(item.get("id"), "user id")
        username = require_valid_id(item.get("username"), "username")
        if user_id in seen_ids:
            raise UserConflictError(f"Duplicate user id: {user_id}")
        if username in seen_usernames:
            raise UserConflictError(f"Duplicate username: {username}")
        seen_ids.add(user_id)
        seen_usernames.add(username)
        groups = item.get("groups", [])
        if not isinstance(groups, list) or not groups:
            raise UserValidationError(f"User '{username}' must have at least one group")
        if not all(isinstance(group_id, str) for group_id in groups):
            raise UserValidationError(f"User '{username}' groups must be strings")
        unknown = [group_id for group_id in groups if group_id not in group_ids]
        if unknown:
            raise UserValidationError(
                f"Unknown groups for user '{username}': {unknown}"
            )
        user = {
            "id": user_id,
            "username": username,
            **_credential_fields(item, current_by_id),
            "groups": list(groups),
            **_profile_fields(item, current_by_id.get(user_id), username),
        }
        if user_id == "guest" or username == "guest":
            if user_id != "guest" or username != "guest":
                raise UserValidationError(
                    "The guest user id and username must both be 'guest'"
                )
            guest = user
        normalized.append(user)
    if guest is None:
        raise UserValidationError("Cannot remove the 'guest' user")
    if guest["groups"] != ["guest"]:
        raise UserValidationError(
            "The guest user must belong only to the 'guest' group"
        )
    if guest.get("password", "") or "passwordHash" in guest:
        raise UserValidationError("The guest user cannot have a password")
    return normalized


def known_group_ids(doc: dict[str, Any]) -> set[str]:
    return {str(g.get("id")) for g in doc.get("groups", []) if isinstance(g, dict)}


def normalize_settings(
    settings: dict[str, Any], group_ids: set[str], current: dict[str, Any]
) -> dict[str, Any]:
    """``autoLoginName`` and ``userAdminGroups``; an omitted ``userAdminGroups``
    keeps the stored one. A group that no longer exists drops out of it, so
    deleting a group never strands the document."""
    auto_login = settings.get("autoLoginName", "guest")
    if not isinstance(auto_login, str):
        raise UserValidationError("autoLoginName must be a string")
    normalized: dict[str, Any] = {"autoLoginName": auto_login}
    admin = settings["userAdminGroups"] if "userAdminGroups" in settings else current.get("userAdminGroups")
    if admin is None:
        return normalized
    if not isinstance(admin, list) or not all(isinstance(g, str) for g in admin):
        raise UserValidationError("userAdminGroups must be a list of group ids")
    if "guest" in admin:
        raise UserValidationError("The guest group cannot manage users")
    normalized["userAdminGroups"] = [g for g in dict.fromkeys(admin) if g in group_ids]
    return normalized


def require_valid_id(value: Any, label: str) -> str:
    if not valid_id(value):
        raise UserValidationError(
            f"Invalid {label}: must match [A-Za-z0-9_-], max 64 chars"
        )
    return str(value)


def admin_groups(doc: dict[str, Any]) -> list[str]:
    settings = doc.get("settings")
    groups = settings.get("userAdminGroups") if isinstance(settings, dict) else None
    return list(groups) if isinstance(groups, list) else list(DEFAULT_ADMIN_GROUPS)


def is_user_admin(doc: dict[str, Any], groups: list[str]) -> bool:
    return bool(set(groups) & set(admin_groups(doc)))


def find_user(doc: dict[str, Any], username: Any) -> dict[str, Any] | None:
    return next(
        (u for u in doc.get("users", []) if isinstance(u, dict) and u.get("username") == username),
        None,
    )


def save_users(doc: dict[str, Any], items: list) -> None:
    """Replace ``doc``'s users with ``items``, validated, and persist it."""
    doc["users"] = normalize_users(items, known_group_ids(doc), doc.get("users", []))
    state = users_document.document_state(doc)
    if not state.valid:
        raise UserValidationError(state.error or "users.json is invalid")
    save(doc)


def unchanged_user(user: dict[str, Any]) -> dict[str, Any]:
    # An empty password and omitted profile keys keep what is stored.
    return {"id": user.get("id"), "username": user.get("username"), "groups": user.get("groups"), "password": ""}


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
