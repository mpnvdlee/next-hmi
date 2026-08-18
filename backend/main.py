import asyncio
import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from api.alarm_api import router as alarm_router
from api.component_api import router as component_router
from api.config_api import router as config_router
from api.datasource_api import router as datasource_router
from api.device_api import router as device_router
from api.historian_api import router as historian_router
from api.http_source_api import router as http_source_router
from api.internal_api import router as internal_router
from api.projects_api import router as projects_router
from api.recipe_api import router as recipe_router
from api.system_api import router as system_router
from api.theme_api import router as theme_router
from api.users_api import router as users_router
from api.widgets_api import router as widgets_router
from core import project_bootstrap
from core.exceptions import register_exception_handlers
from core.logging_setup import configure_logging
from core.project_migrations import run_baseline_migration
from core.storage import (
    WIDGET_BUILD_DIR,
    active_assets_dir,
    active_custom_widgets_dir,
    active_external_libraries_dir,
    active_project_root,
    ensure_active_project_dirs,
    repo_root,
)
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from opcua import opcua_pool, test_server_pool
from services import frontend_serve, users_manager, widget_compiler
from services.alarm_manager import alarm_manager
from services.component_manager import component_manager
from services.datasource_manager import datasource_manager
from services.historian_manager import historian_manager
from services.recipe_manager import recipe_manager
from services.websocket_manager import websocket_manager
from starlette.websockets import WebSocketState

# Instance mode: this process is a project child spawned by the manager and
# served under a URL prefix (``NEXTHMI_BASE_PATH``, e.g. ``/runtime/<slug>/``).
# Drives base-path injection into the SPA and disables manager-owned concerns
# (mDNS peer discovery). Unset in dev / direct ``uvicorn main:app`` → base "/"
# at root.
_BASE_PATH = os.environ.get("NEXTHMI_BASE_PATH", "/")
_INSTANCE_MODE = _BASE_PATH != "/"

# ── Datasource wiring ───────────────────────────────────────────────────────
datasource_manager.set_enqueue_callback(websocket_manager.enqueue)
websocket_manager.set_datasource_manager(datasource_manager)
websocket_manager.set_opcua_pool(opcua_pool)
opcua_pool.set_datasource_manager(datasource_manager)
opcua_pool.set_status_callback(websocket_manager.broadcast_opcua_status)
opcua_pool.set_priority_recompute_callback(websocket_manager.recompute_priority_subscriptions)

websocket_manager.set_alarm_manager(alarm_manager)
datasource_manager.register_value_listener(alarm_manager.on_variable_change)

# Historian wiring lets the websocket manager fold historized variables into the
# fast subscription set so enabling historization actually captures values.
websocket_manager.set_historian_manager(historian_manager)

# Recipe manager shares the write_service path for downloads and folds parameter
# variables into the fast subscription set so Upload / parametersChanged see
# fresh live values.
websocket_manager.set_recipe_manager(recipe_manager)
recipe_manager.set_datasource_manager(datasource_manager)
recipe_manager.set_opcua_pool(opcua_pool)

# Captured at startup in lifespan(); used by sync route handlers to schedule coroutines.
_event_loop: asyncio.AbstractEventLoop | None = None


def _schedule_alarm_broadcast(payload: dict) -> None:
    """Bridge sync alarm_manager broadcasts into the async event loop.

    ack_alarm() is called from a sync FastAPI route which runs in a thread
    pool executor — asyncio.get_running_loop() raises RuntimeError there.
    We capture the loop at startup and use call_soon_threadsafe instead.
    """
    if _event_loop is None or _event_loop.is_closed():
        return
    _event_loop.call_soon_threadsafe(
        _event_loop.create_task,
        websocket_manager.broadcast_alarm_update(payload),
    )


def _schedule_alarm_priority_recompute() -> None:
    """Bridge sync alarm_manager config saves into a background recompute.

    set_config()/apply_config() may run in a thread-pool executor (sync route
    or MCP writer) where asyncio.get_running_loop() raises; use the loop
    captured at startup with call_soon_threadsafe, same as
    _schedule_alarm_broadcast. The coalescing itself lives in
    websocket_manager.schedule_priority_recompute() since it already owns
    recompute_priority_subscriptions().
    """
    if _event_loop is None or _event_loop.is_closed():
        return
    _event_loop.call_soon_threadsafe(websocket_manager.schedule_priority_recompute)


alarm_manager.set_broadcast_callback(_schedule_alarm_broadcast)
alarm_manager.set_recompute_callback(_schedule_alarm_priority_recompute)


def _schedule_recipe_broadcast(payload: dict) -> None:
    """Bridge sync recipe_manager broadcasts into the async event loop.

    download()/upload()/set_config() may run in a thread-pool executor (sync
    routes) where asyncio.get_running_loop() raises; use the loop captured at
    startup with call_soon_threadsafe instead.
    """
    if _event_loop is None or _event_loop.is_closed():
        return
    _event_loop.call_soon_threadsafe(
        _event_loop.create_task,
        websocket_manager.broadcast_recipe_update(payload),
    )


recipe_manager.set_broadcast_callback(_schedule_recipe_broadcast)

# Wire pool references into the API module
from api.datasource_api import set_opcua_pool, set_test_server_pool  # noqa: E402
from api.system_api import set_opcua_pool as set_sys_opcua_pool  # noqa: E402

set_opcua_pool(opcua_pool)
set_sys_opcua_pool(opcua_pool)
test_server_pool.set_opcua_pool(opcua_pool)
test_server_pool.set_datasource_manager(datasource_manager)
set_test_server_pool(test_server_pool)

def _run_validation_sweep() -> None:
    if os.getenv("NEXTHMI_VALIDATION_SWEEP", "on").lower() not in {"on", "true", "1"}:
        return
    log = logging.getLogger("nexthmi.validation_sweep")
    try:
        from core.storage import active_pages_dir, read_json
        from core.validation import build_context, validate_page
    except Exception as exc:
        log.warning("validation sweep skipped: %s", exc)
        return
    pages_dir = active_pages_dir()
    if not pages_dir.exists():
        return
    ctx = build_context()
    findings_total = 0
    for path in pages_dir.glob("*.json"):
        if path.stem.startswith("__"):
            continue
        try:
            page = read_json(path)
        except Exception as exc:
            log.warning("validation sweep: failed to read %s: %s", path.name, exc)
            continue
        report = validate_page(page, ctx)
        if not report.ok:
            findings_total += len(report.findings)
            log.warning(
                "validation sweep: %s has %d findings — %s",
                path.name,
                len(report.findings),
                report.to_message(),
            )
    if findings_total:
        log.warning("validation sweep: %d total findings", findings_total)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # No-op when the launcher already configured logging; idempotent setup
    # so dev (uvicorn --reload) and Docker (uvicorn directly) also get the
    # rotating file handler at LOGS_DIR/nexthmi.log.
    configure_logging()
    ensure_active_project_dirs()
    # Check (and stamp) the live project's on-disk format before anything
    # reads it — datasource_manager.load_all() below assumes the current
    # baseline, and a project stamped newer than this build is rejected here.
    run_baseline_migration(active_project_root())
    users_manager.load_or_create()
    alarm_manager.load()
    recipe_manager.load()
    component_manager.load()
    # Capture the running event loop so sync route handlers can schedule coroutines.
    global _event_loop
    _event_loop = asyncio.get_running_loop()
    datasource_manager.load_all()
    # Historian startup runs AFTER datasource_manager.load_all() so its
    # value-listener sees a fully-initialised core, but BEFORE
    # widget_compiler.compile_all() (which can take seconds on big projects) —
    # so the historian manager is in place before the ASGI app starts accepting
    # requests in any deployment.
    try:
        await historian_manager.start()
    except Exception:
        logging.getLogger(__name__).exception("Historian startup error")
    # Custom-widget compile + schema-manifest generation. Runs before the
    # broadcast loop starts so the very first /ws connection sees a consistent
    # widget-build/ + widget-schemas.json. Failures per-widget are isolated
    # and recorded in .build-status.json — lifespan never aborts on them.
    await widget_compiler.compile_all()
    widget_compiler.regenerate_widget_schemas()
    # Sweep is advisory: log findings but don't block first-request readiness.
    # On a project with hundreds of pages the synchronous form delays OPC-UA
    # pool startup; offload to a thread and let lifespan continue.
    sweep_task = asyncio.create_task(asyncio.to_thread(_run_validation_sweep))
    await test_server_pool.start_all(datasource_manager)
    await opcua_pool.start_all(datasource_manager)
    broadcast_task = asyncio.create_task(websocket_manager.broadcast_loop())
    watcher_task = asyncio.create_task(
        widget_compiler.start_watcher(websocket_manager.broadcast_widget_updated)
    )
    # MCP is no longer served by the child: the manager hosts the single
    # multi-project workspace endpoint at its own /mcp and notifies this child
    # over the loopback reload hook (see api/internal_api). Agent edits reach
    # open browsers through the normal config_changed broadcast path.
    yield
    broadcast_task.cancel()
    watcher_task.cancel()
    sweep_task.cancel()
    with suppress(asyncio.CancelledError):
        await broadcast_task
    with suppress(asyncio.CancelledError):
        await watcher_task
    with suppress(asyncio.CancelledError, Exception):
        await sweep_task
    try:
        await historian_manager.stop()
    except Exception:
        logging.getLogger(__name__).exception("Historian shutdown error")
    await opcua_pool.stop_all()
    await test_server_pool.stop_all()


app = FastAPI(title="NEXT HMI", lifespan=lifespan)
register_exception_handlers(app)


# NOTE: every top-level route lives under one of /api/, /ws, /mcp, or a
# /widgets, /widget-js, /stdlib-js, /external-libraries, /assets, /_app static mount.
# When adding a new top-level route or mount outside those prefixes, also
# add its first path segment to ``_SPA_EXCLUDED_SEGMENTS`` below — otherwise
# the SPA catch-all will swallow it and return index.html for a typo'd URL.
app.include_router(config_router)
app.include_router(datasource_router)
app.include_router(alarm_router)
app.include_router(recipe_router)
app.include_router(device_router)
app.include_router(system_router)
app.include_router(users_router)
app.include_router(widgets_router)
app.include_router(theme_router)
app.include_router(component_router)
app.include_router(projects_router)
# Loopback-only reload hook the manager calls after a workspace MCP write.
app.include_router(internal_router)
app.include_router(historian_router)
app.include_router(http_source_router)

# Static mounts for live-project content. ``follow_symlink=False`` prevents a
# symlink in user-controlled content (e.g. ``ln -s / mylib`` inside
# external-libraries/) from exposing the host filesystem. Bootstrap a default
# project first so the mount directories exist before Starlette resolves them,
# and self-pin NEXTHMI_ACTIVE_PROJECT_PATH so storage.py resolves it the same
# way a supervisor-pinned instance does. Skipped in instance mode — the
# supervisor already pinned this process to a project via that env var, so
# bootstrapping would only pollute the shared manifest with a duplicate
# default entry.
if not _INSTANCE_MODE and not os.environ.get("NEXTHMI_ACTIVE_PROJECT_PATH"):
    _default_entry = project_bootstrap.ensure_default_project()
    os.environ["NEXTHMI_ACTIVE_PROJECT_PATH"] = _default_entry.path
_widgets_dir = active_custom_widgets_dir()
_widgets_dir.mkdir(parents=True, exist_ok=True)
app.mount("/widgets", StaticFiles(directory=str(_widgets_dir), follow_symlink=False), name="widgets")

_widget_build_dir = WIDGET_BUILD_DIR
_widget_build_dir.mkdir(parents=True, exist_ok=True)
app.mount("/widget-js", StaticFiles(directory=str(_widget_build_dir), follow_symlink=False), name="widget-js")

# Product stdlib widgets: compiled at build time and shipped with the frontend,
# unlike /widget-js which is project content compiled on load. Served here rather
# than from Vite's public/ dir because Vite appends `?import` to every dynamic
# import (`__vite__injectQuery`, which `@vite-ignore` does not suppress) and then
# 500s on a path it owns itself. Behind the same proxy hop /widget-js already
# takes, a StaticFiles mount simply ignores the query.
_stdlib_dist_env = os.environ.get("NEXTHMI_FRONTEND_DIST")
_stdlib_js_dir = (
    Path(_stdlib_dist_env).resolve() / "stdlib-js"
    if _stdlib_dist_env
    else repo_root() / "frontend" / "public" / "stdlib-js"
)
# Created, not probed: `npm run dev` runs `build:stdlib` while this module is
# already importing, so a mount guarded on the directory existing loses the race
# on a fresh clone and every stdlib module 404s until the backend is restarted.
# An empty directory 404s per file instead, and starts serving the moment
# esbuild fills it.
_stdlib_js_dir.mkdir(parents=True, exist_ok=True)
app.mount("/stdlib-js", StaticFiles(directory=str(_stdlib_js_dir), follow_symlink=False), name="stdlib-js")

_external_libraries_dir = active_external_libraries_dir()
_external_libraries_dir.mkdir(parents=True, exist_ok=True)
app.mount("/external-libraries", StaticFiles(directory=str(_external_libraries_dir), follow_symlink=False), name="external-libraries")

_assets_dir = active_assets_dir()
_assets_dir.mkdir(parents=True, exist_ok=True)
app.mount("/assets", StaticFiles(directory=str(_assets_dir), follow_symlink=False), name="assets")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    try:
        client_id = await websocket_manager.connect(websocket)
    except WebSocketDisconnect:
        return

    try:
        while True:
            raw = await websocket.receive_text()
            await websocket_manager.handle_message(client_id, raw)
    except WebSocketDisconnect:
        await websocket_manager.disconnect(client_id)
    except RuntimeError as exc:
        # Race with a concurrent broadcast: a send-side OSError flips
        # application_state to DISCONNECTED before this loop's next
        # receive_text() consumes the websocket.disconnect ASGI message,
        # so starlette raises "WebSocket is not connected" instead of
        # WebSocketDisconnect. State is the discriminator — if the socket
        # is still CONNECTED the RuntimeError is a real bug, not the race.
        await websocket_manager.disconnect(client_id)
        if websocket.application_state == WebSocketState.CONNECTED:
            raise
        logging.getLogger(__name__).warning(
            "websocket loop RuntimeError swallowed: %s", exc
        )
    except Exception:
        await websocket_manager.disconnect(client_id)
        raise


# ── SPA serving (production runtime only) ───────────────────────────────────
# Mounted iff NEXTHMI_FRONTEND_DIST is set. In dev the env var is unset and
# Vite serves the SPA on :5173 with /api proxied to the backend — none of the
# routes below register. The catch-all is registered LAST so explicit API
# routes, websocket, and static mounts win on path-prefix collisions.


class _SpaLastRoutes(list):
    """Route list that keeps the SPA catch-all pinned at the end.

    Starlette matches in registration order, so anything appended after the
    catch-all is shadowed by it. Modules that wrap this app import ``app`` and
    only then ``include_router()`` (``launcher._load_edition_app`` imports one
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
    # Resolve once at import so the traversal check below compares against a
    # stable canonical path even if the dist dir is replaced (atomic rename
    # during an upgrade) or moved under a symlink at runtime.
    _frontend_dist = Path(_frontend_dist_env).resolve()
    _app_assets_dir = _frontend_dist / "_app"
    if _app_assets_dir.is_dir():
        # Hashed SPA bundle output — `/_app/*` matches the assetsDir set in
        # frontend/vite.config.ts.
        app.mount(
            "/_app",
            StaticFiles(directory=str(_app_assets_dir), follow_symlink=False),
            name="spa-bundle",
        )

    # Override file is optional; default location is the live project's
    # folder root (parent of external-libraries/).
    _external_modules_override = active_external_libraries_dir().parent / "external-modules.json"

    # Path segments that already have a handler upstream; the catch-all must
    # NOT shadow them with index.html (otherwise misspelled API calls and
    # missing assets would silently return HTML and the JSON parser would
    # explode in the browser — a very confusing failure mode).
    _SPA_EXCLUDED_SEGMENTS = (
        "api",
        "ws",
        "_app",
        "widgets",
        "widget-js",
        "stdlib-js",
        "external-libraries",
        "assets",
        "docs",
        "openapi.json",
        "redoc",
        "mcp",
    )

    def _resolve_base_path(request: Request) -> str:
        # The manager's /runtime/<id>/ and /editor/<id>/ proxy aliases set
        # X-Forwarded-Prefix so this one child serves both areas with the right
        # router basename + asset prefix baked into index.html. Without the
        # header (e.g. a direct hit on the child's own port) fall back to the
        # spawn-time base.
        return request.headers.get("x-forwarded-prefix") or _BASE_PATH

    _spa_route_start = len(app.router.routes)

    @app.get("/", include_in_schema=False)
    async def _spa_root(request: Request) -> HTMLResponse:
        return HTMLResponse(
            frontend_serve.render_index_html(
                _frontend_dist,
                active_external_libraries_dir(),
                _external_modules_override,
                base_path=_resolve_base_path(request),
                mode="instance",
            )
        )

    @app.get("/{path:path}", include_in_schema=False, response_model=None)
    async def _spa_fallback(path: str, request: Request) -> FileResponse | HTMLResponse:
        # Excluded segments 404 here so a typo'd /api/foo doesn't return
        # index.html (which would parse as garbage JSON client-side). Match
        # full segments (``path == seg`` or ``path.startswith(seg + "/")``)
        # so ``/openapi.json.bak`` or ``/mcpalt`` aren't accidentally swallowed.
        first_segment = path.split("/", 1)[0]
        if first_segment in _SPA_EXCLUDED_SEGMENTS:
            raise HTTPException(status_code=404)
        # Public files copied to dist root by Vite (fonts/*, project assets, etc.).
        # Validate the resolved path stays inside dist_dir to avoid traversal.
        candidate = (_frontend_dist / path).resolve()
        try:
            candidate.relative_to(_frontend_dist)
        except ValueError:
            raise HTTPException(status_code=404) from None
        if candidate.is_file():
            return FileResponse(candidate)
        # Anything else is a React Router path — return the templated SPA.
        return HTMLResponse(
            frontend_serve.render_index_html(
                _frontend_dist,
                active_external_libraries_dir(),
                _external_modules_override,
                base_path=_resolve_base_path(request),
                mode="instance",
            )
        )

    app.router.routes = _SpaLastRoutes(
        app.router.routes, app.router.routes[_spa_route_start:]
    )
