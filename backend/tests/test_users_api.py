"""The public `GET /api/users/roster` and the gated users routes beside it.

The live view resolves `$user` → All users / Groups with no session, so the
manager's runtime allowlist opens `/roster`: usernames and group labels, no
membership and no credential state. The full document (`GET /api/users`),
with `passwordSet` per account, stays behind the device-admin session.
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


def test_the_roster_carries_names_and_group_labels_only(client):
    doc = load()
    doc["groups"].append({"id": "operator", "label": "Operators"})
    doc["users"].append(
        {
            "id": "op-1",
            "username": "op",
            "password": "",
            "passwordHash": hash_password("secret"),
            "groups": ["operator"],
        }
    )
    save(doc)

    body = client.get("/api/users/roster").json()

    assert set(body) == {"users", "groups"}
    assert {"id": "op-1", "username": "op"} in body["users"]
    assert all(set(account) == {"id", "username"} for account in body["users"])
    assert {"id": "operator", "label": "Operators"} in body["groups"]


def test_the_full_document_reports_who_has_a_password(client):
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

    body = client.get("/api/users").json()

    assert {u["id"]: u["passwordSet"] for u in body["users"]} == {
        "guest": False,
        "has-pw": True,
    }


def test_only_the_roster_is_public_on_the_runtime():
    import manager

    assert manager._is_gated("/runtime/x/api/users/roster", "GET") is False
    assert manager._is_gated("/runtime/x/api/users", "GET") is True
