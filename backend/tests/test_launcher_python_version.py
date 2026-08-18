"""``launcher._require_supported_python`` — the startup interpreter guard.

Release item 16: the product refuses to run on an unsupported CPython instead of
failing deep inside a version-sensitive import. The supported range mirrors the
README ("Python 3.14 (>=3.14.2, <3.15)"). Tested by faking ``sys.version_info``
so it runs identically on any interpreter, including the stale 3.13 dev venv.
"""
import sys

import launcher
import pytest


def _fake_version(monkeypatch, triple):
    monkeypatch.setattr(sys, "version_info", triple, raising=False)


@pytest.mark.parametrize(
    "triple",
    [
        (3, 14, 2),           # exact floor
        (3, 14, 7),           # patch above floor
        (3, 14, 99),          # any 3.14 patch
    ],
)
def test_accepts_supported(monkeypatch, triple):
    _fake_version(monkeypatch, triple)
    assert launcher._require_supported_python() is None


@pytest.mark.parametrize(
    "triple",
    [
        (3, 13, 12),          # this dev venv — below floor
        (3, 14, 0),           # 3.14 before the required patch
        (3, 14, 1),
        (3, 15, 0),           # too new (upper bound is exclusive)
        (4, 0, 0),
    ],
)
def test_rejects_unsupported(monkeypatch, triple):
    _fake_version(monkeypatch, triple)
    with pytest.raises(SystemExit) as exc:
        launcher._require_supported_python()
    # Message names both the requirement and what was found.
    msg = str(exc.value)
    assert ".".join(map(str, triple)) in msg
    assert "3.14.2" in msg and "3.15" in msg
