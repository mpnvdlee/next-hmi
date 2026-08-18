"""Manager app — the always-on supervisor + reverse proxy front door.

This is the ASGI app the launcher runs in *manager mode* (the default, when no
``--serve-project`` is given). It is deliberately lightweight: it never loads a
project's datasources/OPC-UA/WebSocket pipeline. Instead it:

  * serves the manager SPA (project dashboard + device admin) at the origin root,
  * gates everything behind a device-admin password (see ``core.manager_auth``),
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
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import quote

import httpx
from api.docs_api import bundled_docs_dir
from api.docs_api import router as help_router
from api.manager_auth_api import router as manager_auth_router
from api.manager_peers_api import manager_router as manager_peers_router
from api.manager_peers_api import public_router as public_manager_peers_router
from api.manager_peers_api import reconcile_transfer_journals
from api.mcp_auth_api import manager_router as mcp_tokens_router
from api.mcp_auth_api import public_router as public_mcp_auth_router
from api.operator_setup_api import router as operator_setup_router
from api.projects_api import router as projects_router
from api.supervisor_api import router as supervisor_router
from api.system_api import manager_router as system_router
from api.telemetry_api import router as telemetry_router
from api.tls_api import router as tls_router
from core import manager_auth, operator_setup, peer_tokens, telemetry, tls_settings
from core.exceptions import register_exception_handlers
from core.logging_setup import configure_logging
from core.manifest import (
    default_project,
    find_project,
    load_manifest,
    migrate_invalid_project_ids,
)
from core.peer_discovery import peer_discovery
from core.project_packer import max_zip_bytes
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
from services.supervisor import supervisor
from starlette.background import BackgroundTask
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
    """Request headers to forward upstream: hop-by-hop dropped, manager cookie stripped."""
    headers: list[tuple[str, str]] = []
    for key, value in request.headers.items():
        if key.lower() in _HOP_BY_HOP:
            continue
        if key.lower() == "cookie":
            value = _strip_manager_cookie(value)
            if not value:
                continue
        headers.append((key, value))
    return headers


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
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
    _proxy_client = httpx.AsyncClient(timeout=httpx.Timeout(connect=5.0, read=None, write=None, pool=5.0))
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
app.include_router(operator_setup_router)
app.include_router(supervisor_router)
app.include_router(projects_router)
app.include_router(system_router)
app.include_router(tls_router)
app.include_router(telemetry_router)

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
# Intended for a local AI client (e.g. Claude Desktop) over loopback (the
# default: ``NEXTHMI_HOST=127.0.0.1``). Per-project ``mcpEnabled`` still gates
# writes at the tool layer, on top of that authentication.
mount_workspace_mcp(app)


# The same project child is served under two verb-first, browser-facing
# prefixes: ``/runtime/<slug>/`` and ``/editor/<slug>/``. Both forward
# themselves as ``X-Forwarded-Prefix`` so the child bakes the right base into
# ``index.html``. (The legacy ``/p/<id>/`` alias was removed — backlog R24/R51.)
_PROXY_PREFIXES = ("runtime", "editor")


# ── auth gate ─────────────────────────────────────────────────────────────────

# Error code on the gate's 401 body. The SPA keys its "manager session expired"
# screen off this so it never mistakes a project-user 401 (a bad write
# credential) for a lost device-admin session.
MANAGER_SESSION_REQUIRED = "manager_session_required"


def _is_gated(path: str) -> bool:
    """True for paths that require a manager session.

    The SPA shell + bundle stay public so the login screen can render; the data
    APIs and the project proxy are gated. Auth endpoints are always public.
    ``/mcp`` is excluded here because it enforces its own session-or-bearer-
    token authentication (``mcp_server.auth``) instead of this cookie gate.
    """
    if (
        path.startswith("/api/manager/auth")
        or path.startswith("/api/manager/peer/")
        or path.startswith("/api/manager/mcp/pair")
        or path == "/api/health"
    ):
        return False
    if path == "/mcp" or path.startswith("/mcp/"):
        return False
    if path.startswith("/api/"):
        return True
    return _is_proxy_path(path)


def _is_proxy_path(path: str) -> bool:
    """True for a browser-facing project-instance path (``/runtime/…``, ``/editor/…``)."""
    return any(path.startswith(f"/{prefix}/") for prefix in _PROXY_PREFIXES)


def safe_sign_in_target(raw: str | None) -> str | None:
    """The ``signIn`` destination to resume after sign-in, or ``None``.

    Only same-origin project-instance paths are honoured, so a crafted link
    cannot turn the manager's sign-in round-trip into an open redirect.
    """
    if not raw or not raw.startswith("/"):
        return None
    if any(char in raw for char in ("\\", "\r", "\n")):
        return None
    return raw if _is_proxy_path(raw.split("?", 1)[0]) else None


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


def _operator_setup_state(project_id: str) -> operator_setup.SetupState | None:
    entry = find_project(load_manifest(), project_id)
    return operator_setup.state(Path(entry.path).expanduser()) if entry is not None else None


@app.middleware("http")
async def _auth_gate(request: Request, call_next):
    if _is_gated(request.url.path) and not _has_valid_session(request.cookies):
        # A browser opening a project URL must land on the manager's sign-in
        # screen; without this it renders the raw 401 body (or, in dev where
        # Vite serves the SPA routes itself, an app whose every fetch 401s).
        # `signIn` carries the destination so the manager can return to it.
        if _is_proxy_path(request.url.path) and _is_document_request(request):
            return RedirectResponse(
                url=f"/?signIn={quote(_full_path(request), safe='')}", status_code=303
            )
        return JSONResponse(
            {"detail": "Authentication required", "code": MANAGER_SESSION_REQUIRED},
            status_code=401,
        )
    if request.method == "POST" and request.url.path == "/api/manager/peer/transfers":
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
            async with asyncio.timeout(660):
                return await call_next(request)
        except TimeoutError:
            return JSONResponse({"detail": "Transfer deadline exceeded"}, status_code=408)
    return await call_next(request)


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


async def _proxy_ws_to_child(websocket: WebSocket, project_id: str) -> None:
    """Bridge a browser WebSocket to the project child's ``/ws``.

    Shared by the ``/runtime/`` and ``/editor/`` prefixes — the child is one
    process per project, so both tunnel to the same upstream socket.
    """
    if not _has_valid_session(websocket.cookies):
        await websocket.close(code=1008)
        return
    setup_state = _operator_setup_state(project_id)
    if setup_state is not None and setup_state.status is not operator_setup.SetupStatus.COMPLETE:
        await websocket.close(code=1008)
        return
    port = supervisor.port_for(project_id)
    if port is None:
        await websocket.close(code=1011)
        return

    import websockets

    await websocket.accept()
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws", max_size=None) as upstream:
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
    await asyncio.gather(*pending, return_exceptions=True)
    with suppress(Exception):
        await upstream.close()


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
    setup_state = _operator_setup_state(project_id)
    if setup_state is not None and setup_state.status is operator_setup.SetupStatus.REQUIRED:
        if request.method == "GET" and not path:
            return RedirectResponse(url=f"/projects?operatorSetup={project_id}", status_code=303)
        return JSONResponse(
            {"detail": "Set this project's operator password in the manager before opening it."},
            status_code=409,
        )
    if setup_state is not None and setup_state.status is operator_setup.SetupStatus.ERROR:
        return JSONResponse(
            {"detail": f"Project credentials are unavailable: {setup_state.error}."},
            status_code=409,
        )

    # The child's loopback reload hook is driven by the manager directly (over
    # the instance port), never through this browser-facing proxy.
    if path == "api/internal" or path.startswith("api/internal/"):
        raise HTTPException(status_code=404)
    reason = _unavailable_reason(project_id)
    if reason is not None and _is_document_request(request):
        return RedirectResponse(
            url=f"/projects?unavailable={project_id}&reason={reason}", status_code=303
        )
    port = _upstream_port_or_503(project_id)
    assert _proxy_client is not None
    url = httpx.URL(
        f"http://127.0.0.1:{port}/{path}",
        query=request.url.query.encode("utf-8"),
    )
    headers = _forwarded_headers(request)
    if forwarded_prefix is not None:
        headers.append(("x-forwarded-prefix", forwarded_prefix))
    body = await request.body()
    upstream_req = _proxy_client.build_request(
        request.method, url, headers=headers, content=body
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
    app.websocket(f"/{_prefix}/{{project_id}}/ws")(_proxy_ws_to_child)
    _register_proxy_routes(_prefix)


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

    _spa_route_start = len(app.router.routes)

    @app.get("/", include_in_schema=False, response_model=None)
    async def _spa_root(request: Request):
        # When an authenticated operator hits the origin root and a default
        # project is up, jump straight to its runtime. Otherwise serve the
        # manager SPA (login screen / project picker), which client-redirects
        # once a default is chosen and running.
        if _has_valid_session(request.cookies):
            # A `signIn` round-trip that arrives already authenticated (the
            # session was established in another tab) resumes its destination
            # instead of being sent to the default project.
            resume = safe_sign_in_target(request.query_params.get("signIn"))
            if resume is not None:
                return RedirectResponse(url=resume, status_code=303)
            entry = default_project(load_manifest())
            if (
                entry is not None
                and operator_setup.state(Path(entry.path).expanduser()).status
                is operator_setup.SetupStatus.COMPLETE
                and supervisor.port_for(entry.id) is not None
            ):
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
