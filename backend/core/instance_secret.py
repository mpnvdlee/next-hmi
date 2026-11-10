"""The secret a project child shares with the manager that spawned it.

A child binds a loopback port with no authentication of its own; the manager
in front of it authenticates browsers. Any local process can reach that port
too, so the supervisor hands each child a fresh random secret in its
environment (never on the command line, which every local user can read) and
the manager sends it on every request. A child spawned with one refuses every
request without it. Started by hand without the variable (``uvicorn main:app``)
a child serves as before.

The secret also proves who answers. Between the supervisor finding a port free
and the child binding it, another process can take the port; the readiness
probe sends a nonce, and only the child can answer with its HMAC under the
secret.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

ENV_VAR = "NEXTHMI_INSTANCE_SECRET"
HEADER = "x-nexthmi-instance-secret"
NONCE_HEADER = "x-nexthmi-instance-nonce"
PROOF_HEADER = "x-nexthmi-instance-proof"

_HEADER = HEADER.encode("latin-1")
_NONCE_HEADER = NONCE_HEADER.encode("latin-1")


def new_secret() -> str:
    return secrets.token_urlsafe(32)


def new_nonce() -> str:
    return secrets.token_urlsafe(16)


def proof(secret: str, nonce: str) -> str:
    return hmac.new(secret.encode(), nonce.encode(), hashlib.sha256).hexdigest()


def is_proof(secret: str, nonce: str, presented: str | None) -> bool:
    return presented is not None and hmac.compare_digest(
        presented.encode(), proof(secret, nonce).encode()
    )


class RequireInstanceSecret:
    """Refuse every request that does not carry *secret*; ``None`` turns it off.

    The secret and nonce headers are taken out before the app sees the
    request, so no route can echo or forward them.
    """

    def __init__(self, app: ASGIApp, *, secret: str | None) -> None:
        self._app = app
        self._secret = secret.encode() if secret else None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if self._secret is None or scope["type"] not in ("http", "websocket"):
            await self._app(scope, receive, send)
            return
        presented = b""
        nonce: bytes | None = None
        kept: list[tuple[bytes, bytes]] = []
        for name, value in scope["headers"]:
            if name == _HEADER:
                presented = value
            elif name == _NONCE_HEADER:
                nonce = value
            else:
                kept.append((name, value))
        if not hmac.compare_digest(presented, self._secret):
            if scope["type"] == "websocket":
                # Closing before accept makes the server answer the handshake with 403.
                await send({"type": "websocket.close", "code": 1008})
            else:
                response = JSONResponse({"detail": "Instance secret required"}, status_code=403)
                await response(scope, receive, send)
            return
        scope = {**scope, "headers": kept}
        if nonce is None or scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        answer = proof(self._secret.decode(), nonce.decode("latin-1")).encode()

        async def send_with_proof(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [*message.get("headers", []), (PROOF_HEADER.encode(), answer)]
                message = {**message, "headers": headers}
            await send(message)

        await self._app(scope, receive, send_with_proof)
