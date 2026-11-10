"""External API v1 (``api.v1_api``): auth matrix, each route's shape and paging,
user writes with validation and the reload notice, and token-file compatibility."""
from __future__ import annotations

import asyncio
import base64
import json
import sqlite3
from pathlib import Path

import pytest
from core import manager_auth, mcp_tokens, runtime_home
from core.manifest import ProjectEntry, load_manifest, save_manifest
from core.passwords import hash_password
from core.time_utils import iso_now
from fastapi.testclient import TestClient

PASSWORD = "device-admin"


def _basic(password: str = PASSWORD, username: str = "admin") -> dict[str, str]:
    raw = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"Authorization": f"Basic {raw}"}


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _write_project(root: Path) -> None:
    root.mkdir(parents=True)
    (root / "users.json").write_text(
        json.dumps(
            {
                "settings": {"autoLoginName": "guest"},
                "groups": [{"id": "guest", "label": "Guest"}, {"id": "operator", "label": "Operator"}],
                "users": [
                    {"id": "guest", "username": "guest", "password": "", "groups": ["guest"]},
                    {
                        "id": "ann",
                        "username": "ann",
                        "password": "",
                        "passwordHash": hash_password("ann-secret"),
                        "groups": ["operator"],
                    },
                ],
            }
        )
    )
    history = [
        {
            "id": f"h{i}",
            "alarm_id": "a1",
            "code": "E1",
            "title": "Overheat",
            "triggered_at": f"2026-11-0{i}T09:00:00+00:00",
            "cleared_at": f"2026-11-0{i}T10:00:00+00:00",
            "acked": i == 1,
            "acked_by": "ann" if i == 1 else "",
            "acked_at": "2026-11-01T09:30:00+00:00" if i == 1 else "",
        }
        for i in (3, 1, 2)  # stored newest-first-ish; the API orders by clearedAt
    ]
    (root / "alarm_state.json").write_text(json.dumps({"active": [], "history": history}))
    (root / "recipes.json").write_text(
        json.dumps(
            {
                "version": 1,
                "datasetTypes": [
                    {
                        "id": "bake",
                        "name": "Bake",
                        "parameters": [{"id": "temp", "label": "Temp", "dataType": "float"}],
                        "datasets": [{"id": "bread", "name": "Bread", "values": {"temp": 220}}],
                    }
                ],
            }
        )
    )
    (root / "recipe_state.json").write_text(
        json.dumps({"loaded": {"bake": {"datasetId": "bread", "loadedAt": "x"}}})
    )
    (root / "historian").mkdir()
    conn = sqlite3.connect(root / "historian" / "history.db")
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute(
        "CREATE TABLE samples (id INTEGER PRIMARY KEY AUTOINCREMENT, variable TEXT NOT NULL, "
        "timestamp REAL NOT NULL, value REAL)"
    )
    # 1000.0 twice: the cursor must split ties by row id, not skip or repeat them.
    rows = [("ds:a", 1000.0, 1.0), ("ds:b", 1000.0, 2.0), ("ds:a", 1001.0, 3.0), ("ds:c", 1002.0, 9.0)]
    conn.executemany("INSERT INTO samples (variable, timestamp, value) VALUES (?, ?, ?)", rows)
    conn.commit()
    conn.close()


@pytest.fixture
def client(monkeypatch, tmp_path: Path):
    home = tmp_path / "runtime-home"
    home.mkdir()
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home))

    import manager

    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
    manager_auth.set_password(PASSWORD)
    manager_auth.reset_throttle()
    # asyncio.Lock binds to the first loop that waits on it; each test has its own.
    monkeypatch.setattr(manager_auth, "_password_lock", asyncio.Lock())
    for project_id in ("P1", "P2"):
        _write_project(tmp_path / project_id)
    manifest = load_manifest()
    manifest.projects.extend(
        ProjectEntry(id=pid, name=pid, path=str(tmp_path / pid), addedAt=iso_now()) for pid in ("P1", "P2")
    )
    save_manifest(manifest)
    with TestClient(manager.app, raise_server_exceptions=False) as tc:
        yield tc
    manager_auth.reset_throttle()


def _api_token(*scopes: str) -> str:
    return mcp_tokens.issue_api(scopes=list(scopes))[1]


# ── auth matrix ──────────────────────────────────────────────────────────────


def test_no_credentials_is_401_with_a_bearer_challenge(client: TestClient):
    resp = client.get("/api/v1/projects/P1/users")
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"].startswith("Bearer")


def test_session_cookie_alone_opens_nothing(client: TestClient):
    assert client.post("/api/manager/auth/login", json={"password": PASSWORD}).status_code == 200
    assert client.get("/api/manager/mcp-tokens").status_code == 200  # the session is real
    assert client.get("/api/v1/projects/P1/users").status_code == 401


def test_bad_token_is_401(client: TestClient):
    assert client.get("/api/v1/projects/P1/users", headers=_bearer("x.y")).status_code == 401


def test_a_token_opens_every_project(client: TestClient):
    token = _api_token("users:read")
    for project in ("P1", "P2"):
        assert client.get(f"/api/v1/projects/{project}/users", headers=_bearer(token)).status_code == 200
    assert client.get("/api/v1/projects/P1/recipes", headers=_bearer(token)).status_code == 403


def test_token_without_the_scope_is_403(client: TestClient):
    token = _api_token("history:read")
    resp = client.get("/api/v1/projects/P1/users", headers=_bearer(token))
    assert resp.status_code == 403
    assert "users:read" in resp.json()["detail"]
    # users:write does not imply users:read
    writer = _api_token("users:write")
    assert client.get("/api/v1/projects/P1/users", headers=_bearer(writer)).status_code == 403


def test_mcp_token_is_refused_on_v1(client: TestClient):
    _, token = mcp_tokens.issue(access="write")
    assert client.get("/api/v1/projects/P1/users", headers=_bearer(token)).status_code == 401


def test_api_token_is_refused_on_mcp_and_internal_api(client: TestClient):
    token = _api_token(*mcp_tokens.API_SCOPES)
    assert mcp_tokens.resolve(token) is None
    mcp = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}, headers=_bearer(token))
    assert mcp.status_code == 401
    assert client.get("/api/projects", headers=_bearer(token)).status_code == 401
    assert client.get("/runtime/P1/api/users", headers=_bearer(token)).status_code == 401


def test_admin_basic_has_every_project_and_scope(client: TestClient):
    for project in ("P1", "P2"):
        assert client.get(f"/api/v1/projects/{project}/users", headers=_basic()).status_code == 200
    assert client.get("/api/v1/projects/GHOST/users", headers=_basic()).status_code == 404


def test_basic_needs_the_admin_username(client: TestClient):
    assert client.get("/api/v1/projects/P1/users", headers=_basic(username="ann")).status_code == 401
    # HMI user credentials are never an API key
    hmi = _basic(username="ann", password="ann-secret")
    assert client.get("/api/v1/projects/P1/users", headers=hmi).status_code == 401


def test_wrong_basic_password_locks_out(client: TestClient):
    for _ in range(5):
        resp = client.get("/api/v1/projects/P1/users", headers=_basic("wrong"))
        assert resp.status_code == 401
    assert client.get("/api/v1/projects/P1/users", headers=_basic()).status_code == 429


def _parallel(requests: list[tuple[str, str, dict]]) -> list:
    """Send *requests* (method, url, kwargs) concurrently into the manager app."""
    import httpx
    import manager

    async def run() -> list:
        transport = httpx.ASGITransport(app=manager.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver", timeout=60) as c:
            return await asyncio.gather(*(c.request(m, u, **kw) for m, u, kw in requests))

    return asyncio.run(run())


def test_parallel_wrong_passwords_still_lock_out(client: TestClient):
    responses = _parallel(
        [("GET", "/api/v1/projects/P1/users", {"headers": _basic(f"wrong{i}")}) for i in range(12)]
    )
    codes = sorted(r.status_code for r in responses)
    assert codes.count(401) == 5
    assert codes.count(429) == 7


def test_a_good_basic_call_does_not_reset_the_failure_count(client: TestClient):
    url = "/api/v1/projects/P1/users"
    for _ in range(4):
        assert client.get(url, headers=_basic("wrong")).status_code == 401
    assert client.get(url, headers=_basic()).status_code == 200
    assert client.get(url, headers=_basic("wrong")).status_code == 401  # the fifth failure
    assert client.get(url, headers=_basic()).status_code == 429


def test_token_dies_with_a_password_change(client: TestClient):
    token = _api_token("users:read")
    assert client.get("/api/v1/projects/P1/users", headers=_bearer(token)).status_code == 200
    manager_auth.set_password("rotated")
    assert client.get("/api/v1/projects/P1/users", headers=_bearer(token)).status_code == 401


# ── history ──────────────────────────────────────────────────────────────────


def test_history_pages_raw_samples_in_time_order(client: TestClient):
    token = _api_token("history:read")
    url = "/api/v1/projects/P1/history?variables=ds:a,ds:b&start=1970-01-01T00:00:00&limit=2"
    first = client.get(url, headers=_bearer(token)).json()
    assert [(i["variable"], i["value"]) for i in first["items"]] == [("ds:a", 1.0), ("ds:b", 2.0)]
    assert first["items"][0]["timestamp"] == "1970-01-01T00:16:40+00:00"
    second = client.get(f"{url}&cursor={first['nextCursor']}", headers=_bearer(token)).json()
    assert [(i["variable"], i["value"]) for i in second["items"]] == [("ds:a", 3.0)]
    assert second["nextCursor"] is None


def test_history_csv_carries_the_cursor_in_a_header(client: TestClient):
    url = "/api/v1/projects/P1/history?variables=ds:a&start=1970-01-01T00:00:00&limit=1&format=csv"
    resp = client.get(url, headers=_basic())
    assert resp.headers["content-type"].startswith("text/csv")
    assert resp.text.splitlines() == ["variable,timestamp,value", "ds:a,1970-01-01T00:16:40+00:00,1.0"]
    assert resp.headers["x-next-cursor"]


def test_history_validates_its_query(client: TestClient):
    base = "/api/v1/projects/P1/history?variables=ds:a"
    assert client.get(f"{base}&start=yesterday", headers=_basic()).status_code == 422
    assert client.get(f"{base}&start=-1h&limit=10001", headers=_basic()).status_code == 422
    assert client.get(f"{base}&start=-1h&cursor=nope", headers=_basic()).status_code == 422
    from mcp_server.pagination import encode_cursor

    for ts, row_id in (("1000.0", str(2**63)), ("1000.0", "-1"), ("nan", "1"), ("inf", "1")):
        cursor = encode_cursor(ts, row_id)
        assert client.get(f"{base}&start=-1h&cursor={cursor}", headers=_basic()).status_code == 422


def test_history_does_not_touch_the_database(client: TestClient, tmp_path: Path, monkeypatch):
    from api import v1_api

    opened: list[tuple[tuple, dict]] = []
    real_connect = sqlite3.connect

    def spy(*args, **kwargs):
        opened.append((args, kwargs))
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(v1_api.sqlite3, "connect", spy)
    db = tmp_path / "P1" / "historian" / "history.db"
    before = db.read_bytes()
    client.get("/api/v1/projects/P1/history?variables=ds:a&start=-100000d", headers=_basic())
    assert db.read_bytes() == before
    # The connection the route opens refuses a write outright.
    (args, kwargs), = opened
    conn = real_connect(*args, **kwargs)
    with pytest.raises(sqlite3.OperationalError, match="readonly"):
        conn.execute("INSERT INTO samples (variable, timestamp, value) VALUES ('x', 1, 1)")
    conn.close()


def test_csv_cells_cannot_start_a_formula(client: TestClient, tmp_path: Path):
    state = json.loads((tmp_path / "P1" / "alarm_state.json").read_text())
    state["history"][0]["title"] = '=HYPERLINK("http://evil","x")'
    (tmp_path / "P1" / "alarm_state.json").write_text(json.dumps(state))
    text = client.get("/api/v1/projects/P1/alarms/history?format=csv", headers=_basic()).text
    assert "'=HYPERLINK" in text
    assert ",=HYPERLINK" not in text and '"=HYPERLINK' not in text


def test_a_cross_origin_v1_write_is_refused(client: TestClient, reloads):
    resp = client.put(
        "/api/v1/projects/P1/users/bob",
        json={"groups": ["operator"]},
        headers={"Origin": "http://evil.example", **_basic()},
    )
    assert resp.status_code == 403
    assert reloads == []


# ── alarm history ────────────────────────────────────────────────────────────


def test_alarm_history_orders_by_cleared_at_and_pages(client: TestClient):
    token = _api_token("alarms:read")
    url = "/api/v1/projects/P1/alarms/history?limit=2"
    first = client.get(url, headers=_bearer(token)).json()
    assert [i["id"] for i in first["items"]] == ["h1", "h2"]
    assert first["items"][0] == {
        "id": "h1",
        "alarmId": "a1",
        "code": "E1",
        "level": "error",
        "title": "Overheat",
        "description": "",
        "groupTitle": "",
        "triggeredAt": "2026-11-01T09:00:00+00:00",
        "clearedAt": "2026-11-01T10:00:00+00:00",
        "acked": True,
        "ackedBy": "ann",
        "ackedAt": "2026-11-01T09:30:00+00:00",
    }
    assert first["items"][1]["ackedBy"] is None
    rest = client.get(f"{url}&cursor={first['nextCursor']}", headers=_bearer(token)).json()
    assert [i["id"] for i in rest["items"]] == ["h3"]
    assert rest["nextCursor"] is None


def test_alarm_history_time_range_selects_on_cleared_at(client: TestClient):
    url = "/api/v1/projects/P1/alarms/history?start=2026-11-02T00:00:00&end=2026-11-02T23:59:59"
    assert [i["id"] for i in client.get(url, headers=_basic()).json()["items"]] == ["h2"]
    csv_text = client.get(f"{url}&format=csv", headers=_basic()).text
    assert csv_text.splitlines()[0].startswith("id,alarmId,code")


# ── recipes ──────────────────────────────────────────────────────────────────


def test_recipes_lists_types_and_datasets(client: TestClient):
    token = _api_token("recipes:read")
    body = client.get("/api/v1/projects/P1/recipes", headers=_bearer(token)).json()
    assert body == {
        "datasetTypes": [
            {
                "id": "bake",
                "name": "Bake",
                "loadedDatasetId": "bread",
                "parameters": [{"id": "temp", "label": "Temp", "dataType": "float"}],
                "datasets": [
                    {
                        "id": "bread",
                        "name": "Bread",
                        "description": "",
                        "values": {"temp": 220},
                        "updatedAt": None,
                        "updatedBy": None,
                    }
                ],
            }
        ]
    }


# ── users ────────────────────────────────────────────────────────────────────


@pytest.fixture
def reloads(monkeypatch):
    calls: list[tuple[str, dict]] = []

    async def fake_notify(project_id: str, payload: dict) -> None:
        calls.append((project_id, payload))

    from mcp_server import write_helpers

    monkeypatch.setattr(write_helpers, "notify_child", fake_notify)
    return calls


def test_users_list_is_redacted(client: TestClient, tmp_path: Path):
    body = client.get("/api/v1/projects/P1/users", headers=_bearer(_api_token("users:read"))).json()
    assert body["users"] == [
        {"id": "guest", "username": "guest", "groups": ["guest"], "passwordSet": False},
        {"id": "ann", "username": "ann", "groups": ["operator"], "passwordSet": True},
    ]
    assert body["groups"] == [{"id": "guest", "label": "Guest"}, {"id": "operator", "label": "Operator"}]
    assert "passwordHash" not in json.dumps(body)


def test_put_creates_then_updates_a_user(client: TestClient, tmp_path: Path, reloads):
    headers = _bearer(_api_token("users:write"))
    users_file = tmp_path / "P1" / "users.json"
    ann_hash = next(u for u in json.loads(users_file.read_text())["users"] if u["id"] == "ann")["passwordHash"]
    created = client.put(
        "/api/v1/projects/P1/users/bob",
        json={"username": "bob", "password": "pw", "groups": ["operator"]},
        headers=headers,
    )
    assert created.status_code == 200
    assert created.json() == {"id": "bob", "username": "bob", "groups": ["operator"], "passwordSet": True}
    stored = json.loads((tmp_path / "P1" / "users.json").read_text())["users"]
    bob = next(u for u in stored if u["id"] == "bob")
    assert bob["passwordHash"] and bob["password"] == ""
    # Ann's credential survives a write that did not name her
    assert next(u for u in stored if u["id"] == "ann")["passwordHash"] == ann_hash
    hash_before = bob["passwordHash"]

    client.put("/api/v1/projects/P1/users/ann", json={"groups": ["guest"]}, headers=headers)
    updated = client.put(
        "/api/v1/projects/P1/users/bob", json={"groups": ["guest", "operator"]}, headers=headers
    )
    assert updated.json()["groups"] == ["guest", "operator"]
    stored = json.loads((tmp_path / "P1" / "users.json").read_text())["users"]
    assert next(u for u in stored if u["id"] == "bob")["passwordHash"] == hash_before
    assert [u["id"] for u in stored] == ["guest", "ann", "bob"]  # an update keeps its place
    assert [p for p, _ in reloads] == ["P1", "P1", "P1"]
    assert reloads[0][1]["artifact_type"] == "users"
    assert reloads[0][1]["source"] == "api"


def test_put_validates_with_the_editor_rules(client: TestClient, reloads):
    headers = _basic()
    url = "/api/v1/projects/P1/users"
    assert client.put(f"{url}/bob", json={"groups": ["nope"]}, headers=headers).status_code == 422
    assert client.put(f"{url}/bob", json={}, headers=headers).status_code == 422  # no groups
    assert client.put(f"{url}/bob", json={"role": "x", "groups": ["operator"]}, headers=headers).status_code == 422
    assert client.put(f"{url}/bad id", json={"groups": ["operator"]}, headers=headers).status_code == 422
    assert client.put(f"{url}/guest", json={"password": "x"}, headers=headers).status_code == 422
    assert client.put(f"{url}/guest", json={"groups": ["operator"]}, headers=headers).status_code == 422
    dup = client.put(f"{url}/bob", json={"username": "ann", "groups": ["operator"]}, headers=headers)
    assert dup.status_code == 409
    assert reloads == []


def test_delete_user(client: TestClient, tmp_path: Path, reloads):
    headers = _bearer(_api_token("users:write"))
    assert client.delete("/api/v1/projects/P1/users/ann", headers=headers).json() == {"deleted": "ann"}
    assert client.delete("/api/v1/projects/P1/users/ann", headers=headers).status_code == 404
    assert client.delete("/api/v1/projects/P1/users/guest", headers=headers).status_code == 422
    stored = json.loads((tmp_path / "P1" / "users.json").read_text())["users"]
    assert [u["id"] for u in stored] == ["guest"]
    assert [p for p, _ in reloads] == ["P1"]


def test_parallel_user_writes_all_land(client: TestClient, tmp_path: Path, reloads):
    headers = {"headers": _bearer(_api_token("users:write"))}
    url = "/api/v1/projects/P1/users"
    body = {"json": {"groups": ["operator"]}}
    responses = _parallel([("PUT", f"{url}/u{i}", {**headers, **body}) for i in range(10)])
    assert [r.status_code for r in responses] == [200] * 10
    stored = {u["id"] for u in json.loads((tmp_path / "P1" / "users.json").read_text())["users"]}
    assert stored == {"guest", "ann", *(f"u{i}" for i in range(10))}

    # A delete and an update in parallel both land.
    _parallel([("DELETE", f"{url}/ann", headers), ("PUT", f"{url}/u0", {**headers, **body})])
    stored = {u["id"] for u in json.loads((tmp_path / "P1" / "users.json").read_text())["users"]}
    assert "ann" not in stored and "u0" in stored


def test_users_routes_refuse_a_broken_users_file(client: TestClient, tmp_path: Path, reloads):
    (tmp_path / "P1" / "users.json").write_text("{not json")
    resp = client.put("/api/v1/projects/P1/users/bob", json={"groups": ["guest"]}, headers=_basic())
    assert resp.status_code == 409
    assert (tmp_path / "P1" / "users.json").read_text() == "{not json"


# ── token store ──────────────────────────────────────────────────────────────


def test_a_one_project_token_from_1x_is_refused_not_widened(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: tmp_path)
    manager_auth.set_password(PASSWORD)
    raw = "abc.secret"
    import hashlib

    legacy = {
        "version": 1,
        "tokens": [
            {
                "id": "abc",
                "name": "Old agent",
                "projectId": "P1",
                "access": "read",
                "hash": hashlib.sha256(raw.encode()).hexdigest(),
                "authGeneration": manager_auth.credential_generation(),
                "createdAt": "2026-01-01T00:00:00+00:00",
            }
        ],
    }
    mcp_tokens.tokens_path().write_text(json.dumps(legacy))
    assert mcp_tokens.resolve(raw) is None
    assert mcp_tokens.resolve_api(raw) is None
    # Still listed, without a kind it reads as MCP, so it can be revoked.
    assert mcp_tokens.list_tokens()[0]["kind"] == "mcp"


def test_issue_api_rejects_unknown_or_empty_scopes(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: tmp_path)
    manager_auth.set_password(PASSWORD)
    with pytest.raises(ValueError):
        mcp_tokens.issue_api(scopes=[])
    with pytest.raises(ValueError):
        mcp_tokens.issue_api(scopes=["users:admin"])


def test_dashboard_creates_and_lists_an_api_token(client: TestClient):
    client.post("/api/manager/auth/login", json={"password": PASSWORD})
    body = {"kind": "api", "scopes": ["users:read", "history:read"], "name": "HR"}
    created = client.post("/api/manager/mcp-tokens", json=body)
    assert created.status_code == 201
    issued = created.json()
    assert issued["kind"] == "api" and issued["scopes"] == ["history:read", "users:read"]
    listed = client.get("/api/manager/mcp-tokens").json()["tokens"]
    assert {"kind": "api", "scopes": ["history:read", "users:read"], "name": "HR"}.items() <= next(
        t for t in listed if t["id"] == issued["tokenId"]
    ).items()
    bad = client.post("/api/manager/mcp-tokens", json={"kind": "api", "scopes": ["root"]})
    assert bad.status_code == 422
    assert client.post("/api/manager/mcp-tokens", json={}).status_code == 422
    client.cookies.delete(manager_auth.SESSION_COOKIE)
    assert client.get("/api/v1/projects/P1/users", headers=_bearer(issued["token"])).status_code == 200


@pytest.fixture
def audit_events():
    from core import audit
    from core.storage import current_scoped_project_id

    events: list[tuple[str | None, audit.AuditEvent]] = []

    def listener(event: audit.AuditEvent) -> None:
        events.append((current_scoped_project_id(), event))

    audit.register_listener(listener)
    yield events
    audit.unregister_listener(listener)


def test_user_writes_are_audited_without_secrets(client: TestClient, reloads, audit_events):
    token_id, token = mcp_tokens.issue_api(scopes=["users:write"], name="HR system")
    client.put(
        "/api/v1/projects/P1/users/bob",
        json={"password": "pw-secret", "groups": ["operator"]},
        headers=_bearer(token),
    )
    client.put("/api/v1/projects/P1/users/bob", json={"groups": ["guest"]}, headers=_basic())
    client.put("/api/v1/projects/P1/users/bob", json={"groups": ["nope"]}, headers=_basic())  # 422
    client.delete("/api/v1/projects/P1/users/bob", headers=_bearer(token))

    assert [(project, e.action, e.actor, e.actor_source, e.subject) for project, e in audit_events] == [
        ("P1", "user.save", "HR system", "api", "bob"),
        ("P1", "user.save", "admin", "api", "bob"),
        ("P1", "user.delete", "HR system", "api", "bob"),
    ]
    first, second = audit_events[0][1].detail, audit_events[1][1].detail
    assert first == {
        "tokenId": token_id,
        "created": True,
        "username": "bob",
        "groups": ["operator"],
        "passwordChanged": True,
    }
    assert second["tokenId"] is None and second["created"] is False and second["passwordChanged"] is False
    recorded = repr([e for _, e in audit_events])
    assert "pw-secret" not in recorded and token not in recorded and "pbkdf2" not in recorded


# ── panel sessions ───────────────────────────────────────────────────────────


@pytest.fixture
def child(monkeypatch, tmp_path: Path):
    """P1 running, its loopback hooks served by this process's internal router
    on a fresh WebSocketManager; P2 stays stopped."""
    import httpx
    from api import internal_api
    from core.exceptions import register_exception_handlers
    from fastapi import FastAPI
    from mcp_server import write_helpers
    from services import users_manager
    from services.supervisor import supervisor
    from services.websocket_manager import WebSocketManager

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(internal_api.router)
    loopback = httpx.AsyncClient(transport=httpx.ASGITransport(app=app))
    manager = WebSocketManager()
    monkeypatch.setattr(internal_api, "websocket_manager", manager)
    monkeypatch.setattr(users_manager, "users_path", lambda: tmp_path / "P1" / "users.json")
    monkeypatch.setattr(supervisor, "port_for", lambda pid: 9 if pid == "P1" else None)
    monkeypatch.setattr(write_helpers, "loopback_client", lambda: loopback)
    return manager


def _open_tab(manager, client_id: str, panel: str | None = None, *, editor: bool = False):
    from conftest import FakeWebSocket

    ws = FakeWebSocket()
    manager._connections[client_id] = ws
    manager._client_users[client_id] = {}
    if editor:
        manager._editor_clients.add(client_id)
    msg = {"type": "request_identity", "scope": f"runtime:{client_id}"}
    if panel is not None:
        msg["panel"] = panel
    asyncio.run(manager.handle_message(client_id, json.dumps(msg)))
    return ws


def test_panel_routes_need_the_sessions_write_scope(client: TestClient, child):
    _open_tab(child, "c1", "line-a")
    calls = [
        ("GET", "/api/v1/projects/P1/panels", None),
        ("POST", "/api/v1/projects/P1/panels/line-a/login", {"username": "ann", "password": "ann-secret"}),
        ("POST", "/api/v1/projects/P1/panels/line-a/logout", None),
    ]
    for method, url, body in calls:
        assert client.request(method, url, json=body).status_code == 401
        users = _bearer(_api_token("users:write", "users:read"))
        assert client.request(method, url, json=body, headers=users).status_code == 403
    assert child._client_users["c1"]["runtime:c1"]["username"] == "guest"


def test_panel_routes_need_a_running_project(client: TestClient, child):
    assert client.get("/api/v1/projects/P2/panels", headers=_basic()).status_code == 409
    resp = client.post(
        "/api/v1/projects/P2/panels/line-a/login",
        json={"username": "ann", "password": "ann-secret"},
        headers=_basic(),
    )
    assert resp.status_code == 409


def test_panel_login_reaches_only_that_panels_connections(client: TestClient, child):
    tabs = {
        "a1": _open_tab(child, "a1", "line-a"),
        "a2": _open_tab(child, "a2", "line-a"),
        "b1": _open_tab(child, "b1", "line-b"),
        "unnamed": _open_tab(child, "unnamed"),
        "bad-name": _open_tab(child, "bad-name", "line a"),
        "editor": _open_tab(child, "editor", "line-a", editor=True),
    }
    seen = {cid: len(ws.messages) for cid, ws in tabs.items()}
    headers = _bearer(_api_token("sessions:write"))

    resp = client.post(
        "/api/v1/projects/P1/panels/line-a/login",
        json={"username": "ann", "password": "ann-secret"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json() == {"panel": "line-a", "username": "ann", "groups": ["operator"]}
    for cid, ws in tabs.items():
        new = ws.messages[seen[cid]:]
        if cid in ("a1", "a2"):
            assert [(m["type"], m["scope"], m["username"]) for m in new] == [("user_identity", f"runtime:{cid}", "ann")]
            assert new[0]["sessionToken"] and "requestId" not in new[0]
        else:
            assert new == []
    assert tabs["a1"].messages[-1]["sessionToken"] == tabs["a2"].messages[-1]["sessionToken"]

    assert client.get("/api/v1/projects/P1/panels", headers=headers).json() == {
        "panels": [
            {"name": "line-a", "connections": 2, "users": ["ann"]},
            {"name": "line-b", "connections": 1, "users": ["guest"]},
        ]
    }

    resp = client.post("/api/v1/projects/P1/panels/line-a/logout", headers=headers)
    assert resp.json() == {"panel": "line-a", "signedOut": ["ann"]}
    for cid in ("a1", "a2"):
        last = tabs[cid].messages[-1]
        assert last["username"] == "guest" and "sessionToken" not in last
    assert child._sessions == {}


def test_panel_login_unknown_panel_is_404(client: TestClient, child):
    _open_tab(child, "c1", "line-a")
    body = {"username": "ann", "password": "ann-secret"}
    for panel in ("line-z", "line%20a", "x" * 65):
        url = f"/api/v1/projects/P1/panels/{panel}"
        assert client.post(f"{url}/login", json=body, headers=_basic()).status_code == 404
        assert client.post(f"{url}/logout", headers=_basic()).status_code == 404


def test_panel_login_wrong_password_is_401_then_throttled(client: TestClient, child):
    ws = _open_tab(child, "c1", "line-a")
    seen = len(ws.messages)
    url = "/api/v1/projects/P1/panels/line-a/login"
    headers = _bearer(_api_token("sessions:write"))
    for _ in range(5):
        resp = client.post(url, json={"username": "ann", "password": "nope"}, headers=headers)
        assert resp.status_code == 401
        assert "www-authenticate" not in resp.headers  # the API credential was fine
    # The WS login's per-username throttle: now even the right password waits.
    assert client.post(url, json={"username": "ann", "password": "ann-secret"}, headers=headers).status_code == 429
    assert client.post(url, json={"username": "ann"}, headers=headers).status_code == 422
    assert ws.messages[seen:] == []


def test_panel_sign_in_and_out_are_audited(client: TestClient, child, audit_events):
    _open_tab(child, "c1", "line-a")
    token_id, token = mcp_tokens.issue_api(scopes=["sessions:write"], name="Badge reader")
    client.post(
        "/api/v1/projects/P1/panels/line-a/login",
        json={"username": "ann", "password": "ann-secret"},
        headers=_bearer(token),
    )
    client.post(
        "/api/v1/projects/P1/panels/line-a/login",
        json={"username": "ann", "password": "wrong"},
        headers=_bearer(token),
    )
    client.post("/api/v1/projects/P1/panels/line-a/logout", headers=_basic())

    assert [(p, e.action, e.actor, e.actor_source, e.subject, e.detail) for p, e in audit_events] == [
        ("P1", "user.login", "Badge reader", "api", "line-a",
         {"tokenId": token_id, "username": "ann", "groups": ["operator"]}),
        ("P1", "user.logout", "admin", "api", "line-a", {"tokenId": None, "signedOut": ["ann"]}),
    ]
    assert "ann-secret" not in repr(audit_events)


def test_panel_logout_reaches_tabs_that_resumed_the_login_elsewhere(client: TestClient, child):
    from services.websocket_manager import _auto_login_identity

    tabs = {cid: _open_tab(child, cid, "line-a") for cid in ("a1", "a2")}
    headers = _basic()
    url = "/api/v1/projects/P1/panels/line-a"
    client.post(f"{url}/login", json={"username": "ann", "password": "ann-secret"}, headers=headers)
    token = tabs["a2"].messages[-1]["sessionToken"]

    def detach() -> None:
        # The same tab reloads without ?panel (or under another name) and resumes ann.
        asyncio.run(child.handle_message("a2", json.dumps(
            {"type": "request_identity", "scope": "runtime:a2", "sessionToken": token}
        )))
        assert tabs["a2"].messages[-1]["username"] == "ann" and "a2" not in child._client_panels

    detach()
    assert client.post(f"{url}/logout", headers=headers).json()["signedOut"] == ["ann"]
    held = [i["username"] for scopes in child._client_users.values() for i in scopes.values()]
    assert held == ["guest", "guest"] and child._sessions == {}

    # A new sign-in on the panel revokes the login a detached tab still carries.
    tabs["a2"] = _open_tab(child, "a2", "line-a")
    client.post(f"{url}/login", json={"username": "ann", "password": "ann-secret"}, headers=headers)
    token = tabs["a2"].messages[-1]["sessionToken"]
    detach()
    client.post(f"{url}/login", json={"username": "ann", "password": "ann-secret"}, headers=headers)
    assert child._client_users["a2"]["runtime:a2"] == _auto_login_identity({"users": []})
    assert token not in child._sessions


def test_panel_login_is_404_when_the_panel_closes_during_the_check(client: TestClient, child, monkeypatch):
    from services import users_manager

    _open_tab(child, "c1", "line-a")
    real = users_manager.authenticate

    async def slow_check(username, password, address):
        result = await real(username, password, address)
        await child.disconnect("c1")
        return result

    monkeypatch.setattr(users_manager, "authenticate", slow_check)
    resp = client.post(
        "/api/v1/projects/P1/panels/line-a/login",
        json={"username": "ann", "password": "ann-secret"},
        headers=_basic(),
    )
    assert resp.status_code == 404
    assert child._sessions == {} and "c1" not in child._client_users
