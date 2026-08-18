"""Project-scoping layer for the workspace MCP server.

The ``tools/*.py`` functions are project-agnostic: they resolve paths only
through ``core.storage.active_*`` resolvers. This module turns each *pending*
tool queued by ``server.register_tool`` / ``server.expose_read_tool`` into a
project-scoped one — adding a required ``project`` argument, running the
original inside ``use_project(project)``, authenticating/authorizing the call
(``mcp_server.auth.require_mcp_access``), and refusing writes when the
project's ``mcpEnabled`` flag is off — then registers it, in that final form,
via the public ``MCPServer.tool()`` decorator.

Item 13 of the maintenance backlog: earlier this module registered tools
un-scoped first and rewrapped them in place by reaching into FastMCP's
private tool-manager dict and hand-building its internal ``Tool``/
``FuncMetadata`` objects. Registration now happens exactly once, already
scoped, through ``server._PENDING_TOOLS`` (an application-owned queue) and
``MCPServer.tool()`` (a public, documented API) — nothing here imports or
mutates MCPServer's private storage. The wrapper's advertised signature is
built by copying the original function's real ``inspect.Signature`` (so
MCPServer's own signature-driven schema/output-model derivation produces the
same result it always has) and appending ``project``; the wrapper itself
still takes ``**kwargs`` because MCPServer always calls tools by keyword.

The wrapper also declares a real (non-spoofed) ``ctx: Context`` parameter —
separate from the ``__signature__`` override used for schema derivation —
which mcp 2.0's context-injection machinery detects and fills in on every
real tool call. That's the one place the request's ``Context`` is available;
it's stashed in ``server._current_mcp_session`` for the duration of the call
so ``get_agent_label()``, called several frames down inside tools/*.py, can
still read it ambiently.
"""
from __future__ import annotations

import inspect
from typing import Annotated, Any

from core.manifest import project_mcp_enabled
from core.storage import active_project_root, use_project
from mcp.server.mcpserver import Context
from pydantic import Field

from . import auth as mcp_auth
from .server import _PENDING_TOOLS, PendingTool, _current_mcp_session, mcp_app


class McpWriteDisabledError(Exception):
    """Raised when a write tool targets a project whose ``mcpEnabled`` is off."""

    code = "mcp_write_disabled"


_PROJECT_FIELD_DESCRIPTION = (
    "Target project id (from projects_list). The tool acts on this project, "
    "running or stopped."
)


def _require_write_allowed(project_id: str) -> None:
    # Runs inside the active ``use_project`` scope, which already resolved and
    # validated the project — read the flag off the scoped path rather than
    # re-loading the manifest. This is purely the auth scope.
    if not project_mcp_enabled(active_project_root()):
        raise McpWriteDisabledError(
            f"MCP writes are disabled for project '{project_id}'. Enable MCP for "
            "this project in the manager dashboard."
        )


def _scoped_signature(fn: Any) -> inspect.Signature:
    """The original function's signature plus a trailing required ``project``."""
    original = inspect.signature(fn)
    project_param = inspect.Parameter(
        "project",
        kind=inspect.Parameter.KEYWORD_ONLY,
        annotation=Annotated[str, Field(description=_PROJECT_FIELD_DESCRIPTION)],
    )
    return original.replace(parameters=[*original.parameters.values(), project_param])


def _make_scoped_wrapper(pending: PendingTool) -> Any:
    orig_fn = pending.fn
    is_async = inspect.iscoroutinefunction(orig_fn)

    async def wrapper(ctx: Context, **kwargs: Any) -> Any:
        project_id = kwargs.pop("project")
        try:
            session = ctx.session
        except (ValueError, AttributeError):
            # Context() built without a request_context (e.g. a test driving
            # the tool manager directly) has no session to read — accessing
            # .request_context raises ValueError in that case.
            session = None
        token = _current_mcp_session.set(session)
        try:
            with use_project(project_id):
                mcp_auth.require_mcp_access(project_id, need_write=pending.is_write)
                if pending.is_write:
                    _require_write_allowed(project_id)
                if is_async:
                    return await orig_fn(**kwargs)
                return orig_fn(**kwargs)
        finally:
            _current_mcp_session.reset(token)

    wrapper.__name__ = pending.name
    wrapper.__doc__ = pending.description
    wrapper.__signature__ = _scoped_signature(orig_fn)
    return wrapper


def scope_registered_tools() -> None:
    """Drain ``server._PENDING_TOOLS``, registering each entry project-scoped.

    Call exactly once, between ``import_all()`` (which populates the queue)
    and ``workspace.register_workspace_tools()`` (which registers its two
    tools directly and must not see project-scoped entries here).
    """
    for pending in _PENDING_TOOLS:
        wrapper = _make_scoped_wrapper(pending)
        mcp_app.tool(
            name=pending.name,
            description=pending.description,
            structured_output=pending.structured_output,
        )(wrapper)
    _PENDING_TOOLS.clear()
