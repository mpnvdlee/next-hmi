"""FastMCP public-API dependency contract (maintenance-backlog item 13).

Pins the supported ``mcp`` (FastMCP) version and asserts that
``mcp_server.scoped`` — the project-scoping layer — registers tools using only
public ``FastMCP`` API (``tool()`` / ``add_tool()``) and never imports or
mutates FastMCP's private tool-manager storage. A source-text check is
deliberately used alongside the import assertions below: it protects against
a *future* regression re-introducing a private import even if some other
public surface happened to still work.
"""
from __future__ import annotations

import importlib.metadata
import inspect
from pathlib import Path

import mcp_server.scoped as scoped
import pytest
from mcp_server.server import mcp_app
from packaging.specifiers import SpecifierSet

# Mirrors backend/requirements.txt's ``mcp~=2.0.0`` pin. If this fails after
# a deliberate dependency bump, update both together and re-verify the public
# extension point below still exists on the new version.
_PINNED_MCP_SPECIFIER = "~=2.0.0"


def test_installed_mcp_version_matches_the_pin():
    installed = importlib.metadata.version("mcp")
    assert installed in SpecifierSet(_PINNED_MCP_SPECIFIER)


def test_requirements_txt_pins_the_same_specifier():
    backend_dir = Path(__file__).resolve().parents[1]
    requirements = (backend_dir / "requirements.txt").read_text(encoding="utf-8")
    assert f"mcp{_PINNED_MCP_SPECIFIER}" in requirements


def test_fastmcp_exposes_the_public_registration_extension_point():
    """The pinned version must keep exposing the public API scoped.py relies
    on: MCPServer.tool() (decorator) and MCPServer.add_tool() (imperative)."""
    assert callable(getattr(type(mcp_app), "tool", None))
    assert callable(getattr(type(mcp_app), "add_tool", None))
    tool_sig = inspect.signature(type(mcp_app).tool)
    assert "structured_output" in tool_sig.parameters


_FORBIDDEN_SNIPPETS = (
    "mcp.server.mcpserver.tools",
    "mcp.server.mcpserver.utilities.func_metadata",
    "_tool_manager",
)


@pytest.mark.parametrize("module", [scoped, __import__("mcp_server.server", fromlist=["_"])])
def test_no_private_fastmcp_imports_or_tool_manager_access(module):
    source = inspect.getsource(module)
    for snippet in _FORBIDDEN_SNIPPETS:
        assert snippet not in source, f"{module.__name__} references private FastMCP internal {snippet!r}"


def test_scope_registered_tools_drains_the_application_owned_queue():
    """Registration goes through server._PENDING_TOOLS (app-owned) once, via
    the public FastMCP.tool() decorator — not a rewrap of an already
    -registered private Tool object."""
    from mcp_server.server import _PENDING_TOOLS, PendingTool

    def fake_fn(x: int = 0) -> dict:
        return {"x": x}

    _PENDING_TOOLS.append(
        PendingTool(fn=fake_fn, name="_contract_test_tool", description="x", is_write=False, structured_output=False)
    )
    try:
        assert "_contract_test_tool" not in mcp_app._tool_manager._tools
        scoped.scope_registered_tools()
        assert "_contract_test_tool" in mcp_app._tool_manager._tools
        # Draining is destructive — the queue must not double-register on a
        # second call (nothing left to drain).
        assert _PENDING_TOOLS == []
    finally:
        mcp_app._tool_manager._tools.pop("_contract_test_tool", None)


def test_scoped_tool_argument_schema_adds_project_and_keeps_originals():
    """End-to-end sanity that the signature-injection approach (public
    inspect.Signature, not a hand-built pydantic model against private
    FuncMetadata) produces the same required/optional argument split as
    before: every original tool still resolves, plus a required ``project``.
    """
    from mcp_server.server import prepare_workspace_tools

    prepare_workspace_tools()
    tool = mcp_app._tool_manager.get_tool("pages_create")
    assert tool is not None
    schema = tool.parameters
    assert schema["required"] == ["project"] or "project" in schema["required"]
    assert "project" in schema["properties"]
    assert "title" in schema["properties"]
