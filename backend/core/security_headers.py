"""Response headers that keep other sites and user files from acting as this origin.

**Framing.** A page on another site that frames ``/runtime/<slug>/`` gets a
document of this origin, whose socket passes the origin check, under a disguise
of its own: a click it steers writes a setpoint. :class:`FrameAncestorsMiddleware`
answers every HTML document with ``Content-Security-Policy: frame-ancestors
'self'`` plus the sites listed in ``core.embed_settings``, and with
``X-Frame-Options: SAMEORIGIN`` while that list is empty — the older header
cannot name another site, and a browser that knows ``frame-ancestors`` ignores
it.

Both apps install it. A project instance's documents reach the browser through
the manager proxy, which passes the instance's headers on; the manager only
adds the policy to a document that does not carry one yet, so each document
carries it exactly once. Both read the same list from the runtime home they
share, and an instance opened on its own loopback port is covered too.

**User content.** ``assets``, ``custom-widgets`` and ``external-libraries`` are
project files anyone with editor or MCP write access can fill, served on this
origin. :class:`UserContentFiles` marks them ``nosniff``, and adds
``Content-Security-Policy: sandbox`` where the app never runs them as scripts:
an ``.html`` or ``.svg`` opened straight from there renders without script and
without this origin. The policy binds only a document made from the response,
so an image, mask, video or ``fetch`` of the same file is unaffected.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from core import embed_settings

_CSP = "content-security-policy"
_XFO = "x-frame-options"
_NOSNIFF: Mapping[str, str] = {"X-Content-Type-Options": "nosniff"}
_SANDBOXED: Mapping[str, str] = {**_NOSNIFF, "Content-Security-Policy": "sandbox"}
# A module script is refused unless served as JavaScript, and a platform's MIME
# table can say otherwise (a Windows registry mapping ``.js`` to ``text/plain``).
_JAVASCRIPT_SUFFIXES = frozenset({".js", ".mjs"})


def _framing_headers(origins: tuple[str, ...]) -> dict[str, str]:
    """The framing headers for a document, given the sites allowed to embed it."""
    headers = {_CSP: " ".join(("frame-ancestors 'self'", *origins))}
    if not origins:
        headers[_XFO] = "SAMEORIGIN"
    return headers


def _is_html(headers: MutableHeaders) -> bool:
    return headers.get("content-type", "").lower().startswith("text/html")


def _sets_framing(headers: MutableHeaders) -> bool:
    return _XFO in headers or any(
        "frame-ancestors" in value.lower() for value in headers.getlist(_CSP)
    )


class FrameAncestorsMiddleware:
    """Add the framing policy to every HTML response that does not carry one."""

    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        async def send_with_policy(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                headers = MutableHeaders(scope=message)
                if _is_html(headers) and not _sets_framing(headers):
                    # Appended, not merged: a ``sandbox`` policy already on the
                    # response stays a policy of its own, and the browser
                    # enforces both.
                    origins = embed_settings.allowed_origins()
                    for name, value in _framing_headers(origins).items():
                        headers.append(name, value)
            await send(message)

        await self._app(scope, receive, send_with_policy)


class UserContentFiles(StaticFiles):
    """``StaticFiles`` for project content: ``nosniff``, and ``sandbox`` unless it is code."""

    def __init__(self, *, sandbox: bool, **kwargs) -> None:
        super().__init__(**kwargs)
        self._headers = _SANDBOXED if sandbox else _NOSNIFF

    def file_response(
        self,
        full_path: os.PathLike | str,
        stat_result: os.stat_result,
        scope: Scope,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.headers.update(self._headers)
        is_javascript = Path(full_path).suffix.lower() in _JAVASCRIPT_SUFFIXES
        # A 304 carries no content type to correct.
        if is_javascript and "content-type" in response.headers:
            response.headers["content-type"] = "text/javascript; charset=utf-8"
        return response
