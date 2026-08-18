"""
start-dev.py — Start / restart the NEXT HMI dev environment.

Usage:
    python start-dev.py             # kill any running instances, then start both
                                    # (child output streamed to the terminal)
    python start-dev.py --stop      # only stop running instances
    python start-dev.py --start     # only start (does not kill first)
    python start-dev.py --quiet     # discard child stdout; rely on nexthmi.log
    python start-dev.py --edition ee  # serve manager_enterprise:app instead of
                                       # manager:app, and build the frontend
                                       # against the enterprise @enterprise
                                       # registry. Requires enterprise/ (see D6
                                       # in docs/operations/monetization-model.md).
"""

import argparse
import contextlib
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).parent
BACKEND_DIR = ROOT / "backend"
FRONTEND_DIR = ROOT / "frontend"
ENTERPRISE_DIR = ROOT / "enterprise"
ENTERPRISE_BACKEND_DIR = ENTERPRISE_DIR / "backend"
IS_WINDOWS = sys.platform.startswith("win")
VENV_PYTHON = (
    ROOT / ".venv" / "Scripts" / "python.exe"
    if IS_WINDOWS
    else ROOT / ".venv" / "bin" / "python"
)

BACKEND_PORT = 8000
FRONTEND_PORT = 5173

# Make `backend/` importable so we can share the banner module with launcher.py.
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
from core import runtime_home, tls_settings  # noqa: E402
from core.banner import BannerFields, print_banner  # noqa: E402


def pids_on_port(port: int) -> list[int]:
    """Return PIDs listening on *port*."""
    if IS_WINDOWS:
        try:
            out = subprocess.check_output(
                ["netstat", "-ano"], text=True, stderr=subprocess.DEVNULL
            )
        except Exception:
            return []
        pids: list[int] = []
        for line in out.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.split()
                try:
                    pids.append(int(parts[-1]))
                except ValueError:
                    pass
        return list(set(pids))

    try:
        out = subprocess.check_output(
            ["lsof", "-tiTCP:%d" % port, "-sTCP:LISTEN"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return []

    pids: list[int] = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            pids.append(int(line))
        except ValueError:
            pass
    return list(set(pids))


def kill_port(port: int) -> None:
    pids = pids_on_port(port)
    if not pids:
        return
    for pid in pids:
        if IS_WINDOWS:
            subprocess.call(
                ["taskkill", "/F", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except PermissionError:
                pass


def stop() -> None:
    kill_port(BACKEND_PORT)
    kill_port(FRONTEND_PORT)
    # Best-effort: terminate any project instance children the manager spawned.
    # They listen on ephemeral 127.0.0.1 ports (not the fixed ones above), so the
    # manager's graceful shutdown normally reaps them — this is a safety net for
    # a hard kill that skipped lifespan teardown.
    if not IS_WINDOWS:
        subprocess.call(
            ["pkill", "-f", "launcher.py --serve-project"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    # Wait until both ports are free (up to 5 s) before returning.
    deadline = time.monotonic() + 5.0
    ports = {BACKEND_PORT: "backend", FRONTEND_PORT: "frontend"}
    while ports and time.monotonic() < deadline:
        time.sleep(0.1)
        for port in list(ports):
            if not pids_on_port(port):
                del ports[port]
    for port, label in ports.items():
        print(f"  WARNING: {label} port {port} still in use after stop")


def _pipe_output(proc: subprocess.Popen, prefix: str) -> None:
    """Forward *proc* stdout to the current terminal, prefixing each line."""
    assert proc.stdout is not None
    for raw in proc.stdout:
        try:
            line = raw.decode(errors="replace").rstrip()
        except Exception:
            line = repr(raw)
        print(f"[{prefix}] {line}", flush=True)


def _check_enterprise() -> None:
    """Validate enterprise/ is present and wired before spawning ee processes.

    Mirrors build/build-binary.sh's check. enterprise/ is a gitignored symlink
    to a peer checkout of the private nexthmi-enterprise repo (D6) — nothing
    here creates the checkout itself, only the one-time node_modules link a
    package.json-less tree needs to resolve react.
    """
    if not (ENTERPRISE_BACKEND_DIR / "manager_enterprise.py").is_file():
        sys.exit(
            f"--edition ee but {ENTERPRISE_BACKEND_DIR}/manager_enterprise.py is "
            "missing — symlink enterprise/ to a checkout of the private "
            "nexthmi-enterprise repo (see docs/operations/monetization-model.md, "
            "decision D6)."
        )
    if not (ENTERPRISE_DIR / "frontend" / "registry.ts").is_file():
        sys.exit(f"--edition ee but {ENTERPRISE_DIR}/frontend/registry.ts is missing.")
    enterprise_modules = ENTERPRISE_DIR / "node_modules"
    if not enterprise_modules.is_dir():
        # Absolute target: enterprise/ is itself a symlink to a peer checkout,
        # so a relative "../frontend/node_modules" would resolve against that
        # peer directory instead of this repo (see build-binary.sh).
        target = FRONTEND_DIR / "node_modules"
        if not target.is_dir():
            sys.exit(f"--edition ee needs {target} — run `npm install` in frontend/ first.")
        if enterprise_modules.is_symlink():
            enterprise_modules.unlink()
        enterprise_modules.symlink_to(target, target_is_directory=True)
        print(f"[dev] linked {enterprise_modules} -> {target}", flush=True)


def _resolve_tls() -> tls_settings.TlsPaths | None:
    """The certificate pair Settings → HTTPS manages, or None for plain HTTP.

    Same resolution the launcher does, so a device that serves HTTPS as a
    binary serves it in dev too — otherwise the toggle silently does nothing
    here and the developer chases a connection reset on :5173.
    """
    try:
        return tls_settings.resolve(runtime_home.runtime_home_path())
    except Exception as exc:
        print(f"  WARNING: TLS is enabled but unusable ({exc}) — serving plain HTTP")
        return None


def _spawn_backend(
    python_exe: str, *, quiet: bool, tls: tls_settings.TlsPaths | None, edition: str
) -> subprocess.Popen:
    # The manager app (supervisor + reverse proxy). It spawns one child backend
    # per running project; Vite proxies /p/<id>/* to the manager (see
    # frontend/vite.config.ts). Open the FRONTEND URL — the SPA renders the
    # manager dashboard at the root and proxied project instances under /p/<id>/.
    # Loopback only: the workspace /mcp endpoint is unauthenticated, so the host
    # binding is its security boundary (see backend/manager.py mount comment).
    module = "manager_enterprise:app" if edition == "ee" else "manager:app"
    backend_cmd = [
        python_exe, "-m", "uvicorn", module, "--reload",
        "--host", "127.0.0.1", "--port", str(BACKEND_PORT),
    ]
    env = dict(os.environ)
    env["NEXTHMI_EDITION"] = edition
    if edition == "ee":
        # manager_enterprise.py lives outside backend/ (cwd), so it needs its
        # own entry on the import path. --reload-dir: by default uvicorn only
        # watches cwd, so editing enterprise/backend/ wouldn't trigger a reload.
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = (
            f"{ENTERPRISE_BACKEND_DIR}{os.pathsep}{existing}" if existing
            else str(ENTERPRISE_BACKEND_DIR)
        )
        backend_cmd += [
            "--reload-dir", str(BACKEND_DIR),
            "--reload-dir", str(ENTERPRISE_BACKEND_DIR),
        ]
    if tls is not None:
        backend_cmd += [
            "--ssl-certfile", str(tls.certfile),
            "--ssl-keyfile", str(tls.keyfile),
        ]
        password = os.environ.get("NEXTHMI_SSL_KEYFILE_PASSWORD")
        if password:
            backend_cmd += ["--ssl-keyfile-password", password]
        # Only we know what this listener binds — see manager.lifespan.
        env["NEXTHMI_DEV_TLS_SERVED"] = "1"
    else:
        env.pop("NEXTHMI_DEV_TLS_SERVED", None)

    if quiet:
        proc = subprocess.Popen(
            backend_cmd, cwd=BACKEND_DIR, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    else:
        proc = subprocess.Popen(
            backend_cmd, cwd=BACKEND_DIR, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        threading.Thread(target=_pipe_output, args=(proc, "backend"), daemon=True).start()
    return proc


def _spawn_frontend(
    *, quiet: bool, tls: tls_settings.TlsPaths | None, edition: str
) -> subprocess.Popen:
    # Vite serves the URL the developer actually opens, so it needs the same
    # pair the backend binds with — its own listener and its proxy target are
    # both fixed at startup. Deliberately NOT the NEXTHMI_SSL_* names the
    # backend reads: those mean "externally pinned" and would render
    # Settings → HTTPS read-only.
    env = dict(os.environ)
    # Read by vite.config.ts's enterpriseRegistry() to pick the @enterprise
    # alias target — the empty core stub for oss, enterprise/frontend/registry.ts
    # for ee.
    env["NEXTHMI_EDITION"] = edition
    if tls is not None:
        env["NEXTHMI_DEV_TLS_CERT"] = str(tls.certfile)
        env["NEXTHMI_DEV_TLS_KEY"] = str(tls.keyfile)
    else:
        env.pop("NEXTHMI_DEV_TLS_CERT", None)
        env.pop("NEXTHMI_DEV_TLS_KEY", None)

    frontend_cmd = ["npm.cmd" if IS_WINDOWS else "npm", "run", "dev"]
    # npm is a shim that execs Vite as a grandchild and does not forward
    # SIGTERM to it, so terminating the npm process alone orphans a Vite still
    # holding :5173. Its own process group makes the whole tree killable — see
    # _terminate_frontend.
    group = {"start_new_session": True} if not IS_WINDOWS else {}
    if quiet:
        return subprocess.Popen(
            frontend_cmd, cwd=FRONTEND_DIR, env=env, **group,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    proc = subprocess.Popen(
        frontend_cmd, cwd=FRONTEND_DIR, env=env, **group,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    threading.Thread(target=_pipe_output, args=(proc, "frontend"), daemon=True).start()
    return proc


def _terminate_frontend(proc: subprocess.Popen) -> None:
    """Stop Vite and everything npm spawned under it.

    An orphaned Vite keeps :5173 bound, so the replacement silently lands on
    :5174 while the browser still talks to the old one — with the old proxy
    target and the old protocol.
    """
    if not IS_WINDOWS:
        with contextlib.suppress(OSError, ProcessLookupError):
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    # Backstop for anything that outlived its parent (npm.cmd on Windows has no
    # process group to kill): the port is what actually has to be free.
    kill_port(FRONTEND_PORT)
    deadline = time.monotonic() + 5.0
    while pids_on_port(FRONTEND_PORT) and time.monotonic() < deadline:
        time.sleep(0.1)


def _consume_restart_sentinel() -> bool:
    """Return True (and remove the file) iff a restart was requested."""
    path = runtime_home.restart_sentinel_path()
    if not path.exists():
        return False
    try:
        path.unlink()
    except OSError:
        pass
    return True


def start(*, quiet: bool, edition: str) -> None:
    if edition == "ee":
        _check_enterprise()
    python_exe = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable
    tls = _resolve_tls()

    frontend_proc = _spawn_frontend(quiet=quiet, tls=tls, edition=edition)
    backend_proc = _spawn_backend(python_exe, quiet=quiet, tls=tls, edition=edition)

    scheme = "https" if tls is not None else "http"

    if edition == "ee":
        print("[dev] edition: ee (manager_enterprise:app)", flush=True)

    print_banner(
        "dev",
        BannerFields(
            runtime_home=runtime_home.runtime_home_path(),
            open_url=f"{scheme}://localhost:{BACKEND_PORT}",
            frontend_url=f"{scheme}://localhost:{FRONTEND_PORT}",
        ),
    )

    try:
        # Backend respawn loop: when /api/system/restart shuts the worker
        # down cleanly, it drops a sentinel file. We spawn a fresh
        # subprocess (NOT relying on uvicorn --reload's respawn — that
        # only fires on file change) so module-level mounts pick up the
        # current live project. Frontend Vite normally stays untouched so HMR
        # survives the backend bounce.
        while True:
            exit_code = backend_proc.wait()
            if exit_code == 0 and _consume_restart_sentinel():
                print("[dev] backend restart requested — respawning", flush=True)
                # Re-resolve: the restart sentinel is exactly what Settings →
                # HTTPS drops after toggling TLS, so the new worker must bind
                # with the setting the user just saved.
                previous_tls = tls
                tls = _resolve_tls()
                backend_proc = _spawn_backend(python_exe, quiet=quiet, tls=tls, edition=edition)
                if (previous_tls is None) != (tls is None):
                    # Vite's own listener and its proxy target are both fixed at
                    # its startup, so leaving it up would have it speak the old
                    # scheme at a backend that now speaks the other one — every
                    # /api call dies as "socket hang up". The browser has to move
                    # to a new origin anyway, so HMR state is lost regardless.
                    scheme = "https" if tls is not None else "http"
                    print(
                        f"[dev] protocol changed to {scheme} — restarting Vite; "
                        f"reload {scheme}://localhost:{FRONTEND_PORT}",
                        flush=True,
                    )
                    _terminate_frontend(frontend_proc)
                    frontend_proc = _spawn_frontend(quiet=quiet, tls=tls, edition=edition)
                continue
            break
        frontend_proc.wait()
    except KeyboardInterrupt:
        backend_proc.terminate()
        # Its own session means Ctrl-C at the terminal no longer reaches Vite,
        # so it has to be torn down explicitly.
        _terminate_frontend(frontend_proc)


def main() -> None:
    parser = argparse.ArgumentParser(description="NEXT HMI dev runner")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--stop",  action="store_true", help="Only stop running services")
    group.add_argument("--start", action="store_true", help="Only start services (no kill)")
    parser.add_argument(
        "-q", "--quiet",
        action="store_true",
        help="Discard child stdout. The rotating .dev-logs/nexthmi.log file "
             "is still written by the backend's Python logger.",
    )
    parser.add_argument(
        "--edition",
        choices=["oss", "ee"],
        default="oss",
        help="oss (default) serves manager:app. ee serves manager_enterprise:app "
             "and builds the frontend against enterprise/frontend/registry.ts — "
             "requires enterprise/ symlinked to a nexthmi-enterprise checkout.",
    )
    args = parser.parse_args()

    if args.stop:
        stop()
    elif args.start:
        start(quiet=args.quiet, edition=args.edition)
    else:
        stop()
        start(quiet=args.quiet, edition=args.edition)


if __name__ == "__main__":
    main()
