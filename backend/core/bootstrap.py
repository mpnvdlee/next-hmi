"""Bootstrap config for binary installs.

The workspace path needs to be configurable from the Config → Admin UI for
binary distributions (PyInstaller artifacts). The setting itself can't live
*inside* the workspace (chicken-and-egg), and it must survive zip replacement
during upgrades — so it lives at a per-OS standard location *outside* the
binary folder:

- macOS / Linux: ``~/.config/nexthmi/runtime.json``
- Windows: ``%APPDATA%\\NextHMI\\runtime.json``

Reading order (highest precedence wins) is consumed by ``launcher.py``:
1. ``NEXTHMI_DATA_DIR`` env var — used by Docker / explicit overrides.
2. Bootstrap config file — written by the AdminWorkspaceSection.
3. Platform default — ``~/Documents/NextHMI``.

The launcher resolves all of this *before* importing anything that pulls in
``core.storage``, since storage computes its module-level constants at import
time from ``NEXTHMI_DATA_DIR``.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

CONFIG_FILENAME = "runtime.json"


def bootstrap_config_path() -> Path:
    """Per-OS standard path for the bootstrap config file.

    Honors ``XDG_CONFIG_HOME`` on Linux/macOS (per the XDG basedir spec) and
    ``APPDATA`` on Windows. Falls back to ``~/.config/nexthmi/`` everywhere
    else.
    """
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        if base:
            return Path(base) / "NextHMI" / CONFIG_FILENAME
        return Path.home() / "AppData" / "Roaming" / "NextHMI" / CONFIG_FILENAME
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / "nexthmi" / CONFIG_FILENAME
    return Path.home() / ".config" / "nexthmi" / CONFIG_FILENAME


def platform_default_data_dir() -> Path:
    """Default workspace location when no env var or bootstrap file is set.

    Documents folder on every platform — most discoverable spot for a
    non-technical user to find their project files.
    """
    if sys.platform == "win32":
        userprofile = os.environ.get("USERPROFILE")
        if userprofile:
            return Path(userprofile) / "Documents" / "NextHMI"
    return Path.home() / "Documents" / "NextHMI"


def read_bootstrap_config(path: Path | None = None) -> dict[str, Any]:
    """Read the bootstrap config file. Returns ``{}`` if missing or unparseable.

    Intentionally permissive — a corrupt bootstrap file should never prevent
    the launcher from falling back to the platform default. A user can always
    delete the file to reset.
    """
    if path is None:
        path = bootstrap_config_path()
    if not path.exists():
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def write_bootstrap_config(data: dict[str, Any], path: Path | None = None) -> None:
    """Persist the bootstrap config file. Creates parent dirs as needed.

    Intentionally bypasses ``core.storage.write_json``: this module is what
    *configures* storage's paths (the launcher reads it before importing
    ``core.storage``), so pulling storage in here would create an import-order
    cycle and defeat the purpose of having a bootstrap file outside the
    workspace.
    """
    if path is None:
        path = bootstrap_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def resolve_data_dir(
    env: dict[str, str] | None = None,
    bootstrap_path: Path | None = None,
) -> tuple[Path, str]:
    """Resolve the workspace data dir.

    Returns ``(path, source)`` where ``source`` is one of ``"env"``,
    ``"bootstrap"``, or ``"default"``. The caller uses ``source`` to decide
    whether to allow the UI to change the path (env-set installs like Docker
    pin the path read-only).
    """
    if env is None:
        env = dict(os.environ)
    env_value = env.get("NEXTHMI_DATA_DIR")
    if env_value:
        return Path(env_value), "env"

    config = read_bootstrap_config(bootstrap_path)
    raw = config.get("dataDir")
    if isinstance(raw, str) and raw.strip():
        return Path(raw).expanduser(), "bootstrap"

    return platform_default_data_dir(), "default"


def ensure_bootstrap_seeded(
    data_dir: Path,
    bootstrap_path: Path | None = None,
) -> None:
    """If the bootstrap file is absent, write it with the resolved data dir.

    Run by the launcher *after* the platform default has been computed, so
    subsequent runs are explicit about which path is active. Docker / env
    overrides skip this — only callers that actually want a persisted file
    invoke it.
    """
    if bootstrap_path is None:
        bootstrap_path = bootstrap_config_path()
    if bootstrap_path.exists():
        return
    write_bootstrap_config({"dataDir": str(data_dir)}, bootstrap_path)
