"""Tests for the theme API: multi-theme CRUD, default pointer, migration, validate."""
import json
from pathlib import Path

import api.theme_api as theme_api_module
import core.storage as storage
import pytest
from core.exceptions import register_exception_handlers
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def theme_client(monkeypatch, live_project_root: Path):
    storage.ensure_active_project_dirs()

    test_app = FastAPI()
    register_exception_handlers(test_app)
    test_app.include_router(theme_api_module.router)
    with TestClient(test_app) as client:
        yield client, live_project_root


def _valid_theme() -> dict:
    """A full theme payload with a low-contrast text on white (triggers a warning)."""
    return {
        "colors": {
            "bg": "#ffffff",
            "surface": "#ffffff",
            "surface_raised": "#edf3f8",
            "text": "#bbbbbb",
            "text_muted": "#6b7280",
            "accent": "#2d9cff",
            "border": "#d6dee2",
            "ok": "#1fbf75",
            "warn": "#f2a93b",
            "fault": "#e74c3c",
        },
        "typography": {
            "heading_font": "'Inter', system-ui, sans-serif",
            "heading_size": "1.25rem",
            "heading_weight": 600,
            "heading_tracking": "-0.02em",
            "heading_transform": "none",
            "subheading_font": "'Inter', system-ui, sans-serif",
            "subheading_size": "1rem",
            "subheading_weight": 600,
            "subheading_tracking": "0",
            "subheading_transform": "none",
            "body_font": "'Inter', system-ui, sans-serif",
            "body_size": "0.875rem",
            "body_weight": 400,
            "body_tracking": "-0.005em",
            "body_transform": "none",
            "caption_font": "'Inter', system-ui, sans-serif",
            "caption_size": "0.75rem",
            "caption_weight": 400,
            "caption_tracking": "0",
            "caption_transform": "none",
            "code_font": "'Roboto Mono', monospace",
            "code_size": "0.875rem",
            "code_weight": 400,
            "code_tracking": "0",
            "code_transform": "none",
            "value_font": "'Inter', system-ui, sans-serif",
            "value_size": "1.75rem",
            "value_weight": 700,
            "value_tracking": "0",
            "value_transform": "none",
            "label_font": "'Inter', system-ui, sans-serif",
            "label_size": "0.75rem",
            "label_weight": 700,
            "label_tracking": "0.06em",
            "label_transform": "uppercase",
        },
        "spacing": {
            "space_sm": "0.5rem",
            "space_md": "0.75rem",
            "space_lg": "1rem",
            "radius_sm": "4px",
            "radius_md": "6px",
            "radius_lg": "8px",
            "shadow": "0 4px 16px rgba(0, 0, 0, 0.12)",
        },
    }


def test_seeds_default_theme_when_empty(theme_client):
    client, root = theme_client
    resp = client.get("/api/themes")
    assert resp.status_code == 200
    data = resp.json()
    assert data["default"] == "default"
    assert [t["id"] for t in data["themes"]] == ["default"]
    assert (root / "themes" / "default.json").exists()


def test_create_duplicate_set_default_delete(theme_client):
    client, _ = theme_client
    client.get("/api/themes")  # seed

    # Duplicate the seeded "default" into "Dark".
    resp = client.post("/api/themes", json={"name": "Dark", "source": "default"})
    assert resp.status_code == 200
    dark_id = resp.json()["id"]
    assert dark_id == "dark"

    # Make Dark the default.
    resp = client.put("/api/default-theme", json={"default": "dark"})
    assert resp.status_code == 200
    assert client.get("/api/default-theme").json()["default"] == "dark"

    # Edit a token on Dark and read it back.
    theme = _valid_theme()
    theme["colors"]["bg"] = "#101317"
    resp = client.put("/api/themes/dark", json=theme)
    assert resp.status_code == 200
    assert client.get("/api/themes/dark").json()["colors"]["bg"] == "#101317"

    # Delete Dark — default falls back to the remaining theme.
    assert client.delete("/api/themes/dark").status_code == 200
    assert client.get("/api/default-theme").json()["default"] == "default"


def test_cannot_delete_only_theme(theme_client):
    client, _ = theme_client
    client.get("/api/themes")  # seed single "default"
    resp = client.delete("/api/themes/default")
    assert resp.status_code == 409


def test_get_unknown_theme_404(theme_client):
    client, _ = theme_client
    client.get("/api/themes")
    assert client.get("/api/themes/nope").status_code == 404


def test_validate_returns_wcag_warning(theme_client):
    client, _ = theme_client
    resp = client.post("/api/themes/default/validate", json=_valid_theme())
    assert resp.status_code == 200
    result = resp.json()
    assert result["valid"] is True
    assert result["errors"] == []
    paths_warned = {w["path"] for w in result["warnings"]}
    assert "colors.text + colors.bg" in paths_warned
    assert all(w["code"] for w in result["warnings"])


def test_validate_returns_valid_with_no_findings_for_high_contrast_theme(theme_client):
    client, _ = theme_client
    theme = _valid_theme()
    theme["colors"]["text"] = "#000000"
    theme["colors"]["bg"] = "#ffffff"
    theme["colors"]["surface"] = "#ffffff"
    theme["colors"]["text_muted"] = "#000000"
    resp = client.post("/api/themes/default/validate", json=theme)
    assert resp.status_code == 200
    assert resp.json() == {"valid": True, "warnings": [], "errors": []}


def test_validate_reports_malformed_color_as_structured_error_not_422(theme_client):
    client, _ = theme_client
    theme = _valid_theme()
    theme["colors"]["text"] = "not-a-color"
    resp = client.post("/api/themes/default/validate", json=theme)
    assert resp.status_code == 200
    result = resp.json()
    assert result["valid"] is False
    assert result["warnings"] == []
    assert len(result["errors"]) == 1
    error = result["errors"][0]
    assert error["path"] == "colors.text"
    assert error["level"] == "error"
    assert error["code"]
    assert error["message"]


def test_validate_reports_unknown_field_as_structured_error(theme_client):
    client, _ = theme_client
    theme = _valid_theme()
    theme["unknown_section"] = {"foo": "bar"}
    resp = client.post("/api/themes/default/validate", json=theme)
    assert resp.status_code == 200
    result = resp.json()
    assert result["valid"] is False
    assert any(e["path"] == "unknown_section" for e in result["errors"])


def test_validate_reports_multiple_malformed_fields_independently(theme_client):
    client, _ = theme_client
    theme = _valid_theme()
    theme["colors"]["text"] = "not-a-color"
    theme["typography"]["heading_weight"] = 9999
    resp = client.post("/api/themes/default/validate", json=theme)
    assert resp.status_code == 200
    result = resp.json()
    assert result["valid"] is False
    paths = {e["path"] for e in result["errors"]}
    assert "colors.text" in paths
    assert "typography.heading_weight" in paths


def test_put_theme_still_uses_automatic_422_for_malformed_body(theme_client):
    client, _ = theme_client
    client.get("/api/themes")  # seed
    theme = _valid_theme()
    theme["colors"]["text"] = "not-a-color"
    resp = client.put("/api/themes/default", json=theme)
    assert resp.status_code == 422


def test_shipped_seed_theme_matches_canonical_defaults():
    repo_root = Path(__file__).resolve().parents[2]
    defaults = json.loads(
        (repo_root / "frontend/src/shared/themeDefaults.json").read_text(encoding="utf-8")
    )
    seed = json.loads((repo_root / "project-seed/themes/light.json").read_text(encoding="utf-8"))
    assert seed == defaults
