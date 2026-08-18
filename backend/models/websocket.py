"""
Typed models for WebSocket incoming message protocol.

All messages are plain JSON objects with a "type" discriminator field.
These TypedDict definitions document the expected shape of each message type
and are used by websocket_manager.handle_message() for early field access.

Message types (client → server):
  set_context      — update the client's active page context for priority subscriptions
  write_field      — write a value to a PLC variable via OPC-UA
  login            — authenticate a scoped session with username/password
  logout           — revert a scoped session back to guest
  request_identity — auto-login the configured autoLoginName user for a scope
"""

from typing import Any, Required, TypedDict


class SetContextMessage(TypedDict, total=False):
    """Client → server: update active page / dialog context."""
    type: Required[str]
    currentPageIds: list[str]
    # Open dialogs — included in context so their variables are prioritised
    openDialogIds: list[str]
    # Explicit composite keys the client wants to prioritise
    priorityKeys: list[str]


class WriteFieldMessage(TypedDict, total=False):
    """Client → server: write a value to a PLC variable."""
    type: Required[str]
    datasource: Required[str]
    path: Required[str]
    field: Required[str]
    value: Required[Any]
    scope: str
    requestId: str


class LoginMessage(TypedDict, total=False):
    """Client → server: authenticate a scoped session."""
    type: Required[str]
    scope: Required[str]
    username: Required[str]
    password: Required[str]
    requestId: str


class LogoutMessage(TypedDict, total=False):
    """Client → server: revert a scoped session to guest."""
    type: Required[str]
    scope: Required[str]
    requestId: str


class RequestIdentityMessage(TypedDict, total=False):
    """Client → server: auto-login the configured autoLoginName user."""
    type: Required[str]
    scope: Required[str]


# ── Server → client message shapes (for documentation) ───────────────────────

class VarSnapshotMessage(TypedDict):
    """Server → client: full variable snapshot on connection."""
    type: str        # "var_snapshot"
    values: dict[str, Any]


class VarUpdateMessage(TypedDict):
    """Server → client: partial variable update batch."""
    type: str        # "var_update"
    values: dict[str, Any]


class VarRemovedMessage(TypedDict):
    """Server → client: variables no longer available."""
    type: str        # "var_removed"
    ids: list[str]


class OpcuaStatusMessage(TypedDict):
    """Server → client: OPC-UA connection state change."""
    type: str        # "opcua_status"
    datasource: str
    connected: bool


class ContextReadyMessage(TypedDict):
    """Server → client: every variable requested by the client's most recent
    `set_context` (for `currentPageIds`) has now been sent, from cache and/or
    a fresh OPC-UA read. Lets the client reveal a newly navigated page once
    its own data has actually arrived, rather than guessing from the
    connection-lifetime `var_snapshot` flag."""
    type: str        # "context_ready"
    currentPageIds: list[str]


class UserIdentityMessage(TypedDict, total=False):
    """Server → client: scoped identity after login/request_identity.

    `requestId` is echoed only when the message is sent in response to a login
    or logout request — never for auto-login (request_identity) — so clients
    can correlate result handlers without mistaking auto-login for a login
    success.
    """
    type: Required[str]   # "user_identity"
    scope: Required[str]
    username: Required[str]
    groups: Required[list[str]]
    groupLabels: Required[dict[str, str]]
    requestId: str


class AuthErrorMessage(TypedDict, total=False):
    """Server → client: authentication failure."""
    type: Required[str]   # "auth_error"
    scope: Required[str]
    reason: Required[str]  # see WriteReason / AuthReason constants
    requestId: str


class WriteResponseMessage(TypedDict, total=False):
    """Server → client: write_field completed successfully."""
    type: Required[str]   # "write_response"
    requestId: Required[str]
    datasource: Required[str]
    path: Required[str]


class WriteErrorMessage(TypedDict, total=False):
    """Server → client: write_field failed; see reason for cause."""
    type: Required[str]   # "write_error"
    requestId: Required[str]
    datasource: Required[str]
    path: Required[str]
    reason: Required[str]


# ── Builders for server → client payloads ────────────────────────────────────
# Thin constructors that return the right TypedDict shape. Callers get static
# field-name checking (typos → type error) while runtime cost stays the same as
# inline dict literals.


def build_user_identity(
    scope: str,
    username: str,
    groups: list[str],
    group_labels: dict[str, str],
    request_id: str | None = None,
) -> UserIdentityMessage:
    payload: UserIdentityMessage = {
        "type": "user_identity",
        "scope": scope,
        "username": username,
        "groups": groups,
        "groupLabels": group_labels,
    }
    if request_id:
        payload["requestId"] = request_id
    return payload


def build_auth_error(
    scope: str,
    reason: str,
    request_id: str | None = None,
) -> AuthErrorMessage:
    payload: AuthErrorMessage = {
        "type": "auth_error",
        "scope": scope,
        "reason": reason,
    }
    if request_id:
        payload["requestId"] = request_id
    return payload


def build_write_response(
    request_id: str,
    datasource: str,
    path: str,
) -> WriteResponseMessage:
    return {
        "type": "write_response",
        "requestId": request_id,
        "datasource": datasource,
        "path": path,
    }


def build_write_error(
    request_id: str,
    datasource: str,
    path: str,
    reason: str,
) -> WriteErrorMessage:
    return {
        "type": "write_error",
        "requestId": request_id,
        "datasource": datasource,
        "path": path,
        "reason": reason,
    }
