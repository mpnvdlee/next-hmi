"""Manager app — the always-on supervisor + reverse proxy front door.

This is the ASGI app the launcher runs in *manager mode* (the default, when no
``--serve-project`` is given). It is deliberately lightweight: it never loads a
project's datasources/OPC-UA/WebSocket pipeline. Instead it:

  * serves the manager SPA (project dashboard + device admin) at the origin root,
  * gates everything but the public live view behind a device-admin password
    (see ``core.manager_auth`` and ``_runtime_public`` below),
  * supervises one child backend process per running project
    (``services.supervisor``), and
  * reverse-proxies ``/runtime/<slug>/*`` and ``/editor/<slug>/*`` (HTTP +
    WebSocket) to the matching child.

Each child is the ordinary single-project app from ``main.py`` running in
instance mode; isolation falls out of the process boundary, so none of the
single-project singletons need to become project-aware.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from collections.abc import Callable
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import quote, unquote

import httpx
from api.docs_api import bundled_docs_dir
from api.docs_api import router as help_router
from api.embedding_api import router as embedding_router
from api.manager_auth_api import router as manager_auth_router
from api.manager_peers_api import TRANSFER_DEADLINE_SECONDS, reconcile_transfer_journals
from api.manager_peers_api import manager_router as manager_peers_router
from api.manager_peers_api import public_router as public_manager_peers_router
from api.mcp_auth_api import manager_router as mcp_tokens_router
from api.mcp_auth_api import public_router as public_mcp_auth_router
from api.projects_api import router as projects_router
from api.supervisor_api import router as supervisor_router
from api.system_api import manager_router as system_router
from api.telemetry_api import router as telemetry_router
from api.thumbnail_api import manager_router as thumbnail_manager_router
from api.tls_api import router as tls_router
from api.v1_api import router as api_v1_router
from core import (
    audit,
    instance_secret,
    manager_auth,
    peer_tokens,
    telemetry,
    tls_settings,
    users_document,
)
from core.exceptions import register_exception_handlers
from core.logging_setup import configure_logging
from core.manifest import (
    default_project,
    drop_auto_seeded_projects_root,
    find_project,
    load_manifest,
    migrate_invalid_project_ids,
)
from core.origin_check import OriginCheckMiddleware
from core.peer_discovery import peer_discovery
from core.project_packer import max_zip_bytes
from core.security_headers import FrameAncestorsMiddleware
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from mcp_server.server import mount_workspace_mcp, run_session_manager_once
from mcp_server.write_helpers import drain_inflight_broadcasts
from services import frontend_serve, project_resume
from services.supervisor import ChildAuth, supervisor
from services.theme_manager import THEME_ID
from starlette.background import BackgroundTask
from starlette.datastructures import Headers
from starlette.routing import get_route_path
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from starlette.websockets import WebSocketState

logger = logging.getLogger(__name__)

# Hop-by-hop headers must not be forwarded verbatim across the proxy.
_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "host",
    }
)

_proxy_client: httpx.AsyncClient | None = None


def _strip_manager_cookie(cookie_header: str) -> str:
    """Drop the manager session cookie from a forwarded ``Cookie`` header.

    The session token authenticates the operator to the manager front door only;
    children are trusted localhost processes that have no use for it, so keep it
    out of the project app's context.
    """
    kept = [
        part
        for part in cookie_header.split(";")
        if part.strip().split("=", 1)[0].strip() != manager_auth.SESSION_COOKIE
    ]
    return "; ".join(p.strip() for p in kept if p.strip())


def _forwarded_headers(request: Request) -> list[tuple[str, str]]:
    """Request headers to forward upstream: hop-by-hop dropped, manager cookie stripped.

    ``Origin`` is dropped too: the manager's own check has passed it by now,
    and the child refuses any write that still carries a foreign one
    (``core.origin_check``) — its own ``Host`` is loopback, never the browser's.
    ``x-nexthmi-editor`` is the manager's own mark (``core.audit.EDITOR_HEADER``),
    so a browser's copy never reaches the child. ``X-Forwarded-For`` is replaced
    by the one address the manager saw — ``request.client``, which uvicorn has
    already taken from a trusted front proxy's header — because the child's
    uvicorn trusts loopback and would otherwise believe whatever the browser
    wrote there (``api.device_api``). ``X-Forwarded-Proto`` is likewise the
    scheme the manager derived itself, and a client's ``X-Forwarded-Host``,
    ``X-Forwarded-Prefix`` and ``Forwarded`` are dropped — the child bakes the
    prefix into ``index.html``, so only the manager's own alias may set it.
    The instance-secret headers are the manager's too: the proxy client adds
    the secret itself (``ChildAuth``), and a nonce would turn the child into a
    signing oracle.
    """
    headers: list[tuple[str, str]] = []
    for key, value in request.headers.items():
        if key.lower() in _HOP_BY_HOP or key.lower() in (
            "origin",
            "x-forwarded-for",
            "x-forwarded-proto",
            "x-forwarded-host",
            "x-forwarded-prefix",
            "x-real-ip",
            "forwarded",
            audit.EDITOR_HEADER,
            instance_secret.HEADER,
            instance_secret.NONCE_HEADER,
        ):
            continue
        if key.lower() == "cookie":
            value = _strip_manager_cookie(value)
            if not value:
                continue
        headers.append((key, value))
    if request.client is not None:
        headers.append(("x-forwarded-for", request.client.host))
    headers.append(("x-forwarded-proto", request.url.scheme))
    return headers


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    # Logged as well as printed in the launcher's banner: start-dev.py prints
    # its banner from another process, and the log file outlives the terminal.
    setup_code = manager_auth.setup_code()
    if setup_code is not None:
        logger.warning(
            "No device-admin password is set. Setup code for the first visit to the dashboard: %s",
            setup_code,
        )
    # start-dev.py binds uvicorn itself, so the launcher's ``mark_served`` call
    # never runs and tls_settings still defaults to "serving plain HTTP". Left
    # unset, Settings → HTTPS reads that stale default as reality and reports
    # no restart needed for the very toggle that does need one.
    if os.environ.get("NEXTHMI_DEV_TLS_SERVED") == "1":
        served = None
        if tls_settings.env_override() is None:
            with suppress(tls_settings.TlsError):
                served = tls_settings.describe(None, tls_settings.mode())
        tls_settings.mark_served(True, (served or {}).get("fingerprint"))
    global _proxy_client
    _proxy_client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=None, write=None, pool=5.0),
        auth=ChildAuth(),
        trust_env=False,
    )
    # The workspace MCP transport runs for the life of the manager; its session
    # manager must be entered inside the lifespan.
    async with run_session_manager_once():
        # Bring the device back as it was: migrate a legacy single-live install
        # into the running set / seed the first project on a fresh install,
        # then resume everything recorded as running.
        renamed = migrate_invalid_project_ids()
        if renamed:
            logger.warning(
                "manifest: migrated project ids that predate the canonical grammar: %s",
                ", ".join(f"{old} -> {new}" for old, new in renamed.items()),
            )
        unpinned = drop_auto_seeded_projects_root()
        if unpinned:
            logger.info(
                "manifest: dropped the auto-seeded projects root %s — new projects now "
                "default to the Documents folder; the folder itself is left untouched",
                unpinned,
            )
        reconcile_transfer_journals()
        project_resume.prepare_running_set()
        await asyncio.to_thread(supervisor.resume_all)
        try:
            # With TLS on, the launcher moves the app to the HTTPS port and
            # leaves the HTTP port redirecting, so peers have to be pointed at
            # the one that actually serves. NEXTHMI_HTTPS_PORT is exported
            # either way — it is where HTTPS *would* bind — so what decides is
            # whether this process is actually serving it.
            serving_tls, _ = tls_settings.served()
            advertised_port = (
                os.environ.get("NEXTHMI_HTTPS_PORT") if serving_tls else None
            ) or os.environ.get("NEXTHMI_PORT", "8000")
            await peer_discovery.start(port=int(advertised_port))
        except Exception as exc:
            logger.warning("peer_discovery: manager start failed: %s", exc)
        try:
            telemetry.start()
        except Exception as exc:
            logger.warning("telemetry: start failed: %s", exc)
        try:
            yield
        finally:
            # Let in-flight loopback reload notifications reach their child
            # before the loop tears down.
            await drain_inflight_broadcasts()
            await asyncio.to_thread(supervisor.shutdown)
            await peer_discovery.stop()
            await telemetry.stop()
            if _proxy_client is not None:
                await _proxy_client.aclose()


app = FastAPI(title="NEXT HMI Manager", lifespan=lifespan)
register_exception_handlers(app)

app.include_router(manager_auth_router)
app.include_router(public_manager_peers_router)
app.include_router(manager_peers_router)
app.include_router(public_mcp_auth_router)
app.include_router(mcp_tokens_router)
app.include_router(supervisor_router)
app.include_router(projects_router)
app.include_router(thumbnail_manager_router)
app.include_router(system_router)
app.include_router(tls_router)
app.include_router(telemetry_router)
app.include_router(embedding_router)
# Excluded from ``_auth_gate`` (see ``_is_gated``): every v1 route checks its own
# device-admin Basic or API-token credential, and a session cookie opens none.
app.include_router(api_v1_router)

# Product documentation behind the editor's Help button: the bundled copy when
# this build ships one, otherwise a redirect to the public page.
_bundled_docs = bundled_docs_dir()
if _bundled_docs is not None:

    @app.get("/help", include_in_schema=False)
    async def _help_index() -> RedirectResponse:
        # A mount only matches below its own path, so bare ``/help`` — what the
        # Help button opens — falls through to the SPA catch-all and 404s. The
        # router's own slash-redirect never fires because that catch-all counts
        # as a match.
        return RedirectResponse(url="/help/")

    app.mount(
        "/help",
        StaticFiles(directory=str(_bundled_docs), html=True, follow_symlink=False),
        name="help-docs",
    )
else:
    app.include_router(help_router)

# The single multi-project workspace MCP endpoint. Mounted before the SPA
# catch-all so ``/mcp`` resolves to the transport, not index.html. Excluded
# from ``_auth_gate`` below (see ``_is_gated``) because it carries its own
# authentication — a manager session cookie or an MCP bearer token, checked by
# ``mcp_server.auth.McpAuthMiddleware`` — rather than the plain cookie gate.
# That authentication is the boundary, not the bind address: the manager binds
# every interface by default (``core.net.resolve_bind_host``), so a request off
# the network reaches the same check a loopback one does. Per-project
# ``mcpEnabled`` still gates writes at the tool layer, on top of it.
mount_workspace_mcp(app)


# The same project child is served under two verb-first, browser-facing
# prefixes: ``/runtime/<slug>/`` and ``/editor/<slug>/``. Both forward
# themselves as ``X-Forwarded-Prefix`` so the child bakes the right base into
# ``index.html``. (The legacy ``/p/<id>/`` alias was removed.)
_PROXY_PREFIXES = ("runtime", "editor")


# ── auth gate ─────────────────────────────────────────────────────────────────

# Error code on the gate's 401 body. The SPA keys its "manager session expired"
# screen off this so it never mistakes a project-user 401 (a bad write
# credential) for a lost device-admin session.
MANAGER_SESSION_REQUIRED = "manager_session_required"


# Wildcard in a public-route pattern: exactly one path segment, never more.
# Prefix matching is deliberately absent — "everything under api/config/" plus a
# dot segment is what let a crafted URL walk out of the allowlisted subtree and
# into the datasource passwords.
_ONE = "*"

# The live view is the product's public face: an operator panel must come up on
# a wall-mounted browser with no device-admin password. The project child mounts
# every router on one app and authenticates no user (it only checks that a
# request came through this manager, ``core.instance_secret``), so this table
# *is* the boundary. Deny by default; each entry is exact, or exact with one
# wildcard segment. Query strings never take part in the match.
_RUNTIME_PUBLIC_ROUTES: dict[str, tuple[tuple[str | re.Pattern[str], ...], ...]] = {
    "GET": (
        ("api", "config", "config"),
        ("api", "config", "pages", _ONE),
        # Same document, other index root: an overlay's page is as public as a
        # navigable one — the live view opens both without a session.
        ("api", "config", "dialogs", _ONE),
        ("api", "config", "dictionaries"),
        ("api", "config", "translations"),
        ("api", "themes"),
        # Not ``_ONE``: it would pass ``D:foo``, a file on another drive to a Windows child.
        ("api", "themes", THEME_ID),
        ("api", "default-theme"),
        ("api", "components"),
        ("api", "components", "folders"),
        ("api", "widgets"),
        ("api", "device", "info"),
        ("api", "users", "roster"),
        ("api", "alarms", "history"),
        ("api", "historian", "query"),
    ),
    "POST": (
        ("api", "recipes", "datasets", _ONE, "download"),
        ("api", "recipes", "datasets", _ONE, "upload"),
        ("api", "http-request"),
    ),
}

# First sub-path segment of a child route that must stay behind the session even
# though it is a plain GET outside ``api/``: the child leaves FastAPI's
# interactive docs enabled (``backend/main.py``), and they enumerate every
# route on the instance — including the ones this table withholds.
_RUNTIME_PRIVATE_DOCS = frozenset({"openapi.json", "docs", "redoc"})

_UNSAFE_SEGMENTS = frozenset({"", ".", ".."})


def _is_gated(path: str, method: str = "GET", raw_path: str | None = None) -> bool:
    """True for paths that require a manager session.

    The SPA shell + bundle stay public so the login screen can render; the data
    APIs and the editor proxy are gated. Auth endpoints are always public.
    ``/mcp`` is excluded here because it enforces its own session-or-bearer-
    token authentication (``mcp_server.auth``) instead of this cookie gate;
    ``/api/v1/`` because every route under it authenticates itself
    (``api.v1_api``) and a session cookie must not be enough there.
    ``/runtime/<id>/…`` is gated only for what is not on the public table above.
    """
    if (
        path.startswith("/api/manager/auth")
        or path.startswith("/api/manager/peer/")
        or path.startswith("/api/manager/mcp/pair")
        or path == "/api/health"
    ):
        return False
    if path == "/mcp" or path.startswith("/mcp/") or path.startswith("/api/v1/"):
        return False
    if path.startswith("/api/"):
        return True
    if path.lstrip("/") in _RUNTIME_PRIVATE_DOCS:
        # The manager's own FastAPI instance leaves its interactive docs
        # enabled at the same default paths it withholds for a proxied child
        # above — they enumerate every gated endpoint's path, method and
        # schema, and the manager binds every interface by default.
        return True
    parts = _proxy_parts(path)
    if parts is None:
        return _is_proxy_path(path)
    prefix, project_id, sub_path = parts
    if prefix != "runtime":
        return True
    if not _is_plain_segment(project_id):
        return True
    if not _is_plain_sub_path(sub_path) or not _is_plain_sub_path(_raw_sub_path(raw_path)):
        return True
    return not _runtime_public(sub_path, method)


def _is_proxy_path(path: str) -> bool:
    """True for a browser-facing project-instance path (``/runtime/…``, ``/editor/…``)."""
    return any(path.startswith(f"/{prefix}/") for prefix in _PROXY_PREFIXES)


def _proxy_parts(path: str) -> tuple[str, str, str] | None:
    """``(prefix, project_id, sub_path)`` for a proxy path, else ``None``.

    Split exactly the way the route is declared — ``/{prefix}/{project_id}/{path:path}``
    — so the gate and the router can never disagree about where the sub-path
    begins. A regex over the whole URL would: a single ``%2f`` is already a real
    separator by the time either of them looks at it. A *double*-encoded one is
    not, and that is what :func:`_is_plain_segment` is for.
    """
    parts = path.split("/")
    if len(parts) < 3 or parts[0] != "" or parts[1] not in _PROXY_PREFIXES or not parts[2]:
        return None
    return parts[1], parts[2], "/".join(parts[3:])


def _raw_route_path(scope: Scope) -> str | None:
    """``raw_path`` with ``root_path`` stripped — the still-encoded twin of
    :func:`starlette.routing.get_route_path`.

    Servers build ``raw_path`` with the mount prefix included (uvicorn does), so
    it has to come off here or the sub-path window below lines up one segment
    out from the decoded one.
    """
    raw = scope.get("raw_path")
    if isinstance(raw, bytes):
        raw = raw.decode("latin-1")
    if not isinstance(raw, str):
        return None
    root_path = scope.get("root_path", "")
    if root_path and raw.startswith(root_path):
        raw = raw[len(root_path) :] or "/"
    return raw


def _raw_sub_path(raw_path: str | None) -> str:
    """The still-percent-encoded sub-path, for the second half of the check.

    ``scope["path"]`` has been decoded by the server; ``scope["raw_path"]`` has
    not (same hazard the HTTPS redirector notes in ``launcher.py``). Checking
    both means a dot segment cannot hide behind an extra encoding layer on the
    way to a decoder that disagrees with this one.
    """
    if raw_path is None:
        return ""
    parts = raw_path.split("/")
    return "/".join(parts[3:]) if len(parts) >= 3 else ""


def _decoded_forms(segment: str) -> tuple[str, ...]:
    """*segment* and every form it takes under repeated percent-decoding.

    ``scope["path"]`` has already been decoded once by the server, so a segment
    still carrying ``%xx`` is one the client encoded twice — and the child's own
    server decodes it again before routing. ``unquote`` never lengthens a string
    and only leaves it alone at a fixpoint, so this terminates.
    """
    forms = [segment]
    while (decoded := unquote(forms[-1])) != forms[-1]:
        forms.append(decoded)
    return tuple(forms)


# Characters a server may trim from a path segment before it routes on it.
# Everything at or below 0x20 (space, tab, CR, LF, NUL's neighbours) plus DEL.
_TRIM_CHARS = "".join(chr(code) for code in range(0x21)) + "\x7f"


def _route_name(form: str) -> str:
    """*form* reduced to the name a downstream router may end up matching on.

    A NUL truncates the rest of the segment in any C string API, ``;`` starts a
    path parameter on a servlet-style stack, a trailing dot is dropped on
    Windows filesystems, and surrounding whitespace or control characters are
    trimmed all over. ``api\x00``, ``api;``, ``api.`` and ``api `` are all
    ``api`` to something downstream.
    """
    trimmed = form.split("\x00", 1)[0].split(";", 1)[0].strip(_TRIM_CHARS)
    return trimmed.rstrip(".").strip(_TRIM_CHARS)


def _route_forms(segment: str) -> set[str]:
    """Every lower-cased form of *segment* the classification below must judge.

    Its decodings, and each of those reduced by :func:`_route_name`. Widening
    the set can only move a segment *into* the table (and be denied); the
    hazard runs the other way, where an untrimmed ``api\x00`` falls through to
    the "plain GET outside api/" branch that serves documents and assets.
    """
    forms: set[str] = set()
    for decoded in _decoded_forms(segment):
        lowered = decoded.lower()
        forms.add(lowered)
        forms.add(_route_name(lowered))
    return forms


def _first_route_segment(segments: list[str]) -> str:
    """The segment the child would classify the request on.

    Not always ``segments[0]``: ``/runtime/<id>/;/api/datasources`` is
    ``api/datasources`` to any stack that drops a bare path parameter, so
    classifying on the ``;`` — which is neither ``api`` nor a docs route — hands
    out the whole API subtree. A sub-path that is empty all the way down (the
    live view's own document request) has no such segment and keeps
    ``segments[0]``.
    """
    for segment in segments:
        if _route_name(_decoded_forms(segment)[-1].lower()):
            return segment
    return segments[0]


def _is_plain_segment(segment: str) -> bool:
    """True when *segment* stays one ordinary segment however often it is decoded.

    Rejected: anything that becomes a separator or a dot segment on the way
    down — ``api%2fdatasources`` is opaque here and two real segments at the
    child, which is how a crafted URL walked out of the allowlisted subtree.
    """
    return not any(
        form in _UNSAFE_SEGMENTS or "/" in form or "\\" in form
        for form in _decoded_forms(segment)
    )


def _is_plain_sub_path(sub_path: str) -> bool:
    """True when *sub_path* is already canonical, so forwarding cannot change it.

    Reject, never normalize: ``httpx`` collapses ``.`` and ``..`` when the proxy
    rebuilds the upstream URL and forwards every remaining escape verbatim for
    the child to decode, so only a sub-path that survives both unchanged still
    means at the child what the allowlist decided here.

    Nothing rejects ``%`` on its own. The path reaching this gate has been
    decoded once already, so a project asset genuinely named ``50% mix.png``
    arrives with a literal per-cent sign and must keep working; a literal ``%``
    and a surviving ``%2f`` are indistinguishable by inspection, which is why
    the test is what the segment *decodes to* rather than what it contains.
    """
    if not sub_path:
        return True
    return all(_is_plain_segment(segment) for segment in sub_path.split("/"))


def _has_dot_segment(sub_path: str) -> bool:
    """True when a segment of *sub_path* is, or decodes to, ``.`` or ``..``.

    The proxy's own check for every prefix, session or not. ``httpx`` collapses
    a literal one when it builds the upstream URL and the child decodes an
    encoded one, so either moves the request to a route other than the one
    judged here: ``api/./internal/reload`` reached the internal hook. Unlike
    :func:`_is_plain_sub_path` it leaves empty segments alone, which nothing
    collapses, so an editor's trailing-slash request keeps working.
    """
    return any(
        part in (".", "..")
        for segment in sub_path.split("/")
        for form in _decoded_forms(segment)
        for part in form.split("/")
    )


def _decoded_path(path: str) -> str:
    """*path* with every segment decoded to its fixpoint, for a literal compare.

    A double-encoded separator survives ``scope["path"]`` inside a single
    segment and becomes a real one again at the child, so a string test against
    the form seen here matches nothing while the child still routes it.
    """
    return "/".join(_decoded_forms(segment)[-1] for segment in path.split("/"))


def _runtime_public(sub_path: str, method: str) -> bool:
    """True when ``/runtime/<id>/<sub_path>`` may be served with no session.

    *sub_path* must already have passed :func:`_is_plain_sub_path`.
    """
    segments = sub_path.split("/")
    # HEAD is a GET without the body: a conditional fetch of a public asset or
    # document must not need a session the GET beside it does not. OPTIONS is
    # deliberately left gated — the live view is same-origin so it never sends
    # a preflight, and an anonymous OPTIONS would hand back the child's
    # ``Allow:`` header for exactly the routes this table withholds.
    lookup = "GET" if method == "HEAD" else method
    # Classify the first segment over every form it decodes to, then match the
    # table case-sensitively against the literal one. ``API/datasources`` is a
    # child route only on a stack that folds case and ``%2561pi/datasources``
    # only once the child decodes again; both must land in the table (and be
    # denied) rather than in the "plain GET outside api/" branch that serves
    # documents and assets.
    first_forms = _route_forms(_first_route_segment(segments))
    if lookup == "GET" and "api" not in first_forms:
        return first_forms.isdisjoint(_RUNTIME_PRIVATE_DOCS)
    return any(
        len(pattern) == len(segments)
        and all(
            p.fullmatch(s) is not None if isinstance(p, re.Pattern) else p in (_ONE, s)
            for p, s in zip(pattern, segments, strict=True)
        )
        for pattern in _RUNTIME_PUBLIC_ROUTES.get(lookup, ())
    )


def safe_sign_in_target(raw: str | None) -> str | None:
    """The ``signIn`` destination to resume after sign-in, or ``None``.

    Only same-origin project-instance paths are honoured, so a crafted link
    cannot turn the manager's sign-in round-trip into an open redirect — and
    only canonical ones, because the browser normalizes the ``Location`` it is
    handed: ``/runtime/x/../../evil`` is a request for ``/evil``.
    """
    if not raw or not raw.startswith("/"):
        return None
    if any(char in raw for char in ("\\", "\r", "\n", "\t")):
        return None
    parts = _proxy_parts(raw.split("?", 1)[0])
    if parts is None:
        return None
    _prefix, project_id, sub_path = parts
    if not _is_plain_segment(project_id) or not _is_plain_sub_path(sub_path):
        return None
    return raw


def _is_document_request(request: Request) -> bool:
    """A top-level browser navigation, as opposed to an asset or XHR fetch."""
    return request.method == "GET" and "text/html" in request.headers.get("accept", "")


def _full_path(request: Request) -> str:
    """Root-relative path + query of *request*, for a round-trip after sign-in."""
    query = request.url.query
    return f"{request.url.path}?{query}" if query else request.url.path


def _has_valid_session(cookies) -> bool:
    return manager_auth.verify_token(cookies.get(manager_auth.SESSION_COOKIE))


def _peer_bearer(request: Request) -> str | None:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    return token if scheme.lower() == "bearer" else None


def _users_document_state(project_id: str) -> users_document.DocumentState | None:
    entry = find_project(load_manifest(), project_id)
    return users_document.state(Path(entry.path).expanduser()) if entry is not None else None


@app.middleware("http")
async def _auth_gate(request: Request, call_next):
    # ``get_route_path``, not ``request.url.path``: the two differ by the mount
    # prefix under a ``root_path`` deployment, and a gate reading the longer one
    # waves every ``/api/…`` and proxy path past as "not gated" while the router
    # — which routes on the shorter one — still serves it.
    route_path = get_route_path(request.scope)
    gated = _is_gated(route_path, request.method, _raw_route_path(request.scope))
    if gated and not _has_valid_session(request.cookies):
        # A browser opening a project URL must land on the manager's sign-in
        # screen; without this it renders the raw 401 body (or, in dev where
        # Vite serves the SPA routes itself, an app whose every fetch 401s).
        # `signIn` carries the destination so the manager can return to it.
        if _is_proxy_path(route_path) and _is_document_request(request):
            return RedirectResponse(
                url=f"/?signIn={quote(_full_path(request), safe='')}", status_code=303
            )
        return JSONResponse(
            {"detail": "Authentication required", "code": MANAGER_SESSION_REQUIRED},
            status_code=401,
        )
    if request.method == "POST" and route_path == "/api/manager/peer/transfers":
        # Authenticated here, before the route's File()/Form() parameters make
        # FastAPI spool the whole multipart to disk. Checking inside the handler
        # would let any unauthenticated host on the LAN fill the destination's
        # disk with bodies that are only rejected after they have landed.
        if not peer_tokens.verify(_peer_bearer(request)):
            return JSONResponse(
                {"detail": "Invalid or revoked peer token"}, status_code=401
            )
        raw_length = request.headers.get("content-length")
        if raw_length is None or not raw_length.isdigit():
            return JSONResponse({"detail": "Content-Length is required"}, status_code=411)
        if int(raw_length) > max_zip_bytes() + 2 * 1024 * 1024:
            return JSONResponse({"detail": "Transfer body exceeds the configured limit"}, status_code=413)
        try:
            async with asyncio.timeout(TRANSFER_DEADLINE_SECONDS):
                return await call_next(request)
        except TimeoutError:
            return JSONResponse({"detail": "Transfer deadline exceeded"}, status_code=408)
    return await call_next(request)


app.add_middleware(OriginCheckMiddleware)
# Outside the gate and the proxy, so their documents are covered too; only the
# body cap added below sits further out, and its 413 is JSON.
app.add_middleware(FrameAncestorsMiddleware)


@app.get("/api/health", include_in_schema=False)
async def health() -> dict:
    return {"status": "ok"}


# ── reverse proxy: /runtime|editor/<projectId>/* → child instance ──────────────


def _upstream_port_or_503(project_id: str) -> int:
    port = supervisor.port_for(project_id)
    if port is None:
        raise HTTPException(status_code=503, detail="Project is not running")
    return port


def _unavailable_reason(project_id: str) -> str | None:
    """Why this project cannot be opened right now, or ``None`` when it can.

    The dashboard already withholds the Open buttons for a project that is
    unknown, whose folder is gone, that crashed, or that was never started — a
    ``/runtime/<id>/`` URL typed or bookmarked straight into the address bar
    bypasses all of that, so it makes the same call here.

    ``starting`` is deliberately not a reason: the instance is on its way up
    and the caller should retry, which the 503 below already says.
    """
    if supervisor.port_for(project_id) is not None:
        return None
    entry = find_project(load_manifest(), project_id)
    if entry is None:
        return "unknown"
    try:
        if not Path(entry.path).expanduser().is_dir():
            return "missing"
    except (OSError, ValueError):
        return "missing"
    snapshot = supervisor.status(project_id)
    status = snapshot["status"] if snapshot is not None else "stopped"
    if status == "starting":
        return None
    return "crashed" if status == "crashed" else "stopped"


# Set by the SPA block below when this build ships a frontend bundle. A project
# document whose instance is gone has no child to serve it, so the manager
# renders the bundle itself and the app explains the outage in place
# (ProjectUnavailableOverlay). A source checkout has no bundle to render, so the
# guard falls back to bouncing the navigation to the dashboard.
_render_instance_shell: Callable[[str], str] | None = None


async def _proxy_ws_to_child(
    websocket: WebSocket, project_id: str, *, require_session: bool
) -> None:
    """Bridge a browser WebSocket to the project child's ``/ws``.

    Shared by the ``/runtime/`` and ``/editor/`` prefixes — the child is one
    process per project, so both tunnel to the same upstream socket. Only the
    editor's socket demands a device-admin session: the live view's socket is
    the variable pipeline that makes the panel a panel, and it is public for the
    same reason the rest of ``/runtime/`` is.
    """
    if require_session and not _has_valid_session(websocket.cookies):
        await websocket.close(code=1008)
        return
    users_state = _users_document_state(project_id)
    if users_state is not None and not users_state.valid:
        await websocket.close(code=1008)
        return
    port = supervisor.port_for(project_id)
    if port is None:
        await websocket.close(code=1011)
        return

    import websockets

    await websocket.accept()
    headers = supervisor.child_headers(port)
    # The upstream is a fresh connection carrying none of the browser's
    # headers. The address the manager saw goes along as the HTTP hop sends it
    # (``_forwarded_headers``), so the child's sign-in throttle meters each
    # browser rather than one loopback address for all of them. The child
    # attributes an editor socket's writes, recipe loads and acks to
    # "engineer", so only the session-gated editor prefix sets that mark.
    if websocket.client:
        headers["x-forwarded-for"] = websocket.client.host
    if require_session:
        headers[audit.EDITOR_HEADER] = "1"
    try:
        # ``proxy=None``: an environment proxy cannot reach loopback, and would
        # be handed the child's secret.
        async with websockets.connect(
            f"ws://127.0.0.1:{port}/ws",
            max_size=None,
            additional_headers=headers or None,
            proxy=None,
        ) as upstream:
            await _pump_websocket(websocket, upstream)
    except Exception as exc:  # pragma: no cover — upstream gone mid-connect
        logger.debug("ws proxy %s: upstream error %s", project_id, exc)
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.close(code=1011)


async def _pump_websocket(client: WebSocket, upstream) -> None:
    async def client_to_upstream() -> None:
        try:
            while True:
                message = await client.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("text") is not None:
                    await upstream.send(message["text"])
                elif message.get("bytes") is not None:
                    await upstream.send(message["bytes"])
        except WebSocketDisconnect:
            pass

    async def upstream_to_client() -> None:
        async for message in upstream:
            if isinstance(message, bytes):
                await client.send_bytes(message)
            else:
                await client.send_text(message)

    c2u = asyncio.create_task(client_to_upstream())
    u2c = asyncio.create_task(upstream_to_client())
    _done, pending = await asyncio.wait({c2u, u2c}, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    # Gather both: a finished task's disconnect error must be retrieved too, or asyncio logs it.
    await asyncio.gather(c2u, u2c, return_exceptions=True)
    with suppress(Exception):
        await upstream.close()


# ── request body caps ─────────────────────────────────────────────────────────

# Neither uvicorn nor Starlette caps a request body, and FastAPI reads a JSON
# body before any dependency authenticates the caller, so one chunked multi-GB
# POST could fill the manager's memory and take every project's panels down with
# it. Whatever the gate lets through with no session (the live view, sign-in and
# pairing, API v1) gets the public cap. The proxy streams a body on to the child
# rather than holding it, so the editor cap bounds what a child must take in:
# the largest editor bodies are JSON saves (a page, or a datasource's whole
# variable list after a large browse import) and the 2 MB thumbnail.
_PUBLIC_BODY_LIMIT = 1024 * 1024
_EDITOR_BODY_LIMIT = 64 * 1024 * 1024


def _body_limit(scope: Scope) -> int | None:
    """The most request body *scope* may carry, or ``None`` when it is not capped here."""
    path = get_route_path(scope)
    method = scope["method"]
    if path == "/mcp" or path.startswith("/mcp/"):
        return None  # authenticates before the transport reads a byte
    if method == "POST" and path == "/api/manager/peer/transfers":
        return None  # held to its own Content-Length limit by the gate
    if not _is_gated(path, method, _raw_route_path(scope)):
        return _PUBLIC_BODY_LIMIT
    # The gate demands a session before anything reads the body; the manager's
    # own routes (a project zip import among them) spool uploads to disk.
    return _EDITOR_BODY_LIMIT if _is_proxy_path(path) else None


class _BodyTooLarge(Exception):
    pass


class _RequestBodyLimit:
    """Answer 413 to a request body over :func:`_body_limit`.

    A declared ``Content-Length`` over the cap is refused before a byte is read;
    a chunked body is counted as it arrives. Once the count trips, whatever the
    app made of the failed read is replaced by the 413: FastAPI reports it as a
    400 "error parsing the body", and through the gate's task group it surfaces
    as an ``ExceptionGroup`` rather than anything a handler could match.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        headers = Headers(scope=scope) if scope["type"] == "http" else None
        # A request that announces neither has no body, which is every asset GET.
        has_body = headers is not None and (
            "content-length" in headers or "transfer-encoding" in headers
        )
        limit = _body_limit(scope) if has_body else None
        if limit is None:
            await self.app(scope, receive, send)
            return
        too_large = JSONResponse(
            {
                "detail": "Request body too large: this address accepts at most "
                f"{limit // (1024 * 1024)} MB."
            },
            status_code=413,
        )
        declared = headers.get("content-length", "")
        if declared.isdigit() and int(declared) > limit:
            await too_large(scope, receive, send)
            return

        received = 0
        exceeded = False
        started = False

        async def counting_receive() -> Message:
            nonlocal received, exceeded
            if exceeded:
                raise _BodyTooLarge
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise _BodyTooLarge
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal started
            if exceeded and not started:
                return
            started = started or message["type"] == "http.response.start"
            await send(message)

        try:
            await self.app(scope, counting_receive, guarded_send)
        except Exception:
            if not exceeded or started:
                raise
        if exceeded and not started:
            await too_large(scope, receive, send)


_PROXY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]


async def _proxy_http_to_child(
    project_id: str,
    path: str,
    request: Request,
    *,
    forwarded_prefix: str | None = None,
):
    """Forward a browser HTTP request to the project child.

    ``forwarded_prefix`` (the ``/runtime/<slug>/`` or ``/editor/<slug>/`` alias
    the request came in through) is passed upstream as ``X-Forwarded-Prefix`` so
    the child bakes the right base path into the ``index.html`` it serves.
    """
    users_state = _users_document_state(project_id)
    if users_state is not None and not users_state.valid:
        return JSONResponse(
            {"detail": f"Project credentials are unavailable: {users_state.error}."},
            status_code=409,
        )

    # Refused rather than collapsed, so the path forwarded below is the one
    # every check here judged.
    if _has_dot_segment(path):
        raise HTTPException(status_code=400, detail="Invalid request path")
    # The child's loopback reload hook is driven by the manager directly (over
    # the instance port), never through this browser-facing proxy.
    # Compare the decoded form: ``api%2finternal%2freload`` is one opaque
    # segment here and three real ones at the child, so a literal string test
    # against what arrived matches nothing the child would not still route.
    internal_probe = _decoded_path(path)
    if internal_probe == "api/internal" or internal_probe.startswith("api/internal/"):
        raise HTTPException(status_code=404)
    reason = _unavailable_reason(project_id)
    if reason is not None and _is_document_request(request):
        # The shell's overlay only has something to show an operator who is
        # already signed in — it probes ``/api/projects`` and
        # ``/api/manager/running``, both gated. ``/runtime/<id>/`` is public
        # (the live-view wall panel needs no session), so a session-less
        # visitor would otherwise get a page whose every call 503s with
        # nothing on screen; send them to the dashboard instead, same as a
        # build with no bundle to render.
        if _render_instance_shell is not None and _has_valid_session(request.cookies):
            return HTMLResponse(
                _render_instance_shell(forwarded_prefix or f"/runtime/{project_id}/")
            )
        return RedirectResponse(
            url=f"/projects?unavailable={project_id}&reason={reason}", status_code=303
        )
    port = _upstream_port_or_503(project_id)
    assert _proxy_client is not None
    try:
        # Built from parts, not parsed from a string: a decoded ``?`` or ``#``
        # in the path would otherwise end it there, and the child would serve
        # a shorter path than the one checked.
        url = httpx.URL(
            scheme="http",
            host="127.0.0.1",
            port=port,
            path="/" + path.replace("?", "%3F").replace("#", "%23"),
            query=request.url.query.encode("utf-8"),
        )
    except httpx.InvalidURL as exc:
        # A control character the gate let past (a NUL inside a segment, say)
        # is a malformed request target, not a manager fault. ``InvalidURL`` is
        # not an ``HTTPError``, so the except below never saw it and it
        # surfaced as an anonymous 500.
        raise HTTPException(status_code=400, detail="Invalid request path") from exc
    headers = _forwarded_headers(request)
    if forwarded_prefix is not None:
        headers.append(("x-forwarded-prefix", forwarded_prefix))
        # The auth gate has already demanded the session for /editor/*.
        if forwarded_prefix.startswith("/editor/"):
            headers.append((audit.EDITOR_HEADER, "1"))
    # Streamed, not buffered: ``_RequestBodyLimit`` counts it on the way through.
    # A request that announces no body sends none, so a GET is not reframed as
    # an empty chunked upload.
    has_body = "content-length" in request.headers or "transfer-encoding" in request.headers
    upstream_req = _proxy_client.build_request(
        request.method, url, headers=headers, content=request.stream() if has_body else None
    )
    try:
        upstream_resp = await _proxy_client.send(upstream_req, stream=True, follow_redirects=False)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Upstream error: {exc}") from exc

    resp_headers = {
        k: v for k, v in upstream_resp.headers.items() if k.lower() not in _HOP_BY_HOP
    }
    return StreamingResponse(
        upstream_resp.aiter_raw(),
        status_code=upstream_resp.status_code,
        headers=resp_headers,
        background=BackgroundTask(upstream_resp.aclose),
    )


def _register_proxy_routes(prefix: str) -> None:
    # The prefix is only knowable at registration time — the endpoint itself
    # cannot tell which alias routed to it — so the editor/runtime split for the
    # socket is bound here.
    require_session = prefix != "runtime"

    @app.websocket(f"/{prefix}/{{project_id}}/ws")
    async def _proxy_ws(websocket: WebSocket, project_id: str) -> None:
        await _proxy_ws_to_child(websocket, project_id, require_session=require_session)

    @app.api_route(
        f"/{prefix}/{{project_id}}/{{path:path}}", methods=_PROXY_METHODS, include_in_schema=False
    )
    async def _proxy_http(project_id: str, path: str, request: Request):
        fp = f"/{prefix}/{project_id}/"
        return await _proxy_http_to_child(project_id, path, request, forwarded_prefix=fp)

    @app.get(f"/{prefix}/{{project_id}}", include_in_schema=False)
    async def _proxy_root_redirect(project_id: str) -> RedirectResponse:
        return RedirectResponse(url=f"/{prefix}/{project_id}/")


for _prefix in _PROXY_PREFIXES:
    _register_proxy_routes(_prefix)

# Added after the gate so it wraps it: a declared oversize body is refused
# before the gate or any route looks at the request.
app.add_middleware(_RequestBodyLimit)


# ── manager SPA (served at origin root, base "/") ───────────────────────────────


class _SpaLastRoutes(list):
    """Route list that keeps the SPA catch-all pinned at the end.

    Starlette matches in registration order, so anything appended after the
    catch-all is shadowed by it. Modules that wrap this app import ``app`` and
    only then ``include_router()`` (``launcher._load_manager_app`` imports one
    such entrypoint), by which point the catch-all is already registered: their
    GET routes would answer from ``_spa_fallback`` — 404 for ``/api/...``,
    index.html elsewhere — while their POST routes kept working, a split
    failure that appears only in builds where NEXTHMI_FRONTEND_DIST is set.

    Pinning here makes late registration correct by construction, through
    whichever API it arrives (``include_router``, ``@app.get``, ``app.mount``,
    ``app.websocket`` all land in this list), so a module added later inherits
    the fix without knowing this file exists.
    """

    def __init__(self, routes: list, pinned: list) -> None:
        super().__init__(routes)
        self._pinned = pinned

    def _repin(self) -> None:
        # Identity, not ``==``: Starlette routes compare by path/endpoint/methods,
        # so ``list.remove`` could pull out a value-equal route instead of the pin.
        for pinned in self._pinned:
            for index, existing in enumerate(self):
                if existing is pinned:
                    del self[index]
                    super().append(pinned)
                    break

    def append(self, route: object) -> None:
        super().append(route)
        self._repin()

    def extend(self, routes: list) -> None:
        super().extend(routes)
        self._repin()

    def insert(self, index: int, route: object) -> None:
        super().insert(index, route)
        self._repin()


_frontend_dist_env = os.environ.get("NEXTHMI_FRONTEND_DIST")
if _frontend_dist_env:
    _frontend_dist = Path(_frontend_dist_env).resolve()
    _app_assets_dir = _frontend_dist / "_app"
    if _app_assets_dir.is_dir():
        app.mount(
            "/_app",
            StaticFiles(directory=str(_app_assets_dir), follow_symlink=False),
            name="spa-bundle",
        )

    _SPA_EXCLUDED_SEGMENTS = (
        "api", *_PROXY_PREFIXES, "mcp", "_app", "openapi.json", "redoc", "docs", "help",
    )

    def _render_manager_index() -> str:
        # The manager has no project, so there are no external-library imports
        # to splice; pass the dist root for both library + override paths (both
        # resolve to "no entries") and inject base "/".
        return frontend_serve.render_index_html(
            _frontend_dist,
            _frontend_dist / "external-libraries",
            _frontend_dist / "external-modules.json",
            base_path="/",
            mode="manager",
        )

    def _render_instance_index(base_path: str) -> str:
        # Same bundle, told it is a project document under `base_path`, so the
        # app boots the instance routes and its own 503s drive the overlay —
        # rather than the manager dashboard appearing at a project URL.
        return frontend_serve.render_index_html(
            _frontend_dist,
            _frontend_dist / "external-libraries",
            _frontend_dist / "external-modules.json",
            base_path=base_path,
            mode="instance",
        )

    _render_instance_shell = _render_instance_index

    _spa_route_start = len(app.router.routes)

    @app.get("/", include_in_schema=False, response_model=None)
    async def _spa_root(request: Request):
        # A device with a default project up answers its origin root with that
        # project's live view — signed in or not, because the live view is
        # public. Otherwise serve the manager SPA (login screen / project
        # picker), which client-redirects once a default is chosen and running.
        sign_in = request.query_params.get("signIn")
        if _has_valid_session(request.cookies):
            # A `signIn` round-trip that arrives already authenticated (the
            # session was established in another tab) resumes its destination
            # instead of being sent to the default project.
            resume = safe_sign_in_target(sign_in)
            if resume is not None:
                return RedirectResponse(url=resume, status_code=303)
        elif sign_in is not None:
            # The gate bounced a gated navigation here to sign in. Redirecting
            # to the default project's runtime instead would drop the round-trip
            # and the login screen would never appear.
            return HTMLResponse(_render_manager_index())
        entry = default_project(load_manifest())
        if entry is not None and supervisor.port_for(entry.id) is not None:
            return RedirectResponse(url=f"/runtime/{entry.id}/")
        return HTMLResponse(_render_manager_index())

    @app.get("/{path:path}", include_in_schema=False, response_model=None)
    async def _spa_fallback(path: str):
        first_segment = path.split("/", 1)[0]
        if first_segment in _SPA_EXCLUDED_SEGMENTS:
            raise HTTPException(status_code=404)
        candidate = (_frontend_dist / path).resolve()
        try:
            candidate.relative_to(_frontend_dist)
        except ValueError:
            raise HTTPException(status_code=404) from None
        if candidate.is_file():
            return FileResponse(candidate)
        return HTMLResponse(_render_manager_index())

    app.router.routes = _SpaLastRoutes(
        app.router.routes, app.router.routes[_spa_route_start:]
    )
