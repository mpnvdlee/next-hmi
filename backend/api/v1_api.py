"""External API v1 — a small, versioned surface for integrations (MES, BI, HR).

Mounted on the manager, which sees every project, and excluded from its
session-cookie gate (``manager._is_gated``): every route here authenticates
for itself through ``_caller``, and a manager session cookie alone opens
nothing. Two credentials work:

* the device-admin password over HTTP Basic, username ``admin`` — every
  project, every scope, with the same failure throttle as the dashboard login;
* an API token (``core.mcp_tokens.issue_api``) as ``Authorization: Bearer`` —
  every project, only the scopes it was minted with.

HMI user credentials (``users.json``) are never an API key, and an MCP token
is refused here just as an API token is refused on ``/mcp``.

Every route but ``panels`` reads or writes the project's files under
``use_project``, so it works the same whether the project is running or
stopped. A user write also pokes a running child's reload hook, so open editor
tabs learn the roster changed before they save over it, and a deleted or
regrouped user loses the identity it holds on a panel. ``panels`` acts on live
connections, so it needs the running child and goes through its loopback
``api/internal/panels`` hooks.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import csv
import io
import math
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from core import audit, manager_auth, mcp_tokens, users_document
from core.exceptions import (
    ConflictError,
    NotFoundError,
    ValidationError,
)
from core.manifest import find_project, load_manifest
from core.storage import (
    ProjectNotFoundError,
    active_alarm_state_path,
    active_recipe_state_path,
    active_recipes_config_path,
    load_json_or_default,
    use_project,
)
from core.validation.ids import is_valid_panel_name
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from mcp_server.pagination import CursorError, decode_cursor, encode_cursor, paginate
from models.alarm import AlarmState
from models.recipe import RecipeConfig, RecipeState
from services.historian_manager import _parse_time

from api import users_api

ADMIN_USERNAME = "admin"
HISTORY_DEFAULT_LIMIT = 1000
HISTORY_MAX_LIMIT = 10000
ALARMS_MAX_LIMIT = 500

# Bearer, not Basic: a Basic challenge makes a browser prompt for and then
# cache the password, and a cached password rides along on cross-site requests.
_CHALLENGE = {"WWW-Authenticate": 'Bearer realm="NEXT HMI API"'}
# Per project id: a user write reads, edits and saves the whole users.json, so
# two in parallel would each save their own copy and one change would vanish.
# The editor's own save runs in the project's process and is not covered.
_users_locks: dict[str, threading.Lock] = {}


@dataclass(frozen=True)
class Caller:
    label: str  # the audit actor: "admin" or the token's name
    token: mcp_tokens.ApiTokenScope | None = None  # None: the device admin


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status_code=401, detail=detail, headers=_CHALLENGE)


def _basic_password(value: str) -> str | None:
    try:
        username, _, password = base64.b64decode(value, validate=True).decode("utf-8").partition(":")
    except (binascii.Error, UnicodeDecodeError):
        return None
    return password if username == ADMIN_USERNAME else None


async def _authenticate(request: Request) -> Caller:
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    scheme = scheme.lower()
    if scheme == "bearer":
        token = mcp_tokens.resolve_api(value.strip())
        if token is None:
            raise _unauthorized("Invalid or revoked API token")
        return Caller(label=token.name, token=token)
    if scheme == "basic":
        # A wrong username checks an empty password, so it is throttled like a
        # wrong password. count_success=False: a polling script's good password
        # says nothing about who sent the failures, and clearing the count on
        # every poll would let a guesser slip four tries in between each one.
        password = _basic_password(value.strip()) or ""
        if not await manager_auth.check_password(
            manager_auth.client_address(request), password, count_success=False
        ):
            raise _unauthorized(
                f"Basic auth needs username '{ADMIN_USERNAME}' and the device-admin password"
            )
        return Caller(label=ADMIN_USERNAME)
    raise _unauthorized("API v1 needs an API token (Bearer) or the device-admin password (Basic)")


def _scope(scope: str) -> Any:
    """Per-route check of *scope* and that the project exists, on the request's cached caller."""

    async def check(projectId: str, caller: Caller = Depends(_authenticate)) -> Caller:
        if caller.token is not None and scope not in caller.token.scopes:
            raise HTTPException(status_code=403, detail=f"API token lacks the '{scope}' scope")
        if find_project(load_manifest(), projectId) is None:
            raise NotFoundError(f"Project '{projectId}' not found")
        return caller

    return Depends(check)


# Router-wide, so a route added without a scope still answers no one anonymous.
router = APIRouter(
    prefix="/api/v1/projects/{projectId}",
    tags=["api-v1"],
    dependencies=[Depends(_authenticate)],
)
_HISTORY_READ = _scope("history:read")
_ALARMS_READ = _scope("alarms:read")
_RECIPES_READ = _scope("recipes:read")
_USERS_READ = _scope("users:read")
_USERS_WRITE = _scope("users:write")
_SESSIONS_WRITE = _scope("sessions:write")


@contextmanager
def _project(project_id: str) -> Iterator[Path]:
    try:
        with use_project(project_id) as root:
            yield root
    except ProjectNotFoundError as exc:
        raise NotFoundError(str(exc)) from exc


def _time(value: str, label: str) -> float:
    try:
        return _parse_time(value)
    except ValueError as exc:
        raise ValidationError(f"Invalid {label}: {exc}") from exc


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=UTC).isoformat()


def _page(items: list[dict[str, Any]], next_cursor: str | None, fmt: str, fields: tuple[str, ...]) -> Any:
    if fmt == "json":
        return {"items": items, "nextCursor": next_cursor}
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=fields)
    writer.writeheader()
    writer.writerows({key: _csv_cell(value) for key, value in item.items()} for item in items)
    headers = {"X-Next-Cursor": next_cursor} if next_cursor else {}
    return Response(out.getvalue(), media_type="text/csv", headers=headers)


def _csv_cell(value: Any) -> Any:
    # A spreadsheet runs a cell starting with one of these as a formula, and an
    # alarm title or username is text anyone with editor access could set.
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


_FORMAT = Query("json", pattern="^(json|csv)$")


def _bad_cursor(exc: Exception) -> ValidationError:
    return ValidationError(f"Invalid cursor: {exc}")


# ── 4.2 historian samples ────────────────────────────────────────────────────


def _read_samples(
    db_path: Path, variables: list[str], start: float, end: float,
    after: tuple[float, int] | None, limit: int,
) -> list[tuple[int, str, float, float | None]]:
    if not db_path.is_file():
        return []
    # Read-only, so a running instance's writer is never blocked or disturbed;
    # WAL lets this read alongside it.
    conn = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        marks = ",".join("?" * len(variables))
        sql = (
            "SELECT id, variable, timestamp, value FROM samples "
            f"WHERE variable IN ({marks}) AND timestamp >= ? AND timestamp <= ?"
        )
        params: list[Any] = [*variables, start, end]
        if after is not None:
            sql += " AND (timestamp > ? OR (timestamp = ? AND id > ?))"
            params += [after[0], after[0], after[1]]
        sql += " ORDER BY timestamp, id LIMIT ?"
        params.append(limit)
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


@router.get("/history")
async def history(
    projectId: str,
    variables: str = Query(..., description="Comma-separated variable keys"),
    start: str = Query(..., description="ISO-8601 time, or relative like -1h"),
    end: str = Query("now"),
    limit: int = Query(HISTORY_DEFAULT_LIMIT, ge=1, le=HISTORY_MAX_LIMIT),
    cursor: str | None = None,
    format: str = _FORMAT,
    _: Caller = _HISTORY_READ,
) -> Any:
    keys = sorted({key.strip() for key in variables.split(",") if key.strip()})
    if not keys:
        raise ValidationError("variables must name at least one variable")
    after = None
    if cursor:
        try:
            ts, row_id = decode_cursor(cursor)
            after = (float(ts), int(row_id))
            # SQLite integers are 64-bit; a larger id raises OverflowError at bind.
            if not math.isfinite(after[0]) or not 0 <= after[1] < 2**63:
                raise ValueError("out of range")
        except (CursorError, ValueError) as exc:
            raise _bad_cursor(exc) from exc
    with _project(projectId) as root:
        db_path = root / "historian" / "history.db"
    rows = await asyncio.to_thread(
        _read_samples, db_path, keys, _time(start, "start"), _time(end, "end"), after, limit + 1
    )
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = encode_cursor(repr(rows[-1][2]), str(rows[-1][0]))
    items = [{"variable": var, "timestamp": _iso(ts), "value": value} for _id, var, ts, value in rows]
    return _page(items, next_cursor, format, ("variable", "timestamp", "value"))


# ── 4.6 alarm history ────────────────────────────────────────────────────────

_ALARM_FIELDS = (
    "id", "alarmId", "code", "level", "title", "description", "groupTitle",
    "triggeredAt", "clearedAt", "acked", "ackedBy", "ackedAt",
)


@router.get("/alarms/history")
def alarm_history(
    projectId: str,
    start: str | None = Query(None, description="Earliest clearedAt"),
    end: str = Query("now", description="Latest clearedAt"),
    limit: int = Query(100, ge=1, le=ALARMS_MAX_LIMIT),
    cursor: str | None = None,
    format: str = _FORMAT,
    _: Caller = _ALARMS_READ,
) -> Any:
    low = _time(start, "start") if start else float("-inf")
    high = _time(end, "end")
    with _project(projectId):
        state = load_json_or_default(active_alarm_state_path(), AlarmState, AlarmState.model_validate)
    rows = []
    for entry in state.history:
        try:
            cleared = datetime.fromisoformat(entry.cleared_at).timestamp()
        except ValueError:
            continue
        if not low <= cleared <= high:
            continue
        item = {
            "id": entry.id,
            "alarmId": entry.alarm_id,
            "code": entry.code,
            "level": entry.level,
            "title": entry.title,
            "description": entry.description,
            "groupTitle": entry.group_title,
            "triggeredAt": entry.triggered_at,
            "clearedAt": entry.cleared_at,
            "acked": entry.acked,
            "ackedBy": entry.acked_by or None,
            "ackedAt": entry.acked_at or None,
        }
        # Oldest first by clearedAt, the order entries join the history in.
        rows.append((_iso(cleared), entry.id, item))
    try:
        page = paginate(rows, cursor=cursor, limit=limit)
    except CursorError as exc:
        raise _bad_cursor(exc) from exc
    return _page(page.items, page.next_cursor, format, _ALARM_FIELDS)


# ── 4.7 recipes ──────────────────────────────────────────────────────────────


@router.get("/recipes")
def recipes(projectId: str, _: Caller = _RECIPES_READ) -> dict[str, Any]:
    with _project(projectId):
        config = load_json_or_default(active_recipes_config_path(), RecipeConfig, RecipeConfig.model_validate)
        state = load_json_or_default(active_recipe_state_path(), RecipeState, RecipeState.model_validate)
    return {
        "datasetTypes": [
            {
                "id": dtype.id,
                "name": dtype.name,
                "loadedDatasetId": loaded.dataset_id if (loaded := state.loaded.get(dtype.id)) else None,
                "parameters": [
                    {"id": p.id, "label": p.label, "dataType": p.data_type} for p in dtype.parameters
                ],
                "datasets": [
                    {
                        "id": d.id,
                        "name": d.name,
                        "description": d.description,
                        "values": d.values,
                        "updatedAt": d.updated_at or None,
                        "updatedBy": d.updated_by or None,
                    }
                    for d in dtype.datasets
                ],
            }
            for dtype in config.dataset_types
        ]
    }


# ── 4.4 users ────────────────────────────────────────────────────────────────


def _public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "groups": user.get("groups", []),
        "passwordSet": user.get("passwordSet", False),
    }


def _users_document(root: Path) -> dict[str, Any]:
    # users_manager.load() falls back to defaults on a broken file, and saving
    # that would replace whatever the operator still has to repair.
    state = users_document.state(root)
    if not state.valid:
        raise ConflictError(f"Project credentials are unavailable: {state.error}.")
    return users_api._redact_document(users_api.users_manager.load())


@router.get("/users")
def list_users(projectId: str, _: Caller = _USERS_READ) -> dict[str, Any]:
    with _project(projectId) as root:
        document = _users_document(root)
    return {
        "users": [_public_user(user) for user in document["users"]],
        "groups": users_api.group_entries(document),
    }


async def _notify_running_child(project_id: str, user_id: str, caller: Caller) -> None:
    from mcp_server.write_helpers import notify_child

    await notify_child(
        project_id,
        {
            "artifact_type": "users",
            "artifact_ids": [user_id],
            "source": "api",
            "summary": f"User '{user_id}' changed over API v1",
        },
    )


def _audit(caller: Caller, action: str, user_id: str, detail: dict[str, Any]) -> None:
    # Inside use_project, so a listener files the record under this project.
    audit.emit(
        audit.AuditEvent(
            actor=caller.label,
            actor_source=audit.ACTOR_API,
            action=action,
            subject=user_id,
            detail={"tokenId": caller.token.token_id if caller.token else None, **detail},
        )
    )


def _write_user(project_id: str, user_id: str, body: dict[str, Any], caller: Caller) -> dict[str, Any]:
    with _users_locks.setdefault(project_id, threading.Lock()), _project(project_id) as root:
        stored = _users_document(root)["users"]
        current = next((u for u in stored if u.get("id") == user_id), None)
        submitted = {
            "id": user_id,
            "username": body.get("username", current["username"] if current else user_id),
            "groups": body.get("groups", current["groups"] if current else None),
            "password": body.get("password") or "",
        }
        users = [
            # Every other account passes through unchanged: an empty password
            # tells the shared validator to keep the stored credential.
            submitted
            if u is current
            else {"id": u.get("id"), "username": u.get("username"), "groups": u.get("groups"), "password": ""}
            for u in stored
        ]
        if current is None:
            users.append(submitted)
        saved = _public_user(next(u for u in users_api.put_users(users) if u["id"] == user_id))
        _audit(
            caller,
            "user.save",
            user_id,
            {
                "created": current is None,
                "username": saved["username"],
                "groups": saved["groups"],
                # Whether, never what: no password or hash goes into the record.
                "passwordChanged": bool(submitted["password"]),
            },
        )
    return saved


@router.put("/users/{userId}")
async def put_user(
    projectId: str,
    userId: str,
    body: dict = Body(...),
    caller: Caller = _USERS_WRITE,
) -> dict[str, Any]:
    """Create or update one user; an omitted or empty password keeps the current one."""
    unknown = set(body) - {"username", "password", "groups"}
    if unknown:
        raise ValidationError(f"Unknown fields: {sorted(unknown)}")
    if not isinstance(body.get("password", ""), str):
        raise ValidationError("password must be a string")
    # Off the loop: hashing a new password is deliberately slow.
    user = await asyncio.to_thread(_write_user, projectId, userId, body, caller)
    await _notify_running_child(projectId, userId, caller)
    return user


def _delete_user(project_id: str, user_id: str, caller: Caller) -> None:
    with _users_locks.setdefault(project_id, threading.Lock()), _project(project_id) as root:
        _users_document(root)
        users_api.delete_user(user_id)
        _audit(caller, "user.delete", user_id, {})


@router.delete("/users/{userId}")
async def delete_user(
    projectId: str, userId: str, caller: Caller = _USERS_WRITE
) -> dict[str, Any]:
    await asyncio.to_thread(_delete_user, projectId, userId, caller)
    await _notify_running_child(projectId, userId, caller)
    return {"deleted": userId}


# ── 4.8 panel sessions ───────────────────────────────────────────────────────


async def _child(project_id: str, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    """Call the running child's loopback ``api/internal/<path>``; its errors pass through."""
    import httpx
    from mcp_server.write_helpers import loopback_client
    from services.supervisor import supervisor

    port = supervisor.port_for(project_id)
    if port is None:
        raise ConflictError(f"Project '{project_id}' is not running")
    try:
        resp = await loopback_client().request(
            method, f"http://127.0.0.1:{port}/api/internal/{path}", json=body
        )
    except httpx.HTTPError as exc:
        raise ConflictError(f"Project '{project_id}' did not answer: {exc}") from exc
    if resp.is_error:
        try:
            detail = resp.json().get("detail")
        except ValueError:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail)
    return resp.json()


def _panel_name(panel: str) -> str:
    # Never a connected panel, so 404 like any other unknown one.
    if not is_valid_panel_name(panel):
        raise NotFoundError(f"No connected panel named '{panel}'")
    return panel


@router.get("/panels")
async def list_panels(projectId: str, _: Caller = _SESSIONS_WRITE) -> dict[str, Any]:
    return await _child(projectId, "GET", "panels")


@router.post("/panels/{panel}/login")
async def panel_login(
    projectId: str, panel: str, body: dict = Body(...), caller: Caller = _SESSIONS_WRITE
) -> dict[str, Any]:
    """Sign an HMI user in on every connection of a named panel; checks their password."""
    unknown = set(body) - {"username", "password"}
    if unknown:
        raise ValidationError(f"Unknown fields: {sorted(unknown)}")
    username, password = body.get("username"), body.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        raise ValidationError("username and password must be strings")
    signed_in = await _child(
        projectId,
        "POST",
        "panels/login",
        {"panel": _panel_name(panel), "username": username, "password": password},
    )
    with _project(projectId):
        _audit(caller, "user.login", panel, signed_in)
    return {"panel": panel, **signed_in}


@router.post("/panels/{panel}/logout")
async def panel_logout(projectId: str, panel: str, caller: Caller = _SESSIONS_WRITE) -> dict[str, Any]:
    """Drop a named panel back to the auto-login user."""
    signed_out = await _child(projectId, "POST", "panels/logout", {"panel": _panel_name(panel)})
    with _project(projectId):
        _audit(caller, "user.logout", panel, signed_out)
    return {"panel": panel, **signed_out}
