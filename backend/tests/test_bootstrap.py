"""Tests for ``core.bootstrap`` resolver chain.

Covers:
- env var wins over bootstrap file, bootstrap file wins over default
- absent bootstrap file is written on first call via ``ensure_bootstrap_seeded``
- read tolerates missing / unparseable / non-dict files
- bootstrap config path honors platform conventions (XDG / APPDATA)

``core.bootstrap`` only resolves the runtime home's location; reading and
writing it goes through ``/api/system/runtime-home`` (see
``test_runtime_home_api.py``). There is no ``/api/admin/workspace`` endpoint —
the "workspace" notion it belonged to was replaced by the runtime home.
"""
from __future__ import annotations

import json
from pathlib import Path

from core import bootstrap

# ── core.bootstrap ──────────────────────────────────────────────────────────

def test_resolve_data_dir_prefers_env(monkeypatch, tmp_path):
    boot = tmp_path / "runtime.json"
    boot.write_text(json.dumps({"dataDir": "/from/file"}))
    path, source = bootstrap.resolve_data_dir(
        env={"NEXTHMI_DATA_DIR": "/from/env"}, bootstrap_path=boot
    )
    assert source == "env"
    assert path == Path("/from/env")


def test_resolve_data_dir_uses_bootstrap_when_no_env(tmp_path):
    boot = tmp_path / "runtime.json"
    boot.write_text(json.dumps({"dataDir": str(tmp_path / "ws")}))
    path, source = bootstrap.resolve_data_dir(env={}, bootstrap_path=boot)
    assert source == "bootstrap"
    assert path == tmp_path / "ws"


def test_resolve_data_dir_falls_back_to_default_when_absent(tmp_path):
    boot = tmp_path / "missing.json"
    path, source = bootstrap.resolve_data_dir(env={}, bootstrap_path=boot)
    assert source == "default"
    assert path == bootstrap.platform_default_data_dir()


def test_read_bootstrap_config_tolerates_corruption(tmp_path):
    boot = tmp_path / "runtime.json"
    boot.write_text("{not json")
    assert bootstrap.read_bootstrap_config(boot) == {}


def test_read_bootstrap_config_rejects_non_dict(tmp_path):
    boot = tmp_path / "runtime.json"
    boot.write_text(json.dumps(["a", "b"]))
    assert bootstrap.read_bootstrap_config(boot) == {}


def test_ensure_bootstrap_seeded_writes_on_first_call(tmp_path):
    boot = tmp_path / "runtime.json"
    assert not boot.exists()
    data_dir = tmp_path / "ws"
    bootstrap.ensure_bootstrap_seeded(data_dir, bootstrap_path=boot)
    assert boot.exists()
    data = json.loads(boot.read_text())
    assert data["dataDir"] == str(data_dir)


def test_ensure_bootstrap_seeded_does_not_overwrite_existing(tmp_path):
    boot = tmp_path / "runtime.json"
    boot.write_text(json.dumps({"dataDir": "/existing"}))
    bootstrap.ensure_bootstrap_seeded(tmp_path / "new", bootstrap_path=boot)
    assert json.loads(boot.read_text())["dataDir"] == "/existing"


def test_write_bootstrap_config_creates_parent_dirs(tmp_path):
    boot = tmp_path / "nested" / "dir" / "runtime.json"
    bootstrap.write_bootstrap_config({"dataDir": "/x"}, boot)
    assert boot.exists()
    assert json.loads(boot.read_text())["dataDir"] == "/x"


def test_bootstrap_config_path_honors_xdg(monkeypatch, tmp_path):
    monkeypatch.delenv("NEXTHMI_DATA_DIR", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setattr("sys.platform", "linux", raising=False)
    expected = tmp_path / "nexthmi" / "runtime.json"
    assert bootstrap.bootstrap_config_path() == expected


def test_bootstrap_config_path_windows(monkeypatch, tmp_path):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.setattr("sys.platform", "win32", raising=False)
    expected = tmp_path / "NextHMI" / "runtime.json"
    assert bootstrap.bootstrap_config_path() == expected


def test_launcher_does_not_copy_project_files_into_runtime_home(monkeypatch, tmp_path):
    import launcher

    runtime_home = tmp_path / "runtime-home"
    runtime_home.mkdir()
    monkeypatch.setattr(
        launcher.bootstrap,
        "resolve_data_dir",
        lambda: (runtime_home, "env"),
    )
    monkeypatch.setattr(launcher, "_run_manager", lambda data_dir, args: 0)
    monkeypatch.setattr(launcher, "_esbuild_binary_path", lambda: None)
    # Guard is version-tested separately; keep this test interpreter-agnostic.
    monkeypatch.setattr(launcher, "_require_supported_python", lambda: None)
    # In a checkout that has run `npm run build`, `main` would export the real
    # frontend/dist as NEXTHMI_FRONTEND_DIST. `frontend_serve` caches that at
    # first use, so restoring the env afterwards is too late and every later
    # test in the session gets a manager that serves the SPA catch-all for
    # paths that must 404. Point the lookup at a non-directory, the same way
    # `_esbuild_binary_path` is neutralised above.
    monkeypatch.setattr(launcher, "_resource_path", lambda relative: tmp_path / "absent")
    # `main` also exports its resolved paths process-wide and never unwinds
    # them; touch each key through monkeypatch so teardown restores it.
    for key in (
        "NEXTHMI_DATA_DIR",
        "NEXTHMI_DATA_DIR_SOURCE",
        "NEXTHMI_WIDGET_BUILD_DIR",
        "NEXTHMI_FRONTEND_DIST",
        "ESBUILD_BINARY_PATH",
    ):
        monkeypatch.delenv(key, raising=False)

    assert launcher.main([]) == 0
    assert list(runtime_home.iterdir()) == []
