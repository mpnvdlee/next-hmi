"""opcua.client_pool stays a facade over the split OPC-UA client modules.

Code outside this repository imports from it too, so every name it re-exports
must be the very object its owning module defines. The globals the moved code
looks up are deliberately absent from it, so a monkeypatch aimed at the facade
fails loudly instead of silently patching nothing.
"""

import subprocess
import sys
from pathlib import Path

import opcua
import opcua.client_pool as client_pool
import pytest
from opcua import browse, discovery, engine, limits, pool, routing, security

_OWNERS = (browse, discovery, engine, limits, pool, routing, security)


@pytest.mark.parametrize("name", client_pool.__all__)
def test_a_reexport_is_the_owning_modules_own_object(name: str):
    obj = getattr(client_pool, name)
    assert any(vars(module).get(name) is obj for module in _OWNERS)


def test_the_pool_singleton_is_shared():
    assert client_pool.opcua_pool is pool.opcua_pool is opcua.opcua_pool


@pytest.mark.parametrize(
    "target",
    [
        "opcua.client_pool.active_project_root",
        "opcua.client_pool.active_certs_dir",
        "opcua.client_pool.Client",
    ],
)
def test_a_patch_aimed_at_the_facade_fails_loudly(monkeypatch, target: str):
    with pytest.raises(AttributeError):
        monkeypatch.setattr(target, lambda *_: None)


def test_any_use_of_the_client_applies_the_watchdog_log_patch():
    """A fresh interpreter, so no earlier test has applied it already."""
    code = (
        "import logging, opcua.discovery; "
        "assert getattr(logging.getLogger('asyncua.client.client'), "
        "'_nexthmi_watchdog_patch', False)"
    )
    backend = Path(__file__).resolve().parents[1]
    subprocess.run([sys.executable, "-c", code], cwd=backend, check=True)
