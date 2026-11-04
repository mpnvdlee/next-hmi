"""Refuse cross-site WebSocket upgrades and state-changing requests.

Installed on both apps: the manager front door, and every project instance.
A browser reaches an instance only through the manager proxy, which drops the
``Origin`` header after the manager's own check passed, so on an instance this
refuses a page that found the loopback port and went around the manager. A
standalone ``uvicorn main:app`` keeps working from its own origin.

Comparing ``Origin`` with ``Host`` cannot catch DNS rebinding: a page that
points a name of its own at this machine sends a matching pair. The instance
closes that with ``loopback_only``: the manager proxy and its own callers
always reach it as ``127.0.0.1``, so any other ``Host`` is refused, reads
included. The manager cannot do the same — it is reached by IP, hostname and
``.local`` alike — so a rebound name still gets past the manager's check.
"""
from __future__ import annotations

from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from core.http_origins import normalize_origin

# Methods a browser may send cross-site without the server's say-so having any
# effect beyond a read the same-origin policy hides from the page.
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def is_cross_origin(scope: Scope) -> bool:
    """True when a browser sent this request from a page on another origin.

    The request's own origin is its scheme (uvicorn already rewrote it from a
    trusted proxy's ``X-Forwarded-Proto``) plus its ``Host`` header. No
    ``Origin`` at all is a script — curl, an MCP client, a peer transfer, the
    manager proxy — and passes: this guards what a browser page can reach, not
    the API itself. ``Origin: null`` (sandboxed frame, ``file:``) never matches.
    """
    headers = Headers(scope=scope)
    origin = headers.get("origin")
    if origin is None:
        return False
    scheme = {"ws": "http", "wss": "https"}.get(scope["scheme"], scope["scheme"])
    own = normalize_origin(f"{scheme}://{headers.get('host', '')}")
    return own is None or normalize_origin(origin) != own


def _is_loopback_host(scope: Scope) -> bool:
    try:
        host = urlsplit(f"//{Headers(scope=scope).get('host', '')}").hostname
    except ValueError:
        return False
    return host in _LOOPBACK_HOSTS


class OriginCheckMiddleware:
    """403 a cross-origin write; close a cross-origin upgrade before accept.

    The SameSite cookie keeps a foreign page from riding the device-admin
    session, but the public live view needs no session at all, and a
    WebSocket ignores CORS: without this any page open in the panel's browser
    could open ``/runtime/<slug>/ws`` and read and write live values, or POST
    to the public runtime routes as a "simple" request that never preflights.

    ``loopback_only`` also refuses every request whose ``Host`` is not a
    loopback name (see the module docstring).
    """

    def __init__(self, app: ASGIApp, *, loopback_only: bool = False) -> None:
        self._app = app
        self._loopback_only = loopback_only

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self._app(scope, receive, send)
            return
        if self._loopback_only and not _is_loopback_host(scope):
            refused = "Host not allowed"
        elif (
            scope["type"] == "websocket" or scope["method"] not in _SAFE_METHODS
        ) and is_cross_origin(scope):
            refused = "Cross-origin request refused"
        else:
            await self._app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            # Closing before accept makes the server answer the handshake with 403.
            await send({"type": "websocket.close", "code": 1008})
        else:
            await JSONResponse({"detail": refused}, status_code=403)(scope, receive, send)
