"""Golden-snapshot regression: project-testbench's known diagnostic findings.

``project-testbench`` intentionally keeps a handful of draft/nonexistent
variable bindings (an unknown icon, an unbound switch, and the
``LegacyPLC:StructTest`` binding repeated across the 163-widget scale-fixture
page — see maintenance-backlog #40) to exercise the editor's diagnostics UI.
This runs the same whole-project sweep as ``GET /api/config/validate``
against the real ``project-testbench/`` tree and asserts the result against a
checked-in golden list (backlog #39): a new, unapproved diagnostic finding
fails this test, while the currently-known/intentional ones are allowed.

Adding a genuinely new intentional finding to project-testbench means
regenerating ``fixtures/project_testbench_diagnostics.json`` deliberately, not
silently — that's the point of checking it in.
"""

import json
from pathlib import Path
from typing import Any

import core.storage as storage
import core.validation.structure as structure
import pytest
import services.widget_compiler as widget_compiler
from core.exceptions import register_exception_handlers
from fastapi import FastAPI
from fastapi.testclient import TestClient
from services.datasource_manager import datasource_manager

REPO_ROOT = Path(__file__).resolve().parents[2]
PROJECT_TESTBENCH = REPO_ROOT / "project-testbench"
GOLDEN_PATH = Path(__file__).parent / "fixtures" / "project_testbench_diagnostics.json"


def _diagnostic_key(d: dict[str, Any]) -> tuple:
    return (d["artifactKind"], d["artifactId"] or "", d["sourcePath"], d["code"], d["message"])


@pytest.fixture()
def testbench_diagnostics(monkeypatch, tmp_path: Path) -> list[dict[str, Any]]:
    """Run the real ``GET /api/config/validate`` sweep against project-testbench.

    Regenerates the widget-schema manifest from the actual builtin registry
    plus project-testbench's actual custom widgets, into a scratch build dir
    so the run never touches the real runtime home. Forces the datasource
    typed-registry to fall back to the on-disk scan (no live OPC pool here),
    matching how the sweep behaves against a freshly opened project. Entirely
    read-only against project-testbench itself — the sweep never writes.
    """
    build_dir = tmp_path / "widget-build"
    build_dir.mkdir()
    monkeypatch.setattr(widget_compiler, "WIDGET_BUILD_DIR", build_dir)
    monkeypatch.setattr(structure, "WIDGET_SCHEMAS_PATH", build_dir / "widget-schemas.json")
    monkeypatch.setattr(structure, "_manifest_cache", None)
    assert widget_compiler.regenerate_widget_schemas(src_dir=PROJECT_TESTBENCH / "custom-widgets")

    monkeypatch.setattr(datasource_manager, "datasources", {})
    monkeypatch.setattr(storage, "_active_project_path", lambda: PROJECT_TESTBENCH)

    from api.config_api import router

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(router)
    with TestClient(app) as client:
        resp = client.get("/api/config/validate")
    assert resp.status_code == 200
    return sorted(resp.json()["diagnostics"], key=_diagnostic_key)


@pytest.mark.skipif(not PROJECT_TESTBENCH.exists(), reason="project-testbench not present")
def test_project_testbench_diagnostics_match_golden_snapshot(testbench_diagnostics):
    golden = sorted(json.loads(GOLDEN_PATH.read_text(encoding="utf-8")), key=_diagnostic_key)
    assert testbench_diagnostics == golden, (
        "project-testbench's diagnostics changed. If this is a new, "
        "unapproved finding, fix the binding instead of updating the golden "
        "file. If it's a deliberate new/changed intentional finding, "
        f"regenerate {GOLDEN_PATH} and record it in "
        "docs/operations/maintenance-backlog.md #39."
    )
