"""Structural validity of a project's users document."""

from __future__ import annotations

import json
from pathlib import Path

from core import users_document
from core.passwords import hash_password

REPO_ROOT = Path(__file__).resolve().parents[2]
SEED_USERS = REPO_ROOT / "project-seed" / "users.json"


def _seed_document() -> dict:
    return json.loads(SEED_USERS.read_text(encoding="utf-8"))


def _write(tmp_path: Path, document: dict) -> Path:
    (tmp_path / "users.json").write_text(json.dumps(document), encoding="utf-8")
    return tmp_path


def test_seed_ships_no_credential_and_needs_no_setup() -> None:
    """A new project is usable the moment it is created: the seed carries no
    admin account to share a credential across installs, and nothing gates it."""
    document = _seed_document()

    assert "operatorSetup" not in document
    assert [user["username"] for user in document["users"]] == ["guest"]
    assert all("passwordHash" not in user for user in document["users"])
    assert users_document.document_state(document).valid is True


def test_seeded_project_on_disk_is_valid(tmp_path: Path) -> None:
    assert users_document.is_valid(_write(tmp_path, _seed_document())) is True


def test_missing_document_is_invalid(tmp_path: Path) -> None:
    state = users_document.state(tmp_path)

    assert state.valid is False
    assert state.error == "users.json is missing"


def test_corrupt_document_is_invalid(tmp_path: Path) -> None:
    (tmp_path / "users.json").write_text("{ not json", encoding="utf-8")

    state = users_document.state(tmp_path)

    assert state.valid is False
    assert state.error == "users.json is unreadable or corrupt"


def test_user_in_an_undeclared_group_is_invalid() -> None:
    document = _seed_document()
    document["users"][0]["groups"] = ["nonexistent"]

    assert users_document.document_state(document).valid is False


def test_leftover_config_access_setting_is_ignored(tmp_path: Path) -> None:
    """A project written before the setting was removed must keep opening: the
    key is dead weight, never a reason to refuse to start."""
    document = _seed_document()
    document["settings"]["configAccessGroups"] = ["admin", "nonexistent"]

    assert users_document.document_state(document).valid is True
    assert users_document.is_valid(_write(tmp_path, document)) is True


def test_duplicate_group_id_is_invalid() -> None:
    document = _seed_document()
    document["groups"].append(dict(document["groups"][0]))

    assert users_document.document_state(document).valid is False


def test_hash_alongside_a_plaintext_password_is_invalid() -> None:
    """A user carrying both is ambiguous about which one authenticates."""
    document = _seed_document()
    document["users"].append(
        {
            "id": "lena",
            "username": "lena",
            "password": "plaintext",
            "passwordHash": hash_password("chosen"),
            "groups": ["admin"],
        }
    )

    assert users_document.document_state(document).valid is False
