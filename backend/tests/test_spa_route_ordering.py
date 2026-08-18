"""A router included after app import must still win over the SPA catch-all.

Both app modules register a ``GET /{path:path}`` catch-all at import time,
guarded by ``NEXTHMI_FRONTEND_DIST``. That variable is unset in dev and set in
every Docker and PyInstaller build, so ordering bugs behind it are invisible to
dev usage and to any test that does not set it — which is exactly how a build
shipped with every late-registered GET route answering 404 from the SPA
fallback while its POST routes still worked.

Late registration is how the launcher composes an app: it imports one of these
modules and the importer then calls ``include_router()``. These tests assert the
composition works, without naming any particular importer, so a module added
later is covered too.

Each case runs in a subprocess: the modules read the env var at import, and
re-importing them inside the pytest session would graft their singletons and
routes onto the shared module table for every later test.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND = REPO_ROOT / "backend"

# Runs inside the subprocess. Mirrors what an importing entrypoint does: take
# ``app`` from the module, then mount a router on it.
_PROBE = '''
import json
import sys

from fastapi import APIRouter
from fastapi.testclient import TestClient

module_name, out_path = sys.argv[1], sys.argv[2]
app = __import__(module_name).app

late = APIRouter(prefix="/api/late-probe")


@late.get("/ping")
def _get_ping():
    return {"method": "GET"}


@late.post("/ping")
def _post_ping():
    return {"method": "POST"}


app.include_router(late)

client = TestClient(app)
if module_name == "manager":
    client.post("/api/manager/auth/setup", json={"password": "regression"})

late_get = client.get("/api/late-probe/ping")
late_post = client.post("/api/late-probe/ping")
spa = client.get("/deep/spa/route")
unknown_api = client.get("/api/no-such-route")

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(
        {
            "spa_active": any(
                getattr(r, "path", "") == "/{path:path}" for r in app.router.routes
            ),
            "late_get_status": late_get.status_code,
            "late_get_body": late_get.text[:200],
            "late_post_status": late_post.status_code,
            "spa_status": spa.status_code,
            "spa_content_type": spa.headers.get("content-type", ""),
            "unknown_api_status": unknown_api.status_code,
        },
        fh,
    )
'''


def _run_probe(module_name: str, tmp_path: Path) -> dict:
    dist = tmp_path / "dist"
    (dist / "_app").mkdir(parents=True)
    (dist / "index.html").write_text(
        '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
        encoding="utf-8",
    )
    home = tmp_path / "runtime-home"
    home.mkdir()

    script = tmp_path / "probe.py"
    script.write_text(_PROBE, encoding="utf-8")
    out_path = tmp_path / "result.json"

    env = {
        **os.environ,
        "NEXTHMI_FRONTEND_DIST": str(dist),
        "NEXTHMI_DATA_DIR": str(home),
        "PYTHONPATH": os.pathsep.join([str(BACKEND), os.environ.get("PYTHONPATH", "")]),
    }
    env.pop("NEXTHMI_EDITION", None)

    proc = subprocess.run(
        [sys.executable, str(script), module_name, str(out_path)],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=180,
    )
    assert proc.returncode == 0, f"probe failed:\n{proc.stdout}\n{proc.stderr}"
    return json.loads(out_path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("module_name", ["main", "manager"])
def test_router_included_after_import_is_reachable(module_name: str, tmp_path: Path) -> None:
    result = _run_probe(module_name, tmp_path)

    assert result["spa_active"], (
        f"{module_name}: the SPA catch-all did not register, so this run proves nothing"
    )
    assert result["late_get_status"] == 200, (
        f"{module_name}: GET on a router included after import returned "
        f"{result['late_get_status']} — the SPA catch-all is shadowing it "
        f"(body: {result['late_get_body']!r})"
    )
    assert json.loads(result["late_get_body"]) == {"method": "GET"}
    # POST passing while GET fails is the signature of this bug, so assert both:
    # a green POST alone would have hidden it.
    assert result["late_post_status"] == 200, f"{module_name}: late POST route unreachable"


@pytest.mark.parametrize("module_name", ["main", "manager"])
def test_spa_fallback_still_serves_after_a_late_include(
    module_name: str, tmp_path: Path
) -> None:
    """Pinning the catch-all last must not stop it catching what it should."""
    result = _run_probe(module_name, tmp_path)

    assert result["spa_status"] == 200
    assert "text/html" in result["spa_content_type"]
    # An unmatched /api path must stay a JSON 404 rather than become index.html.
    assert result["unknown_api_status"] == 404
