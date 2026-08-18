"""Frozen-binary entry point.

This module is the entry point for PyInstaller-packaged distributions. It
resolves the runtime home, initializes its manifest/default project on first
run, sets the env vars that ``core.storage`` reads at import time, prints a
banner, and starts the manager.

Why this exists as a separate module: ``core.storage`` computes its
module-level path constants the moment it is imported, so any caller that
needs to influence those paths has to do so *before* the first import. The
launcher is the place that runs early enough to do that.

The plain dev workflow (``python start-dev.py``) does **not** go through this
module — it starts uvicorn directly against ``manager:app`` so Vite-on-:5173
keeps working unchanged.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib
import logging
import os
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path


def _prepend_lgpl_path() -> None:
    """Put the bundled ``lgpl/`` directory on ``sys.path`` (release item 1a).

    ``asyncua`` (LGPL-3.0-or-later) and ``zeroconf`` (LGPL-2.1-or-later) ship as
    loose, replaceable package directories under ``lgpl/`` rather than inside
    the frozen PyInstaller archive, so a recipient can substitute their own
    build and relink — the Python analogue of LGPL's shared-library mechanism.
    ``build/nexthmi.spec`` carves them out of the archive and copies them here.

    This runs at module load, ahead of the ``core`` imports below, so the folder
    is on the path before anything can import either package. It is a no-op when
    running from source, where both resolve from ``site-packages`` normally.
    """
    if not getattr(sys, "frozen", False):
        return
    lgpl_dir = Path(sys._MEIPASS) / "lgpl"  # type: ignore[attr-defined]
    if not lgpl_dir.is_dir():
        raise SystemExit(
            "Missing 'lgpl/' folder in the application bundle — reinstall from "
            "the original archive. asyncua and zeroconf ship there, beside the "
            "executable, not inside it."
        )
    entry = str(lgpl_dir)
    if entry not in sys.path:
        sys.path.insert(0, entry)


# Supported CPython range — see README ("Requirements: Python 3.14 (>=3.14.2,
# <3.15)"). asyncua 2.0 (requirements.txt) needs 3.14, and two 3.14 behaviour
# bugs were fixed in-app against >=3.14.2. Enforced in main() (below), not at
# import, so `import launcher` and the test suite stay ungated. The frozen
# artifact always embeds a supported interpreter, so this only bites source
# runs. Dev is NOT exempt: start-dev.py boots the manager via uvicorn (which
# bypasses main()), but the manager spawns every project instance through
# `launcher.py --serve-project` → main() (services/supervisor.py), so an
# unsupported interpreter surfaces as each instance's child exiting code 1
# "during startup" — with this message in that instance's
# <runtime_home>/.logs/instances/<id>/process.log.
_MIN_PYTHON = (3, 14, 2)
_MAX_PYTHON_EXCLUSIVE = (3, 15)


def _require_supported_python() -> None:
    """Refuse to start on an unsupported interpreter (release item 16).

    Raises ``SystemExit`` with a legible message rather than letting the process
    fail deep inside a version-sensitive import. Called from ``main()``, so it
    gates an actual product launch, never a bare ``import launcher``.
    """
    current = sys.version_info[:3]
    if _MIN_PYTHON <= current < _MAX_PYTHON_EXCLUSIVE:
        return
    want = (
        f">={'.'.join(map(str, _MIN_PYTHON))}, "
        f"<{'.'.join(map(str, _MAX_PYTHON_EXCLUSIVE))}"
    )
    have = ".".join(map(str, current))
    raise SystemExit(
        f"NEXT HMI requires Python {want}; this interpreter is {have}. "
        "Install a supported Python (see the README) and retry."
    )


_prepend_lgpl_path()

from core import bootstrap  # noqa: E402  — must follow the lgpl/ path insert above
from core.banner import BannerFields, print_banner  # noqa: E402

logger = logging.getLogger(__name__)


def _resource_path(relative: str) -> Path:
    """Resolve a path bundled inside the frozen executable (``sys._MEIPASS``).

    Falls back to the repo layout when running from source so the same
    launcher script is usable for smoke-testing locally.
    """
    base = getattr(sys, "_MEIPASS", None)
    if base:
        return Path(base) / relative
    # Source layout: <repo>/backend/launcher.py — go up one to repo root.
    return Path(__file__).resolve().parent.parent / relative


def _esbuild_binary_path() -> Path | None:
    """Bundled esbuild binary, if present in the frozen artifact."""
    name = "esbuild.exe" if sys.platform == "win32" else "esbuild"
    candidate = _resource_path(name)
    return candidate if candidate.is_file() else None


def _read_version() -> str:
    """Best-effort version string for the banner; never crashes the launcher.

    Shared with the served index.html so the terminal splash and the browser
    boot splash name the same build.
    """
    from core.version import app_version

    return app_version()


def _processes_on_port(port: int) -> list[tuple[int, str]]:
    """Best-effort list of (pid, process_name) LISTENING on *port*.

    Uses ``netstat -ano`` + ``tasklist`` on Windows and ``lsof`` on
    macOS/Linux. Returns ``[]`` on error rather than raising — a missing
    diagnostic tool should never block startup.
    """
    if sys.platform == "win32":
        try:
            net = subprocess.check_output(
                ["netstat", "-ano"], text=True, stderr=subprocess.DEVNULL
            )
        except Exception:
            return []
        pids: set[int] = set()
        for line in net.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.split()
                with contextlib.suppress(ValueError):
                    pids.add(int(parts[-1]))
        out: list[tuple[int, str]] = []
        for pid in pids:
            name = "unknown"
            try:
                tl = subprocess.check_output(
                    ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                    text=True, stderr=subprocess.DEVNULL,
                )
                first = tl.strip().splitlines()[0] if tl.strip() else ""
                if first.startswith('"'):
                    name = first.split('","')[0].lstrip('"')
            except Exception:
                pass
            out.append((pid, name))
        return out

    try:
        listing = subprocess.check_output(
            ["lsof", f"-iTCP:{port}", "-sTCP:LISTEN", "-P", "-n"],
            text=True, stderr=subprocess.DEVNULL,
        )
    except Exception:
        return []
    out: list[tuple[int, str]] = []
    seen: set[int] = set()
    for line in listing.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            pid = int(parts[1])
        except ValueError:
            continue
        if pid in seen:
            continue
        seen.add(pid)
        out.append((pid, parts[0]))
    return out


def _kill_pid(pid: int) -> bool:
    try:
        if sys.platform == "win32":
            return subprocess.call(
                ["taskkill", "/F", "/PID", str(pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            ) == 0
        os.kill(pid, signal.SIGTERM)
        return True
    except Exception:
        return False


def _wait_port_free(port: int, deadline_sec: float = 5.0) -> bool:
    end = time.monotonic() + deadline_sec
    while time.monotonic() < end:
        if not _processes_on_port(port):
            return True
        time.sleep(0.1)
    return not _processes_on_port(port)


def _port_bindable(host: str, port: int) -> bool:
    """True iff we can actually bind a TCP socket on (host, port) right now.

    ``_processes_on_port`` only sees LISTEN sockets; this catches the rarer
    case where the port is reserved by the OS but no userspace listener shows.
    """
    bind_host = host if host else "0.0.0.0"
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((bind_host, port))
        return True
    except OSError:
        return False


def _next_free_port(host: str, start: int, limit: int = 50) -> int | None:
    for candidate in range(start, start + limit):
        if not _processes_on_port(candidate) and _port_bindable(host, candidate):
            return candidate
    return None


def _resolve_port_conflict(host: str, port: int) -> int | None:
    """Return the port to actually bind on, or ``None`` if the user aborted.

    If *port* is free, returns it unchanged. Otherwise prompts the operator
    for one of: continue with the same port (uvicorn will fail to bind),
    kill the conflicting process, or pick the next free port.
    """
    occupants = _processes_on_port(port)
    if not occupants and _port_bindable(host, port):
        return port

    print()
    print(f"  Port {port} is already in use.")
    if occupants:
        for pid, name in occupants:
            print(f"    - {name} (PID {pid})")
    print()
    print("  [1] Continue anyway (startup will likely fail to bind)")
    print("  [2] Kill the existing process and reuse the port")
    print("  [3] Try the next free port")
    print("  [q] Quit")
    print()

    if not sys.stdin.isatty():
        print("  No interactive terminal; aborting. Set NEXTHMI_PORT to override.")
        return None

    while True:
        try:
            choice = input("  Choose [1/2/3/q]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return None
        if choice in {"1", "continue"}:
            return port
        if choice in {"2", "kill"}:
            for pid, _ in occupants:
                if not _kill_pid(pid):
                    print(f"  Failed to terminate PID {pid}")
            if _wait_port_free(port) and _port_bindable(host, port):
                return port
            print(f"  Port {port} still in use after kill.")
            continue
        if choice in {"3", "next"}:
            nxt = _next_free_port(host, port + 1)
            if nxt is None:
                print(f"  No free port found in range {port + 1}..{port + 50}.")
                continue
            print(f"  Using port {nxt}.")
            return nxt
        if choice in {"q", "quit", "exit"}:
            return None
        print("  Unknown choice — enter 1, 2, 3, or q.")


def _restart_argv() -> list[str]:
    """argv for the re-exec that applies a pending restart sentinel.

    In a frozen (PyInstaller) build, ``sys.executable`` IS ``sys.argv[0]`` —
    the bundled binary, not a python interpreter taking a script path — so
    including argv[0] again here would pass it twice, and argparse rejects
    the stray positional on the way back up.
    """
    return sys.argv[1:] if getattr(sys, "frozen", False) else sys.argv


class TlsConfigError(Exception):
    """Raised when the TLS environment is set but unusable."""


def _resolve_tls(data_dir: Path | None = None) -> dict[str, str]:
    """Uvicorn TLS kwargs; empty dict when the manager should serve plain HTTP.

    ``NEXTHMI_SSL_*`` wins so a deployment with a real CA-issued certificate
    stays in charge; otherwise the operator's own choice in Admin → HTTPS is
    read from the runtime home.

    Certificate and key must be given together, and both must exist before the
    socket is bound — a missing file otherwise surfaces as an ssl stack trace
    on the first request rather than at startup.
    """
    from core import tls_settings

    pinned = tls_settings.env_override()
    if pinned is None:
        # Half-configured is a mistake, not a request for plain HTTP.
        if os.environ.get("NEXTHMI_SSL_CERTFILE") or os.environ.get("NEXTHMI_SSL_KEYFILE"):
            raise TlsConfigError(
                "NEXTHMI_SSL_CERTFILE and NEXTHMI_SSL_KEYFILE must both be set."
            )
        if data_dir is None:
            return {}
        pinned = tls_settings.resolve(data_dir)
        if pinned is None:
            return {}
    missing = tls_settings.missing_files(pinned)
    if missing:
        raise TlsConfigError("TLS file not found: " + ", ".join(missing))

    # Load the pair the way uvicorn will, here, so a mismatched key or a
    # corrupt file (a truncated write from a previous crash, a hand-copied
    # wrong file) is rejected before the socket is bound rather than as an
    # ssl.SSLError out of uvicorn.run() with no handler around it. Mirrors
    # ``tls_settings.install_custom``'s validation for the upload path.
    password = os.environ.get("NEXTHMI_SSL_KEYFILE_PASSWORD")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    try:
        context.load_cert_chain(str(pinned.certfile), str(pinned.keyfile), password or None)
    except ssl.SSLError as exc:
        raise TlsConfigError(
            f"The certificate and private key at {pinned.certfile} could not be loaded "
            f"together — check that they are a matching pair and that the key is not "
            f"passphrase-protected without NEXTHMI_SSL_KEYFILE_PASSWORD set. "
            f"({exc.reason or exc})"
        ) from exc
    except OSError as exc:
        raise TlsConfigError(f"Could not read the TLS certificate or key: {exc}") from exc

    kwargs = {
        "ssl_certfile": str(pinned.certfile),
        "ssl_keyfile": str(pinned.keyfile),
    }
    if password:
        kwargs["ssl_keyfile_password"] = password
    return kwargs


HTTPS_PORT_DEFAULT = 8443


def _redirect_hostname(scope) -> str | None:
    """The host the client asked for, without its port.

    Taken from the ``Host`` header so a device reached by IP, hostname, or
    ``.local`` all redirect to themselves. The header is client-controlled, but
    the only thing it can influence is which host appears in a ``Location`` the
    client already chose to visit — scheme, port, and path are ours.
    """
    for key, value in scope.get("headers", ()):
        if key == b"host":
            raw = value.decode("latin-1").strip()
            if not raw:
                break
            if raw.startswith("["):  # IPv6 literal, e.g. [::1]:8000
                end = raw.find("]")
                return raw if end == -1 else raw[: end + 1]
            return raw.split(":", 1)[0]
    server = scope.get("server")
    return server[0] if server else None


def _https_redirect_app(https_port: int):
    """ASGI app that bounces plain HTTP at the TLS listener.

    Bound on the HTTP port only while TLS is on, so links and bookmarks made
    before HTTPS was enabled keep working instead of dying in a handshake.

    Temporary (307) rather than permanent on purpose: HTTPS here is a toggle,
    and browsers cache a 301 hard enough that turning it back off would strand
    the operator on a port nothing listens on, with no way to undo it from the
    UI. 307 also forbids rewriting the method, so a POST stays a POST.
    """

    async def app(scope, receive, send) -> None:
        if scope["type"] == "websocket":
            # A WebSocket handshake cannot follow a redirect, so there is no
            # honest answer but to close it. The SPA never lands here: its
            # document was already redirected, and it derives ws/wss from the
            # page's own origin.
            await send({"type": "websocket.close", "code": 1008})
            return

        host = _redirect_hostname(scope)
        if host is None:
            await send({
                "type": "http.response.start",
                "status": 400,
                "headers": [(b"content-length", b"0")],
            })
            await send({"type": "http.response.body", "body": b""})
            return

        # raw_path keeps the client's original percent-encoding; scope["path"]
        # is already decoded and would re-encode wrongly.
        raw_path = scope.get("raw_path") or scope["path"].encode("latin-1")
        location = f"https://{host}:{https_port}{raw_path.decode('latin-1')}"
        query = scope.get("query_string") or b""
        if query:
            location += "?" + query.decode("latin-1")

        await send({
            "type": "http.response.start",
            "status": 307,
            "headers": [
                (b"location", location.encode("latin-1")),
                (b"content-length", b"0"),
            ],
        })
        await send({"type": "http.response.body", "body": b""})

    return app


def _start_https_redirector(host: str, port: int, https_port: int):
    """Serve the redirect app on *port* in a background thread.

    Uvicorn only installs signal handlers on the main thread, so the real app
    keeps owning SIGINT/SIGTERM. Returns the server and its thread so the
    caller can stop it before re-execing — the listening socket has to be
    released or the replacement process cannot rebind it.
    """
    import uvicorn

    server = uvicorn.Server(uvicorn.Config(
        _https_redirect_app(https_port),
        host=host,
        port=port,
        log_level="warning",
        access_log=False,
        lifespan="off",
    ))
    thread = threading.Thread(target=server.run, daemon=True, name="https-redirect")
    thread.start()
    return server, thread


@contextlib.contextmanager
def _absorb_uvicorns_signal_reraise():
    """Keep a signal-driven shutdown from killing us before we can restart.

    ``uvicorn.Server.capture_signals`` restores the *previous* handlers and
    then re-raises the signal that stopped it, so with the default disposition
    in place ``uvicorn.run()`` never returns from a SIGTERM — the process dies
    at 128+SIGTERM and the sentinel re-exec below is unreachable. That is how
    ``/api/system/restart`` asks for a restart (``system_api`` SIGTERMs this
    process on purpose), so owning SIGTERM here is what makes the restart
    actually restart rather than shut the device down.

    A SIGTERM that arrives for any other reason still stops the process: the
    serve loop has already unwound by the time this handler is reachable, and
    with no sentinel on disk the caller simply returns.
    """
    previous = signal.signal(signal.SIGTERM, lambda *_: None)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


def _serve(app, host: str, port: int, verbose: bool, **uvicorn_kwargs) -> None:
    import uvicorn

    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="info" if verbose else "warning",
        access_log=verbose,
        **uvicorn_kwargs,
    )


def _run_instance(args: argparse.Namespace) -> int:
    """Instance mode — serve a single project under a URL prefix.

    Spawned by the manager supervisor (``--serve-project``). Binds 127.0.0.1 on
    the supervisor-chosen port; no port-conflict prompt, no banner, and no
    restart re-exec loop — crash recovery is the supervisor's job.
    """
    project_path = Path(args.serve_project).expanduser().resolve()
    # Pin this process to its project (storage binds paths at import time) and
    # record the URL prefix the SPA must use for its API/WebSocket calls.
    os.environ["NEXTHMI_ACTIVE_PROJECT_PATH"] = str(project_path)
    os.environ["NEXTHMI_BASE_PATH"] = args.base_path or "/"

    from core.logging_setup import configure_logging
    configure_logging(verbose=args.verbose)

    app = _load_edition_app("main")

    port = args.port or int(os.environ.get("NEXTHMI_PORT", "8000"))
    logger.info("instance: serving %s on 127.0.0.1:%d (base %s)", project_path, port, args.base_path)

    _serve(app, host="127.0.0.1", port=port, verbose=args.verbose)
    return 0


def _load_edition_app(base: str):
    """Resolve an ASGI app for this edition — ``base`` is "manager" or "main".

    ``NEXTHMI_EDITION`` (default ``oss``) selects the entrypoint module by
    convention — Metabase's ``MB_EDITION`` shape. The ``ee`` entrypoint
    (``<base>_enterprise``) ships only in enterprise builds: it imports the
    core app and mounts the paid modules on top. Nothing in this repository
    imports it, so an oss build cannot reach enterprise code even if the
    variable is set by accident.

    Every name resolved here is invisible to PyInstaller's static scanner,
    including the plain ``oss`` ones: ``build/nexthmi.spec`` carries all four
    (``main``, ``manager``, and per-edition their ``_enterprise`` twins) as
    hidden imports. Renaming an entrypoint means editing the spec too, or the
    frozen binary ships without an application.
    """
    edition = os.environ.get("NEXTHMI_EDITION", "oss")
    if edition == "oss":
        return importlib.import_module(base).app
    if edition != "ee":
        raise SystemExit(f"Unknown NEXTHMI_EDITION '{edition}' — expected 'oss' or 'ee'.")
    entrypoint = f"{base}_enterprise"
    try:
        return importlib.import_module(entrypoint).app
    except ImportError as exc:
        # Only a *missing entrypoint* means "this is an oss build". An
        # ImportError raised from inside it is a broken enterprise install and
        # must surface as itself, not as that message.
        if exc.name != entrypoint:
            raise
        raise SystemExit(
            "NEXTHMI_EDITION=ee but the enterprise entrypoint is not installed. "
            "This is an open-source build; use the enterprise distribution."
        ) from exc


def _load_manager_app():
    return _load_edition_app("manager")


def _run_manager(data_dir: Path, args: argparse.Namespace) -> int:
    """Manager mode (default) — supervisor + reverse proxy front door."""
    from core.logging_setup import configure_logging
    configure_logging(verbose=args.verbose)

    app = _load_manager_app()

    # Loopback by default. The workspace /mcp endpoint authenticates every
    # request (manager session or MCP bearer token, see mcp_server.auth), but
    # without NEXTHMI_SSL_* it's still plain HTTP — binding off-host accepts a
    # trusted-LAN interception risk rather than a silent one. Set
    # NEXTHMI_HOST=0.0.0.0 explicitly to reach the manager dashboard from other
    # machines.
    host = os.environ.get("NEXTHMI_HOST", "127.0.0.1")
    port = args.port or int(os.environ.get("NEXTHMI_PORT", "8000"))

    try:
        tls = _resolve_tls(data_dir)
    except TlsConfigError as exc:
        print(f"  TLS configuration error: {exc}")
        return 1
    # Only the manager terminates TLS. Project children are spawned on loopback
    # and reached over plain HTTP by the in-process proxy, so they must not
    # inherit these.
    serve_kwargs = dict(tls)
    forwarded = os.environ.get("NEXTHMI_FORWARDED_ALLOW_IPS")
    if forwarded:
        serve_kwargs["forwarded_allow_ips"] = forwarded

    from core import tls_settings

    # Record what is actually about to be bound, so the admin endpoint's
    # restart guard can compare the stored setting against reality instead of
    # a request's scheme (which a terminating proxy controls, not us).
    served_fingerprint = None
    if tls and tls_settings.env_override() is None:
        try:
            served = tls_settings.describe(data_dir, tls_settings.mode(data_dir))
        except tls_settings.TlsError:
            served = None
        served_fingerprint = (served or {}).get("fingerprint")
    tls_settings.mark_served(bool(tls), served_fingerprint)

    expiry_warning = tls_settings.log_expiry_warning(data_dir)

    # NEXTHMI_PORT is the HTTP port whether or not TLS is on, so it stays
    # stable across the re-exec below. Turning HTTPS on in Settings moves the
    # app to the HTTPS port and leaves the HTTP port answering with redirects,
    # so the links made before the switch still land somewhere.
    #
    # Certificates pinned through NEXTHMI_SSL_* are the exception: that
    # deployment has served HTTPS on NEXTHMI_PORT since its first boot, there is
    # no toggle and so no earlier plain-HTTP link to preserve, and moving the
    # port under it would break the operator's own published mapping.
    split_ports = bool(tls) and tls_settings.env_override() is None
    https_port = args.https_port or int(
        os.environ.get("NEXTHMI_HTTPS_PORT", str(HTTPS_PORT_DEFAULT))
    )
    if split_ports and https_port == port:
        print(f"  The HTTP and HTTPS ports are both {port}; they must differ.")
        return 1

    resolved = _resolve_port_conflict(host, port)
    if resolved is None:
        print("  Aborted.")
        return 1
    port = resolved
    os.environ["NEXTHMI_PORT"] = str(port)

    if split_ports:
        resolved_https = _resolve_port_conflict(host, https_port)
        if resolved_https is None:
            print("  Aborted.")
            return 1
        https_port = resolved_https

    if tls and not split_ports:
        # Pinned to one port; its absence is how peer discovery knows the HTTP
        # port is the one actually serving TLS.
        os.environ.pop("NEXTHMI_HTTPS_PORT", None)
    else:
        # Exported while serving plain HTTP too: Settings → HTTPS has to tell
        # the operator's page where enabling it will move the app *before* the
        # move, or the page reopens itself on a port that by then only redirects.
        os.environ["NEXTHMI_HTTPS_PORT"] = str(https_port)

    app_port = https_port if split_ports else port
    scheme = "https" if tls else "http"
    open_host = "127.0.0.1" if host in {"0.0.0.0", ""} else host
    open_url = f"{scheme}://{open_host}:{app_port}"
    print_banner(
        "runtime",
        BannerFields(
            runtime_home=data_dir,
            open_url=open_url,
            version=_read_version(),
        ),
    )
    redirector = redirector_thread = None
    if split_ports:
        redirector, redirector_thread = _start_https_redirector(host, port, https_port)
        print(f"  http://{open_host}:{port} redirects here.")
        print()
    if expiry_warning is not None:
        print(f"  {expiry_warning}")
        print()

    from core import runtime_home

    with _absorb_uvicorns_signal_reraise():
        _serve(app, host=host, port=app_port, verbose=args.verbose, **serve_kwargs)

    if redirector is not None:
        redirector.should_exit = True
        redirector_thread.join(timeout=5.0)

    # Self-restart loop: the manager's device-level /api/system/restart leaves a
    # sentinel behind on clean exit. Re-exec a fresh interpreter so static
    # mounts re-resolve.
    sentinel = runtime_home.restart_sentinel_path()
    if sentinel.exists():
        with contextlib.suppress(OSError):
            sentinel.unlink()
        logger.info("Restart sentinel present — re-executing launcher")
        os.execv(sys.executable, [sys.executable, *_restart_argv()])
    return 0


def main(argv: list[str] | None = None) -> int:
    _require_supported_python()
    parser = argparse.ArgumentParser(
        prog="nexthmi",
        description="NEXT HMI portable runtime",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Stream INFO logs to the terminal (default: WARNING+ only).",
    )
    parser.add_argument(
        "--serve-project",
        help="Instance mode: serve the project at this path (used by the manager supervisor).",
    )
    parser.add_argument(
        "--project-id",
        help="Instance mode: project id (build/log isolation; informational).",
    )
    parser.add_argument(
        "--base-path",
        default="/",
        help="Instance mode: URL prefix this instance is served under (e.g. /runtime/<slug>/).",
    )
    parser.add_argument(
        "--port",
        type=int,
        help="HTTP port to bind (instance mode: required; manager mode: overrides NEXTHMI_PORT).",
    )
    parser.add_argument(
        "--https-port",
        type=int,
        help=(
            "Port the app binds when HTTPS is enabled; the HTTP port then only "
            f"redirects here (default {HTTPS_PORT_DEFAULT}, overrides NEXTHMI_HTTPS_PORT)."
        ),
    )
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    data_dir, source = bootstrap.resolve_data_dir()
    data_dir = data_dir.expanduser().resolve()

    # Persist the chosen path on first run so subsequent launches are explicit.
    # Docker (source == "env") skips this — the env var is the source of truth.
    if source == "default":
        bootstrap.ensure_bootstrap_seeded(data_dir)

    os.environ["NEXTHMI_DATA_DIR"] = str(data_dir)
    # Tell the admin endpoint that *we* set NEXTHMI_DATA_DIR (so it isn't
    # rendered read-only). When the user shell-exported NEXTHMI_DATA_DIR
    # themselves (source == "env"), we leave the flag unset — that case is
    # indistinguishable from Docker, and bootstrap-file edits wouldn't take
    # effect anyway since the env var keeps winning on the next launch.
    if source != "env":
        os.environ["NEXTHMI_DATA_DIR_SOURCE"] = source
    os.environ.setdefault("NEXTHMI_WIDGET_BUILD_DIR", str(data_dir / ".widget-build"))

    frontend_dist = _resource_path("frontend/dist")
    if frontend_dist.is_dir():
        os.environ.setdefault("NEXTHMI_FRONTEND_DIST", str(frontend_dist))

    esbuild = _esbuild_binary_path()
    if esbuild is not None:
        os.environ.setdefault("ESBUILD_BINARY_PATH", str(esbuild))

    if args.serve_project:
        return _run_instance(args)
    return _run_manager(data_dir, args)


if __name__ == "__main__":
    raise SystemExit(main())
