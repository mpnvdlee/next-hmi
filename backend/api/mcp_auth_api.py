"""MCP and API bearer-token pairing, creation, listing, and revocation.

Mirrors ``api.manager_peers_api``'s peer-token pairing pattern: a token is
minted once and is scoped — here to ``read``/``write`` access on every
project — instead of being a blanket credential.
There are two ways to mint one: Settings > Tokens on the dashboard (``POST
/api/manager/mcp-tokens``), where the manager session is the proof, and
``/pair``, where a script presents the device-admin password instead. All
routes are mounted only on the manager app and require the existing manager
auth gate (``manager._auth_gate``) except ``/pair`` itself, which is
reachable pre-session the same way login/setup are (see
``api.manager_auth_api``) since a scripted client has no session cookie.

``kind: "api"`` mints an external-API token (``/api/v1``, see ``api.v1_api``)
instead: it carries ``scopes`` rather than an ``access`` level.
"""
from __future__ import annotations

from core import manager_auth, mcp_tokens
from core.exceptions import NotFoundError, ValidationError
from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

public_router = APIRouter(prefix="/api/manager/mcp", tags=["manager-mcp"])
manager_router = APIRouter(prefix="/api/manager/mcp-tokens", tags=["manager-mcp"])


class CreateBody(BaseModel):
    # A 1.x script still sending projectId gets a 422, not a token for every project it didn't ask for.
    model_config = ConfigDict(extra="forbid")

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
    if body.kind == "api":
        try:
            token_id, token = mcp_tokens.issue_api(scopes=body.scopes, name=body.name)
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc
        return {
            "tokenId": token_id,
            "token": token,
            "kind": "api",
            "scopes": sorted(set(body.scopes)),
        }
    assert body.access is not None
    token_id, token = mcp_tokens.issue(access=body.access, name=body.name)
    return {
        "kind": "mcp",
        "tokenId": token_id,
        "token": token,
        "access": body.access,
        "transport": "http",
        "trustedLanOnly": True,
    }


@public_router.post("/pair", status_code=201)
async def pair(body: PairBody, request: Request) -> dict:
    if not await manager_auth.check_password(manager_auth.client_address(request), body.password):
        raise ValidationError("Incorrect device-admin password")
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
