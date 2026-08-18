from __future__ import annotations

import logging
from collections.abc import Callable
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, TypeVar

from mcp.server.mcpserver import MCPServer
from starlette.types import ASGIApp, Receive, Scope, Send

from . import agent_label


def _build_mcp_app() -> MCPServer:
    # MCPServer.__init__ calls logging.basicConfig(level=INFO) which would unblock
    # asyncua's per-publish "Publish callback" INFO spam. Snapshot root logger
    # state and restore after, so the host process's logging stays untouched.
    root = logging.getLogger()
    saved_level = root.level
    saved_handlers = list(root.handlers)
    instance = MCPServer(
        "NEXT HMI",
        instructions=(
            "NEXT HMI multi-project workspace. This one endpoint serves every "
            "project. Start with ``projects_list`` to discover projects (each "
            "has an ``id``, ``status``, and ``mcpEnabled``), then pass an "
            "``id`` as the required ``project`` argument of any other tool — "
            "the project is per-call context, not session state, so the same "
            "session can act on several projects and a project need not be "
            "running to be edited. Read tools (``*_list``, ``*_get``) expose "
            "pages, datasources, variables, alarms, translations, assets, "
            "components, users, and widget schemas. Write tools are namespaced "
            "per-artifact (pages_*, variables_*, alarms_*, translations_*, "
            "assets_*) and are refused when the target project's ``mcpEnabled`` "
            "is false. All writes validate strictly against the widget-schema "
            "manifest and existing IDs. Destructive ops are two-step: call once "
            "for a dry-run diff, then again with confirm=true to apply."
        ),
    )
    # Drop any handler basicConfig added that wasn't there before, then
    # restore the prior level.
    for handler in list(root.handlers):
        if handler not in saved_handlers:
            root.removeHandler(handler)
    root.setLevel(saved_level)
    return instance


mcp_app = _build_mcp_app()


F = TypeVar("F", bound=Callable[..., Any])

# Names registered as read tools (``*_list`` / ``*_get`` / schema reads). The
# scoped-registration layer (``mcp_server.scoped``) treats every other pending
# tool as a write and refuses it when the target project's ``mcpEnabled`` is off.
READ_TOOL_NAMES: set[str] = set()


@dataclass(frozen=True)
class PendingTool:
    """An un-scoped project tool queued for ``mcp_server.scoped`` to wrap.

    Application-owned registry (item 13 of the maintenance backlog): tools/*.py
    modules queue themselves here via ``register_tool``/``expose_read_tool``
    instead of registering onto ``mcp_app`` directly, so the *only* function
    that ever calls it is registered once, already project-scoped, via the
    public ``MCPServer.tool()`` decorator — nothing reads or mutates MCPServer's
    private tool-manager storage to rewrap an existing registration.
    """

    fn: Callable[..., Any]
    name: str
    description: str | None
    is_write: bool
    structured_output: bool | None


# Drained exactly once by ``mcp_server.scoped.scope_registered_tools()``,
# between ``import_all()`` (which populates it) and
# ``workspace.register_workspace_tools()`` (which registers directly and must
# not see project-scoped entries here).
_PENDING_TOOLS: list[PendingTool] = []


def register_tool(
    *, name: str | None = None, description: str | None = None, structured_output: bool | None = True
) -> Callable[[F], F]:
    """Queue a project-scoped write tool. Replaces ``@mcp_app.tool(...)``.

    The decorated function is returned unchanged (still directly callable/
    importable by tests); its actual MCP registration — with the ``project``
    argument added — happens later in ``scoped.scope_registered_tools()``.
    """

    def decorator(fn: F) -> F:
        _PENDING_TOOLS.append(
            PendingTool(
                fn=fn,
                name=name or fn.__name__,
                description=description or fn.__doc__,
                is_write=True,
                structured_output=structured_output,
            )
        )
        return fn

    return decorator


def expose_read_tool(payload_fn: F, *, name: str, description: str) -> F:  # noqa: UP047 -- PEP 695 type-param syntax is a manual rewrite (module-level TypeVar `F` also used elsewhere), not mechanical
    """Queue a project-scoped read tool. Returns the same fn so the caller can
    bind it under a module-level name that tests import."""
    _PENDING_TOOLS.append(
        PendingTool(
            fn=payload_fn, name=name, description=description, is_write=False, structured_output=None,
        )
    )
    READ_TOOL_NAMES.add(name)
    return payload_fn


def expose_workspace_tool(payload_fn: F, *, name: str, description: str) -> F:  # noqa: UP047 -- PEP 695 type-param syntax is a manual rewrite (module-level TypeVar `F` also used elsewhere), not mechanical
    """Register *payload_fn* directly, with no project-scoping wrapper.

    Used only by the two un-scoped workspace discovery tools
    (``projects_list`` / ``projects_get``) — a plain, immediate call to the
    public ``MCPServer.tool()`` decorator, bypassing the pending-tool queue.
    """
    mcp_app.tool(name=name, description=description)(payload_fn)
    return payload_fn


# mcp 2.0 dropped FastMCP.get_context() (no more ambient access to the current
# request's Context from arbitrary call stacks) — Context is now only
# available where the framework injects it: a ``Context``-typed parameter on
# the function it actually calls, which is ``mcp_server.scoped``'s wrapper,
# not the tools/*.py functions that call ``get_agent_label()`` several frames
# below it. The wrapper stashes the session here for the duration of the call
# so this ambient-lookup call pattern keeps working unchanged.
_current_mcp_session: ContextVar[Any | None] = ContextVar("_current_mcp_session", default=None)


def get_agent_label() -> str:
    return agent_label.resolve_label(_current_mcp_session.get())


class _LabelMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            header_value: str | None = None
            for raw_key, raw_value in scope.get("headers", []):
                if raw_key == b"x-mcp-agent":
                    header_value = raw_value.decode("ascii", errors="ignore").strip()
                    break
            token = agent_label._header_label.set(header_value)
            try:
                await self._app(scope, receive, send)
            finally:
                agent_label._header_label.reset(token)
            return
        await self._app(scope, receive, send)


class _McpSlashMiddleware:
    """Route ``/mcp`` to the mount as if the client had asked for ``/mcp/``.

    A Starlette ``Mount`` only matches paths *under* its prefix, so bare
    ``/mcp`` falls through to the router's ``redirect_slashes`` and comes back
    as a 307. Most MCP clients do not follow redirects, so a config that omits
    the slash would fail outright — rewrite the path before routing instead.
    """

    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope.get("path") == "/mcp":
            scope = {**scope, "path": "/mcp/"}
            if scope.get("raw_path") == b"/mcp":
                scope["raw_path"] = b"/mcp/"
        await self._app(scope, receive, send)


def build_mcp_asgi_app() -> ASGIApp:
    """The ``/mcp`` ASGI app: auth gate, then agent-label capture, then MCPServer.

    ``McpAuthMiddleware`` (item 12) wraps everything else so an
    unauthenticated request never reaches the label middleware or MCPServer's
    own session logic.
    """
    from . import auth as mcp_auth

    # stateless_http/streamable_http_path moved here from the MCPServer
    # constructor in mcp 2.0.
    inner = mcp_app.streamable_http_app(stateless_http=False, streamable_http_path="/")
    inner.add_middleware(_LabelMiddleware)
    return mcp_auth.McpAuthMiddleware(inner)


_session_started = False


@asynccontextmanager
async def run_session_manager_once():
    """Enter the streamable-HTTP session manager, but only the first time.

    ``mcp_app`` is a process-global singleton and its ``session_manager`` may be
    ``run()`` exactly once per instance. In production the manager lifespan runs
    a single time, so this is transparent; in tests (which spin up several
    ``TestClient(manager.app)`` lifespans, plus module reloads) the guard keeps
    later lifespans from re-entering — those clients simply don't exercise
    ``/mcp``.
    """
    global _session_started
    if _session_started:
        yield
        return
    _session_started = True
    async with mcp_app.session_manager.run():
        yield


_REGISTERED_MODULES = (
    "mcp_server.tools.pages",
    "mcp_server.tools.datasources",
    "mcp_server.tools.variables",
    "mcp_server.tools.alarms",
    "mcp_server.tools.translations",
    "mcp_server.tools.assets",
    "mcp_server.tools.components",
    "mcp_server.tools.users",
    "mcp_server.tools.widgets",
    "mcp_server.prompts.scaffold_page",
    "mcp_server.prompts.build_datasource_dashboard",
    "mcp_server.prompts.localize_strings",
    "mcp_server.prompts.seed_alarms_from_datasource",
)


def import_all() -> None:
    """Import every resource/tool/prompt module so their tools queue onto
    ``_PENDING_TOOLS`` (nothing is registered onto ``mcp_app`` yet).

    Every entry in ``_REGISTERED_MODULES`` is required — a typo or rename
    should surface at startup, not be silently dropped.
    """
    import importlib

    for mod_path in _REGISTERED_MODULES:
        importlib.import_module(mod_path)


_workspace_prepared = False


def prepare_workspace_tools() -> None:
    """Register, project-scope, and add the workspace discovery tools.

    Order is load-bearing: ``import_all`` queues every project tool onto
    ``_PENDING_TOOLS``, ``scope_registered_tools`` drains that queue and
    registers each one — already wrapped with a ``project`` argument — via the
    public ``FastMCP.tool()`` decorator, and ``register_workspace_tools`` then
    adds ``projects_list`` / ``projects_get`` directly (which must stay
    un-scoped, so they bypass the queue entirely). Idempotent: the tools live
    on the global ``mcp_app`` singleton, so repeated calls (e.g. a module
    reload in tests) are no-ops after the first.
    """
    global _workspace_prepared
    if _workspace_prepared:
        return
    from . import scoped, workspace

    import_all()
    scoped.scope_registered_tools()
    workspace.register_workspace_tools()
    _workspace_prepared = True


def mount_workspace_mcp(app: Any) -> None:
    """Mount the multi-project workspace MCP at ``/mcp`` on the manager app.

    Meant for a local AI client over loopback (the default:
    ``NEXTHMI_HOST=127.0.0.1`` in ``launcher.py``); running it reachable on a
    trusted LAN is an accepted risk, not a silent default. Every request must
    authenticate with the manager session cookie or an MCP bearer token (see
    ``mcp_server.auth`` and ``api.mcp_auth_api``) before it reaches any tool.
    Per-project ``mcpEnabled`` is an additional gate on top of that — writes
    are refused when it's off even for an otherwise-authorized caller.
    """
    prepare_workspace_tools()
    app.mount("/mcp", build_mcp_asgi_app())
    app.add_middleware(_McpSlashMiddleware)
