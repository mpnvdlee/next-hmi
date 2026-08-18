"""MCP bearer-token pairing, listing, and revocation (maintenance-backlog item 12).

Mirrors ``api.manager_peers_api``'s peer-token pairing pattern: a token is
minted once by presenting the device-admin password and is scoped — here to
one project and to ``read``/``write`` access — instead of being a blanket
credential. All routes are mounted only on the manager app and require the
existing manager auth gate (``manager._auth_gate``) except ``/pair`` itself,
which is reachable pre-session the same way login/setup are (see
``api.manager_auth_api``) since a client pairing an MCP token has no session
cookie yet.
"""
from __future__ import annotations

from core import manager_auth, mcp_tokens
from core.exceptions import NotFoundError, RateLimitError, ValidationError
from core.manifest import find_project, load_manifest
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

public_router = APIRouter(prefix="/api/manager/mcp", tags=["manager-mcp"])
manager_router = APIRouter(prefix="/api/manager/mcp-tokens", tags=["manager-mcp"])


class PairBody(BaseModel):
    password: str = Field(min_length=1, max_length=512)
    projectId: str = Field(min_length=1, max_length=200)
    access: str = Field(pattern="^(read|write)$")
    name: str | None = Field(default=None, max_length=200)


@public_router.post("/pair", status_code=201)
async def pair(body: PairBody, request: Request) -> dict:
    remaining = manager_auth.lockout_remaining()
    if remaining > 0:
        raise RateLimitError(f"Too many failed attempts. Try again in {int(remaining) + 1}s.")
    if not manager_auth.verify_password(body.password):
        manager_auth.register_login_failure()
        raise ValidationError("Incorrect device-admin password")
    manager_auth.register_login_success()
    if find_project(load_manifest(), body.projectId) is None:
        raise NotFoundError(f"Project '{body.projectId}' not found")
    token_id, token = mcp_tokens.issue(project_id=body.projectId, access=body.access, name=body.name)
    return {
        "tokenId": token_id,
        "token": token,
        "projectId": body.projectId,
        "access": body.access,
        "transport": "http",
        "trustedLanOnly": True,
    }


@manager_router.get("")
async def mcp_token_list() -> dict:
    return {"tokens": mcp_tokens.list_tokens()}


@manager_router.delete("/{token_id}")
async def mcp_token_revoke(token_id: str) -> dict:
    if not mcp_tokens.revoke(token_id):
        raise NotFoundError(f"MCP token '{token_id}' not found")
    return {"revoked": True, "tokenId": token_id}
