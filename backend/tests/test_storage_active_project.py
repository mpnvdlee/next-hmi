"""active_project_root() honours the process pin, and only the process pin.

Scope-vs-pin precedence is covered by ``test_storage_scope.py``.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from core import storage


def test_env_override_wins(monkeypatch, tmp_path: Path) -> None:
    pinned = tmp_path / "pinned-project"
    pinned.mkdir()
    monkeypatch.setenv("NEXTHMI_ACTIVE_PROJECT_PATH", str(pinned))
    assert storage.active_project_root() == pinned
    # Derived resolvers follow the pin.
    assert storage.active_datasources_dir() == pinned / "datasources"


def test_no_pin_raises_no_live_project(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("NEXTHMI_ACTIVE_PROJECT_PATH", raising=False)
    with pytest.raises(storage.NoLiveProjectError):
        storage.active_project_root()
