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
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from core import user_auth_throttle, users_document
from core.exceptions import RateLimitError, UserConflictError, UserValidationError
from core.passwords import hash_password, verify_absent_user, verify_password
from core.storage import active_project_root, read_json, write_json
from core.validation import USER_ID_MAX_LEN, is_valid_user_id

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


async def authenticate(
    username: Any, password: Any, address: str | None
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Resolve one project-user identity using the shared password verifier.

    The single funnel every credential path runs through — the WebSocket
    ``login`` message and the REST Basic routes alike — so the throttle and the
    constant-cost miss below cover all of them at once. *address* is the
    caller's client address, which the throttle meters on its own.

    Raises ``RateLimitError`` (HTTP 429) while this username, this address, or
    the whole credential path, is locked out. Returns ``None`` for a credential
    that does not authenticate, including every account with no password set.
    """
    if not isinstance(username, str) or not isinstance(password, str):
        return None
    # No username is longer, so a cut one still names nobody, and a 64 KiB one
    # cannot make the throttle's tables large.
    name = username[: USER_ID_MAX_LEN + 1]
    async with _one_check_at_a_time(name):
        remaining = user_auth_throttle.begin_attempt(name, address)
        if remaining > 0:
            raise RateLimitError(
                f"Too many failed sign-in attempts. Try again in {int(remaining) + 1}s."
            )
        authenticated = await _verify(username, password)
        if authenticated is not None:
            user_auth_throttle.register_login_success(name, address)
        return authenticated


@dataclass
class _Check:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    users: int = 0  # holding or waiting on the lock


_checks: dict[str, _Check] = {}


@asynccontextmanager
async def _one_check_at_a_time(name: str) -> AsyncIterator[None]:
    """Serialise the checks of one username, so parallel right passwords queue
    rather than meet the lockout their own admission counted. A name's lock
    lives only while someone holds or waits on it."""
    check = _checks.setdefault(name, _Check())
    check.users += 1
    try:
        async with check.lock:
            yield
    finally:
        check.users -= 1
        if not check.users:
            del _checks[name]


async def _verify(username: str, password: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
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
        return None
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


# --- Runtime user management --------------------------------------------------
#
# What a signed-in HMI user may do over the WebSocket. Every check runs here,
# against the identity the server holds for the socket, never a claim the
# message makes: the runtime socket is on the public prefix.


class UserActionRefused(Exception):
    """A runtime user action the server refuses; ``reason`` goes to ``$result``."""

    def __init__(self, reason: str, message: str = "") -> None:
        super().__init__(message or reason)
        self.reason = reason


# Load-modify-save of users.json from concurrent sockets.
_runtime_lock = threading.Lock()


def account_list(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Every account as the runtime's ``$user`` → Accounts shows it — admins only."""
    return [
        {
            "username": user["username"],
            "groups": list(user.get("groups", [])),
            "language": user.get("language", ""),
            "locked": {key: bool(user.get("locked", {}).get(key)) for key in LOCK_KEYS},
        }
        for user in doc.get("users", [])
        if isinstance(user, dict) and isinstance(user.get("username"), str)
    ]


def _load_for_write() -> dict[str, Any]:
    # Not load(): it falls back to defaults on a broken file, and saving that
    # would replace whatever the operator still has to repair.
    try:
        doc = read_json(users_path())
    except (OSError, ValueError) as exc:
        raise UserActionRefused("unavailable", "users.json is unreadable") from exc
    state = users_document.document_state(doc)
    if not state.valid:
        raise UserActionRefused("unavailable", state.error or "users.json is invalid")
    return doc


def _require_admin(doc: dict[str, Any], actor: dict[str, Any]) -> None:
    if not is_user_admin(doc, list(actor.get("groups", []))):
        raise UserActionRefused("forbidden", "Not in a user-admin group")


def update_user(
    actor: dict[str, Any], username: Any, groups: Any, password: Any, language: Any
) -> dict[str, Any]:
    """Create or update one account. An empty field leaves that part unchanged;
    a new account needs groups and a password. Blocking: hashes a password."""
    if not isinstance(username, str) or not valid_id(username):
        raise UserActionRefused("invalid", "Invalid username")
    group_list = [g.strip() for g in groups.split(",") if g.strip()] if isinstance(groups, str) else []
    password = password if isinstance(password, str) else ""
    language = language if isinstance(language, str) else ""
    with _runtime_lock:
        doc = _load_for_write()
        _require_admin(doc, actor)
        target = find_user(doc, username)
        locked = target.get("locked", {}) if target else {}
        if target is None and (not group_list or not password):
            raise UserActionRefused("invalid", "A new user needs groups and a password")
        if (
            target is not None
            and group_list
            and set(group_list) != set(target.get("groups", []))
            and locked.get("groups")
        ):
            raise UserActionRefused("locked", "This user's groups are locked")
        if password and locked.get("password"):
            raise UserActionRefused("locked", "This user's password is locked")
        if (
            username == actor.get("username")
            and group_list
            and not is_user_admin(doc, group_list)
        ):
            raise UserActionRefused("forbidden", "You cannot remove your own user-admin rights")
        submitted: dict[str, Any] = {
            "id": target.get("id") if target else username,
            "username": username,
            "groups": group_list or (target or {}).get("groups"),
            "password": password,
        }
        if language:
            submitted["language"] = language
        items = [submitted if u is target else unchanged_user(u) for u in doc.get("users", [])]
        if target is None:
            items.append(submitted)
        save_users(doc, items)
    return {"username": username, "created": target is None}


def delete_user(actor: dict[str, Any], username: Any) -> dict[str, Any]:
    with _runtime_lock:
        doc = _load_for_write()
        _require_admin(doc, actor)
        target = find_user(doc, username)
        if target is None:
            raise UserActionRefused("not_found", "No such user")
        if username == "guest":
            raise UserActionRefused("invalid", "The guest user cannot be deleted")
        if username == actor.get("username"):
            raise UserActionRefused("forbidden", "You cannot delete yourself")
        if target.get("locked", {}).get("delete"):
            raise UserActionRefused("locked", "This user cannot be deleted")
        save_users(doc, [unchanged_user(u) for u in doc["users"] if u is not target])
    return {"username": username}


async def change_own_password(
    actor: dict[str, Any], current_password: Any, new_password: Any, address: str | None
) -> dict[str, Any]:
    """The signed-in user's own password, proven with the current one.

    *address* is the caller's client address, metered by the sign-in throttle."""
    username = actor.get("username")
    if not isinstance(username, str) or username == "guest":
        raise UserActionRefused("forbidden", "Sign in first")
    if not isinstance(new_password, str) or not new_password:
        raise UserActionRefused("invalid", "The new password is empty")
    # The sign-in funnel: same throttle, same constant-cost miss.
    if await authenticate(username, current_password, address) is None:
        raise UserActionRefused("wrong_password", "The current password is wrong")

    def write() -> None:
        with _runtime_lock:
            doc = _load_for_write()
            user = find_user(doc, username)
            if user is None:
                raise UserActionRefused("not_found", "No such user")
            if user.get("locked", {}).get("password"):
                raise UserActionRefused("locked", "This user's password is locked")
            save_users(
                doc,
                [{**unchanged_user(u), "password": new_password} if u is user else unchanged_user(u) for u in doc["users"]],
            )

    await asyncio.to_thread(write)
    return {"username": username}


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
