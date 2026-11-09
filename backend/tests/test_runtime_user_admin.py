"""Runtime user management over the WebSocket: user_update / user_delete /
user_change_password, the admin-only account list, and the profile fields
(language, locked) every writer keeps."""

import asyncio
import copy
import json
from pathlib import Path

import pytest
import services.users_manager as users_manager_module
from conftest import FakeWebSocket
from core.exceptions import UserValidationError
from core.passwords import hash_password, verify_password
from services.users_manager import _DEFAULT_DOCUMENT, load
from services.websocket_manager import WebSocketManager

SCOPE = "runtime:tab1"


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


@pytest.fixture()
def manager(users_file) -> WebSocketManager:
    return WebSocketManager()


def _connect(manager: WebSocketManager, client_id: str) -> FakeWebSocket:
    ws = FakeWebSocket()
    manager._connections[client_id] = ws
    manager._client_users[client_id] = {}
    return ws


def _sign_in(manager: WebSocketManager, client_id: str, username: str, password: str) -> FakeWebSocket:
    ws = _connect(manager, client_id)
    asyncio.run(manager._handle_login(client_id, {"type": "login", "scope": SCOPE, "username": username, "password": password}))
    return ws


def _send(manager: WebSocketManager, client_id: str, **msg) -> dict:
    ws = manager._connections[client_id]
    ws.messages.clear()
    asyncio.run(manager.handle_message(client_id, json.dumps({"scope": SCOPE, "requestId": "r1", **msg})))
    return next(m for m in ws.messages if m.get("requestId") == "r1")


def _user(username: str) -> dict | None:
    return next((u for u in load()["users"] if u["username"] == username), None)


def test_admin_identity_carries_language_and_accounts(manager):
    ws = _sign_in(manager, "c1", "boss", "boss-pass")
    identity = next(m for m in ws.messages if m["type"] == "user_identity")
    assert identity["language"] == "nl"
    op = next(a for a in identity["accounts"] if a["username"] == "op")
    assert op == {"username": "op", "groups": ["operator"], "language": "", "locked": {"delete": False, "password": True, "groups": True}}


def test_non_admin_gets_no_accounts_and_is_refused(manager):
    ws = _sign_in(manager, "c1", "op", "op-pass")
    assert "accounts" not in next(m for m in ws.messages if m["type"] == "user_identity")
    reply = _send(manager, "c1", type="user_update", username="new", groups="operator", password="pw")
    assert reply == {"type": "user_error", "requestId": "r1", "reason": "forbidden"}
    assert _user("new") is None


def test_admin_creates_a_user_and_every_admin_sees_it(manager):
    _sign_in(manager, "c1", "boss", "boss-pass")
    other = _sign_in(manager, "c2", "svc", "svc-pass")
    other.messages.clear()
    reply = _send(manager, "c1", type="user_update", username="jan", groups="operator, engineer", password="jan-pass", language="de")
    assert reply["type"] == "user_response"
    assert reply["result"] == {"username": "jan", "created": True}
    jan = _user("jan")
    assert jan["groups"] == ["operator", "engineer"] and jan["language"] == "de"
    assert verify_password(jan, "jan-pass")
    pushed = next(m for m in other.messages if m["type"] == "user_identity")
    assert "jan" in [a["username"] for a in pushed["accounts"]]
    assert any(m["type"] == "config_changed" and m["source"] == "runtime" for m in other.messages)


def test_a_new_user_needs_groups_and_a_password(manager):
    _sign_in(manager, "c1", "boss", "boss-pass")
    assert _send(manager, "c1", type="user_update", username="jan", groups="operator")["reason"] == "invalid"
    assert _send(manager, "c1", type="user_update", username="jan", groups="nope", password="x")["reason"] == "invalid"


def test_locks_refuse_the_locked_part_only(manager):
    _sign_in(manager, "c1", "boss", "boss-pass")
    assert _send(manager, "c1", type="user_update", username="op", groups="engineer")["reason"] == "locked"
    assert _send(manager, "c1", type="user_update", username="op", password="x")["reason"] == "locked"
    # Unchanged groups and an empty password leave the language editable.
    assert _send(manager, "c1", type="user_update", username="op", groups="operator", language="en")["type"] == "user_response"
    assert _user("op")["language"] == "en"
    assert _user("op")["locked"] == {"password": True, "groups": True}
    assert _send(manager, "c1", type="user_delete", username="svc")["reason"] == "locked"


def test_an_admin_cannot_lock_itself_out(manager):
    _sign_in(manager, "c1", "boss", "boss-pass")
    assert _send(manager, "c1", type="user_delete", username="boss")["reason"] == "forbidden"
    assert _send(manager, "c1", type="user_update", username="boss", groups="operator")["reason"] == "forbidden"
    assert _send(manager, "c1", type="user_delete", username="guest")["reason"] == "invalid"
    assert _send(manager, "c1", type="user_delete", username="ghost")["reason"] == "not_found"


def test_admin_deletes_a_user_and_its_login_ends(manager):
    _sign_in(manager, "c1", "boss", "boss-pass")
    victim = _sign_in(manager, "c2", "op", "op-pass")
    assert _send(manager, "c1", type="user_delete", username="op")["type"] == "user_response"
    assert _user("op") is None
    assert manager._client_users["c2"][SCOPE]["username"] == "guest"
    assert any(m["type"] == "user_identity" and m["username"] == "guest" for m in victim.messages)


def test_own_password_change_keeps_this_login(manager):
    _sign_in(manager, "c1", "boss", "boss-pass")
    elsewhere = _sign_in(manager, "c2", "boss", "boss-pass")
    wrong = _send(manager, "c1", type="user_change_password", currentPassword="nope", newPassword="new-pass")
    assert wrong["reason"] == "wrong_password"
    reply = _send(manager, "c1", type="user_change_password", currentPassword="boss-pass", newPassword="new-pass")
    assert reply["type"] == "user_response"
    assert verify_password(_user("boss"), "new-pass")
    assert manager._client_users["c1"][SCOPE]["username"] == "boss"
    # Another login taken with the old password ends.
    assert manager._client_users["c2"][SCOPE]["username"] == "guest"
    assert elsewhere.messages


def test_own_password_change_respects_the_lock_and_needs_a_login(manager):
    _sign_in(manager, "c1", "op", "op-pass")
    assert _send(manager, "c1", type="user_change_password", currentPassword="op-pass", newPassword="x")["reason"] == "locked"
    _connect(manager, "c2")
    assert _send(manager, "c2", type="user_change_password", currentPassword="", newPassword="x")["reason"] == "forbidden"


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
