"""HTTP-transport authentication for the workspace MCP endpoint (item 12).

Every ``/mcp`` request must present one of two credentials, checked by
``McpAuthMiddleware`` before the request reaches FastMCP's streamable-HTTP
session logic:

* the same manager device-admin session cookie the dashboard uses — full
  workspace access, since a signed-in operator already has that privilege
  through the dashboard's own project list and per-project MCP toggle; or
* an MCP bearer token (``core.mcp_tokens``), scoped to exactly one project and
  to ``read`` or ``write`` access, paired once with the device-admin password
  the same way peer-transfer tokens are (see ``api.mcp_auth_api``).

The middleware only decides *whether* a request may reach the MCP tool layer
at all; per-call project/access authorization happens in
``require_mcp_access``, called from ``mcp_server.scoped``'s wrapper — the only
place that knows which ``project`` argument a given tool call names. The
identity the middleware authenticates travels from the ASGI layer to that
per-call check via a contextvar, the same pattern ``mcp_server.agent_label``
uses to smuggle the ``X-Mcp-Agent`` header past FastMCP, which has no public
hook for either.

Per-project ``mcpEnabled`` (``mcp_server.scoped._require_write_allowed``)
remains an *additional* write gate on top of this: a valid write-scoped token
still can't write to a project that has MCP writes turned off.

Threat model:

* **Cross-project access** — impossible for a token: it names exactly one
  project and every tool call re-checks it here, inside the already-resolved
  ``use_project`` scope.
* **Request provenance** — a token is bound to the device-admin password
  generation (``core.manager_auth.credential_generation()``) and stops
  resolving the instant the password changes, independent of the explicit
  ``mcp_tokens.revoke_all()`` the change-password endpoint also calls.
* **Replay/idempotency** — every mutating tool is idempotent by construction
  or accepts an explicit ``idempotency_key`` (``mcp_server.idempotency``), so
  a replayed request cannot double-apply a write.
* **Audit logging** — every write is attributed to a caller-supplied
  ``X-Mcp-Agent`` label (``mcp_server.agent_label``) and published as a
  diffed ``emit_change`` event visible to every connected WebSocket client.
* **Exposure** — the transport binds to loopback by default (``NEXTHMI_HOST``
  in ``launcher.py``); running it reachable on a trusted LAN is an accepted
  risk, matching the same disposition already documented for peer transfer,
  never a silent default.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Literal

from core import manager_auth, mcp_tokens
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

IdentityKind = Literal["session", "token"]
Access = Literal["read", "write"]


@dataclass(frozen=True)
class McpIdentity:
    kind: IdentityKind
    project_id: str | None = None
    access: Access | None = None
    token_id: str | None = None


class McpAuthError(Exception):
    """Raised when a tool call is not authorized for its ``project``/access."""

    code = "mcp_unauthorized"


_identity: ContextVar[McpIdentity | None] = ContextVar("_mcp_identity", default=None)


def _bearer(request: Request) -> str | None:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    return token if scheme.lower() == "bearer" else None


def authenticate(request: Request) -> McpIdentity | None:
    if manager_auth.verify_token(request.cookies.get(manager_auth.SESSION_COOKIE)):
        return McpIdentity(kind="session")
    scope = mcp_tokens.resolve(_bearer(request))
    if scope is not None:
        return McpIdentity(
            kind="token", project_id=scope.project_id, access=scope.access, token_id=scope.token_id,
        )
    return None


class McpAuthMiddleware:
    """ASGI middleware in front of the ``/mcp`` transport. See module docstring."""

    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        identity = authenticate(Request(scope))
        if identity is None:
            response = JSONResponse(
                {"detail": "MCP requires a manager session or a valid MCP bearer token"},
                status_code=401,
            )
            await response(scope, receive, send)
            return
        token = _identity.set(identity)
        try:
            await self._app(scope, receive, send)
        finally:
            _identity.reset(token)


def require_mcp_access(project_id: str, *, need_write: bool) -> None:
    """Enforce the current request's identity against one tool call's project.

    Called from inside the scoped-tool wrapper, which already knows the
    ``project`` argument and whether the tool is a write. A manager session
    carries full workspace access; a bearer token must name this exact
    project and, for a write, have been issued ``write`` access.
    """
    identity = _identity.get()
    if identity is None:
        # No middleware ran (e.g. a test calling a tool in-process without
        # going through the ASGI transport) — fail closed rather than
        # silently trusting an un-authenticated caller.
        raise McpAuthError("MCP request is not authenticated")
    if identity.kind == "session":
        return
    if identity.project_id != project_id:
        raise McpAuthError(f"MCP token is not scoped to project '{project_id}'")
    if need_write and identity.access != "write":
        raise McpAuthError("MCP token has read-only access")


@contextmanager
def identity_for_tests(identity: McpIdentity | None) -> Iterator[None]:
    """Set the current-request identity for a test that calls tools in-process."""
    token = _identity.set(identity)
    try:
        yield
    finally:
        _identity.reset(token)
