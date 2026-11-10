"""Manager device-admin auth endpoints (login / logout / first-run setup).

These routes are reachable without a session (the gate middleware allow-lists
``/api/manager/auth``); everything else on the manager requires the cookie.
``logout-everywhere`` checks the session itself.
"""
from __future__ import annotations

import asyncio

from core import manager_auth, mcp_tokens, peer_tokens
from core.exceptions import ConflictError, ValidationError
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/manager/auth", tags=["manager-auth"])


class PasswordBody(BaseModel):
    password: str = Field(min_length=1, max_length=512)


class SetupBody(PasswordBody):
    # Optional in the schema so a missing code gets a readable refusal, not a
    # list of validation errors.
    setupCode: str = Field(default="", max_length=64)


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
        max_age=manager_auth.SESSION_TTL_SECONDS,
    )


def _clear_session_cookie(request: Request, response: Response) -> None:
    # Attribute-matched with _set_session_cookie: a Set-Cookie whose flags
    # differ from the original does not clear it in every browser.
    response.delete_cookie(
        manager_auth.SESSION_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=_is_secure(request),
    )


def _require_new_password_rule(password: str) -> None:
    # Checked in the routes rather than in set_password: sign-in accepts any
    # stored password, so an install with a shorter one keeps working.
    if len(password) < manager_auth.MIN_PASSWORD_LENGTH:
        raise ValidationError(
            f"Choose a password of at least {manager_auth.MIN_PASSWORD_LENGTH} characters."
        )


@router.get("/status")
async def auth_status(request: Request) -> dict:
    token = request.cookies.get(manager_auth.SESSION_COOKIE)
    return {
        "passwordSet": manager_auth.is_password_set(),
        "authenticated": manager_auth.verify_token(token),
    }


@router.post("/setup")
async def setup_password(body: SetupBody, request: Request, response: Response) -> dict:
    """Set the device-admin password on first run. Refuses if one already exists.

    Demands the one-time setup code the device printed when it started
    (``manager_auth.setup_code``); a wrong code counts toward the same lockout
    as a wrong password.
    """
    if manager_auth.is_password_set():
        raise ConflictError("A device-admin password is already set; use login.")
    if not body.setupCode.strip():
        raise ValidationError(
            "Enter the setup code. It is shown in the console and the log when the device starts."
        )
    _require_new_password_rule(body.password)
    address = manager_auth.client_address(request)
    manager_auth.require_not_locked_out(address)
    if not manager_auth.verify_setup_code(body.setupCode):
        manager_auth.register_login_failure(address)
        raise ValidationError(
            "Incorrect setup code. Use the code from the device's most recent start: "
            "it changes every time the device starts."
        )
    manager_auth.register_login_success(address)
    # PBKDF2 at 600k rounds: off the loop, or every proxied request stalls with it.
    await asyncio.to_thread(manager_auth.set_password, body.password)
    _set_session_cookie(request, response, manager_auth.issue_token())
    return {"authenticated": True}


@router.post("/login")
async def login(body: PasswordBody, request: Request, response: Response) -> dict:
    if not await manager_auth.check_password(manager_auth.client_address(request), body.password):
        raise ValidationError("Incorrect password")
    _set_session_cookie(request, response, manager_auth.issue_token())
    return {"authenticated": True}


@router.post("/change-password")
async def change_password(
    body: ChangePasswordBody, request: Request, response: Response
) -> dict:
    """Replace the device-admin password. Requires the current password.

    ``set_password`` ends every session, so a fresh cookie is issued here to
    keep the caller signed in. Every peer-transfer and MCP token is revoked in
    the same step — each is already bound to the password generation and would
    stop resolving on its own, but revoking here makes it immediate and explicit.
    """
    _require_new_password_rule(body.newPassword)
    address = manager_auth.client_address(request)
    if not await manager_auth.check_password(address, body.currentPassword):
        raise ValidationError("Incorrect current password")
    await asyncio.to_thread(manager_auth.set_password, body.newPassword)
    peer_tokens.revoke_all()
    mcp_tokens.revoke_all()
    _set_session_cookie(request, response, manager_auth.issue_token())
    return {"authenticated": True}


@router.post("/logout")
async def logout(request: Request, response: Response) -> dict:
    manager_auth.revoke_token(request.cookies.get(manager_auth.SESSION_COOKIE))
    _clear_session_cookie(request, response)
    return {"authenticated": False}


@router.post("/logout-everywhere", response_model=None)
async def logout_everywhere(request: Request, response: Response) -> dict | JSONResponse:
    """End every browser session on this manager, the caller's included.

    MCP, API and peer tokens are separate credentials and keep working.
    """
    if not manager_auth.verify_token(request.cookies.get(manager_auth.SESSION_COOKIE)):
        # The auth gate's own refusal (``manager.MANAGER_SESSION_REQUIRED``):
        # this prefix is exempt from the gate, so the route answers in its place.
        return JSONResponse(
            {"detail": "Authentication required", "code": "manager_session_required"},
            status_code=401,
        )
    manager_auth.revoke_all_sessions()
    _clear_session_cookie(request, response)
    return {"authenticated": False}
