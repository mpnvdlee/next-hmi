"""The anonymous `GET /api/users` roster and the gated credential-state route
beside it.

`GET /api/users` sits on the manager's anonymous runtime allowlist so the live
view can resolve `$user` / `$userGroups` and populate the sign-in dropdown with
no session. That is a reason to publish `users` and `groups`; it is not a
reason to publish which of those accounts carries a credential — that is a
target list for whoever is guessing passwords on the WebSocket. This module
pins that split and confirms the new `/credential-state` route lives behind
the manager's session gate instead.
"""

from __future__ import annotations

import pytest
import services.users_manager as users_manager_module
from core.passwords import hash_password
from services.users_manager import load, load_or_create, save


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """HTTPX TestClient for the users router alone, users.json redirected to tmp."""
    from fastapi.testclient import TestClient

    users_path = tmp_path / "users.json"
    monkeypatch.setattr(users_manager_module, "users_path", lambda: users_path)
    load_or_create()

    from api.users_api import router
    from core.exceptions import register_exception_handlers
    from fastapi import FastAPI

    test_app = FastAPI()
    register_exception_handlers(test_app)
    test_app.include_router(router)
    return TestClient(test_app)


def test_the_anonymous_roster_does_not_say_who_has_a_password(client):
    """The live view reads this route with no session so it can resolve
    $user and $userGroups. Which accounts carry a credential is not part of
    that, and publishing it hands an attacker a target list."""
    body = client.get("/api/users").json()
    assert body["users"], "fixture should have users"
    for account in body["users"]:
        assert "passwordSet" not in account


def test_the_roster_still_carries_what_the_runtime_needs(client):
    body = client.get("/api/users").json()
    assert "users" in body and "groups" in body
    assert all("username" in u for u in body["users"])


def test_credential_state_route_reports_who_has_a_password(client):
    doc = load()
    doc["users"].append(
        {
            "id": "has-pw",
            "username": "has-pw",
            "password": "",
            "passwordHash": hash_password("secret"),
            "groups": ["guest"],
        }
    )
    save(doc)

    body = client.get("/api/users/credential-state").json()

    assert body == {"guest": False, "has-pw": True}


def test_credential_state_route_is_gated_behind_a_manager_session():
    """Deny-by-default: a brand new path is gated with no allowlist edit, which
    is what lets this fix stay inside `_redact_document` instead of widening
    the anonymous table."""
    import manager

    assert manager._is_gated("/runtime/x/api/users/credential-state", "GET") is True
    # The roster beside it must stay public — this fix must not touch that.
    assert manager._is_gated("/runtime/x/api/users", "GET") is False
