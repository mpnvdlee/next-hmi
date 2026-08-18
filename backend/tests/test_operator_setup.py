"""Fresh-project operator credential setup state and atomic completion."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from core import operator_setup
from core.exceptions import ConflictError
from core.passwords import hash_password, is_valid_hash, verify_password

REPO_ROOT = Path(__file__).resolve().parents[2]
SEED_USERS = REPO_ROOT / "project-seed" / "users.json"


def _seed_document() -> dict:
    return json.loads(SEED_USERS.read_text(encoding="utf-8"))


def test_fresh_seed_requires_setup_and_has_no_admin_credential() -> None:
    document = _seed_document()

    assert document["operatorSetup"] == {"version": 1, "required": True}
    assert [user["username"] for user in document["users"]] == ["guest"]
    assert all(user.get("password") != "admin" for user in document["users"])


def test_interrupted_setup_leaves_project_incomplete(
    monkeypatch, tmp_path: Path
) -> None:
    users_path = tmp_path / "users.json"
    original = _seed_document()
    users_path.write_text(json.dumps(original), encoding="utf-8")

    def fail_write(_path: Path, _document: dict) -> None:
        raise OSError("simulated interruption before atomic replace")

    monkeypatch.setattr(operator_setup, "write_json", fail_write)

    with pytest.raises(OSError, match="simulated interruption"):
        operator_setup.complete(tmp_path, "chosen-password")

    assert json.loads(users_path.read_text(encoding="utf-8")) == original
    assert operator_setup.is_required(tmp_path) is True


def test_completed_setup_survives_restart_and_cannot_be_replayed(
    tmp_path: Path,
) -> None:
    users_path = tmp_path / "users.json"
    users_path.write_text(json.dumps(_seed_document()), encoding="utf-8")

    operator_setup.complete(tmp_path, "chosen-password")

    persisted = json.loads(users_path.read_text(encoding="utf-8"))
    assert persisted["operatorSetup"] == {"version": 1, "required": False}
    admin = next(user for user in persisted["users"] if user["username"] == "admin")
    assert admin["id"] == "admin"
    assert admin["groups"] == ["guest", "admin"]
    assert admin["password"] != "chosen-password"
    assert admin["password"] == ""
    assert is_valid_hash(admin["passwordHash"]) is True
    assert verify_password(admin, "chosen-password") is True
    assert operator_setup.is_required(tmp_path) is False

    with pytest.raises(ConflictError, match="already complete"):
        operator_setup.complete(tmp_path, "replacement-password")
    assert json.loads(users_path.read_text(encoding="utf-8")) == persisted


def test_existing_project_upgrade_preserves_credentials_unchanged(
    tmp_path: Path,
) -> None:
    users_path = tmp_path / "users.json"
    existing = _seed_document()
    existing.pop("operatorSetup")
    existing["users"].append(
        {
            "id": "site-admin",
            "username": "site_admin",
            "password": "existing-secret",
            "groups": ["admin"],
        }
    )
    users_path.write_text(json.dumps(existing), encoding="utf-8")
    before = users_path.read_bytes()

    assert operator_setup.is_required(tmp_path) is False
    with pytest.raises(ConflictError, match="already complete"):
        operator_setup.complete(tmp_path, "new-secret")

    assert users_path.read_bytes() == before


def test_setup_state_is_independent_per_project(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    (first / "users.json").write_text(json.dumps(_seed_document()), encoding="utf-8")
    (second / "users.json").write_text(json.dumps(_seed_document()), encoding="utf-8")

    operator_setup.complete(first, "first-password")

    assert operator_setup.is_required(first) is False
    assert operator_setup.is_required(second) is True


def test_missing_users_document_is_error(tmp_path: Path) -> None:
    setup_state = operator_setup.state(tmp_path)

    assert setup_state.status is operator_setup.SetupStatus.ERROR
    assert setup_state.error == "users.json is missing"


def test_corrupt_users_document_is_error(tmp_path: Path) -> None:
    (tmp_path / "users.json").write_text("{not-json", encoding="utf-8")

    setup_state = operator_setup.state(tmp_path)

    assert setup_state.status is operator_setup.SetupStatus.ERROR
    assert setup_state.error == "users.json is unreadable or corrupt"


def test_invalid_users_schema_is_error(tmp_path: Path) -> None:
    (tmp_path / "users.json").write_text(
        json.dumps({"settings": {}, "groups": [], "users": [{"username": "bad user"}]}),
        encoding="utf-8",
    )

    setup_state = operator_setup.state(tmp_path)
    assert setup_state.status is operator_setup.SetupStatus.ERROR
    assert setup_state.error == "users.json is invalid"


def test_unreadable_users_document_is_error(monkeypatch, tmp_path: Path) -> None:
    def deny_read(_path: Path):
        raise PermissionError("denied")

    monkeypatch.setattr(operator_setup, "read_json", deny_read)

    setup_state = operator_setup.state(tmp_path)
    assert setup_state.status is operator_setup.SetupStatus.ERROR
    assert setup_state.error == "users.json is unreadable or corrupt"


@pytest.mark.parametrize(
    "marker",
    [
        None,
        "required",
        {"version": 99, "required": True},
        {"version": 1, "required": "yes"},
    ],
)
def test_invalid_setup_marker_is_error(tmp_path: Path, marker: object) -> None:
    document = _seed_document()
    document["operatorSetup"] = marker
    (tmp_path / "users.json").write_text(json.dumps(document), encoding="utf-8")

    setup_state = operator_setup.state(tmp_path)
    assert setup_state.status is operator_setup.SetupStatus.ERROR
    assert setup_state.error == "operator setup marker is invalid"


@pytest.mark.parametrize("missing_group", ["guest", "admin"])
def test_marker_requires_seed_groups(tmp_path: Path, missing_group: str) -> None:
    document = _seed_document()
    document["groups"] = [
        group for group in document["groups"] if group["id"] != missing_group
    ]
    (tmp_path / "users.json").write_text(json.dumps(document), encoding="utf-8")

    assert operator_setup.state(tmp_path).status is operator_setup.SetupStatus.ERROR


def test_marker_requires_canonical_guest(tmp_path: Path) -> None:
    document = _seed_document()
    document["users"] = []
    (tmp_path / "users.json").write_text(json.dumps(document), encoding="utf-8")

    setup_state = operator_setup.state(tmp_path)
    assert setup_state.status is operator_setup.SetupStatus.ERROR
    assert setup_state.error == "operator setup guest is invalid"


def test_completed_marker_requires_admin(tmp_path: Path) -> None:
    document = _seed_document()
    document["operatorSetup"]["required"] = False
    (tmp_path / "users.json").write_text(json.dumps(document), encoding="utf-8")

    setup_state = operator_setup.state(tmp_path)
    assert setup_state.status is operator_setup.SetupStatus.ERROR
    assert setup_state.error == "completed operator setup admin is invalid"


@pytest.mark.parametrize(
    "admin",
    [
        {
            "id": "admin",
            "username": "admin",
            "password": "",
            "passwordHash": {"version": 1},
            "groups": ["admin"],
        },
        {
            "id": "admin",
            "username": "admin",
            "password": "plaintext-is-not-valid-with-a-hash",
            "passwordHash": hash_password("secret"),
            "groups": ["admin"],
        },
        {
            "id": "admin",
            "username": "admin",
            "password": "",
            "passwordHash": hash_password("secret"),
            "groups": ["missing"],
        },
        {
            "id": "admin",
            "username": "admin",
            "password": "",
            "passwordHash": hash_password("secret"),
            "groups": ["guest"],
        },
    ],
)
def test_completed_marker_rejects_invalid_admin_credentials_or_group_refs(
    tmp_path: Path, admin: dict
) -> None:
    document = _seed_document()
    document["operatorSetup"]["required"] = False
    document["users"].append(admin)
    (tmp_path / "users.json").write_text(json.dumps(document), encoding="utf-8")

    assert operator_setup.state(tmp_path).status is operator_setup.SetupStatus.ERROR


def test_markerless_prefix_like_legacy_password_is_compatible(tmp_path: Path) -> None:
    document = _seed_document()
    document.pop("operatorSetup")
    legacy_password = "$nexthmi$pbkdf2-sha256$v1$literal-plaintext"
    document["users"].append(
        {
            "id": "legacy",
            "username": "legacy",
            "password": legacy_password,
            "groups": ["admin"],
        }
    )
    users_path = tmp_path / "users.json"
    users_path.write_text(json.dumps(document), encoding="utf-8")
    before = users_path.read_bytes()

    assert operator_setup.state(tmp_path).status is operator_setup.SetupStatus.COMPLETE
    assert users_path.read_bytes() == before
