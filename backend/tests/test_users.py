"""Tests for users_manager and users_api."""

import asyncio
import copy
import json
from datetime import UTC
from pathlib import Path
from typing import Any

import pytest
import services.users_manager as users_manager_module
from conftest import FakeWebSocket
from core.passwords import hash_password, is_valid_hash, verify_password
from services.users_manager import (
    _DEFAULT_DOCUMENT,
    load,
    load_or_create,
    save,
    valid_id,
)
from services.websocket_manager import WebSocketManager

# ─── users_manager unit tests ───────────────────────────────────────────────


def _make_doc(**overrides) -> dict[str, Any]:
    doc = copy.deepcopy(_DEFAULT_DOCUMENT)
    doc.update(overrides)
    return doc


@pytest.fixture()
def users_tmp(tmp_path, monkeypatch):
    """Redirect ``users_path()`` to a temp directory for each test."""
    users_path = tmp_path / "users.json"
    monkeypatch.setattr(users_manager_module, "users_path", lambda: users_path)
    return users_path


def test_valid_id_accepts_alphanumeric_and_hyphens():
    assert valid_id("guest") is True
    assert valid_id("user-1_abc") is True


def test_valid_id_rejects_special_chars():
    assert valid_id("bad name") is False
    assert valid_id("bad@name") is False
    assert valid_id("") is False


def test_valid_id_rejects_too_long():
    assert valid_id("a" * 65) is False
    assert valid_id("a" * 64) is True


def test_load_or_create_writes_defaults_when_missing(users_tmp):
    assert not users_tmp.exists()
    load_or_create()
    assert users_tmp.exists()
    data = json.loads(users_tmp.read_text())
    assert data["settings"]["autoLoginName"] == "guest"
    assert any(g["id"] == "guest" for g in data["groups"])
    assert any(u["username"] == "guest" for u in data["users"])


def test_load_or_create_skips_creation_when_valid_file_exists(users_tmp):
    doc = _make_doc()
    doc["settings"]["autoLoginName"] = "custom"
    users_tmp.write_text(json.dumps(doc))
    load_or_create()
    data = json.loads(users_tmp.read_text())
    assert data["settings"]["autoLoginName"] == "custom"


def test_load_or_create_creates_backup_for_invalid_json(users_tmp):
    users_tmp.write_text("{invalid json")
    load_or_create()
    backups = list(users_tmp.parent.glob("users.json.bak.invalid.*"))
    assert len(backups) == 1
    # backup has the original invalid content
    assert "{invalid json" in backups[0].read_text()
    # users.json is now the default
    data = json.loads(users_tmp.read_text())
    assert data["settings"]["autoLoginName"] == "guest"


def test_load_or_create_creates_backup_for_invalid_schema(users_tmp):
    users_tmp.write_text(json.dumps({"not": "valid"}))
    load_or_create()
    backups = list(users_tmp.parent.glob("users.json.bak.invalid.*"))
    assert len(backups) == 1


def test_load_returns_defaults_when_file_missing(users_tmp):
    doc = load()
    assert doc["settings"]["autoLoginName"] == "guest"


def test_save_round_trips(users_tmp):
    doc = _make_doc()
    doc["settings"]["autoLoginName"] = "operator1"
    save(doc)
    loaded = load()
    assert loaded["settings"]["autoLoginName"] == "operator1"


# ─── users_api REST endpoint tests ──────────────────────────────────────────


@pytest.fixture()
def api_client(tmp_path, monkeypatch):
    """Create HTTPX TestClient for the FastAPI app with users redirected to tmp."""
    from fastapi.testclient import TestClient

    users_path = tmp_path / "users.json"
    monkeypatch.setattr(users_manager_module, "users_path", lambda: users_path)

    # Make sure the file is populated with defaults before each test
    load_or_create()

    from api.users_api import router
    from core.exceptions import register_exception_handlers
    from fastapi import FastAPI
    test_app = FastAPI()
    register_exception_handlers(test_app)
    test_app.include_router(router)
    return TestClient(test_app)


def test_get_users_returns_full_document(api_client):
    resp = api_client.get("/api/users")
    assert resp.status_code == 200
    data = resp.json()
    assert "groups" in data
    assert "users" in data
    assert "settings" in data
    assert all(user["password"] == "" for user in data["users"])
    assert all("passwordSet" in user for user in data["users"])


def test_put_users_document_saves_all_sections_together(api_client):
    document = {
        "settings": {"autoLoginName": "operator1", "configAccessGroups": ["operator"]},
        "groups": [
            {"id": "guest", "label": "Guest"},
            {"id": "operator", "label": "Operators"},
        ],
        "users": [
            {"id": "guest", "username": "guest", "password": "", "groups": ["guest"]},
            {
                "id": "operator1",
                "username": "operator1",
                "password": "secret",
                "groups": ["operator"],
            },
        ],
    }

    resp = api_client.put("/api/users", json=document)

    assert resp.status_code == 200
    payload = resp.json()
    assert payload["settings"] == document["settings"]
    assert payload["groups"] == document["groups"]
    assert all(user["password"] == "" for user in payload["users"])
    stored = next(user for user in load()["users"] if user["id"] == "operator1")
    assert stored["password"] == ""
    assert is_valid_hash(stored["passwordHash"]) is True
    assert verify_password(stored, "secret") is True


def test_put_users_document_validation_failure_leaves_file_unchanged(api_client):
    before = load()
    invalid = copy.deepcopy(before)
    invalid["settings"]["configAccessGroups"] = ["missing-group"]

    resp = api_client.put("/api/users", json=invalid)

    assert resp.status_code == 422
    assert load() == before


def test_put_users_document_cannot_consume_pending_operator_setup(api_client):
    pending = load()
    pending["operatorSetup"] = {"version": 1, "required": True}
    save(pending)
    submitted = copy.deepcopy(pending)
    submitted.pop("operatorSetup")

    resp = api_client.put("/api/users", json=submitted)

    assert resp.status_code == 200
    assert resp.json()["operatorSetup"] == {"version": 1, "required": True}
    assert load()["operatorSetup"] == {"version": 1, "required": True}


def test_put_users_document_cannot_discard_malformed_operator_setup(api_client):
    malformed = load()
    malformed["operatorSetup"] = None
    save(malformed)
    submitted = api_client.get("/api/users").json()
    submitted.pop("operatorSetup")

    resp = api_client.put("/api/users", json=submitted)

    assert resp.status_code == 422
    assert load() == malformed


def test_put_groups_saves_and_returns(api_client):
    new_groups = [
        {"id": "guest", "label": "Guest"},
        {"id": "operator", "label": "Operator"},
        {"id": "engineer", "label": "Engineering"},
        {"id": "admin", "label": "Administrators"},
    ]
    resp = api_client.put("/api/users/groups", json=new_groups)
    assert resp.status_code == 200
    assert resp.json() == new_groups


def test_put_groups_rejects_duplicate_ids(api_client):
    groups = [{"id": "guest", "label": "G"}, {"id": "guest", "label": "G2"}]
    resp = api_client.put("/api/users/groups", json=groups)
    assert resp.status_code == 409


def test_put_groups_rejects_missing_guest(api_client):
    groups = [{"id": "admin", "label": "Admin"}]
    resp = api_client.put("/api/users/groups", json=groups)
    assert resp.status_code == 422


def test_delete_group_removes_group(api_client):
    resp = api_client.delete("/api/users/groups/operator")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": "operator"}


def test_delete_guest_group_is_blocked(api_client):
    resp = api_client.delete("/api/users/groups/guest")
    assert resp.status_code == 422


def test_delete_nonexistent_group_returns_404(api_client):
    resp = api_client.delete("/api/users/groups/nonexistent")
    assert resp.status_code == 404


def test_put_users_saves_and_returns(api_client):
    new_users = [
        {"id": "guest", "username": "guest", "password": "", "groups": ["guest"]},
        {"id": "u-op1", "username": "operator1", "password": "pass", "groups": ["guest"]},
    ]
    resp = api_client.put("/api/users/users", json=new_users)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    assert all(user["password"] == "" for user in data)
    stored = next(user for user in load()["users"] if user["id"] == "u-op1")
    assert verify_password(stored, "pass") is True


def test_get_redacts_legacy_plaintext_without_rewriting(api_client, users_tmp):
    legacy = load()
    legacy["users"].append(
        {
            "id": "legacy",
            "username": "legacy",
            "password": "legacy-secret",
            "groups": ["guest"],
        }
    )
    save(legacy)
    before = users_tmp.read_bytes()

    payload = api_client.get("/api/users").json()

    returned = next(user for user in payload["users"] if user["id"] == "legacy")
    assert returned["password"] == ""
    assert returned["passwordSet"] is True
    assert users_tmp.read_bytes() == before


def test_prefix_like_legacy_password_is_preserved_on_unchanged_save(api_client):
    legacy_value = "$nexthmi$pbkdf2-sha256$v1$literal-plaintext"
    document = load()
    document["users"].append(
        {
            "id": "legacy",
            "username": "legacy",
            "password": legacy_value,
            "groups": ["guest"],
        }
    )
    save(document)
    editable = api_client.get("/api/users").json()
    editable["groups"][0]["label"] = "Visitors"

    response = api_client.put("/api/users", json=editable)

    assert response.status_code == 200
    stored = next(user for user in load()["users"] if user["id"] == "legacy")
    assert stored["password"] == legacy_value
    assert "passwordHash" not in stored


def test_full_document_edit_preserves_unchanged_hash(api_client):
    document = load()
    digest = hash_password("existing-secret")
    document["users"].append(
        {
            "id": "operator1",
            "username": "operator1",
            "password": "",
            "passwordHash": digest,
            "groups": ["guest"],
        }
    )
    save(document)
    editable = api_client.get("/api/users").json()
    editable["groups"][0]["label"] = "Visitors"

    response = api_client.put("/api/users", json=editable)

    assert response.status_code == 200
    stored = next(user for user in load()["users"] if user["id"] == "operator1")
    assert stored["passwordHash"] == digest


def test_full_document_can_intentionally_change_password(api_client):
    document = load()
    original = hash_password("old-secret")
    document["users"].append(
        {
            "id": "operator1",
            "username": "operator1",
            "password": "",
            "passwordHash": original,
            "groups": ["guest"],
        }
    )
    save(document)
    editable = api_client.get("/api/users").json()
    next(user for user in editable["users"] if user["id"] == "operator1")["password"] = (
        "new-secret"
    )

    response = api_client.put("/api/users", json=editable)

    assert response.status_code == 200
    stored = next(user for user in load()["users"] if user["id"] == "operator1")
    assert stored["passwordHash"] != original
    assert verify_password(stored, "new-secret") is True
    assert verify_password(stored, "old-secret") is False


def test_full_document_rejects_even_unchanged_client_supplied_hash(api_client):
    document = load()
    digest = hash_password("existing-secret")
    document["users"].append(
        {
            "id": "operator1",
            "username": "operator1",
            "password": "",
            "passwordHash": digest,
            "groups": ["guest"],
        }
    )
    save(document)
    submitted = copy.deepcopy(document)

    before = load()
    response = api_client.put("/api/users", json=submitted)

    assert response.status_code == 422
    assert load() == before


def test_full_document_rejects_client_supplied_hash(api_client):
    before = load()
    submitted = copy.deepcopy(before)
    submitted["users"].append(
        {
            "id": "operator1",
            "username": "operator1",
            "password": "",
            "passwordHash": hash_password("injected"),
            "groups": ["guest"],
        }
    )

    response = api_client.put("/api/users", json=submitted)

    assert response.status_code == 422
    assert load() == before


def test_put_users_rejects_duplicate_usernames(api_client):
    users = [
        {"id": "guest", "username": "guest", "password": "", "groups": ["guest"]},
        {"id": "u1", "username": "guest", "password": "", "groups": ["guest"]},
    ]
    resp = api_client.put("/api/users/users", json=users)
    assert resp.status_code == 409


def test_put_users_rejects_user_without_groups(api_client):
    users = [
        {"id": "guest", "username": "guest", "password": "", "groups": ["guest"]},
        {"id": "u1", "username": "user1", "password": "", "groups": []},
    ]
    resp = api_client.put("/api/users/users", json=users)
    assert resp.status_code == 422


def test_put_users_rejects_missing_guest(api_client):
    users = [
        {"id": "u1", "username": "operator1", "password": "", "groups": ["guest"]},
    ]
    resp = api_client.put("/api/users/users", json=users)
    assert resp.status_code == 422


@pytest.mark.parametrize("endpoint", ["/api/users", "/api/users/users"])
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("id", "visitor"),
        ("username", "visitor"),
        ("groups", ["guest", "admin"]),
        ("password", "guest-secret"),
        ("passwordHash", {"version": 1}),
    ],
)
def test_guest_identity_membership_and_credentials_are_immutable(
    api_client, endpoint: str, field: str, value: object
):
    before = load()
    submitted = api_client.get("/api/users").json()
    guest = next(user for user in submitted["users"] if user["id"] == "guest")
    guest[field] = value
    body = submitted if endpoint == "/api/users" else submitted["users"]

    response = api_client.put(endpoint, json=body)

    assert response.status_code == 422
    assert load() == before


def test_full_document_cannot_remove_guest_group(api_client):
    before = load()
    submitted = api_client.get("/api/users").json()
    submitted["groups"] = [group for group in submitted["groups"] if group["id"] != "guest"]

    response = api_client.put("/api/users", json=submitted)

    assert response.status_code == 422
    assert load() == before


def test_delete_user_removes_user(api_client):
    # Add a user first
    users = [
        {"id": "guest", "username": "guest", "password": "", "groups": ["guest"]},
        {"id": "u-op1", "username": "operator1", "password": "pass", "groups": ["guest"]},
    ]
    api_client.put("/api/users/users", json=users)
    resp = api_client.delete("/api/users/users/u-op1")
    assert resp.status_code == 200


def test_delete_referenced_group_is_rejected_without_persistence(api_client):
    before = load()

    response = api_client.delete("/api/users/groups/admin")

    assert response.status_code == 422
    assert load() == before


def test_delete_guest_user_is_blocked(api_client):
    resp = api_client.delete("/api/users/users/guest")
    assert resp.status_code == 422


def test_put_settings_saves(api_client):
    resp = api_client.put(
        "/api/users/settings",
        json={"autoLoginName": "guest", "configAccessGroups": ["engineer", "admin"]},
    )
    assert resp.status_code == 200


def test_put_settings_rejects_unknown_configAccessGroup(api_client):
    resp = api_client.put(
        "/api/users/settings",
        json={"autoLoginName": "guest", "configAccessGroups": ["nonexistent"]},
    )
    assert resp.status_code == 422


# ─── WebSocket login/logout + permission tests ─────────────────────────────


def _setup_users_file(path: Path) -> None:
    doc = copy.deepcopy(_DEFAULT_DOCUMENT)
    doc["users"].append(
        {"id": "u-op1", "username": "operator1", "password": "op1pass", "groups": ["operator", "guest"]}
    )
    doc["users"].append(
        {
            "id": "u-prefix",
            "username": "prefix",
            "password": "$nexthmi$pbkdf2-sha256$v1$literal-plaintext",
            "groups": ["operator", "guest"],
        }
    )
    doc["users"].append(
        {
            "id": "u-hashed",
            "username": "hashed",
            "password": "",
            "passwordHash": hash_password("hashed-pass"),
            "groups": ["operator", "guest"],
        }
    )
    path.write_text(json.dumps(doc))


@pytest.fixture()
def ws_manager(tmp_path, monkeypatch):
    users_path = tmp_path / "users.json"
    _setup_users_file(users_path)
    monkeypatch.setattr(users_manager_module, "users_path", lambda: users_path)
    return WebSocketManager()


def test_login_success_sends_user_identity(ws_manager):
    ws = FakeWebSocket()
    ws_manager._connections["c1"] = ws
    ws_manager._client_users["c1"] = {}

    asyncio.run(ws_manager._handle_login("c1", {
        "type": "login",
        "scope": "runtime:tab1:inst1",
        "username": "operator1",
        "password": "op1pass",
    }))

    assert any(m.get("type") == "user_identity" for m in ws.messages)
    identity_msg = next(m for m in ws.messages if m.get("type") == "user_identity")
    assert identity_msg["username"] == "operator1"
    assert "operator" in identity_msg["groups"]
    assert identity_msg["scope"] == "runtime:tab1:inst1"


def test_login_wrong_password_sends_auth_error(ws_manager):
    ws = FakeWebSocket()
    ws_manager._connections["c1"] = ws
    ws_manager._client_users["c1"] = {}

    asyncio.run(ws_manager._handle_login("c1", {
        "type": "login",
        "scope": "runtime:tab1:inst1",
        "username": "operator1",
        "password": "wrongpass",
    }))

    assert any(m.get("type") == "auth_error" for m in ws.messages)


def test_login_with_hashed_password_accepts_valid_and_rejects_invalid(ws_manager):
    valid = FakeWebSocket()
    ws_manager._connections["valid"] = valid
    ws_manager._client_users["valid"] = {}
    asyncio.run(
        ws_manager._handle_login(
            "valid",
            {
                "type": "login",
                "scope": "runtime:valid",
                "username": "hashed",
                "password": "hashed-pass",
            },
        )
    )
    assert any(message.get("type") == "user_identity" for message in valid.messages)

    invalid = FakeWebSocket()
    ws_manager._connections["invalid"] = invalid
    ws_manager._client_users["invalid"] = {}
    asyncio.run(
        ws_manager._handle_login(
            "invalid",
            {
                "type": "login",
                "scope": "runtime:invalid",
                "username": "hashed",
                "password": "wrong",
            },
        )
    )
    assert any(message.get("type") == "auth_error" for message in invalid.messages)


def test_login_treats_hash_prefix_like_legacy_password_as_plaintext(ws_manager):
    exact = FakeWebSocket()
    ws_manager._connections["exact"] = exact
    ws_manager._client_users["exact"] = {}
    asyncio.run(
        ws_manager._handle_login(
            "exact",
            {
                "type": "login",
                "scope": "runtime:exact",
                "username": "prefix",
                "password": "$nexthmi$pbkdf2-sha256$v1$literal-plaintext",
            },
        )
    )
    assert any(message.get("type") == "user_identity" for message in exact.messages)

    wrong = FakeWebSocket()
    ws_manager._connections["wrong-prefix"] = wrong
    ws_manager._client_users["wrong-prefix"] = {}
    asyncio.run(
        ws_manager._handle_login(
            "wrong-prefix",
            {
                "type": "login",
                "scope": "runtime:wrong-prefix",
                "username": "prefix",
                "password": "literal-plaintext",
            },
        )
    )
    assert any(message.get("type") == "auth_error" for message in wrong.messages)


def test_login_unknown_user_sends_auth_error(ws_manager):
    ws = FakeWebSocket()
    ws_manager._connections["c1"] = ws
    ws_manager._client_users["c1"] = {}

    asyncio.run(ws_manager._handle_login("c1", {
        "type": "login",
        "scope": "config",
        "username": "nobody",
        "password": "x",
    }))

    assert any(m.get("type") == "auth_error" for m in ws.messages)


def test_logout_resets_to_guest(ws_manager):
    ws = FakeWebSocket()
    ws_manager._connections["c1"] = ws
    ws_manager._client_users["c1"] = {
        "runtime:tab1:inst1": {"username": "operator1", "groups": ["operator", "guest"]}
    }

    asyncio.run(ws_manager._handle_logout("c1", {
        "type": "logout",
        "scope": "runtime:tab1:inst1",
    }))

    identity_msg = next(m for m in ws.messages if m.get("type") == "user_identity")
    assert identity_msg["username"] == "guest"
    assert ws_manager._client_users["c1"]["runtime:tab1:inst1"]["username"] == "guest"


def test_write_field_denied_when_group_mismatch(ws_manager):
    ws = FakeWebSocket()
    ws_manager._connections["c1"] = ws
    # client logged in as operator with groups ["operator", "guest"]
    ws_manager._client_users["c1"] = {
        "runtime:tab1:inst1": {"username": "operator1", "groups": ["operator", "guest"]}
    }

    entry_data = {"interactableByGroups": ["engineer", "admin"]}
    permitted = ws_manager._check_write_permitted("c1", "runtime:tab1:inst1", entry_data)
    assert permitted is False


def test_write_field_permitted_when_group_matches(ws_manager):
    ws = FakeWebSocket()
    ws_manager._connections["c1"] = ws
    ws_manager._client_users["c1"] = {
        "runtime:tab1:inst1": {"username": "operator1", "groups": ["operator", "guest"]}
    }

    entry_data = {"interactableByGroups": ["operator", "engineer"]}
    permitted = ws_manager._check_write_permitted("c1", "runtime:tab1:inst1", entry_data)
    assert permitted is True


def test_write_field_permitted_when_no_restriction(ws_manager):
    entry_data = {}
    assert ws_manager._check_write_permitted("c1", "config", entry_data) is True


def test_get_runtime_sessions_excludes_config_scope(ws_manager):
    from datetime import datetime
    ws_manager._connections["c2"] = FakeWebSocket()
    ws_manager._client_users["c2"] = {
        "config": {"username": "engineer1", "groups": ["engineer"]},
        "runtime:tab1:inst1": {"username": "operator1", "groups": ["operator", "guest"]},
    }
    ws_manager._client_connected_at["c2"] = datetime.now(UTC).isoformat()

    sessions = ws_manager.get_runtime_sessions()
    assert len(sessions) == 1
    assert sessions[0]["scope"] == "runtime:tab1:inst1"
    assert sessions[0]["username"] == "operator1"


def test_disconnect_clears_user_state(ws_manager):
    ws_manager._connections["c1"] = FakeWebSocket()
    ws_manager._client_users["c1"] = {"config": {"username": "guest", "groups": ["guest"]}}
    ws_manager._client_connected_at["c1"] = "2026-04-01T00:00:00Z"

    asyncio.run(ws_manager.disconnect("c1"))

    assert "c1" not in ws_manager._client_users
    assert "c1" not in ws_manager._client_connected_at


def test_request_identity_sends_auto_login_user(ws_manager, users_tmp):
    """request_identity responds with the autoLoginName user's identity."""
    doc = copy.deepcopy(_DEFAULT_DOCUMENT)
    doc["settings"]["autoLoginName"] = "guest"
    users_tmp.write_text(json.dumps(doc))

    fake_ws = FakeWebSocket()
    ws_manager._connections["c1"] = fake_ws

    asyncio.run(
        ws_manager.handle_message("c1", json.dumps({"type": "request_identity", "scope": "runtime:test123"}))
    )

    assert len(fake_ws.messages) == 1
    resp = fake_ws.messages[0]
    assert resp["type"] == "user_identity"
    assert resp["scope"] == "runtime:test123"
    assert resp["username"] == "guest"
    assert "guest" in resp["groups"]


def test_request_identity_missing_scope_is_ignored(ws_manager, users_tmp):
    doc = copy.deepcopy(_DEFAULT_DOCUMENT)
    users_tmp.write_text(json.dumps(doc))

    fake_ws = FakeWebSocket()
    ws_manager._connections["c1"] = fake_ws

    asyncio.run(
        ws_manager.handle_message("c1", json.dumps({"type": "request_identity"}))
    )

    assert len(fake_ws.messages) == 0


def test_request_identity_fallback_when_user_not_found(ws_manager, users_tmp):
    """If autoLoginName user doesn't exist, falls back to bare guest identity."""
    doc = copy.deepcopy(_DEFAULT_DOCUMENT)
    doc["settings"]["autoLoginName"] = "nonexistent"
    users_tmp.write_text(json.dumps(doc))

    fake_ws = FakeWebSocket()
    ws_manager._connections["c1"] = fake_ws

    asyncio.run(
        ws_manager.handle_message("c1", json.dumps({"type": "request_identity", "scope": "config"}))
    )

    assert len(fake_ws.messages) == 1
    resp = fake_ws.messages[0]
    assert resp["type"] == "user_identity"
    assert resp["username"] == "guest"


# ─── requestId echoing for action-result correlation ───────────────────────


def test_login_success_echoes_request_id(ws_manager):
    ws = FakeWebSocket()
    ws_manager._connections["c1"] = ws
    ws_manager._client_users["c1"] = {}

    asyncio.run(ws_manager._handle_login("c1", {
        "type": "login",
        "requestId": "req-abc",
        "scope": "runtime:tab1:inst1",
        "username": "operator1",
        "password": "op1pass",
    }))

    identity_msg = next(m for m in ws.messages if m.get("type") == "user_identity")
    assert identity_msg.get("requestId") == "req-abc"


def test_login_success_without_request_id_omits_field(ws_manager):
    ws = FakeWebSocket()
    ws_manager._connections["c1"] = ws
    ws_manager._client_users["c1"] = {}

    asyncio.run(ws_manager._handle_login("c1", {
        "type": "login",
        "scope": "runtime:tab1:inst1",
        "username": "operator1",
        "password": "op1pass",
    }))

    identity_msg = next(m for m in ws.messages if m.get("type") == "user_identity")
    assert "requestId" not in identity_msg


def test_login_failure_echoes_request_id(ws_manager):
    ws = FakeWebSocket()
    ws_manager._connections["c1"] = ws
    ws_manager._client_users["c1"] = {}

    asyncio.run(ws_manager._handle_login("c1", {
        "type": "login",
        "requestId": "req-xyz",
        "scope": "runtime:tab1:inst1",
        "username": "operator1",
        "password": "WRONG",
    }))

    err = next(m for m in ws.messages if m.get("type") == "auth_error")
    assert err.get("requestId") == "req-xyz"
    assert err.get("reason") == "invalid_credentials"


def test_logout_echoes_request_id(ws_manager):
    ws = FakeWebSocket()
    ws_manager._connections["c1"] = ws
    ws_manager._client_users["c1"] = {
        "runtime:tab1:inst1": {"username": "operator1", "groups": ["operator", "guest"]}
    }

    asyncio.run(ws_manager._handle_logout("c1", {
        "type": "logout",
        "requestId": "req-out",
        "scope": "runtime:tab1:inst1",
    }))

    identity_msg = next(m for m in ws.messages if m.get("type") == "user_identity")
    assert identity_msg.get("requestId") == "req-out"
    assert identity_msg["username"] == "guest"


def test_request_identity_does_not_echo_request_id(ws_manager, users_tmp):
    """Auto-login responses must never carry requestId — otherwise the client
    dispatcher would mistake an auto-login for a login response."""
    doc = copy.deepcopy(_DEFAULT_DOCUMENT)
    users_tmp.write_text(json.dumps(doc))

    fake_ws = FakeWebSocket()
    ws_manager._connections["c1"] = fake_ws

    asyncio.run(
        ws_manager.handle_message(
            "c1",
            json.dumps({
                "type": "request_identity",
                "scope": "runtime:tab1:inst1",
                # Even if a client erroneously included one, it must not be echoed
                "requestId": "should-be-ignored",
            }),
        )
    )

    resp = fake_ws.messages[0]
    assert resp["type"] == "user_identity"
    assert "requestId" not in resp
