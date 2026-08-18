"""Operator-managed HTTPS: certificate generation, the toggle, and the restart."""
from __future__ import annotations

import os
import ssl
import stat
from pathlib import Path

import launcher
import pytest
from core import runtime_home, tls_settings
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def home(monkeypatch, tmp_path: Path) -> Path:
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setenv("NEXTHMI_DATA_DIR", str(home_dir))
    for name in ("NEXTHMI_SSL_CERTFILE", "NEXTHMI_SSL_KEYFILE"):
        monkeypatch.delenv(name, raising=False)
    # `tls_settings.mark_served` sets process-level module state (it mirrors
    # what the launcher records once at startup), so tests that call it must
    # not leak that into whichever test runs next.
    tls_settings.mark_served(False, None)
    yield home_dir
    tls_settings.mark_served(False, None)


def test_defaults_to_plain_http(home: Path) -> None:
    assert tls_settings.is_enabled() is False
    assert tls_settings.resolve() is None
    assert tls_settings.status()["enabled"] is False
    assert launcher._resolve_tls(home) == {}


def test_generated_certificate_is_usable_and_private(home: Path) -> None:
    tls_settings.generate_self_signed()
    pair = tls_settings.paths()

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(pair.certfile), str(pair.keyfile))

    mode = stat.S_IMODE(pair.keyfile.stat().st_mode)
    assert mode == 0o600, oct(mode)


def test_generated_certificate_covers_localhost(home: Path) -> None:
    described = tls_settings.generate_self_signed()
    assert "localhost" in described["names"]
    assert "127.0.0.1" in described["names"]
    assert len(described["fingerprint"]) == 64


def test_generated_certificate_outlives_the_machine(home: Path) -> None:
    """A panel outliving its certificate by 18 years is the worse failure."""
    described = tls_settings.generate_self_signed()
    assert described["expiresInDays"] > 365 * 19
    assert described["expiring"] is False
    assert described["expired"] is False


def test_corrupt_certificate_reports_as_a_tls_error_not_a_crash(home: Path) -> None:
    """A truncated/garbled cert.pem must not escape as a bare ValueError."""
    tls_dir = tls_settings.tls_dir(home)
    tls_dir.mkdir(parents=True, exist_ok=True)
    (tls_dir / "cert.pem").write_text(
        "-----BEGIN CERTIFICATE-----\nZ2FyYmFnZQ==\n-----END CERTIFICATE-----\n",
        encoding="utf-8",
    )
    (tls_dir / "key.pem").write_text("not a key", encoding="utf-8")
    tls_settings.set_config(home, enabled=True, mode="generated")

    with pytest.raises(tls_settings.TlsError):
        tls_settings.describe(home, "generated")

    # Every other reader downgrades that to a warning instead of raising.
    status = tls_settings.status(home)
    assert status["generatedCertificate"] is None
    assert tls_settings.log_expiry_warning(home) is None


def _expiring_pair(tmp_path: Path, days: int) -> tuple[bytes, bytes]:
    """A cert/key pair whose validity ends ``days`` from now (negative = past)."""
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "aging.example")])
    now = datetime.datetime.now(datetime.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=400))
        .not_valid_after(now + datetime.timedelta(days=days, hours=1))
        .sign(key, hashes.SHA256())
    )
    return (
        certificate.public_bytes(serialization.Encoding.PEM),
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ),
    )


@pytest.mark.parametrize(
    "days,expiring,expired",
    [(200, False, False), (30, True, False), (-5, True, True)],
)
def test_expiry_flags_track_the_remaining_validity(
    tmp_path: Path, home: Path, days: int, expiring: bool, expired: bool
) -> None:
    cert_pem, key_pem = _expiring_pair(tmp_path, days)
    tls_settings._write_pair(tls_settings.paths(home, "custom"), cert_pem, key_pem)

    described = tls_settings.describe(home, "custom")
    assert described["expiring"] is expiring
    assert described["expired"] is expired
    assert described["expiresInDays"] == days


def test_startup_warns_about_a_certificate_near_expiry(tmp_path: Path, home: Path, caplog) -> None:
    cert_pem, key_pem = _expiring_pair(tmp_path, 30)
    tls_settings._write_pair(tls_settings.paths(home, "custom"), cert_pem, key_pem)
    tls_settings.set_config(home, enabled=True, mode="custom")

    with caplog.at_level("WARNING"):
        message = tls_settings.log_expiry_warning(home)

    assert message is not None
    assert "expires in 30 days" in message
    assert "expires in 30 days" in caplog.text


def test_startup_warns_that_a_certificate_already_expired(
    tmp_path: Path, home: Path
) -> None:
    cert_pem, key_pem = _expiring_pair(tmp_path, -5)
    tls_settings._write_pair(tls_settings.paths(home, "custom"), cert_pem, key_pem)
    tls_settings.set_config(home, enabled=True, mode="custom")

    message = tls_settings.log_expiry_warning(home)
    assert message is not None and "expired 5 days ago" in message


def test_an_expired_certificate_still_serves(tmp_path: Path, home: Path) -> None:
    """Refusing to bind would take a panel offline over a browser-trust problem."""
    cert_pem, key_pem = _expiring_pair(tmp_path, -5)
    tls_settings._write_pair(tls_settings.paths(home, "custom"), cert_pem, key_pem)
    tls_settings.set_config(home, enabled=True, mode="custom")

    assert tls_settings.resolve(home) is not None
    assert launcher._resolve_tls(home)["ssl_certfile"] == str(
        tls_settings.paths(home, "custom").certfile
    )


def test_no_expiry_warning_while_serving_plain_http(tmp_path: Path, home: Path) -> None:
    cert_pem, key_pem = _expiring_pair(tmp_path, -5)
    tls_settings._write_pair(tls_settings.paths(home, "custom"), cert_pem, key_pem)
    tls_settings.set_config(home, enabled=False, mode="custom")

    assert tls_settings.log_expiry_warning(home) is None


def test_regenerating_replaces_the_certificate(home: Path) -> None:
    first = tls_settings.generate_self_signed()
    second = tls_settings.generate_self_signed()
    assert first["fingerprint"] != second["fingerprint"]


def test_enabled_without_a_certificate_stays_plain_http(home: Path) -> None:
    """A config that claims HTTPS but has no files must not wedge startup."""
    tls_settings.set_config(enabled=True)
    assert tls_settings.resolve() is None
    assert launcher._resolve_tls(home) == {}


def test_enabled_with_a_certificate_serves_https(home: Path) -> None:
    tls_settings.generate_self_signed()
    tls_settings.set_config(enabled=True)
    kwargs = launcher._resolve_tls(home)
    assert kwargs["ssl_certfile"] == str(tls_settings.paths().certfile)
    assert kwargs["ssl_keyfile"] == str(tls_settings.paths().keyfile)


def test_environment_wins_over_the_managed_setting(monkeypatch, tmp_path: Path, home: Path) -> None:
    tls_settings.generate_self_signed()
    tls_settings.set_config(enabled=False)
    cert_pem, key_pem = _external_pair(tmp_path)
    external_cert = home / "external-cert.pem"
    external_key = home / "external-key.pem"
    external_cert.write_bytes(cert_pem)
    external_key.write_bytes(key_pem)
    monkeypatch.setenv("NEXTHMI_SSL_CERTFILE", str(external_cert))
    monkeypatch.setenv("NEXTHMI_SSL_KEYFILE", str(external_key))

    assert launcher._resolve_tls(home)["ssl_certfile"] == str(external_cert)
    status = tls_settings.status()
    assert status["enabled"] is True
    assert status["source"] == "env"
    assert status["generatedCertificate"] is None
    assert status["error"] is None


def test_env_pinned_files_that_do_not_exist_report_the_same_way_the_launcher_does(
    monkeypatch, home: Path
) -> None:
    """The UI must not advertise HTTPS the next restart would refuse to bind."""
    monkeypatch.setenv("NEXTHMI_SSL_CERTFILE", str(home / "absent-cert.pem"))
    monkeypatch.setenv("NEXTHMI_SSL_KEYFILE", str(home / "absent-key.pem"))

    with pytest.raises(launcher.TlsConfigError, match="not found"):
        launcher._resolve_tls(home)

    status = tls_settings.status()
    assert status["enabled"] is False
    assert status["source"] == "env"
    assert "absent-cert.pem" in status["error"]


# ── custom certificates ──────────────────────────────────────────────────────


def _external_pair(tmp_path: Path, common_name: str = "plant.example") -> tuple[bytes, bytes]:
    """A cert/key pair standing in for one issued by the operator's own CA."""
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    now = datetime.datetime.now(datetime.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=30))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName(common_name)]), critical=False
        )
        .sign(key, hashes.SHA256())
    )
    return (
        certificate.public_bytes(serialization.Encoding.PEM),
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ),
    )


def test_custom_certificate_is_stored_and_served(tmp_path: Path, home: Path) -> None:
    cert_pem, key_pem = _external_pair(tmp_path)
    described = tls_settings.install_custom(cert_pem, key_pem)
    assert described["names"] == ["plant.example"]
    assert tls_settings.has_custom() is True

    tls_settings.set_config(enabled=True, mode="custom")
    assert launcher._resolve_tls(home)["ssl_certfile"] == str(
        tls_settings.paths(mode="custom").certfile
    )


def test_custom_key_is_not_world_readable(tmp_path: Path, home: Path) -> None:
    cert_pem, key_pem = _external_pair(tmp_path)
    tls_settings.install_custom(cert_pem, key_pem)
    mode = stat.S_IMODE(tls_settings.paths(mode="custom").keyfile.stat().st_mode)
    assert mode == 0o600, oct(mode)


def test_mismatched_key_is_rejected(tmp_path: Path, home: Path) -> None:
    cert_pem, _ = _external_pair(tmp_path, "plant.example")
    _, other_key = _external_pair(tmp_path, "other.example")
    with pytest.raises(tls_settings.TlsError, match="matching pair"):
        tls_settings.install_custom(cert_pem, other_key)
    assert tls_settings.has_custom() is False


@pytest.mark.parametrize(
    "cert,key,expected",
    [
        (b"", b"key", "empty"),
        (b"not pem at all", b"also not pem", "not PEM"),
        (b"-----BEGIN CERTIFICATE-----\n" + b"x" * 70_000, b"-----BEGIN KEY-----", "larger than"),
    ],
)
def test_unusable_uploads_are_refused(cert: bytes, key: bytes, expected: str, home: Path) -> None:
    with pytest.raises(tls_settings.TlsError, match=expected):
        tls_settings.install_custom(cert, key)


def test_switching_modes_keeps_both_certificates(tmp_path: Path, home: Path) -> None:
    """Going back to self-signed must not require re-uploading the custom pair."""
    generated = tls_settings.generate_self_signed()
    cert_pem, key_pem = _external_pair(tmp_path)
    custom = tls_settings.install_custom(cert_pem, key_pem)

    tls_settings.set_config(enabled=True, mode="generated")
    assert tls_settings.status()["mode"] == "generated"
    tls_settings.set_config(enabled=True, mode="custom")
    after = tls_settings.status()
    assert after["mode"] == "custom"
    assert after["customCertificate"]["fingerprint"] == custom["fingerprint"]
    assert after["generatedCertificate"]["fingerprint"] == generated["fingerprint"]


# ── manager endpoints ────────────────────────────────────────────────────────


@pytest.fixture
def client(monkeypatch, home: Path) -> TestClient:
    import manager

    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
    with TestClient(manager.app) as tc:
        tc.post("/api/manager/auth/setup", json={"password": "secret"})
        yield tc


def test_status_is_gated_behind_the_device_admin_session(monkeypatch, home: Path) -> None:
    import manager

    monkeypatch.setattr(manager.project_resume, "prepare_running_set", lambda: None)
    monkeypatch.setattr(manager.supervisor, "resume_all", lambda: None)
    monkeypatch.setattr(manager.supervisor, "shutdown", lambda: None)
    with TestClient(manager.app) as tc:
        assert tc.get("/api/system/tls").status_code == 401


def test_enabling_generates_a_certificate_and_asks_for_a_restart(client: TestClient) -> None:
    before = client.get("/api/system/tls").json()
    assert before["enabled"] is False
    assert before["generatedCertificate"] is None
    assert before["restartRequired"] is False

    response = client.post("/api/system/tls", json={"enabled": True})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["enabled"] is True
    assert len(body["generatedCertificate"]["fingerprint"]) == 64
    # The test client speaks http, so the running listener now disagrees.
    assert body["restartRequired"] is True
    assert tls_settings.paths().certfile.is_file()


def test_disabling_keeps_the_certificate_for_next_time(client: TestClient) -> None:
    fingerprint = client.post("/api/system/tls", json={"enabled": True}).json()[
        "generatedCertificate"
    ]["fingerprint"]
    disabled = client.post("/api/system/tls", json={"enabled": False}).json()
    assert disabled["enabled"] is False
    assert disabled["generatedCertificate"]["fingerprint"] == fingerprint


def test_restart_required_when_the_served_certificate_changes(client: TestClient) -> None:
    """Already serving HTTPS, then the *certificate* changes: still needs a restart."""
    enabled = client.post("/api/system/tls", json={"enabled": True}).json()
    tls_settings.mark_served(True, enabled["generatedCertificate"]["fingerprint"])
    assert client.get("/api/system/tls").json()["restartRequired"] is False

    regenerated = client.post("/api/system/tls/certificate").json()
    assert regenerated["restartRequired"] is True
    assert client.post("/api/system/tls/restart").status_code == 202


def test_restart_required_ignores_the_request_scheme(monkeypatch, client: TestClient) -> None:
    """A terminating proxy's X-Forwarded-Proto must not drive the restart guard."""
    tls_settings.mark_served(False, None)
    response = client.get("/api/system/tls", headers={"X-Forwarded-Proto": "https"})
    assert response.json()["restartRequired"] is False


def test_regenerate_replaces_the_certificate(client: TestClient) -> None:
    first = client.post("/api/system/tls", json={"enabled": True}).json()
    second = client.post("/api/system/tls/certificate").json()
    assert (
        second["generatedCertificate"]["fingerprint"]
        != first["generatedCertificate"]["fingerprint"]
    )


def test_environment_pinned_tls_refuses_edits(monkeypatch, client: TestClient, home: Path) -> None:
    monkeypatch.setenv("NEXTHMI_SSL_CERTFILE", str(home / "cert.pem"))
    monkeypatch.setenv("NEXTHMI_SSL_KEYFILE", str(home / "key.pem"))
    assert client.get("/api/system/tls").json()["source"] == "env"
    assert client.post("/api/system/tls", json={"enabled": False}).status_code == 409
    assert client.post("/api/system/tls/certificate").status_code == 409


def test_restart_refuses_when_nothing_changed(client: TestClient) -> None:
    assert client.post("/api/system/tls/restart").status_code == 409


def test_restart_writes_the_sentinel_and_shuts_down_gracefully(
    monkeypatch, client: TestClient
) -> None:
    """The supervisor's contract, not an in-process exec.

    A graceful SIGTERM lets the manager's lifespan stop the running projects and
    the peer advertisement; the sentinel is what tells the supervisor to come
    back up instead of staying down.
    """
    from api import tls_api
    from core import runtime_home

    scheduled: list[str] = []

    async def fake_shutdown(reason: str) -> None:
        scheduled.append(reason)

    monkeypatch.setattr(tls_api, "shutdown_after_response", fake_shutdown)

    client.post("/api/system/tls", json={"enabled": True})
    response = client.post("/api/system/tls/restart")

    assert response.status_code == 202, response.text
    assert response.json()["status"] == "restarting"
    assert scheduled == ["tls"]
    assert runtime_home.restart_sentinel_path().exists()


def test_restart_stays_up_when_the_sentinel_cannot_be_written(
    monkeypatch, client: TestClient
) -> None:
    """Shutting down without the marker would take the device off the network."""
    from api import tls_api

    scheduled: list[str] = []

    async def fake_shutdown(reason: str) -> None:
        scheduled.append(reason)

    def unwritable(_reason: str) -> None:
        raise OSError("read-only runtime home")

    monkeypatch.setattr(tls_api, "write_restart_sentinel", unwritable)
    monkeypatch.setattr(tls_api, "shutdown_after_response", fake_shutdown)

    client.post("/api/system/tls", json={"enabled": True})
    assert client.post("/api/system/tls/restart").status_code == 500
    assert scheduled == []


def test_uploading_a_custom_certificate_switches_mode(
    client: TestClient, tmp_path: Path
) -> None:
    cert_pem, key_pem = _external_pair(tmp_path)
    response = client.put(
        "/api/system/tls/certificate/custom",
        files={
            "certificate": ("cert.pem", cert_pem, "application/x-pem-file"),
            "privateKey": ("key.pem", key_pem, "application/x-pem-file"),
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mode"] == "custom"
    assert body["customCertificate"]["names"] == ["plant.example"]


def test_uploading_a_mismatched_pair_is_refused(client: TestClient, tmp_path: Path) -> None:
    cert_pem, _ = _external_pair(tmp_path, "plant.example")
    _, other_key = _external_pair(tmp_path, "other.example")
    response = client.put(
        "/api/system/tls/certificate/custom",
        files={
            "certificate": ("cert.pem", cert_pem, "application/x-pem-file"),
            "privateKey": ("key.pem", other_key, "application/x-pem-file"),
        },
    )
    assert response.status_code == 422, response.text
    assert client.get("/api/system/tls").json()["mode"] == "generated"


def test_custom_mode_without_an_upload_is_refused(client: TestClient) -> None:
    response = client.post("/api/system/tls", json={"enabled": True, "mode": "custom"})
    assert response.status_code == 422, response.text
    assert "Upload a certificate" in response.json()["detail"]


def test_general_restart_is_still_absent_from_the_manager(client: TestClient) -> None:
    """Adding a TLS-scoped restart must not open a general one."""
    assert client.post("/api/system/restart").status_code in {404, 405}


# ── which port the app itself binds ───────────────────────────────────────────


@pytest.fixture
def bound(monkeypatch, home: Path):
    """Run ``_run_manager`` up to the bind and report what it would have served.

    Everything past the decision is stubbed out: the point is the port and
    whether a redirector was started, not a real listener.
    """
    import argparse

    def run(**env: str) -> dict:
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        record: dict = {"redirector": False}

        def fake_serve(app, host, port, verbose, **kwargs):
            record["port"] = port
            record["tls"] = "ssl_certfile" in kwargs

        def fake_redirector(host, port, https_port):
            record["redirector"] = True
            record["redirect_from"] = port
            record["redirect_to"] = https_port
            return None, None

        monkeypatch.setattr(launcher, "_serve", fake_serve)
        monkeypatch.setattr(launcher, "_start_https_redirector", fake_redirector)
        monkeypatch.setattr(launcher, "_resolve_port_conflict", lambda host, port: port)
        monkeypatch.setattr(launcher, "print_banner", lambda *a, **k: None)
        args = argparse.Namespace(verbose=False, port=None, https_port=None)
        assert launcher._run_manager(home, args) == 0
        return record

    return run


def test_managed_https_moves_the_app_and_leaves_the_http_port_redirecting(
    bound, home: Path
) -> None:
    tls_settings.generate_self_signed(home)
    tls_settings.set_config(home, enabled=True, mode="generated")

    record = bound(NEXTHMI_PORT="8000", NEXTHMI_HTTPS_PORT="8443")

    assert (record["port"], record["tls"]) == (8443, True)
    assert (record["redirect_from"], record["redirect_to"]) == (8000, 8443)


def test_pinned_certificates_keep_serving_on_the_port_they_always_did(
    monkeypatch, bound, home: Path, tmp_path: Path
) -> None:
    """NEXTHMI_SSL_* deployments never had a plain-HTTP phase to redirect from.

    Moving them to 8443 would break the port mapping the operator published,
    for the sake of preserving links that cannot exist.
    """
    tls_settings.generate_self_signed(home)
    pair = tls_settings.paths(home, "generated")
    monkeypatch.setenv("NEXTHMI_SSL_CERTFILE", str(pair.certfile))
    monkeypatch.setenv("NEXTHMI_SSL_KEYFILE", str(pair.keyfile))

    record = bound(NEXTHMI_PORT="8000")

    assert (record["port"], record["tls"]) == (8000, True)
    assert record["redirector"] is False
    # Peer discovery reads this to find the port that actually serves TLS.
    assert os.environ.get("NEXTHMI_HTTPS_PORT") is None


def test_plain_http_still_publishes_where_https_would_go(bound, home: Path) -> None:
    """The admin page needs the destination before the move, not after."""
    record = bound(NEXTHMI_PORT="8000", NEXTHMI_HTTPS_PORT="8443")

    assert (record["port"], record["tls"]) == (8000, False)
    assert record["redirector"] is False
    assert os.environ["NEXTHMI_HTTPS_PORT"] == "8443"


# ── the ports the admin page has to reopen itself on ──────────────────────────


def test_status_reports_both_ports_so_the_page_can_follow_the_move(
    monkeypatch, client: TestClient
) -> None:
    """Enabling HTTPS moves the app, so the page cannot just swap its scheme."""
    monkeypatch.setenv("NEXTHMI_PORT", "8000")
    monkeypatch.setenv("NEXTHMI_HTTPS_PORT", "8443")
    status = client.get("/api/system/tls").json()
    assert (status["httpPort"], status["httpsPort"]) == (8000, 8443)


def test_status_reports_no_ports_when_the_listener_is_rebound_in_place(
    monkeypatch, client: TestClient
) -> None:
    """start-dev.py binds uvicorn itself and exports neither."""
    monkeypatch.delenv("NEXTHMI_PORT", raising=False)
    monkeypatch.delenv("NEXTHMI_HTTPS_PORT", raising=False)
    status = client.get("/api/system/tls").json()
    assert (status["httpPort"], status["httpsPort"]) == (None, None)


def test_unparseable_port_reads_as_absent_rather_than_500ing(
    monkeypatch, client: TestClient
) -> None:
    monkeypatch.setenv("NEXTHMI_HTTPS_PORT", "not-a-port")
    assert client.get("/api/system/tls").json()["httpsPort"] is None


# ── HTTP → HTTPS redirector ───────────────────────────────────────────────────
# With HTTPS on, the launcher keeps the HTTP port bound so links made before the
# switch still land somewhere. It serves nothing but redirects.


@pytest.fixture
def redirect_client() -> TestClient:
    return TestClient(launcher._https_redirect_app(8443), base_url="http://panel:8000")


def test_redirects_to_the_https_port_keeping_path_and_query(
    redirect_client: TestClient,
) -> None:
    response = redirect_client.get(
        "/editor/default/editor?widget=x%2Fy", follow_redirects=False
    )
    assert response.status_code == 307
    assert response.headers["location"] == (
        "https://panel:8443/editor/default/editor?widget=x%2Fy"
    )


def test_redirect_is_temporary_so_disabling_https_is_not_cached_forever(
    redirect_client: TestClient,
) -> None:
    """A 301 would outlive the toggle and strand the operator on a dead port."""
    assert redirect_client.get("/", follow_redirects=False).status_code == 307


def test_redirect_keeps_the_method(redirect_client: TestClient) -> None:
    response = redirect_client.post("/api/system/tls", follow_redirects=False)
    assert response.status_code == 307


def test_redirect_follows_the_host_the_client_used(redirect_client: TestClient) -> None:
    response = redirect_client.get(
        "/", headers={"host": "10.0.0.7:8000"}, follow_redirects=False
    )
    assert response.headers["location"] == "https://10.0.0.7:8443/"


def test_redirect_handles_an_ipv6_literal_host(redirect_client: TestClient) -> None:
    response = redirect_client.get(
        "/", headers={"host": "[fe80::1]:8000"}, follow_redirects=False
    )
    assert response.headers["location"] == "https://[fe80::1]:8443/"


def test_redirect_hostname_falls_back_to_the_server_address() -> None:
    scope = {"type": "http", "path": "/", "headers": [], "server": ("192.168.1.4", 8000)}
    assert launcher._redirect_hostname(scope) == "192.168.1.4"


def test_redirect_hostname_is_none_without_a_host_or_server() -> None:
    assert launcher._redirect_hostname({"type": "http", "path": "/", "headers": []}) is None


@pytest.mark.asyncio
async def test_websocket_handshake_is_closed_not_redirected() -> None:
    """Browsers cannot follow a redirect on a WebSocket handshake."""
    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    await launcher._https_redirect_app(8443)({"type": "websocket"}, None, send)
    assert sent == [{"type": "websocket.close", "code": 1008}]


@pytest.mark.asyncio
async def test_request_without_a_resolvable_host_is_rejected() -> None:
    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {"type": "http", "path": "/", "headers": [], "server": None}
    await launcher._https_redirect_app(8443)(scope, None, send)
    assert sent[0]["status"] == 400
