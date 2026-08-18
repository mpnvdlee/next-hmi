"""Workspace MCP server — discovery, project-scoped routing, and write auth.

Drives the tools through the MCPServer tool manager exactly as the transport
would: ``projects_list`` discovers projects; every other tool takes a
``project`` argument resolved per call; writes are refused when a project's
``mcpEnabled`` is off.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from core import manifest as manifest_mod
from core.manifest import ManifestV1, ProjectEntry, save_manifest
from core.time_utils import iso_now
from mcp.server.mcpserver import Context
from mcp.server.mcpserver.exceptions import ToolError


def _run(coro):
    return asyncio.run(coro)


class _ToolManagerFacade:
    """mcp 2.0's ``ToolManager.call_tool`` now requires an explicit ``Context``
    argument (there's no more ambient access to one). Every test below calls
    ``tools.call_tool(name, arguments)`` the same way the pre-2.0 API allowed,
    so this wraps the real tool manager and supplies a bare ``Context`` (no
    live request/session behind it — the tools under test here don't read
    ``ctx.session``) rather than touching every call site."""

    def __init__(self, tool_manager, mcp_app) -> None:
        self._tool_manager = tool_manager
        self._context = Context(mcp_server=mcp_app)

    def call_tool(self, name: str, arguments: dict):
        return self._tool_manager.call_tool(name, arguments, self._context)


@pytest.fixture
def tools(monkeypatch, tmp_path: Path):
    manifest_path = tmp_path / "projects.json"
    monkeypatch.setattr(manifest_mod, "manifest_path", lambda: manifest_path)

    def _make(name: str, enabled: bool) -> Path:
        root = tmp_path / name
        (root / "pages").mkdir(parents=True)
        (root / "config.json").write_text(
            json.dumps({"mcpEnabled": enabled, "pages": []}), encoding="utf-8"
        )
        return root

    on = _make("on", True)
    off = _make("off", False)
    save_manifest(
        ManifestV1(
            projects=[
                ProjectEntry(id="ON", name="On", path=str(on), addedAt=iso_now()),
                ProjectEntry(id="OFF", name="Off", path=str(off), addedAt=iso_now()),
            ]
        )
    )

    from mcp_server.auth import McpIdentity, identity_for_tests
    from mcp_server.server import mcp_app, prepare_workspace_tools

    prepare_workspace_tools()
    # A manager session carries full workspace access, same as an operator
    # driving the dashboard — the transport-level auth boundary (item 12) is
    # covered separately in test_mcp_auth.py.
    with identity_for_tests(McpIdentity(kind="session")):
        yield _ToolManagerFacade(mcp_app._tool_manager, mcp_app)


def test_projects_list_reports_status_and_mcp(tools) -> None:
    result = _run(tools.call_tool("projects_list", {}))
    by_id = {p["id"]: p for p in result["items"]}
    assert by_id["ON"]["mcpEnabled"] is True
    assert by_id["OFF"]["mcpEnabled"] is False
    # No supervisor child in tests → stopped.
    assert by_id["ON"]["status"] == "stopped"


def test_projects_get_returns_detail(tools) -> None:
    result = _run(tools.call_tool("projects_get", {"project": "ON"}))
    assert result["id"] == "ON"
    assert result["mcpEnabled"] is True
    assert "path" in result


def test_scoped_read_routes_to_named_project(tools) -> None:
    assert _run(tools.call_tool("pages_list", {"project": "ON"})) == {"items": []}


def test_scoped_tool_requires_project_argument(tools) -> None:
    with pytest.raises(ToolError):
        _run(tools.call_tool("pages_list", {}))


def test_unknown_project_is_rejected(tools) -> None:
    with pytest.raises(Exception) as excinfo:
        _run(tools.call_tool("pages_list", {"project": "NOPE"}))
    assert "not found" in str(excinfo.value).lower()


def test_write_refused_when_mcp_disabled(tools, tmp_path: Path) -> None:
    with pytest.raises(Exception) as excinfo:
        _run(tools.call_tool("pages_create", {"project": "OFF", "title": "X"}))
    assert "disabled" in str(excinfo.value).lower()
    # Nothing was written: no page files and the index stays empty.
    assert list((tmp_path / "off" / "pages").glob("*.json")) == []
    config = json.loads((tmp_path / "off" / "config.json").read_text())
    assert config["pages"] == []


def test_write_allowed_and_persisted_when_enabled(tools, tmp_path: Path) -> None:
    result = _run(tools.call_tool("pages_create", {"project": "ON", "title": "Home"}))
    assert result["result"] == "applied"
    page_id = result["page_id"]
    assert (tmp_path / "on" / "pages" / f"{page_id}.json").exists()
    # The project's mcpEnabled flag survives the config-index rewrite.
    config = json.loads((tmp_path / "on" / "config.json").read_text())
    assert config["mcpEnabled"] is True
    assert {"id": page_id, "type": "page"} in config["pages"]


def test_prompts_include_project_on_tool_calls() -> None:
    from mcp_server.prompts.build_datasource_dashboard import build_datasource_dashboard
    from mcp_server.prompts.localize_strings import localize_strings
    from mcp_server.prompts.scaffold_page import scaffold_page
    from mcp_server.prompts.seed_alarms_from_datasource import (
        seed_alarms_from_datasource,
    )

    outputs = [
        build_datasource_dashboard("ON", "PLC"),
        localize_strings("ON", "home"),
        scaffold_page("ON", "Overview"),
        seed_alarms_from_datasource("ON", "PLC"),
    ]
    for output in outputs:
        assert "project 'ON'" in output
        for line in output.splitlines():
            if "Call `" in line or "call `" in line:
                assert "project='ON'" in line
