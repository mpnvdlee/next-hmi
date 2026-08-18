"""REST API for user and group management."""

from typing import Any

from core import operator_setup
from core.exceptions import UserConflictError, UserNotFoundError, UserValidationError
from core.passwords import hash_password
from fastapi import APIRouter, Body
from services import users_manager

router = APIRouter(prefix="/api/users", tags=["users"])


# ── Helpers ────────────────────────────────────────────────────────────────


def _require_valid_id(value: Any, label: str) -> str:
    if not users_manager.valid_id(value):
        raise UserValidationError(
            f"Invalid {label}: must match [A-Za-z0-9_-], max 64 chars"
        )
    return str(value)


def _redact_document(document: dict[str, Any]) -> dict[str, Any]:
    redacted = dict(document)
    redacted["users"] = [
        {
            **{key: value for key, value in user.items() if key != "passwordHash"},
            "password": "",
            "passwordSet": bool(user.get("password", "")) or "passwordHash" in user,
        }
        for user in document.get("users", [])
        if isinstance(user, dict)
    ]
    return redacted


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


def _normalize_users(
    users: list, group_ids: set[str], current_by_id: dict[str, dict]
) -> list[dict[str, Any]]:
    seen_ids: set[str] = set()
    seen_usernames: set[str] = set()
    normalized: list[dict[str, Any]] = []
    guest: dict[str, Any] | None = None
    for item in users:
        if not isinstance(item, dict):
            raise UserValidationError("Each user must be an object")
        user_id = _require_valid_id(item.get("id"), "user id")
        username = _require_valid_id(item.get("username"), "username")
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


def _require_valid_setup_document(document: dict[str, Any]) -> None:
    setup_state = operator_setup.document_state(document)
    if setup_state.status is operator_setup.SetupStatus.ERROR:
        raise UserValidationError(setup_state.error or "users.json is invalid")


# ── Endpoints ──────────────────────────────────────────────────────────────


@router.get("")
def get_users() -> dict:
    """Return the users document with stored credentials redacted."""
    return _redact_document(users_manager.load())


@router.put("")
def put_users_document(body: dict = Body(...)) -> dict:
    """Validate and atomically replace the full users document."""
    settings = body.get("settings")
    groups = body.get("groups")
    users = body.get("users")
    if not isinstance(settings, dict):
        raise UserValidationError("settings must be an object")
    if not isinstance(groups, list):
        raise UserValidationError("groups must be a list")
    if not isinstance(users, list):
        raise UserValidationError("users must be a list")

    seen_group_ids: set[str] = set()
    normalized_groups: list[dict[str, str]] = []
    for item in groups:
        if not isinstance(item, dict):
            raise UserValidationError("Each group must be an object")
        group_id = _require_valid_id(item.get("id"), "group id")
        if group_id in seen_group_ids:
            raise UserConflictError(f"Duplicate group id: {group_id}")
        seen_group_ids.add(group_id)
        normalized_groups.append(
            {"id": group_id, "label": str(item.get("label", group_id))}
        )
    if "guest" not in seen_group_ids:
        raise UserValidationError("Cannot remove the 'guest' group")

    auto_login = settings.get("autoLoginName", "guest")
    config_groups = settings.get("configAccessGroups", [])
    if not isinstance(auto_login, str):
        raise UserValidationError("autoLoginName must be a string")
    if not isinstance(config_groups, list) or not all(
        isinstance(g, str) for g in config_groups
    ):
        raise UserValidationError("configAccessGroups must be a list of strings")
    unknown_config_groups = [
        group_id for group_id in config_groups if group_id not in seen_group_ids
    ]
    if unknown_config_groups:
        raise UserValidationError(
            f"Unknown groups in configAccessGroups: {unknown_config_groups}"
        )

    current = users_manager.load()
    current_by_id = {
        str(user.get("id")): user
        for user in current.get("users", [])
        if isinstance(user, dict)
    }
    normalized_users = _normalize_users(users, seen_group_ids, current_by_id)

    document = {
        "settings": {
            "autoLoginName": auto_login,
            "configAccessGroups": list(config_groups),
        },
        "groups": normalized_groups,
        "users": normalized_users,
    }
    if "operatorSetup" in current:
        document["operatorSetup"] = current["operatorSetup"]
    _require_valid_setup_document(document)
    users_manager.save(document)
    return _redact_document(document)


@router.put("/settings")
def put_settings(body: dict) -> dict:
    """Replace the settings section."""
    auto_login = body.get("autoLoginName", "guest")
    config_groups = body.get("configAccessGroups", [])

    if not isinstance(auto_login, str):
        raise UserValidationError("autoLoginName must be a string")
    if not isinstance(config_groups, list) or not all(
        isinstance(g, str) for g in config_groups
    ):
        raise UserValidationError("configAccessGroups must be a list of strings")

    doc = users_manager.load()

    existing_ids = {g["id"] for g in doc.get("groups", []) if isinstance(g, dict)}
    unknown = [g for g in config_groups if g not in existing_ids]
    if unknown:
        raise UserValidationError(f"Unknown groups in configAccessGroups: {unknown}")

    doc["settings"] = {"autoLoginName": auto_login, "configAccessGroups": config_groups}
    _require_valid_setup_document(doc)
    users_manager.save(doc)
    return doc["settings"]


@router.put("/groups")
def put_groups(body: list = Body(...)) -> list:
    """Replace the full groups list."""
    if not isinstance(body, list):
        raise UserValidationError("Body must be a list of groups")

    seen_ids: set[str] = set()
    for item in body:
        if not isinstance(item, dict):
            raise UserValidationError("Each group must be an object")
        gid = _require_valid_id(item.get("id"), "group id")
        if gid in seen_ids:
            raise UserConflictError(f"Duplicate group id: {gid}")
        seen_ids.add(gid)

    if "guest" not in seen_ids:
        raise UserValidationError("Cannot remove the 'guest' group")

    doc = users_manager.load()
    config_groups = doc.get("settings", {}).get("configAccessGroups", [])
    unknown_config = [
        group_id for group_id in config_groups if group_id not in seen_ids
    ]
    if unknown_config:
        raise UserValidationError(
            f"Groups are still used by config access: {unknown_config}"
        )
    referenced = sorted(
        {
            group_id
            for user in doc.get("users", [])
            if isinstance(user, dict)
            for group_id in user.get("groups", [])
            if group_id not in seen_ids
        }
    )
    if referenced:
        raise UserValidationError(f"Groups are still used by users: {referenced}")
    doc["groups"] = [
        {"id": g["id"], "label": str(g.get("label", g["id"]))} for g in body
    ]
    _require_valid_setup_document(doc)
    users_manager.save(doc)
    return doc["groups"]


@router.delete("/groups/{group_id}")
def delete_group(group_id: str) -> dict:
    """Remove a group by ID. 'guest' cannot be deleted."""
    if group_id == "guest":
        raise UserValidationError("Cannot delete the 'guest' group")

    doc = users_manager.load()
    original = doc.get("groups", [])
    updated = [g for g in original if isinstance(g, dict) and g.get("id") != group_id]
    if len(updated) == len(original):
        raise UserNotFoundError(f"Group '{group_id}' not found")

    doc["groups"] = updated
    _require_valid_setup_document(doc)
    users_manager.save(doc)
    return {"deleted": group_id}


@router.put("/users")
def put_users(body: list = Body(...)) -> list:
    """Replace the full users list."""
    if not isinstance(body, list):
        raise UserValidationError("Body must be a list of users")

    doc = users_manager.load()
    current_by_id = {
        str(user.get("id")): user
        for user in doc.get("users", [])
        if isinstance(user, dict)
    }
    group_ids = {
        str(group.get("id"))
        for group in doc.get("groups", [])
        if isinstance(group, dict)
    }
    doc["users"] = _normalize_users(body, group_ids, current_by_id)
    _require_valid_setup_document(doc)
    users_manager.save(doc)
    return _redact_document(doc)["users"]


@router.delete("/users/{user_id}")
def delete_user(user_id: str) -> dict:
    """Remove a user by ID. 'guest' cannot be deleted."""
    doc = users_manager.load()
    original = doc.get("users", [])
    target = next(
        (
            user
            for user in original
            if isinstance(user, dict) and user.get("id") == user_id
        ),
        None,
    )
    if target is not None and (
        target.get("id") == "guest" or target.get("username") == "guest"
    ):
        raise UserValidationError("Cannot delete the 'guest' user")
    updated = [u for u in original if isinstance(u, dict) and u.get("id") != user_id]
    if len(updated) == len(original):
        raise UserNotFoundError(f"User '{user_id}' not found")

    doc["users"] = updated
    _require_valid_setup_document(doc)
    users_manager.save(doc)
    return {"deleted": user_id}
