"""First-run setup demands the one-time code the device printed at startup.

Without it, a website that points a name of its own at the device (DNS
rebinding) passes the Origin check and claims an unconfigured install.
"""
from __future__ import annotations

import argparse
import logging
import re
from pathlib import Path

import pytest
from core import manager_auth, runtime_home
from fastapi.testclient import TestClient

SETUP = "/api/manager/auth/setup"


@pytest.fixture
def home(monkeypatch, tmp_path: Path) -> Path:
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir()
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home_dir))
    return home_dir


@pytest.fixture(autouse=True)
def _reset_throttle():
    manager_auth.reset_throttle()
    yield
    manager_auth.reset_throttle()


@pytest.fixture
def client(monkeypatch, home: Path):
    import manager

    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
    with TestClient(manager.app) as tc:
        yield tc


def _password_set(client: TestClient) -> bool:
    return client.get("/api/manager/auth/status").json()["passwordSet"]


def test_code_is_eight_unambiguous_characters_and_stable_until_used(home: Path) -> None:
    code = manager_auth.setup_code()
    assert code is not None
    assert re.fullmatch(r"[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}", code)
    assert manager_auth.setup_code() == code


@pytest.mark.parametrize("body", [{"password": "secret-pw"}, {"password": "secret-pw", "setupCode": "  "}])
def test_setup_without_the_code_is_refused(client: TestClient, body: dict) -> None:
    resp = client.post(SETUP, json=body)

    assert resp.status_code == 422
    assert resp.json()["detail"].startswith("Enter the setup code.")
    assert _password_set(client) is False


def test_wrong_code_is_refused_and_counted_by_the_lockout(client: TestClient) -> None:
    code = manager_auth.setup_code()
    assert code is not None
    wrong = "AAAA-AAAA" if code != "AAAA-AAAA" else "BBBB-BBBB"

    for _ in range(manager_auth._LOCKOUT_THRESHOLD):
        resp = client.post(SETUP, json={"password": "secret-pw", "setupCode": wrong})
        assert resp.status_code == 422
        assert resp.json()["detail"].startswith("Incorrect setup code.")

    # Locked out like a wrong password: even the right code waits.
    assert manager_auth.lockout_remaining("testclient") > 0
    locked = client.post(SETUP, json={"password": "secret-pw", "setupCode": code})
    assert locked.status_code == 429
    assert _password_set(client) is False


def test_right_code_sets_the_password_and_signs_in(client: TestClient) -> None:
    code = manager_auth.setup_code()

    resp = client.post(SETUP, json={"password": "secret-pw", "setupCode": code})

    assert resp.status_code == 200
    assert resp.json() == {"authenticated": True}
    assert client.get("/api/manager/running").status_code == 200


def test_code_is_read_as_typed_from_a_terminal(client: TestClient) -> None:
    code = manager_auth.setup_code()
    assert code is not None
    typed = f" {code.replace('-', '').lower()} "

    assert client.post(SETUP, json={"password": "secret-pw", "setupCode": typed}).status_code == 200


def test_code_is_spent_once_the_password_is_set(client: TestClient) -> None:
    code = manager_auth.setup_code()
    assert code is not None
    client.post(SETUP, json={"password": "secret-pw", "setupCode": code})

    assert manager_auth.setup_code() is None
    assert manager_auth.verify_setup_code(code) is False
    again = client.post(SETUP, json={"password": "taken-over", "setupCode": code})
    assert again.status_code == 409
    assert manager_auth.verify_password("secret-pw") is True


@pytest.mark.parametrize("path", ["/api/manager/mcp/pair", "/api/manager/peer/pair"])
def test_pairing_stays_closed_until_a_password_is_set(client: TestClient, path: str) -> None:
    """Pairing hands out a long-lived token for the device-admin password, so
    before one exists there must be nothing it accepts, the setup code included."""
    code = manager_auth.setup_code()
    for password in ("", "anything", code):
        resp = client.post(path, json={"password": password, "access": "read", "name": "probe"})
        assert resp.status_code in (422, 403), resp.text
    assert _password_set(client) is False


def test_manager_logs_the_code_at_startup(monkeypatch, home: Path, caplog) -> None:
    import manager

    monkeypatch.setattr(manager, "configure_logging", lambda **_kwargs: None)
    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)

    with caplog.at_level(logging.WARNING, logger="manager"), TestClient(manager.app):
        pass

    code = manager_auth.setup_code()
    assert code is not None
    assert any(code in record.getMessage() for record in caplog.records)


def test_manager_logs_no_code_once_a_password_is_set(monkeypatch, home: Path, caplog) -> None:
    import manager

    manager_auth.set_password("secret")
    monkeypatch.setattr(manager, "configure_logging", lambda **_kwargs: None)
    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)

    with caplog.at_level(logging.WARNING, logger="manager"), TestClient(manager.app):
        pass

    assert not any("Setup code" in record.getMessage() for record in caplog.records)


@pytest.mark.parametrize("password_set", [False, True])
def test_launcher_banner_carries_the_code_the_manager_checks(
    monkeypatch, home: Path, password_set: bool
) -> None:
    import launcher
    from api import system_api
    from core import tls_settings

    if password_set:
        manager_auth.set_password("secret")
    monkeypatch.setenv("NEXTHMI_PORT", "8000")
    monkeypatch.setenv("NEXTHMI_HTTPS_PORT", "8443")
    for name in ("NEXTHMI_SSL_CERTFILE", "NEXTHMI_SSL_KEYFILE"):
        monkeypatch.delenv(name, raising=False)

    banners = []
    monkeypatch.setattr(launcher, "_load_manager_app", lambda: object())
    monkeypatch.setattr(launcher, "_serve", lambda *args, **kwargs: None)
    monkeypatch.setattr(launcher, "_resolve_port_conflict", lambda host, port: port)
    monkeypatch.setattr(launcher, "print_banner", lambda mode, fields: banners.append(fields))
    monkeypatch.setattr(launcher, "_apply_pending_restart", lambda: None)
    monkeypatch.setattr(system_api, "apply_pending_restart", lambda: None)
    tls_settings.mark_served(False, None)

    args = argparse.Namespace(verbose=False, port=None, https_port=None)
    assert launcher._run_manager(home, args) == 0

    assert len(banners) == 1
    expected = None if password_set else manager_auth.setup_code()
    assert banners[0].setup_code == expected
    if not password_set:
        assert manager_auth.verify_setup_code(banners[0].setup_code) is True
