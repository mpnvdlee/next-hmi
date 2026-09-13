"""Tests for datasource_api CRUD routes."""
import json
import sys
from pathlib import Path

import api.datasource_api as datasource_api_module
import core.storage as storage
import pytest
from core.exceptions import register_exception_handlers
from fastapi import FastAPI
from fastapi.testclient import TestClient
from services.datasource_manager import DatasourceManager


@pytest.fixture()
def ds_client(monkeypatch, live_project_root: Path):
    """Create TestClient with real DatasourceManager backed by a temp directory."""
    storage.active_datasources_dir().mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(datasource_api_module, "_opcua_pool", None)
    monkeypatch.setattr(datasource_api_module, "_test_server_pool", None)

    # Fresh manager backed by the temp dir
    manager = DatasourceManager()
    monkeypatch.setattr(datasource_api_module, "datasource_manager", manager)

    from api.datasource_api import router
    test_app = FastAPI()
    register_exception_handlers(test_app)
    test_app.include_router(router)
    with TestClient(test_app) as c:
        yield c, manager


# ── GET / list ────────────────────────────────────────────────────────────────


def test_list_datasources_empty(ds_client):
    client, _ = ds_client
    resp = client.get("/api/datasources")
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_datasources_returns_summaries(ds_client):
    client, manager = ds_client
    manager.save("plc1", {"name": "plc1", "type": "static", "variables": []})
    resp = client.get("/api/datasources")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 1
    assert items[0]["name"] == "plc1"
    assert items[0]["type"] == "static"
    assert items[0]["connected"] is False


# ── GET /{name} ───────────────────────────────────────────────────────────────


def test_get_datasource_returns_config(ds_client):
    client, manager = ds_client
    manager.save("plc1", {"name": "plc1", "type": "static", "variables": [{"display_name": "Temp"}]})
    resp = client.get("/api/datasources/plc1")
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "plc1"
    assert len(data["variables"]) == 1


def test_get_datasource_exclude_variables(ds_client):
    client, manager = ds_client
    manager.save("plc1", {"name": "plc1", "type": "static", "variables": [{"display_name": "Temp"}]})
    resp = client.get("/api/datasources/plc1?include_variables=false")
    assert resp.status_code == 200
    data = resp.json()
    assert "variables" not in data
    assert data["type"] == "static"


def test_get_datasource_variables_returns_simple_types(ds_client):
    client, manager = ds_client
    manager.save(
        "plc1",
        {
            "name": "plc1",
            "type": "static",
            "variables": [
                {
                    "kind": "folder",
                    "name": "Motor",
                    "children": [
                        {"kind": "variable", "display_name": "Speed", "data_type": "Float"},
                        {
                            "kind": "variable",
                            "display_name": "Hist",
                            "data_type": "Int16",
                            "is_array": True,
                            "array_length": 5,
                        },
                    ],
                },
            ],
        },
    )
    resp = client.get("/api/datasources/plc1/variables")
    assert resp.status_code == 200
    children = resp.json()["variables"][0]["children"]
    # Simple element type, array-ness preserved via is_array/array_length (no [] suffix).
    assert children[0]["data_type"] == "Float"
    assert children[1]["data_type"] == "Integer"
    assert children[1]["is_array"] is True
    assert children[1]["array_length"] == 5


def test_get_datasource_variables_simple_false_keeps_raw_types(ds_client):
    client, manager = ds_client
    manager.save(
        "plc1",
        {
            "name": "plc1",
            "type": "opcua-client",
            "variables": [
                {
                    "kind": "folder",
                    "name": "Motor",
                    "children": [
                        {"kind": "variable", "display_name": "Speed", "data_type": "Float"},
                        {
                            "kind": "variable",
                            "display_name": "Hist",
                            "data_type": "Int16",
                            "is_array": True,
                            "array_length": 5,
                        },
                    ],
                },
            ],
        },
    )
    resp = client.get("/api/datasources/plc1/variables?simple=false")
    assert resp.status_code == 200
    children = resp.json()["variables"][0]["children"]
    # Raw OPC-UA types are returned unchanged for the config editor.
    assert children[0]["data_type"] == "Float"
    assert children[1]["data_type"] == "Int16"
    assert children[1]["array_length"] == 5


def test_get_datasource_variables_simple_false_preserves_bool_spelling(ds_client):
    client, manager = ds_client
    manager.save(
        "plc1",
        {
            "name": "plc1",
            "type": "opcua-client",
            "variables": [
                {"kind": "variable", "display_name": "Ready", "data_type": "Bool"}
            ],
        },
    )
    response = client.get("/api/datasources/plc1/variables?simple=false")
    assert response.json()["variables"][0]["data_type"] == "Bool"
    assert manager.get("plc1").config["variables"][0]["data_type"] == "Bool"


def test_get_datasource_not_found(ds_client):
    client, _ = ds_client
    resp = client.get("/api/datasources/ghost")
    assert resp.status_code == 404
    assert "ghost" in resp.json()["detail"]


# ── GET /{name}/variables ─────────────────────────────────────────────────────


def test_get_datasource_variables(ds_client):
    client, manager = ds_client
    manager.save("plc1", {"name": "plc1", "type": "static", "variables": [{"display_name": "Temp"}]})
    resp = client.get("/api/datasources/plc1/variables")
    assert resp.status_code == 200
    assert len(resp.json()["variables"]) == 1


def test_get_datasource_variables_not_found(ds_client):
    client, _ = ds_client
    resp = client.get("/api/datasources/ghost/variables")
    assert resp.status_code == 404


# ── PUT /{name} ───────────────────────────────────────────────────────────────


def test_put_datasource_creates(ds_client):
    client, manager = ds_client
    resp = client.put(
        "/api/datasources/plc1",
        json={"type": "static", "variables": []},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "plc1"
    assert data["type"] == "static"
    # Verify it was persisted
    assert manager.get("plc1") is not None


def test_put_datasource_updates(ds_client):
    client, manager = ds_client
    manager.save("plc1", {"name": "plc1", "type": "static", "variables": []})
    resp = client.put(
        "/api/datasources/plc1",
        json={"type": "static", "variables": [{"display_name": "Temp", "data_type": "Float"}]},
    )
    assert resp.status_code == 200
    entry = manager.get("plc1")
    assert entry is not None
    assert len(entry.config["variables"]) == 1


def test_put_datasource_rejects_invalid_type(ds_client):
    client, _ = ds_client
    resp = client.put("/api/datasources/plc1", json={"type": "unknown-type"})
    assert resp.status_code == 422


def test_put_datasource_rejects_unknown_data_type(ds_client):
    """§1.6: an unrecognized data_type on a static datasource can't be saved."""
    client, manager = ds_client
    resp = client.put(
        "/api/datasources/plc1",
        json={
            "type": "static",
            "variables": [{"kind": "variable", "display_name": "X", "data_type": "Guid"}],
        },
    )
    assert resp.status_code == 422
    assert manager.get("plc1") is None


def test_put_variables_rejects_unknown_data_type(ds_client):
    client, manager = ds_client
    manager.save("plc1", {"name": "plc1", "type": "static", "variables": []})
    resp = client.put(
        "/api/datasources/plc1/variables",
        json=[{"kind": "variable", "display_name": "X", "data_type": "Guid"}],
    )
    assert resp.status_code == 422
    entry = manager.get("plc1")
    assert entry is not None
    assert entry.config["variables"] == []


def test_put_variables_unknown_data_type_allowed_for_non_static(ds_client):
    """Validation is scoped to static datasources — opcua types aren't in _STATIC_DEFAULTS."""
    client, manager = ds_client
    manager.save("plc1", {"name": "plc1", "type": "opcua-client", "variables": []})
    resp = client.put(
        "/api/datasources/plc1/variables",
        json=[{"kind": "variable", "display_name": "X", "data_type": "Guid"}],
    )
    assert resp.status_code == 200


def test_put_variables_round_trips_configured_ranges(ds_client):
    """The config editor's write direction: a min/max typed into the variable
    table survives the PUT, the atomic write to disk and the reload, and comes
    back out of ``variable_metadata`` — as ``min``/``max`` for a scalar and as
    ``fieldRanges`` for a struct field (the same per-variable field either way).
    """
    client, manager = ds_client
    manager.save("plc1", {"name": "plc1", "type": "static", "variables": []})
    resp = client.put(
        "/api/datasources/plc1/variables",
        json=[
            {
                "kind": "variable",
                "display_name": "Setpoint",
                "data_type": "Float",
                "enabled": True,
                "writable": True,
                "min": 0,
                "max": 100,
            },
            {
                "kind": "folder",
                "name": "Motor",
                "children": [
                    {
                        "kind": "variable",
                        "display_name": "fValue",
                        "data_type": "Float",
                        "enabled": True,
                        "writable": True,
                        "min": -5,
                        "max": 3000,
                    },
                ],
            },
        ],
    )
    assert resp.status_code == 200

    reloaded = DatasourceManager()
    reloaded.load_all()
    stored = reloaded.get("plc1").config["variables"]
    assert (stored[0]["min"], stored[0]["max"]) == (0, 100)
    assert (stored[1]["children"][0]["min"], stored[1]["children"][0]["max"]) == (-5, 3000)

    meta = reloaded.variable_metadata()
    assert meta["plc1:Setpoint"]["min"] == 0
    assert meta["plc1:Setpoint"]["max"] == 100
    assert meta["plc1:Motor"]["fieldRanges"] == {"fValue": {"min": -5, "max": 3000}}


def test_rest_write_requires_project_user_credentials(ds_client):
    client, _manager = ds_client
    response = client.post(
        "/api/datasources/write", json={"datasource": "plc1", "path": "Count", "value": 1}
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "invalid_credentials"


def _restricted_setpoint(manager, groups: list[str]) -> dict:
    manager.save(
        "plc1",
        {
            "name": "plc1",
            "type": "static",
            "variables": [
                {
                    "kind": "variable",
                    "display_name": "Setpoint",
                    "data_type": "Int16",
                    "enabled": True,
                    "interactableByGroups": groups,
                }
            ],
        },
    )
    return {"datasource": "plc1", "path": "Setpoint", "value": 42}


def _write_project_users(root: Path, *extra: dict) -> None:
    root.joinpath("users.json").write_text(
        json.dumps(
            {
                "settings": {"autoLoginName": "guest"},
                "groups": [
                    {"id": "guest", "label": "Guest"},
                    {"id": "engineer", "label": "Engineer"},
                ],
                "users": [
                    {"id": "guest", "username": "guest", "password": "", "groups": ["guest"]},
                    *extra,
                ],
            }
        )
    )


def test_rest_write_refuses_an_account_with_no_password(ds_client, live_project_root: Path):
    """``interactableByGroups`` is the only per-tag restriction an anonymous
    operator faces on the public runtime prefix, and ``Basic bGluZWJvc3M6`` —
    a real username with an empty password — walked straight through it."""
    client, manager = ds_client
    payload = _restricted_setpoint(manager, ["engineer"])
    _write_project_users(
        live_project_root,
        {"id": "u-lb", "username": "lineboss", "password": "", "groups": ["engineer", "guest"]},
    )

    anonymous = client.post("/api/datasources/write", json=payload)
    assert anonymous.status_code == 401

    response = client.post("/api/datasources/write", json=payload, auth=("lineboss", ""))
    assert response.status_code == 401
    assert response.json()["detail"] == "invalid_credentials"


def test_rest_write_throttles_repeated_credential_failures(ds_client, live_project_root: Path):
    """Nothing counted failures on a route reachable with no session at all,
    and each attempt costs a 200 000-iteration PBKDF2."""
    client, manager = ds_client
    payload = _restricted_setpoint(manager, ["engineer"])
    _write_project_users(
        live_project_root,
        {"id": "u-lb", "username": "lineboss", "password": "", "groups": ["engineer", "guest"]},
    )

    for _ in range(5):
        attempt = client.post("/api/datasources/write", json=payload, auth=("lineboss", "guess"))
        assert attempt.status_code == 401

    locked = client.post("/api/datasources/write", json=payload, auth=("lineboss", "guess"))
    assert locked.status_code == 429


def test_rest_write_shares_envelope_coercion_and_group_permission(ds_client, monkeypatch):
    client, manager = ds_client
    manager.save(
        "plc1",
        {
            "name": "plc1",
            "type": "static",
            "variables": [
                {
                    "kind": "variable",
                    "display_name": "Count",
                    "data_type": "Int16",
                    "enabled": True,
                    "interactableByGroups": ["operator"],
                }
            ],
        },
    )

    async def authenticate(username, password):
        if (username, password) == ("operator", "secret"):
            return {"username": username, "groups": ["operator"]}, {}
        if (username, password) == ("guest", "guest"):
            return {"username": username, "groups": ["guest"]}, {}
        return None

    monkeypatch.setattr(datasource_api_module.users_manager, "authenticate", authenticate)
    url = "/api/datasources/write"
    payload = {"datasource": "plc1", "path": "Count", "value": "32767"}
    assert client.post(url, json=payload, auth=("operator", "secret")).json() == {
        "ok": True,
        "reason": None,
    }
    assert client.post(url, json=payload, auth=("guest", "guest")).json() == {
        "ok": False,
        "reason": "permission_denied",
    }
    assert client.post(url, json={**payload, "value": None}, auth=("operator", "secret")).json() == {
        "ok": False,
        "reason": "invalid_value",
    }
    malformed = {"datasource": "plc1", "path": [], "value": 1}
    assert client.post(url, json=malformed, auth=("operator", "secret")).json() == {
        "ok": False,
        "reason": "bad_request",
    }


def test_put_datasource_omitted_variables_preserves_existing_tree(ds_client):
    """§1.5: a settings-only PUT (no `variables` key) must not wipe the tree."""
    client, manager = ds_client
    manager.save(
        "plc1",
        {"name": "plc1", "type": "static", "variables": [{"display_name": "Temp", "data_type": "Float"}]},
    )
    resp = client.put("/api/datasources/plc1", json={"type": "static", "settings": {"x": 1}})
    assert resp.status_code == 200
    entry = manager.get("plc1")
    assert entry is not None
    assert len(entry.config["variables"]) == 1


def test_put_datasource_null_variables_preserves_existing_tree(ds_client):
    client, manager = ds_client
    manager.save(
        "plc1",
        {"name": "plc1", "type": "static", "variables": [{"display_name": "Temp", "data_type": "Float"}]},
    )
    resp = client.put(
        "/api/datasources/plc1", json={"type": "static", "variables": None},
    )
    assert resp.status_code == 200
    entry = manager.get("plc1")
    assert entry is not None
    assert len(entry.config["variables"]) == 1


def test_put_datasource_explicit_empty_variables_clears_tree(ds_client):
    client, manager = ds_client
    manager.save(
        "plc1",
        {"name": "plc1", "type": "static", "variables": [{"display_name": "Temp", "data_type": "Float"}]},
    )
    resp = client.put("/api/datasources/plc1", json={"type": "static", "variables": []})
    assert resp.status_code == 200
    entry = manager.get("plc1")
    assert entry is not None
    assert entry.config["variables"] == []


# ── DELETE /{name} ────────────────────────────────────────────────────────────


def test_delete_datasource(ds_client):
    client, manager = ds_client
    manager.save("plc1", {"name": "plc1", "type": "static", "variables": []})
    resp = client.delete("/api/datasources/plc1")
    assert resp.status_code == 200
    assert resp.json() == {"status": "deleted"}
    assert manager.get("plc1") is None


def test_delete_datasource_not_found(ds_client):
    client, _ = ds_client
    resp = client.delete("/api/datasources/ghost")
    assert resp.status_code == 404


# ── POST /{name}/stop ─────────────────────────────────────────────────────────


def test_stop_static_datasource_returns_422(ds_client):
    client, manager = ds_client
    manager.save("plc1", {"name": "plc1", "type": "static", "variables": []})
    resp = client.post("/api/datasources/plc1/stop")
    assert resp.status_code == 422
    assert "OPC-UA" in resp.json()["detail"]


def test_stop_opcua_client_disconnects(ds_client, monkeypatch):
    client, manager = ds_client
    manager.save(
        "plc1",
        {"name": "plc1", "type": "opcua-client", "settings": {"server_url": "opc.tcp://x"}},
    )

    stopped = []

    class _FakePool:
        async def stop(self, name):
            stopped.append(name)

    monkeypatch.setattr(datasource_api_module, "_opcua_pool", _FakePool())
    resp = client.post("/api/datasources/plc1/stop")
    assert resp.status_code == 200
    assert resp.json() == {"status": "disconnected"}
    assert stopped == ["plc1"]


def test_start_opcua_client_connects(ds_client, monkeypatch):
    client, manager = ds_client
    manager.save(
        "plc1",
        {"name": "plc1", "type": "opcua-client", "settings": {"server_url": "opc.tcp://x"}},
    )

    started = []

    class _FakePool:
        async def start(self, name, settings):
            started.append((name, settings))

    monkeypatch.setattr(datasource_api_module, "_opcua_pool", _FakePool())
    resp = client.post("/api/datasources/plc1/start")
    assert resp.status_code == 200
    assert resp.json() == {"status": "connected"}
    assert started == [("plc1", {"server_url": "opc.tcp://x"})]


# ── GET /{name}/browse — non-OPC-UA returns 422 ───────────────────────────────


def test_browse_static_datasource_returns_422(ds_client):
    client, manager = ds_client
    manager.save("plc1", {"name": "plc1", "type": "static", "variables": []})
    resp = client.get("/api/datasources/plc1/browse")
    assert resp.status_code == 422
    assert "OPC-UA" in resp.json()["detail"]


# ── POST /certs ───────────────────────────────────────────────────────────────


def test_upload_certificate_returns_project_relative_path(ds_client, live_project_root: Path):
    client, _ = ds_client
    resp = client.post(
        "/api/datasources/certs",
        files={"file": ("client-cert.pem", b"-----BEGIN CERTIFICATE-----", "application/x-pem-file")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["path"] == "certs/client-cert.pem"
    assert not body["path"].startswith("/")

    written = live_project_root / "certs" / "client-cert.pem"
    assert written.read_bytes() == b"-----BEGIN CERTIFICATE-----"


def test_upload_certificate_reupload_overwrites_same_name(ds_client, live_project_root: Path):
    client, _ = ds_client
    client.post(
        "/api/datasources/certs",
        files={"file": ("key.pem", b"first", "application/x-pem-file")},
    )
    resp = client.post(
        "/api/datasources/certs",
        files={"file": ("key.pem", b"second", "application/x-pem-file")},
    )
    assert resp.status_code == 200
    written = live_project_root / "certs" / "key.pem"
    assert written.read_bytes() == b"second"


def test_upload_certificate_rejects_dotdot_filename(ds_client):
    client, _ = ds_client
    resp = client.post(
        "/api/datasources/certs",
        files={"file": ("..", b"payload", "application/octet-stream")},
    )
    assert resp.status_code == 422


def test_upload_certificate_rejects_dot_filename(ds_client):
    client, _ = ds_client
    resp = client.post(
        "/api/datasources/certs",
        files={"file": (".", b"payload", "application/octet-stream")},
    )
    assert resp.status_code == 422


def test_upload_certificate_sanitizes_slash_traversal_without_escaping(
    ds_client, live_project_root: Path
):
    client, _ = ds_client
    resp = client.post(
        "/api/datasources/certs",
        files={"file": ("../../../../etc/evil.pem", b"payload", "application/octet-stream")},
    )
    assert resp.status_code == 200
    relative_path = resp.json()["path"]
    assert relative_path.startswith("certs/")

    certs_dir = live_project_root / "certs"
    written = live_project_root / relative_path
    assert written.resolve().is_relative_to(certs_dir.resolve())
    assert not (live_project_root.parent / "evil.pem").exists()


def test_sanitize_cert_filename_rejects_dot_variants_falls_back_for_empty():
    from api.datasource_api import _sanitize_cert_filename
    from core.exceptions import DatasourceValidationError

    assert _sanitize_cert_filename("client-key.pem") == "client-key.pem"
    assert _sanitize_cert_filename(None) == "project"
    with pytest.raises(DatasourceValidationError):
        _sanitize_cert_filename(".")
    with pytest.raises(DatasourceValidationError):
        _sanitize_cert_filename("..")


# ── POST /certs/generate ───────────────────────────────────────────────────────


def test_generate_certificate_writes_project_relative_pair(ds_client, live_project_root: Path):
    client, _ = ds_client
    resp = client.post("/api/datasources/certs/generate", json={"name": "my-plc"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["client_certificate"] == "certs/my-plc-cert.der"
    assert body["client_private_key"] == "certs/my-plc-key.pem"

    cert = live_project_root / "certs" / "my-plc-cert.der"
    key = live_project_root / "certs" / "my-plc-key.pem"
    assert cert.exists() and key.exists()
    if sys.platform != "win32":
        # os.chmod on Windows can't restrict to owner-only; NTFS ACLs would be
        # needed for that guarantee there. See core/tls_settings.py's
        # documented weaker guarantee for the same platform gap.
        assert (key.stat().st_mode & 0o777) == 0o600
    from cryptography import x509

    assert x509.load_der_x509_certificate(cert.read_bytes())


def test_generate_certificate_regenerates_same_path(ds_client, live_project_root: Path):
    client, _ = ds_client
    first = client.post("/api/datasources/certs/generate", json={"name": "my-plc"}).json()
    cert_path = live_project_root / first["client_certificate"]
    key_path = live_project_root / first["client_private_key"]
    first_cert_bytes = cert_path.read_bytes()
    first_key_bytes = key_path.read_bytes()

    second = client.post("/api/datasources/certs/generate", json={"name": "my-plc"}).json()

    assert second["client_certificate"] == first["client_certificate"]
    assert second["client_private_key"] == first["client_private_key"]
    assert cert_path.read_bytes() != first_cert_bytes
    assert key_path.read_bytes() != first_key_bytes


def test_generate_certificate_defaults_name_when_blank(ds_client):
    client, _ = ds_client
    resp = client.post("/api/datasources/certs/generate", json={"name": ""})
    assert resp.status_code == 200
    assert resp.json()["client_certificate"] == "certs/client-cert.der"


def test_generate_certificate_honours_common_name_and_validity(
    ds_client, live_project_root: Path
):
    client, _ = ds_client
    resp = client.post(
        "/api/datasources/certs/generate",
        json={"name": "my-plc", "common_name": "plant-a-plc", "validity_days": 30},
    )
    assert resp.status_code == 200

    info = client.get(
        "/api/datasources/certs/info",
        params={"path": resp.json()["client_certificate"]},
    ).json()
    assert "plant-a-plc" in info["subject"]
    assert 28 <= info["expiresInDays"] <= 30


def test_generate_certificate_rejects_out_of_range_validity(ds_client):
    client, _ = ds_client
    resp = client.post(
        "/api/datasources/certs/generate", json={"name": "my-plc", "validity_days": 0}
    )
    assert resp.status_code == 422


# ── GET /certs/info ────────────────────────────────────────────────────────────


def test_certificate_info_describes_a_generated_pair(ds_client):
    client, _ = ds_client
    generated = client.post("/api/datasources/certs/generate", json={"name": "my-plc"}).json()

    resp = client.get(
        "/api/datasources/certs/info", params={"path": generated["client_certificate"]}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["readable"] is True
    assert body["expired"] is False and body["expiring"] is False
    assert body["expiresInDays"] > 3000
    assert body["selfSigned"] is True
    assert "webhmi-opc-client" in body["subject"]
    assert body["expiresAt"]


def test_certificate_info_reports_a_missing_file_as_unreadable(ds_client):
    client, _ = ds_client
    resp = client.get("/api/datasources/certs/info", params={"path": "certs/absent.pem"})
    assert resp.status_code == 200
    assert resp.json() == {
        "readable": False,
        "subject": "",
        "fingerprint": "",
        "issuedAt": "",
        "expiresAt": "",
        "expiresInDays": 0,
        "expired": False,
        "expiring": False,
        "selfSigned": False,
        "names": [],
    }


def test_certificate_info_reports_a_private_key_as_unreadable(ds_client):
    """The path field is free text — pointing it at the key is a typo, not a fault."""
    client, _ = ds_client
    generated = client.post("/api/datasources/certs/generate", json={"name": "my-plc"}).json()

    resp = client.get(
        "/api/datasources/certs/info", params={"path": generated["client_private_key"]}
    )

    assert resp.status_code == 200
    assert resp.json()["readable"] is False


def test_certificate_info_never_escapes_the_certs_directory(ds_client, live_project_root: Path):
    (live_project_root / "secret.pem").write_bytes(b"-----BEGIN CERTIFICATE-----\n")

    client, _ = ds_client
    resp = client.get("/api/datasources/certs/info", params={"path": "../secret.pem"})

    assert resp.status_code == 200
    assert resp.json()["readable"] is False


# ── Connection-status error surfacing ──────────────────────────────────────────


def test_list_datasources_surfaces_opcua_client_connect_error(ds_client, monkeypatch):
    """A real OPC-UA datasource that failed to connect must report why in the
    summary the sidebar reads, the same way a test-server datasource already
    does via its own pool."""
    client, manager = ds_client
    manager.save(
        "plc1",
        {"name": "plc1", "type": "opcua-client", "settings": {"server_url": "opc.tcp://x"}},
    )

    class _FakeEngine:
        connected = False
        error = "Connection timed out"

    class _FakePool:
        def get(self, name):
            return _FakeEngine() if name == "plc1" else None

    monkeypatch.setattr(datasource_api_module, "_opcua_pool", _FakePool())
    resp = client.get("/api/datasources")

    assert resp.status_code == 200
    item = resp.json()[0]
    assert item["connected"] is False
    assert item["error"] == "Connection timed out"
