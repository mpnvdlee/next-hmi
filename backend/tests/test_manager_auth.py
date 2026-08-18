"""Device-admin password + session token unit tests."""
from __future__ import annotations

import time
from pathlib import Path

import pytest
from core import manager_auth, runtime_home


@pytest.fixture(autouse=True)
def home(monkeypatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: tmp_path)
    return tmp_path


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


def test_rotating_password_invalidates_tokens() -> None:
    manager_auth.set_password("pw")
    token = manager_auth.issue_token()
    assert manager_auth.verify_token(token) is True
    time.sleep(0.001)
    manager_auth.set_password("new")  # rotates the signing secret
    assert manager_auth.verify_token(token) is False


@pytest.fixture(autouse=True)
def _reset_throttle():
    manager_auth.register_login_success()
    yield
    manager_auth.register_login_success()


def test_login_throttle_trips_after_threshold() -> None:
    assert manager_auth.lockout_remaining() == 0.0
    for _ in range(manager_auth._LOCKOUT_THRESHOLD - 1):
        manager_auth.register_login_failure()
        assert manager_auth.lockout_remaining() == 0.0
    manager_auth.register_login_failure()  # crosses the threshold
    assert manager_auth.lockout_remaining() > 0.0


def test_login_success_clears_lockout() -> None:
    for _ in range(manager_auth._LOCKOUT_THRESHOLD):
        manager_auth.register_login_failure()
    assert manager_auth.lockout_remaining() > 0.0
    manager_auth.register_login_success()
    assert manager_auth.lockout_remaining() == 0.0
