"""The profile fields (language, locked) every users.json writer keeps, and the
user-admin groups setting."""

import copy
import json
from pathlib import Path

import pytest
import services.users_manager as users_manager_module
from core.exceptions import UserValidationError
from core.passwords import hash_password
from services.users_manager import _DEFAULT_DOCUMENT, load


@pytest.fixture()
def users_file(tmp_path, monkeypatch) -> Path:
    doc = copy.deepcopy(_DEFAULT_DOCUMENT)
    doc["users"] += [
        {"id": "boss", "username": "boss", "password": "", "passwordHash": hash_password("boss-pass"), "groups": ["admin"], "language": "nl"},
        {
            "id": "op", "username": "op", "password": "", "passwordHash": hash_password("op-pass"),
            "groups": ["operator"], "locked": {"password": True, "groups": True},
        },
        {
            "id": "svc", "username": "svc", "password": "", "passwordHash": hash_password("svc-pass"),
            "groups": ["admin"], "locked": {"delete": True},
        },
    ]
    path = tmp_path / "users.json"
    path.write_text(json.dumps(doc))
    monkeypatch.setattr(users_manager_module, "users_path", lambda: path)
    return path


def test_rest_writes_keep_profile_fields_they_omit(users_file):
    doc = load()
    current = doc["users"]
    items = [{"id": u["id"], "username": u["username"], "groups": u["groups"], "password": ""} for u in doc["users"]]
    users = users_manager_module.normalize_users(items, users_manager_module.known_group_ids(doc), current)
    op = next(u for u in users if u["id"] == "op")
    assert op["locked"] == {"password": True, "groups": True}
    assert next(u for u in users if u["id"] == "boss")["language"] == "nl"
    # Present keys set them; empty values clear them.
    items[2] = {**items[2], "locked": {}, "language": ""}
    cleared = users_manager_module.normalize_users(items, users_manager_module.known_group_ids(doc), current)[2]
    assert "locked" not in cleared and "language" not in cleared


def test_admin_groups_setting(users_file):
    doc = load()
    assert users_manager_module.admin_groups(doc) == ["admin"]
    settings = users_manager_module.normalize_settings(
        {"autoLoginName": "guest", "userAdminGroups": ["engineer", "gone"]}, {"guest", "engineer"}, {}
    )
    assert settings == {"autoLoginName": "guest", "userAdminGroups": ["engineer"]}
    with pytest.raises(UserValidationError):
        users_manager_module.normalize_settings({"userAdminGroups": ["guest"]}, {"guest"}, {})
