"""Runtime home — per-installation directory for the manifest, logs, and widget build.

Replaces the legacy "workspace" notion (where one folder held both the runtime's
bookkeeping AND a single project). The new layout:

    <runtime_home>/
        projects.json   — manifest listing every project known to this runtime
        .logs/          — application logs
        .widget-build/  — compiled custom-widget JS

Projects themselves live wherever the operator places them; the manifest's
``projects[].path`` is the source of truth.

Resolution order:
1. ``NEXTHMI_DATA_DIR`` env var (same var, new meaning — now the runtime home).
2. Bootstrap config file (``core.bootstrap.read_bootstrap_config()``).
3. Dev fallback (``<repo>/.dev-runtime-home/``) — when running from a checkout
   with no env / bootstrap, keep state contained inside the repo tree.
4. Platform default — ``~/Documents/NextHMI/``.

Binaries always export the env var via ``launcher.py`` before any code that
calls into this module, so production hits the env-var branch. Dev (``python
start-dev.py``) hits the dev fallback. Tests monkeypatch the env var or this
module's resolvers directly.
"""
from __future__ import annotations

import os
from pathlib import Path

from core import bootstrap

_REPO_ROOT = Path(__file__).parent.parent.parent
_DEV_RUNTIME_HOME = _REPO_ROOT / ".dev-runtime-home"

MANIFEST_FILENAME = "projects.json"
LOGS_SUBDIR = ".logs"
WIDGET_BUILD_SUBDIR = ".widget-build"
RESTART_SENTINEL_FILENAME = ".restart-pending"


def _platform_default() -> Path:
    return bootstrap.platform_default_data_dir()


def _running_from_checkout() -> bool:
    return (_REPO_ROOT / "start-dev.py").exists()


def runtime_home_path() -> Path:
    """Resolve the runtime home directory.

    No caching — every call re-reads the env var / bootstrap file. The lookup
    is cheap (one env-var read plus, at most, a small JSON file) and the
    no-cache contract lets test fixtures swap dirs without re-importing.
    """
    env_value = os.environ.get("NEXTHMI_DATA_DIR")
    if env_value:
        return Path(env_value).expanduser()
    config = bootstrap.read_bootstrap_config()
    raw = config.get("dataDir")
    if isinstance(raw, str) and raw.strip():
        return Path(raw).expanduser()
    if _running_from_checkout():
        return _DEV_RUNTIME_HOME
    return _platform_default()


def manifest_path() -> Path:
    return runtime_home_path() / MANIFEST_FILENAME


def logs_dir() -> Path:
    env_value = os.environ.get("NEXTHMI_LOGS_DIR")
    if env_value:
        return Path(env_value).expanduser()
    # Binary installs that go through the launcher with a bootstrap-derived
    # data dir keep logs next to the bootstrap file (one well-known place for
    # support). Detected via the ``NEXTHMI_DATA_DIR_SOURCE`` flag set by the
    # launcher.
    if os.environ.get("NEXTHMI_DATA_DIR_SOURCE"):
        return bootstrap.bootstrap_config_path().parent / "logs"
    return runtime_home_path() / LOGS_SUBDIR


def widget_build_dir() -> Path:
    env_value = os.environ.get("NEXTHMI_WIDGET_BUILD_DIR")
    if env_value:
        return Path(env_value).expanduser()
    return runtime_home_path() / WIDGET_BUILD_SUBDIR


def restart_sentinel_path() -> Path:
    return runtime_home_path() / RESTART_SENTINEL_FILENAME
