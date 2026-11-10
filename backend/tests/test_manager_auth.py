"""Device-admin password, server-side sessions and the per-address sign-in throttle."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from core import manager_auth, mcp_tokens, peer_tokens, runtime_home
from core.exceptions import RateLimitError
from fastapi.testclient import TestClient

_BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def home(monkeypatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: tmp_path)
    return tmp_path


@pytest.fixture(autouse=True)
def _reset_throttle():
    manager_auth.reset_throttle()
    yield
    manager_auth.reset_throttle()


def _stored(home: Path) -> dict:
    return json.loads((home / ".manager-auth.json").read_text(encoding="utf-8"))


def test_password_lifecycle() -> None:
    assert manager_auth.is_password_set() is False
    manager_auth.set_password("hunter2")
    assert manager_auth.is_password_set() is True
    assert manager_auth.verify_password("hunter2") is True
    assert manager_auth.verify_password("wrong") is False


def test_token_roundtrip() -> None:
    manager_auth.set_password("pw")
    token = manager_auth.issue_token()
    assert manager_auth.verify_token(token) is True
    assert manager_auth.verify_token(None) is False
    assert manager_auth.verify_token("garbage") is False
    assert manager_auth.verify_token(token + "x") is False


def test_expired_token_rejected() -> None:
    manager_auth.set_password("pw")
    token = manager_auth.issue_token(ttl_seconds=-1)
    assert manager_auth.verify_token(token) is False


def test_default_session_expires_after_a_day(home: Path) -> None:
    manager_auth.set_password("pw")
    before = int(time.time())
    manager_auth.issue_token()
    (exp,) = _stored(home)["sessions"].values()
    assert before + 24 * 3600 <= exp <= int(time.time()) + 24 * 3600


def test_the_file_holds_no_usable_token(home: Path) -> None:
    manager_auth.set_password("pw")
    token = manager_auth.issue_token()
    raw = (home / ".manager-auth.json").read_text(encoding="utf-8")
    assert token not in raw
    assert hashlib.sha256(token.encode()).hexdigest() in raw


def test_rotating_password_invalidates_tokens() -> None:
    manager_auth.set_password("pw")
    token = manager_auth.issue_token()
    assert manager_auth.verify_token(token) is True
    manager_auth.set_password("new")
    assert manager_auth.verify_token(token) is False


def test_revoking_one_session_leaves_the_others() -> None:
    manager_auth.set_password("pw")
    mine, theirs = manager_auth.issue_token(), manager_auth.issue_token()
    manager_auth.revoke_token(mine)
    assert manager_auth.verify_token(mine) is False
    assert manager_auth.verify_token(theirs) is True


def test_revoking_every_session_keeps_the_token_generation() -> None:
    manager_auth.set_password("pw")
    generation = manager_auth.credential_generation()
    tokens = [manager_auth.issue_token() for _ in range(3)]
    manager_auth.revoke_all_sessions()
    assert not any(manager_auth.verify_token(t) for t in tokens)
    # MCP, API and peer tokens are bound to this and must keep resolving.
    assert manager_auth.credential_generation() == generation


def test_sessions_are_capped_and_the_oldest_ends_first(monkeypatch) -> None:
    monkeypatch.setattr(manager_auth, "_MAX_SESSIONS", 3)
    manager_auth.set_password("pw")
    tokens = [manager_auth.issue_token(ttl_seconds=100 + i) for i in range(4)]
    assert [manager_auth.verify_token(t) for t in tokens] == [False, True, True, True]


def test_expired_sessions_are_pruned_on_the_next_sign_in(home: Path) -> None:
    manager_auth.set_password("pw")
    manager_auth.issue_token(ttl_seconds=-1)
    manager_auth.issue_token()
    assert len(_stored(home)["sessions"]) == 1


def test_an_ended_session_stays_ended_after_a_restart(home: Path) -> None:
    """A fresh process reads the sessions from disk: nothing ended comes back."""
    manager_auth.set_password("pw")
    kept, signed_out, everywhere = (manager_auth.issue_token() for _ in range(3))
    manager_auth.revoke_token(signed_out)
    script = (
        "import json, sys\n"
        "from core import manager_auth\n"
        "print(json.dumps([manager_auth.verify_token(t) for t in sys.argv[1:]]))\n"
    )

    def verified_in_a_new_process(*tokens: str) -> list[bool]:
        proc = subprocess.run(
            [sys.executable, "-c", script, *tokens],
            cwd=_BACKEND,
            env={**os.environ, "NEXTHMI_DATA_DIR": str(home)},
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(proc.stdout.strip().splitlines()[-1])

    assert verified_in_a_new_process(kept, signed_out, everywhere) == [True, False, True]
    manager_auth.revoke_all_sessions()
    assert verified_in_a_new_process(kept, everywhere) == [False, False]


# ── password hashing ─────────────────────────────────────────────────────────


def test_new_hashes_use_600k_iterations(home: Path) -> None:
    manager_auth.set_password("pw")
    assert _stored(home)["iterations"] == 600_000


def test_a_200k_hash_verifies_and_is_upgraded_keeping_secret_and_sessions(
    monkeypatch, home: Path
) -> None:
    salt = bytes.fromhex("00" * 16)
    legacy = {
        "salt": salt.hex(),
        "hash": hashlib.pbkdf2_hmac("sha256", b"short", salt, 200_000).hex(),
        "iterations": 200_000,
        "secret": "ab" * 32,
        "sessions": {},
    }
    (home / ".manager-auth.json").write_text(json.dumps(legacy), encoding="utf-8")
    token = manager_auth.issue_token()

    assert manager_auth.verify_password("wrong") is False
    assert _stored(home)["iterations"] == 200_000  # a miss upgrades nothing
    assert manager_auth.verify_password("short") is True

    upgraded = _stored(home)
    assert upgraded["iterations"] == 600_000
    assert upgraded["hash"] != legacy["hash"]
    assert upgraded["secret"] == legacy["secret"]
    assert manager_auth.verify_token(token) is True
    monkeypatch.setattr(manager_auth, "_verified", None)  # make the next check derive again
    assert manager_auth.verify_password("short") is True
    assert manager_auth.verify_password("wrong") is False


def test_a_verified_password_is_not_derived_again(monkeypatch) -> None:
    manager_auth.set_password("pw-for-basic")
    assert manager_auth.verify_password("pw-for-basic") is True
    calls: list[int] = []
    real = manager_auth._hash_password

    def counting(password: str, salt: bytes, iterations: int) -> bytes:
        calls.append(iterations)
        return real(password, salt, iterations)

    monkeypatch.setattr(manager_auth, "_hash_password", counting)
    assert manager_auth.verify_password("pw-for-basic") is True
    assert calls == []
    assert manager_auth.verify_password("pw-for-basix") is False
    assert calls == [600_000]  # a wrong password still pays in full
    manager_auth.set_password("pw-for-basic")  # same text, new hash: no stale match
    calls.clear()
    assert manager_auth.verify_password("pw-for-basic") is True
    assert calls == [600_000]


# ── throttle ─────────────────────────────────────────────────────────────────


def test_login_throttle_trips_after_threshold() -> None:
    assert manager_auth.lockout_remaining("10.0.0.5") == 0.0
    for _ in range(manager_auth._LOCKOUT_THRESHOLD - 1):
        manager_auth.register_login_failure("10.0.0.5")
        assert manager_auth.lockout_remaining("10.0.0.5") == 0.0
    manager_auth.register_login_failure("10.0.0.5")  # crosses the threshold
    assert manager_auth.lockout_remaining("10.0.0.5") > 0.0


def test_a_locked_address_does_not_lock_the_others() -> None:
    for _ in range(manager_auth._LOCKOUT_THRESHOLD):
        manager_auth.register_login_failure("10.0.0.5")
    assert manager_auth.lockout_remaining("10.0.0.5") > 0.0
    assert manager_auth.lockout_remaining("10.0.0.6") == 0.0
    manager_auth.require_not_locked_out("10.0.0.6")


def test_login_success_clears_only_that_address() -> None:
    for address in ("10.0.0.5", "10.0.0.6"):
        for _ in range(manager_auth._LOCKOUT_THRESHOLD - 1):
            manager_auth.register_login_failure(address)
    manager_auth.register_login_success("10.0.0.5")
    manager_auth.register_login_failure("10.0.0.5")
    manager_auth.register_login_failure("10.0.0.6")
    assert manager_auth.lockout_remaining("10.0.0.5") == 0.0
    assert manager_auth.lockout_remaining("10.0.0.6") > 0.0


def test_a_locked_address_is_refused_with_its_remaining_seconds() -> None:
    for _ in range(manager_auth._LOCKOUT_THRESHOLD):
        manager_auth.register_login_failure("10.0.0.5")
    with pytest.raises(RateLimitError) as refused:
        manager_auth.require_not_locked_out("10.0.0.5")
    assert refused.value.retry_after == 60
    assert refused.value.fields == {"clientAddress": "10.0.0.5"}
    assert "10.0.0.5" in refused.value.message


def test_failures_spread_over_many_addresses_lock_everyone() -> None:
    per_address = manager_auth._LOCKOUT_THRESHOLD - 1  # none of them locks itself
    addresses = [f"10.1.{i // 256}.{i % 256}" for i in range(manager_auth._GLOBAL_THRESHOLD)]
    for i in range(manager_auth._GLOBAL_THRESHOLD - 1):
        manager_auth.register_login_failure(addresses[i // per_address])
    manager_auth.require_not_locked_out("10.9.9.9")
    manager_auth.register_login_failure(addresses[-1])

    with pytest.raises(RateLimitError) as refused:
        manager_auth.require_not_locked_out("10.9.9.9")
    assert refused.value.retry_after == 60
    assert "clientAddress" not in refused.value.fields


def test_the_global_count_starts_over_each_window(monkeypatch) -> None:
    clock = [1000.0]
    monkeypatch.setattr(manager_auth.time, "monotonic", lambda: clock[0])
    for i in range(manager_auth._GLOBAL_THRESHOLD - 1):
        manager_auth.register_login_failure(f"10.2.0.{i % 250}")
    clock[0] += manager_auth._GLOBAL_WINDOW_SECONDS
    manager_auth.register_login_failure("10.3.0.1")
    manager_auth.require_not_locked_out("10.9.9.9")


def test_the_address_table_is_capped_oldest_first(monkeypatch) -> None:
    monkeypatch.setattr(manager_auth, "_MAX_TRACKED_ADDRESSES", 3)
    for address in ("a", "b", "c", "d"):
        manager_auth.register_login_failure(address)
    assert list(manager_auth._failures) == ["b", "c", "d"]
    manager_auth.register_login_failure("b")  # a new failure makes it the newest
    manager_auth.register_login_failure("e")
    assert list(manager_auth._failures) == ["d", "b", "e"]


# ── the routes ───────────────────────────────────────────────────────────────

PASSWORD = "device-admin"
RUNNING = "/api/manager/running"


@pytest.fixture
def app(monkeypatch, home: Path):
    import manager

    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home))
    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
    # asyncio.Lock binds to the first loop that waits on it; each test has its own.
    monkeypatch.setattr(manager_auth, "_password_lock", asyncio.Lock())
    manager_auth.set_password(PASSWORD)
    return manager.app


def _browser(app, address: str = "10.0.0.5") -> TestClient:
    return TestClient(app, client=(address, 50000), raise_server_exceptions=False)


def _signed_in(app, address: str = "10.0.0.5") -> TestClient:
    browser = _browser(app, address)
    assert browser.post("/api/manager/auth/login", json={"password": PASSWORD}).status_code == 200
    return browser


def test_a_locked_address_gets_429_and_another_still_signs_in(app) -> None:
    guesser, admin = _browser(app, "10.0.0.5"), _browser(app, "10.0.0.6")
    for _ in range(manager_auth._LOCKOUT_THRESHOLD):
        bad = guesser.post("/api/manager/auth/login", json={"password": "wrong"})
        assert bad.status_code == 422

    locked = guesser.post("/api/manager/auth/login", json={"password": PASSWORD})
    assert locked.status_code == 429
    assert locked.headers["retry-after"] == "60"
    assert locked.json() == {
        "detail": "Too many failed attempts from 10.0.0.5. Try again in 60s.",
        "retryAfter": 60,
        "clientAddress": "10.0.0.5",
    }
    assert admin.post("/api/manager/auth/login", json={"password": PASSWORD}).status_code == 200


def _basic(password: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"admin:{password}".encode()).decode()}


@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("post", "/api/manager/auth/login", {"json": {"password": "wrong"}}),
        (
            "post",
            "/api/manager/auth/change-password",
            {"json": {"currentPassword": "wrong", "newPassword": "long-enough"}},
        ),
        ("post", "/api/manager/mcp/pair", {"json": {"password": "wrong", "access": "read"}}),
        ("post", "/api/manager/peer/pair", {"json": {"password": "wrong"}}),
        ("get", "/api/v1/projects/P1/users", {"headers": _basic("wrong")}),
    ],
)
def test_every_admin_path_locks_only_the_address_it_was_tried_from(
    app, method: str, path: str, kwargs: dict
) -> None:
    guesser = _browser(app, "10.0.0.5")
    for _ in range(manager_auth._LOCKOUT_THRESHOLD):
        assert getattr(guesser, method)(path, **kwargs).status_code in (401, 422)

    assert getattr(guesser, method)(path, **kwargs).status_code == 429
    assert guesser.post("/api/manager/auth/login", json={"password": PASSWORD}).status_code == 429
    other = _browser(app, "10.0.0.6")
    assert other.post("/api/manager/auth/login", json={"password": PASSWORD}).status_code == 200


def test_parallel_wrong_logins_from_one_address_still_lock_it_after_five(app) -> None:
    async def run() -> list[int]:
        transport = httpx.ASGITransport(app=app, client=("10.0.0.5", 50000))
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            responses = await asyncio.gather(
                *(c.post("/api/manager/auth/login", json={"password": f"w{i}"}) for i in range(12))
            )
        return sorted(r.status_code for r in responses)

    codes = asyncio.run(run())
    assert codes.count(422) == manager_auth._LOCKOUT_THRESHOLD
    assert codes.count(429) == 12 - manager_auth._LOCKOUT_THRESHOLD


def test_logout_ends_the_session_on_the_server(app) -> None:
    browser = _signed_in(app)
    token = browser.cookies[manager_auth.SESSION_COOKIE]
    assert browser.post("/api/manager/auth/logout").status_code == 200

    # Replaying the cookie someone copied before the logout opens nothing.
    replay = _browser(app, "10.0.0.7")
    replay.cookies.set(manager_auth.SESSION_COOKIE, token)
    assert replay.get(RUNNING).status_code == 401
    assert replay.get("/api/manager/auth/status").json()["authenticated"] is False


def test_logout_everywhere_ends_every_browser_session_and_no_token(app) -> None:
    caller, other = _signed_in(app, "10.0.0.5"), _signed_in(app, "10.0.0.6")
    _, mcp_token = mcp_tokens.issue(access="read")
    _, api_token = mcp_tokens.issue_api(scopes=["users:read"])
    _, peer_token = peer_tokens.issue()

    resp = caller.post("/api/manager/auth/logout-everywhere")

    assert resp.status_code == 200
    assert resp.json() == {"authenticated": False}
    assert caller.get(RUNNING).status_code == 401
    assert other.get(RUNNING).status_code == 401
    assert mcp_tokens.resolve(mcp_token) is not None
    assert mcp_tokens.resolve_api(api_token) is not None
    assert peer_tokens.verify(peer_token) is True


def test_logout_everywhere_needs_a_session_and_a_same_origin_page(app) -> None:
    other = _signed_in(app, "10.0.0.6")
    anonymous = _browser(app, "10.0.0.5").post("/api/manager/auth/logout-everywhere")
    assert anonymous.status_code == 401
    assert anonymous.json()["code"] == "manager_session_required"

    signed_in = _signed_in(app, "10.0.0.5")
    cross_site = signed_in.post(
        "/api/manager/auth/logout-everywhere", headers={"Origin": "http://evil.example"}
    )
    assert cross_site.status_code == 403
    assert other.get(RUNNING).status_code == 200


def test_changing_the_password_ends_every_other_session_but_the_callers(app) -> None:
    caller, other = _signed_in(app, "10.0.0.5"), _signed_in(app, "10.0.0.6")
    resp = caller.post(
        "/api/manager/auth/change-password",
        json={"currentPassword": PASSWORD, "newPassword": "a-new-password"},
    )
    assert resp.status_code == 200
    assert caller.get(RUNNING).status_code == 200
    assert other.get(RUNNING).status_code == 401


def test_setup_refuses_a_password_under_eight_characters(monkeypatch, home: Path) -> None:
    import manager

    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home))
    browser = _browser(manager.app)
    short = browser.post(
        "/api/manager/auth/setup",
        json={"password": "seven77", "setupCode": manager_auth.setup_code()},
    )
    assert short.status_code == 422
    assert short.json() == {"detail": "Choose a password of at least 8 characters."}
    assert manager_auth.is_password_set() is False

    ok = browser.post(
        "/api/manager/auth/setup",
        json={"password": "eight888", "setupCode": manager_auth.setup_code()},
    )
    assert ok.status_code == 200


def test_change_password_refuses_a_new_password_under_eight_characters(app) -> None:
    browser = _signed_in(app)
    resp = browser.post(
        "/api/manager/auth/change-password",
        json={"currentPassword": PASSWORD, "newPassword": "seven77"},
    )
    assert resp.status_code == 422
    assert resp.json() == {"detail": "Choose a password of at least 8 characters."}
    assert manager_auth.verify_password(PASSWORD) is True


def test_an_existing_short_password_still_signs_in_and_changes(app) -> None:
    manager_auth.set_password("short")
    browser = _browser(app)
    assert browser.post("/api/manager/auth/login", json={"password": "short"}).status_code == 200
    resp = browser.post(
        "/api/manager/auth/change-password",
        json={"currentPassword": "short", "newPassword": "long-enough"},
    )
    assert resp.status_code == 200
