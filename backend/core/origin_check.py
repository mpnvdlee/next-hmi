"""Refuse cross-site WebSocket upgrades and state-changing requests.

Installed on both apps: the manager front door, and every project instance.
A browser reaches an instance only through the manager proxy, which drops the
``Origin`` header after the manager's own check passed, so on an instance this
refuses a page that found the loopback port and went around the manager. A
standalone ``uvicorn main:app`` keeps working from its own origin.

Comparing ``Origin`` with ``Host`` cannot catch DNS rebinding: a page that
points a name of its own at this machine sends a matching pair. Closing that
needs a ``Host`` allowlist, which an install reached by IP, hostname and
``.local`` alike does not have.
"""
from __future__ import annotations

from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

# Methods a browser may send cross-site without the server's say-so having any
# effect beyond a read the same-origin policy hides from the page.
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_DEFAULT_PORTS = {"http": 80, "https": 443}


def _origin_key(url: str) -> tuple[str, str, int | None] | None:
    try:
        parts = urlsplit(url)
        port = parts.port or _DEFAULT_PORTS.get(parts.scheme)
    except ValueError:
        return None
    return (parts.scheme, parts.hostname, port) if parts.hostname else None


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
    own = _origin_key(f"{scheme}://{headers.get('host', '')}")
    return own is None or _origin_key(origin) != own


class OriginCheckMiddleware:
    """403 a cross-origin write; close a cross-origin upgrade before accept.

    The SameSite cookie keeps a foreign page from riding the device-admin
    session, but the public live view needs no session at all, and a
    WebSocket ignores CORS: without this any page open in the panel's browser
    could open ``/runtime/<slug>/ws`` and read and write live values, or POST
    to the public runtime routes as a "simple" request that never preflights.
    """

    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        checked = scope["type"] == "websocket" or (
            scope["type"] == "http" and scope["method"] not in _SAFE_METHODS
        )
        if not checked or not is_cross_origin(scope):
            await self._app(scope, receive, send)
        elif scope["type"] == "websocket":
            # Closing before accept makes the server answer the handshake with 403.
            await send({"type": "websocket.close", "code": 1008})
        else:
            response = JSONResponse({"detail": "Cross-origin request refused"}, status_code=403)
            await response(scope, receive, send)
