"""Manager device-admin auth endpoints (login / logout / first-run setup).

These routes are reachable without a session (the gate middleware allow-lists
``/api/manager/auth``); everything else on the manager requires the cookie.
"""
from __future__ import annotations

from core import manager_auth, mcp_tokens, peer_tokens
from core.exceptions import ConflictError, RateLimitError, ValidationError
from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/manager/auth", tags=["manager-auth"])


class PasswordBody(BaseModel):
    password: str = Field(min_length=1, max_length=512)


class ChangePasswordBody(BaseModel):
    currentPassword: str = Field(min_length=1, max_length=512)
    newPassword: str = Field(min_length=1, max_length=512)


def _is_secure(request: Request) -> bool:
    """Whether this request arrived over TLS.

    Uvicorn runs with ``proxy_headers`` on, so ``url.scheme`` already reflects
    ``X-Forwarded-Proto`` when a trusted terminating proxy sits in front.
    """
    return request.url.scheme == "https"


def _set_session_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(
        manager_auth.SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=_is_secure(request),
        path="/",
        max_age=7 * 24 * 3600,
    )


def _require_not_locked_out() -> None:
    remaining = manager_auth.lockout_remaining()
    if remaining > 0:
        raise RateLimitError(
            f"Too many failed attempts. Try again in {int(remaining) + 1}s."
        )


@router.get("/status")
async def auth_status(request: Request) -> dict:
    token = request.cookies.get(manager_auth.SESSION_COOKIE)
    return {
        "passwordSet": manager_auth.is_password_set(),
        "authenticated": manager_auth.verify_token(token),
    }


@router.post("/setup")
async def setup_password(body: PasswordBody, request: Request, response: Response) -> dict:
    """Set the device-admin password on first run. Refuses if one already exists."""
    if manager_auth.is_password_set():
        raise ConflictError("A device-admin password is already set; use login.")
    manager_auth.set_password(body.password)
    _set_session_cookie(request, response, manager_auth.issue_token())
    return {"authenticated": True}


@router.post("/login")
async def login(body: PasswordBody, request: Request, response: Response) -> dict:
    _require_not_locked_out()
    if not manager_auth.verify_password(body.password):
        manager_auth.register_login_failure()
        raise ValidationError("Incorrect password")
    manager_auth.register_login_success()
    _set_session_cookie(request, response, manager_auth.issue_token())
    return {"authenticated": True}


@router.post("/change-password")
async def change_password(
    body: ChangePasswordBody, request: Request, response: Response
) -> dict:
    """Replace the device-admin password. Requires the current password.

    ``set_password`` rotates the signing secret, invalidating every other
    session, so a fresh cookie is issued here to keep the caller signed in.
    Every peer-transfer and MCP token is revoked in the same step — each is
    already bound to the password generation and would stop resolving on its
    own, but revoking here makes it immediate and explicit.
    """
    _require_not_locked_out()
    if not manager_auth.verify_password(body.currentPassword):
        manager_auth.register_login_failure()
        raise ValidationError("Incorrect current password")
    manager_auth.register_login_success()
    manager_auth.set_password(body.newPassword)
    peer_tokens.revoke_all()
    mcp_tokens.revoke_all()
    _set_session_cookie(request, response, manager_auth.issue_token())
    return {"authenticated": True}


@router.post("/logout")
async def logout(request: Request, response: Response) -> dict:
    # Attribute-matched with _set_session_cookie: a Set-Cookie whose flags
    # differ from the original does not clear it in every browser.
    response.delete_cookie(
        manager_auth.SESSION_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=_is_secure(request),
    )
    return {"authenticated": False}
