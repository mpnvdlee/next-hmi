"""The dev backend's bind host, and the host its banner prints (``start-dev.py``).

``start-dev.py`` runs uvicorn with ``--reload``, which binds through
``Config.bind_socket`` rather than the event loop. That path opens a single
AF_INET socket unless the host string contains a colon, so it needs the
opposite spelling from the launcher's — see ``core.net.DEFAULT_HOST``.

What the splash prints is a separate question from what is bound — see
``core.net.display_url`` and ``core.net.network_urls``.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_START_DEV = Path(__file__).resolve().parents[2] / "start-dev.py"


@pytest.fixture(scope="module")
def start_dev():
    """Load the hyphenated top-level script as a module.

    Everything below its ``if __name__ == "__main__"`` guard is constants and
    imports, so loading it starts nothing.
    """
    spec = importlib.util.spec_from_file_location("start_dev_under_test", _START_DEV)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_wildcard_becomes_the_ipv6_spelling(start_dev, monkeypatch) -> None:
    """The whole point: an AF_INET6 socket is what answers both families here."""
    monkeypatch.setattr(start_dev, "IS_WINDOWS", False)
    assert start_dev._reload_bind_host("") == "::"


def test_wildcard_stays_ipv4_on_windows(start_dev, monkeypatch) -> None:
    """Windows defaults IPV6_V6ONLY on, so ``::`` would trade one half of
    localhost for the other rather than gaining anything."""
    monkeypatch.setattr(start_dev, "IS_WINDOWS", True)
    assert start_dev._reload_bind_host("") == ""


@pytest.mark.parametrize("pinned", ["127.0.0.1", "0.0.0.0", "10.0.0.7", "::1"])
def test_a_pinned_host_is_passed_through(start_dev, monkeypatch, pinned) -> None:
    """NEXTHMI_HOST names an interface deliberately; widening it is not ours."""
    monkeypatch.setattr(start_dev, "IS_WINDOWS", False)
    assert start_dev._reload_bind_host(pinned) == pinned
