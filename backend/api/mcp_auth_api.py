"""MCP and API bearer-token pairing, creation, listing, and revocation.

Mirrors ``api.manager_peers_api``'s peer-token pairing pattern: a token is
minted once and is scoped — here to one project and to ``read``/``write``
access — instead of being a blanket credential. There are two ways to mint
one: Editor > Admin > Tokens (``POST /api/manager/mcp-tokens``), where the
manager session is the proof, and ``/pair``, where a script presents the
device-admin password instead. All routes are mounted only on the manager app and require
the existing manager auth gate (``manager._auth_gate``) except ``/pair``
itself, which is reachable pre-session the same way login/setup are (see
``api.manager_auth_api``) since a scripted client has no session cookie.

``kind: "api"`` mints an external-API token (``/api/v1``, see ``api.v1_api``)
instead: it carries ``scopes`` rather than an ``access`` level.
"""
from __future__ import annotations

from core import manager_auth, mcp_tokens
from core.exceptions import NotFoundError, RateLimitError, ValidationError
from core.manifest import find_project, load_manifest
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field, model_validator

public_router = APIRouter(prefix="/api/manager/mcp", tags=["manager-mcp"])
manager_router = APIRouter(prefix="/api/manager/mcp-tokens", tags=["manager-mcp"])


class CreateBody(BaseModel):
    projectId: str = Field(min_length=1, max_length=200)
    kind: str = Field(default="mcp", pattern="^(mcp|api)$")
    access: str | None = Field(default=None, pattern="^(read|write)$")
    scopes: list[str] = Field(default_factory=list)
    name: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _kind_fields(self) -> CreateBody:
        if self.kind == "mcp" and self.access is None:
            raise ValueError("An MCP token needs an access level")
        return self


class PairBody(CreateBody):
    password: str = Field(min_length=1, max_length=512)


def _issue(body: CreateBody) -> dict:
    if find_project(load_manifest(), body.projectId) is None:
        raise NotFoundError(f"Project '{body.projectId}' not found")
    if body.kind == "api":
        try:
            token_id, token = mcp_tokens.issue_api(
                project_id=body.projectId, scopes=body.scopes, name=body.name
            )
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc
        return {
            "tokenId": token_id,
            "token": token,
            "kind": "api",
            "projectId": body.projectId,
            "scopes": sorted(set(body.scopes)),
        }
    assert body.access is not None
    token_id, token = mcp_tokens.issue(project_id=body.projectId, access=body.access, name=body.name)
    return {
        "kind": "mcp",
        "tokenId": token_id,
        "token": token,
        "projectId": body.projectId,
        "access": body.access,
        "transport": "http",
        "trustedLanOnly": True,
    }


@public_router.post("/pair", status_code=201)
async def pair(body: PairBody, request: Request) -> dict:
    remaining = manager_auth.lockout_remaining()
    if remaining > 0:
        raise RateLimitError(f"Too many failed attempts. Try again in {int(remaining) + 1}s.")
    if not manager_auth.verify_password(body.password):
        manager_auth.register_login_failure()
        raise ValidationError("Incorrect device-admin password")
    manager_auth.register_login_success()
    return _issue(body)


@manager_router.post("", status_code=201)
async def mcp_token_create(body: CreateBody) -> dict:
    return _issue(body)


@manager_router.get("")
async def mcp_token_list() -> dict:
    return {"tokens": mcp_tokens.list_tokens()}


@manager_router.delete("/{token_id}")
async def mcp_token_revoke(token_id: str) -> dict:
    if not mcp_tokens.revoke(token_id):
        raise NotFoundError(f"Token '{token_id}' not found")
    return {"revoked": True, "tokenId": token_id}
