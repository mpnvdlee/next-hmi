"""Per-project first-run operator credential setup."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from core.exceptions import ConflictError, ValidationError
from core.passwords import hash_password, is_valid_hash
from core.storage import read_json, write_json
from core.validation import is_valid_user_id

SETUP_FIELD = "operatorSetup"
SETUP_VERSION = 1

_lock = threading.RLock()


class SetupStatus(str, Enum):  # noqa: UP042 -- switching to enum.StrEnum changes str()/repr() formatting (behavior change), not a mechanical rewrite
    REQUIRED = "required"
    COMPLETE = "complete"
    ERROR = "error"


@dataclass(frozen=True)
class SetupState:
    status: SetupStatus
    error: str | None = None


def state(project_root: Path) -> SetupState:
    """Read setup state without ever repairing or replacing project data."""
    try:
        document = read_json(project_root / "users.json")
    except FileNotFoundError:
        return SetupState(SetupStatus.ERROR, "users.json is missing")
    except (OSError, ValueError):
        return SetupState(SetupStatus.ERROR, "users.json is unreadable or corrupt")
    return document_state(document)


def is_required(project_root: Path) -> bool:
    return state(project_root).status is SetupStatus.REQUIRED


def complete(project_root: Path, password: str) -> dict[str, Any]:
    """Atomically create the initial admin user and consume the setup marker."""
    if not password:
        raise ValidationError("Operator password must not be empty")
    if len(password) > 512:
        raise ValidationError("Operator password must be at most 512 characters")

    users_path = project_root / "users.json"
    with _lock:
        try:
            document = read_json(users_path)
        except FileNotFoundError as exc:
            raise ValidationError(
                "Cannot complete setup: users.json is missing"
            ) from exc
        except (OSError, ValueError) as exc:
            raise ValidationError(
                "Cannot complete setup: users.json is unreadable or corrupt"
            ) from exc

        setup_state = document_state(document)
        if setup_state.status is SetupStatus.ERROR:
            raise ValidationError(f"Cannot complete setup: {setup_state.error}")
        if setup_state.status is not SetupStatus.REQUIRED:
            raise ConflictError("Operator setup is already complete for this project")

        users = document.get("users")
        assert isinstance(users, list)
        if any(
            isinstance(user, dict)
            and (user.get("id") == "admin" or user.get("username") == "admin")
            for user in users
        ):
            raise ConflictError(
                "The admin operator already exists; setup cannot be replayed"
            )

        completed = dict(document)
        completed["users"] = [
            *users,
            {
                "id": "admin",
                "username": "admin",
                "password": "",
                "passwordHash": hash_password(password),
                "groups": ["guest", "admin"],
            },
        ]
        completed[SETUP_FIELD] = {"version": SETUP_VERSION, "required": False}
        write_json(users_path, completed)
        return completed


def document_state(document: Any) -> SetupState:
    """Classify an already-loaded users document without mutating it."""
    if not isinstance(document, dict):
        return SetupState(SetupStatus.ERROR, "users.json is invalid")
    if not isinstance(document.get("settings"), dict):
        return SetupState(SetupStatus.ERROR, "users.json is invalid")
    if not isinstance(document.get("groups"), list):
        return SetupState(SetupStatus.ERROR, "users.json is invalid")
    if not isinstance(document.get("users"), list):
        return SetupState(SetupStatus.ERROR, "users.json is invalid")
    group_ids: set[str] = set()
    for group in document["groups"]:
        if not isinstance(group, dict) or not is_valid_user_id(group.get("id", "")):
            return SetupState(SetupStatus.ERROR, "users.json is invalid")
        group_id = str(group["id"])
        if group_id in group_ids:
            return SetupState(SetupStatus.ERROR, "users.json is invalid")
        group_ids.add(group_id)

    config_groups = document["settings"].get("configAccessGroups", [])
    if (
        not isinstance(config_groups, list)
        or not all(isinstance(group_id, str) for group_id in config_groups)
        or any(group_id not in group_ids for group_id in config_groups)
    ):
        return SetupState(SetupStatus.ERROR, "users.json is invalid")

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
            return SetupState(SetupStatus.ERROR, "users.json is invalid")
        if user["id"] in user_ids or user["username"] in usernames:
            return SetupState(SetupStatus.ERROR, "users.json is invalid")
        if "passwordHash" in user and (
            user.get("password", "") != "" or not is_valid_hash(user["passwordHash"])
        ):
            return SetupState(SetupStatus.ERROR, "users.json is invalid")
        user_ids.add(user["id"])
        usernames.add(user["username"])

    if SETUP_FIELD not in document:
        return SetupState(SetupStatus.COMPLETE)
    marker = document[SETUP_FIELD]
    if not isinstance(marker, dict):
        return SetupState(SetupStatus.ERROR, "operator setup marker is invalid")
    if marker.get("version") != SETUP_VERSION or not isinstance(
        marker.get("required"), bool
    ):
        return SetupState(SetupStatus.ERROR, "operator setup marker is invalid")
    if not {"guest", "admin"}.issubset(group_ids):
        return SetupState(SetupStatus.ERROR, "operator setup groups are invalid")
    guest = next(
        (
            user
            for user in document["users"]
            if user.get("id") == "guest" or user.get("username") == "guest"
        ),
        None,
    )
    if (
        guest is None
        or guest.get("id") != "guest"
        or guest.get("username") != "guest"
        or guest.get("groups") != ["guest"]
        or guest.get("password", "") != ""
        or "passwordHash" in guest
    ):
        return SetupState(SetupStatus.ERROR, "operator setup guest is invalid")

    admin = next(
        (
            user
            for user in document["users"]
            if user.get("id") == "admin" or user.get("username") == "admin"
        ),
        None,
    )
    if marker["required"]:
        if admin is not None:
            return SetupState(
                SetupStatus.ERROR, "pending operator setup has an admin user"
            )
        return SetupState(SetupStatus.REQUIRED)
    if (
        admin is None
        or admin.get("id") != "admin"
        or admin.get("username") != "admin"
        or "admin" not in admin.get("groups", [])
        or admin.get("password", "") != ""
        or not is_valid_hash(admin.get("passwordHash"))
    ):
        return SetupState(
            SetupStatus.ERROR, "completed operator setup admin is invalid"
        )
    return SetupState(SetupStatus.COMPLETE)
