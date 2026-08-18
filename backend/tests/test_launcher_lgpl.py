"""``launcher._prepend_lgpl_path`` — the runtime half of the LGPL carve-out.

``build/nexthmi.spec`` ships asyncua and zeroconf as loose directories under
``lgpl/`` instead of inside the frozen archive (release item 1a). This function
puts that directory back on ``sys.path`` before either package is imported, and
fails legibly if a broken install dropped it.
"""
from __future__ import annotations

import sys

import launcher
import pytest


@pytest.fixture(autouse=True)
def _isolate_sys_path(monkeypatch):
    # Give each test its own sys.path copy so insertions can't leak.
    monkeypatch.setattr(sys, "path", list(sys.path))


def test_noop_when_not_frozen(monkeypatch):
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    before = list(sys.path)
    launcher._prepend_lgpl_path()
    assert sys.path == before


def test_inserts_lgpl_dir_when_frozen(monkeypatch, tmp_path):
    (tmp_path / "lgpl").mkdir()
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)

    launcher._prepend_lgpl_path()

    assert sys.path[0] == str(tmp_path / "lgpl")


def test_idempotent(monkeypatch, tmp_path):
    (tmp_path / "lgpl").mkdir()
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)

    launcher._prepend_lgpl_path()
    launcher._prepend_lgpl_path()

    assert sys.path.count(str(tmp_path / "lgpl")) == 1


def test_exits_when_lgpl_dir_missing(monkeypatch, tmp_path):
    # _MEIPASS with no lgpl/ subdirectory: a corrupt or partial extraction.
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)

    with pytest.raises(SystemExit, match="lgpl"):
        launcher._prepend_lgpl_path()
