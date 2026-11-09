"""REST API for user and group management."""

from collections.abc import AsyncIterator
from typing import Any

from core import users_document
from core.exceptions import UserConflictError, UserNotFoundError, UserValidationError
from core.passwords import has_password
from fastapi import APIRouter, Body, Depends, Request
from services import users_manager

from api.change_broadcast import broadcasts


async def _refresh_identities_after_write(request: Request) -> AsyncIterator[None]:
    # Skipped when the handler raises. The same refresh API v1 writes reach
    # through the reload hook, so a deleted or regrouped user is signed out or
    # regrouped on every connection of this instance.
    yield
    if request.method not in ("GET", "HEAD"):
        from services.websocket_manager import websocket_manager

        await websocket_manager.refresh_identities()


router = APIRouter(
    prefix="/api/users",
    tags=["users"],
    dependencies=[Depends(_refresh_identities_after_write), broadcasts("users")],
)


# ── Helpers ────────────────────────────────────────────────────────────────


def _redact_document(document: dict[str, Any]) -> dict[str, Any]:
    """Strip stored credentials from every account, keeping ``passwordSet``.

    The editor needs ``passwordSet`` to render the "(unchanged)" vs
    "(no password)" placeholder.
    """
    redacted = dict(document)
    # The editor shows the groups in effect, not an absent key.
    known = users_manager.known_group_ids(document)
    redacted["settings"] = {
        "userAdminGroups": [g for g in users_manager.admin_groups(document) if g in known],
        **document.get("settings", {}),
    }
    redacted["users"] = [
        {
            **{key: value for key, value in user.items() if key != "passwordHash"},
            "password": "",
            # The same test sign-in makes: an unusable stored hash is not a
            # password set, or the editor would show a credential nobody can
            # present as configured.
            "passwordSet": has_password(user),
        }
        for user in document.get("users", [])
        if isinstance(user, dict)
    ]
    return redacted


def _require_valid_users_document(document: dict[str, Any]) -> None:
    users_state = users_document.document_state(document)
    if not users_state.valid:
        raise UserValidationError(users_state.error or "users.json is invalid")


# ── Endpoints ──────────────────────────────────────────────────────────────


@router.get("")
def get_users() -> dict:
    """Return the users document with stored credentials redacted.

    Editor only: the manager gates it; the live view reads ``/roster``.
    """
    return _redact_document(users_manager.load())


@router.get("/roster")
def get_roster() -> dict:
    """Usernames and group labels — all the live view needs, with no session.

    Public on the manager's runtime allowlist for the sign-in dropdown
    (``$user`` → All users) and the group picker (``$user`` → Groups). Who
    belongs to which group stays behind the session: the signed-in user's own
    groups reach the live view over the WebSocket identity.
    """
    document = users_manager.load()
    return {
        "users": [
            {"id": user.get("id"), "username": user.get("username")}
            for user in document.get("users", [])
            if isinstance(user, dict)
        ],
        "groups": group_entries(document),
    }


def group_entries(document: dict) -> list[dict[str, Any]]:
    """Each group as ``{id, label}``, the label falling back to the id."""
    return [
        {"id": group.get("id"), "label": group.get("label", group.get("id"))}
        for group in document.get("groups", [])
        if isinstance(group, dict)
    ]


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
        group_id = users_manager.require_valid_id(item.get("id"), "group id")
        if group_id in seen_group_ids:
            raise UserConflictError(f"Duplicate group id: {group_id}")
        seen_group_ids.add(group_id)
        normalized_groups.append(
            {"id": group_id, "label": str(item.get("label", group_id))}
        )
    if "guest" not in seen_group_ids:
        raise UserValidationError("Cannot remove the 'guest' group")

    current = users_manager.load()
    normalized_settings = users_manager.normalize_settings(
        settings, seen_group_ids, current.get("settings", {})
    )
    normalized_users = users_manager.normalize_users(
        users, seen_group_ids, current.get("users", [])
    )

    document = {
        "settings": normalized_settings,
        "groups": normalized_groups,
        "users": normalized_users,
    }
    _require_valid_users_document(document)
    users_manager.save(document)
    return _redact_document(document)


@router.put("/settings")
def put_settings(body: dict) -> dict:
    """Replace the settings section."""
    doc = users_manager.load()
    doc["settings"] = users_manager.normalize_settings(
        body, users_manager.known_group_ids(doc), doc.get("settings", {})
    )
    _require_valid_users_document(doc)
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
        gid = users_manager.require_valid_id(item.get("id"), "group id")
        if gid in seen_ids:
            raise UserConflictError(f"Duplicate group id: {gid}")
        seen_ids.add(gid)

    if "guest" not in seen_ids:
        raise UserValidationError("Cannot remove the 'guest' group")

    doc = users_manager.load()
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
    _require_valid_users_document(doc)
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
    _require_valid_users_document(doc)
    users_manager.save(doc)
    return {"deleted": group_id}


@router.put("/users")
def put_users(body: list = Body(...)) -> list:
    """Replace the full users list."""
    if not isinstance(body, list):
        raise UserValidationError("Body must be a list of users")

    doc = users_manager.load()
    users_manager.save_users(doc, body)
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
    _require_valid_users_document(doc)
    users_manager.save(doc)
    return {"deleted": user_id}
