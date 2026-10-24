"""
opcua.discovery — endpoint discovery and the connection probe.

Throwaway clients for the connection wizard, independent of the pool.
"""

import asyncio
import contextlib
from typing import Any

from asyncua import Client, ua

from .compat import apply_asyncua_watchdog_log_patch
from .security import SECURE_POLICY_NAMES, SECURITY_MODES, apply_client_security

apply_asyncua_watchdog_log_patch()


def _normalize_discovery_url(address: str) -> str:
    """Coerce a host / host:port / full URL into an ``opc.tcp://`` endpoint."""
    addr = (address or "").strip()
    if not addr:
        return "opc.tcp://localhost:4840"
    if "://" not in addr:
        addr = f"opc.tcp://{addr}"
    scheme, _, rest = addr.partition("://")
    authority, slash, path = rest.partition("/")
    if authority and ":" not in authority:
        authority = f"{authority}:4840"
    return f"{scheme}://{authority}{slash}{path}"


def _policy_short_name(uri: str) -> str:
    """Map a SecurityPolicy URI to the short names the config UI uses."""
    if not uri:
        return "NoSecurity"
    suffix = uri.rsplit("#", 1)[-1]
    return "NoSecurity" if suffix == "None" else suffix


def _security_mode_name(mode: Any) -> str:
    try:
        name = ua.MessageSecurityMode(mode).name
    except Exception:
        name = str(mode)
    return "None" if name == "None_" else name


def _endpoint_supported(security_mode: str, security_policy: str) -> bool:
    """Whether a discovered endpoint is one a datasource can be saved against.

    The same allowlist resolve_security_settings() enforces at connect time,
    applied before the user picks: servers still offer the deprecated
    Basic128Rsa15 and Basic256, which would otherwise be selectable here and
    only refused once the connection is tested.
    """
    if security_mode == "None" and security_policy == "NoSecurity":
        return True
    return security_mode in SECURITY_MODES and security_policy in SECURE_POLICY_NAMES


def _user_token_types(tokens: Any) -> list[str]:
    result: list[str] = []
    for tok in tokens or []:
        try:
            name = ua.UserTokenType(tok.TokenType).name
        except Exception:
            continue
        label = "Username" if name == "UserName" else name
        if label not in result:
            result.append(label)
    return result


def _short_probe_error(exc: Exception) -> str:
    if isinstance(exc, TimeoutError):
        return "Connection timed out"
    msg = str(exc).strip() or exc.__class__.__name__
    return msg[:300]


async def discover_endpoints(address: str, *, timeout_s: float = 5.0) -> dict:
    """Connect to a server (no session) and enumerate its endpoints.

    Returns ``{ok, error, endpoints}``; ``endpoints`` rows carry the endpoint
    URL, security mode/policy short-names, supported user-token types, and the
    server application name. Failures are reported as ``ok=False`` (never raised).
    """
    url = _normalize_discovery_url(address)
    client = Client(url, timeout=timeout_s)
    try:
        raw = await asyncio.wait_for(
            client.connect_and_get_server_endpoints(), timeout=timeout_s
        )
    except Exception as exc:  # surfaced to the caller as a string
        return {"ok": False, "error": _short_probe_error(exc), "endpoints": []}
    finally:
        with contextlib.suppress(Exception):
            await client.disconnect()

    endpoints: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    for ep in raw:
        server = getattr(ep, "Server", None)
        app_name = ""
        app_uri = ""
        if server is not None:
            name_field = getattr(server, "ApplicationName", None)
            app_name = getattr(name_field, "Text", "") or ""
            app_uri = getattr(server, "ApplicationUri", "") or ""
        security_mode = _security_mode_name(getattr(ep, "SecurityMode", None))
        security_policy = _policy_short_name(getattr(ep, "SecurityPolicyUri", "") or "")
        row = {
            "endpoint_url": getattr(ep, "EndpointUrl", "") or url,
            "security_mode": security_mode,
            "security_policy": security_policy,
            "user_tokens": _user_token_types(getattr(ep, "UserIdentityTokens", None)),
            "server_name": app_name,
            "application_uri": app_uri,
            "supported": _endpoint_supported(security_mode, security_policy),
        }
        key = (row["endpoint_url"], row["security_mode"], row["security_policy"])
        if key in seen:
            continue
        seen.add(key)
        endpoints.append(row)
    return {"ok": True, "error": None, "endpoints": endpoints}


async def probe_connection(settings: dict, *, timeout_s: float = 5.0) -> dict:
    """Open a throwaway session to verify credentials/reachability.

    Uses the same security semantics as the live engine (NoSecurity unless a
    policy is chosen). Returns ``{ok, error, server_name, namespace_count}``.
    """
    url = str(settings.get("server_url", "opc.tcp://localhost:4840"))
    username = str(settings.get("username", "") or "")
    password = str(settings.get("password", "") or "")
    timeout = float(settings.get("connect_timeout_s", timeout_s) or timeout_s)
    client = Client(url, timeout=timeout)
    try:
        await apply_client_security(client, settings)
        if username:
            client.set_user(username)
            client.set_password(password)
        await asyncio.wait_for(client.connect(), timeout=timeout)
    except Exception as exc:  # surfaced to the caller as a string
        with contextlib.suppress(Exception):
            await client.disconnect()
        return {"ok": False, "error": _short_probe_error(exc), "server_name": None, "namespace_count": None}

    server_name: str | None = None
    namespace_count: int | None = None
    with contextlib.suppress(Exception):
        namespace_count = len(await client.get_namespace_array())
    try:
        node = client.get_node(ua.NodeId(ua.ObjectIds.Server_ServerStatus_BuildInfo_ProductName))
        value = await node.read_value()
        server_name = str(value) if value else None
    except Exception:
        pass
    with contextlib.suppress(Exception):
        await client.disconnect()
    return {"ok": True, "error": None, "server_name": server_name, "namespace_count": namespace_count}
