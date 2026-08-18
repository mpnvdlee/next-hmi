"""Project supervisor — one child backend process per running project.

The manager process owns a :class:`Supervisor`. Each running project is a
separate child process started from the same entry point (``launcher.py`` in
source, the frozen binary in a packaged build) in *instance mode*
(``--serve-project``). Children bind ``127.0.0.1`` on an ephemeral port and are
reached only through the manager's reverse proxy under ``/runtime/<slug>/`` or
``/editor/<slug>/``.

Responsibilities:
  * start/stop children and track their state,
  * health-check a freshly started child before reporting it running,
  * auto-restart a child that exits unexpectedly, with exponential backoff and
    a circuit-breaker that flips it to ``crashed`` after repeated rapid failures,
  * persist the running set to the manifest so it can be resumed after a manager
    restart (see :func:`resume_all`),
  * expose a serialisable status snapshot for the manager dashboard.

State lives in process memory (the child PIDs/ports) plus the manifest
(``running`` list) for durability. The manifest is the source of truth for
*which* projects should be up; in-memory ``ChildInstance`` carries the live
PID/port/status.
"""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from core import operator_setup, runtime_home, start_guards
from core.manifest import (
    find_project,
    load_manifest,
    remove_running,
    running_entry,
    upsert_running,
    validate_project_id,
)

logger = logging.getLogger(__name__)

Status = Literal["starting", "running", "stopped", "crashed"]

# Circuit breaker: more than this many restarts inside the window flips the
# instance to ``crashed`` and stops the supervisor from respawning it.
_MAX_RESTARTS = 5
_RESTART_WINDOW_SECONDS = 60.0
# Exponential backoff bounds between auto-restart attempts.
_BACKOFF_BASE_SECONDS = 1.0
_BACKOFF_MAX_SECONDS = 30.0
# How long to wait for a freshly spawned child to answer /api/health.
_HEALTH_TIMEOUT_SECONDS = 25.0
_HEALTH_POLL_INTERVAL = 0.25
# Grace period for SIGTERM before escalating to SIGKILL.
_STOP_GRACE_SECONDS = 8.0


def base_path_for(project_id: str) -> str:
    """The default URL prefix a project's instance is spawned with.

    This is the base the child bakes into its own generated absolute URLs
    (e.g. widget-build static assets) before it has ever been proxied — it
    matches the primary ``/runtime/<slug>/`` access path. A request actually
    arriving through ``/editor/<slug>/`` overrides this via the manager's
    ``X-Forwarded-Prefix`` header (see ``main._resolve_base_path``).
    """
    validate_project_id(project_id)
    return f"/runtime/{project_id}/"


@dataclass
class ChildInstance:
    project_id: str
    name: str
    path: str
    base_path: str
    port: int | None = None
    proc: subprocess.Popen[bytes] | None = None
    status: Status = "stopped"
    started_at: float | None = None
    restarts: int = 0
    last_error: str | None = None
    # Monotonic timestamps of recent (auto)starts — drives the circuit breaker.
    _restart_times: list[float] = field(default_factory=list)

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.project_id,
            "name": self.name,
            "path": self.path,
            "basePath": self.base_path,
            "port": self.port,
            "pid": self.proc.pid if self.proc is not None else None,
            "status": self.status,
            "startedAt": self.started_at,
            "restarts": self.restarts,
            "lastError": self.last_error,
        }


def _is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _child_command(args: list[str]) -> list[str]:
    """Build the command that launches a child in instance mode.

    Frozen builds re-invoke the executable directly; source runs re-invoke the
    launcher module with the current interpreter.
    """
    if _is_frozen():
        return [sys.executable, *args]
    launcher = Path(__file__).resolve().parent.parent / "launcher.py"
    return [sys.executable, str(launcher), *args]


def _port_free(port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _pick_port(preferred: int | None) -> int:
    """Return ``preferred`` if free, otherwise an OS-assigned ephemeral port."""
    if preferred is not None and _port_free(preferred):
        return preferred
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _instance_log_dir(project_id: str) -> Path:
    validate_project_id(project_id)
    return runtime_home.logs_dir() / "instances" / project_id


class Supervisor:
    def __init__(self) -> None:
        self._instances: dict[str, ChildInstance] = {}
        self._lock = threading.RLock()
        # Project ids we are intentionally stopping — suppresses auto-restart.
        self._stopping: set[str] = set()
        self._monitor: threading.Thread | None = None
        self._monitor_stop = threading.Event()
        self._operation_locks: dict[str, threading.Lock] = {}

    def project_operation_lock(self, project_id: str) -> threading.Lock:
        """Serialize start, stop, and replacement for one project."""
        validate_project_id(project_id)
        with self._lock:
            return self._operation_locks.setdefault(project_id, threading.Lock())

    def is_fully_stopped(self, project_id: str) -> bool:
        validate_project_id(project_id)
        with self._lock:
            instance = self._instances.get(project_id)
            if instance is None:
                return True
            process_stopped = instance.proc is None or instance.proc.poll() is not None
            return process_stopped and instance.status in ("stopped", "crashed")

    # ── lifecycle ────────────────────────────────────────────────────────────

    def start(self, project_id: str) -> dict[str, Any]:
        """Start (or report already-running) the instance for *project_id*.

        Spawns the child, waits for it to pass the health check, records it in
        the persisted running set, and returns its status snapshot. Raises
        ``ValueError`` if the project is unknown or its folder is missing.
        """
        validate_project_id(project_id)
        refusal = start_guards.refusal(project_id)
        if refusal is not None:
            raise ValueError(refusal)
        with self.project_operation_lock(project_id):
            return self._start_serialized(project_id)

    def _start_serialized(self, project_id: str) -> dict[str, Any]:
        with self._lock:
            manifest = load_manifest()
            entry = find_project(manifest, project_id)
            if entry is None:
                raise ValueError(f"Project '{project_id}' not found")
            project_path = Path(entry.path).expanduser()
            if not project_path.is_dir():
                raise ValueError(f"Project folder is missing at {entry.path}")
            setup_state = operator_setup.state(project_path)
            if setup_state.status is operator_setup.SetupStatus.REQUIRED:
                raise ValueError(
                    "Set this project's operator password in the manager before starting it"
                )
            if setup_state.status is operator_setup.SetupStatus.ERROR:
                raise ValueError(
                    f"Project credentials are unavailable: {setup_state.error}"
                )

            existing = self._instances.get(project_id)
            if existing is not None and existing.status in ("starting", "running"):  # noqa: SIM102 -- no autofix offered, left as-is per the mechanical-only policy for this family
                if existing.proc is not None and existing.proc.poll() is None:
                    return existing.snapshot()

            persisted = running_entry(manifest, project_id)
            preferred = persisted.port if persisted is not None else None
            instance = existing or ChildInstance(
                project_id=project_id,
                name=entry.name,
                path=str(project_path),
                base_path=base_path_for(project_id),
            )
            instance.name = entry.name
            instance.path = str(project_path)
            self._instances[project_id] = instance
            self._stopping.discard(project_id)
            self._spawn_locked(instance, project_path, preferred)

        # Health check outside the lock so other status reads don't block.
        if self._await_health(instance):
            with self._lock:
                instance.status = "running"
            upsert_running(project_id, instance.port)
            self._ensure_monitor()
            return instance.snapshot()

        # Failed to come up — tear the child down and surface the error.
        self._terminate(instance)
        with self._lock:
            instance.status = "crashed"
            instance.last_error = instance.last_error or "health check timed out"
        return instance.snapshot()

    def _spawn_locked(
        self, instance: ChildInstance, project_path: Path, preferred: int | None
    ) -> None:
        port = _pick_port(preferred)
        instance.port = port
        instance.status = "starting"
        instance.started_at = time.time()
        instance.last_error = None

        log_dir = _instance_log_dir(instance.project_id)
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / "process.log"

        args = [
            "--serve-project", str(project_path),
            "--port", str(port),
            "--base-path", instance.base_path,
            "--project-id", instance.project_id,
        ]
        cmd = _child_command(args)

        env = dict(os.environ)
        # The manager's own port must not leak into the child's discovery, and
        # the child resolves its project from the path, not the manifest.
        env.pop("NEXTHMI_PORT", None)
        # Children are plain-HTTP on loopback behind the manager's proxy; the
        # manager's HTTPS port would only mislead anything that reads it.
        env.pop("NEXTHMI_HTTPS_PORT", None)
        # Per-project build + log isolation so two instances with same-named
        # custom widgets don't collide in the shared widget-build dir, and each
        # child's nexthmi.log lands beside the supervisor-captured process.log.
        env["NEXTHMI_WIDGET_BUILD_DIR"] = str(
            runtime_home.widget_build_dir() / instance.project_id
        )
        env["NEXTHMI_LOGS_DIR"] = str(log_dir)

        logger.info(
            "supervisor: starting '%s' (%s) on 127.0.0.1:%d", instance.name, instance.project_id, port
        )
        handle = open(log_file, "ab", buffering=0)  # noqa: SIM115 — closed in _terminate
        try:
            instance.proc = subprocess.Popen(  # args are controlled
                cmd,
                stdout=handle,
                stderr=subprocess.STDOUT,
                env=env,
                close_fds=True,
            )
        finally:
            handle.close()
        instance._restart_times.append(time.monotonic())

    def stop(self, project_id: str) -> dict[str, Any]:
        """Stop the instance and drop it from the persisted running set."""
        validate_project_id(project_id)
        with self.project_operation_lock(project_id):
            return self._stop_serialized(project_id)

    def _stop_serialized(self, project_id: str) -> dict[str, Any]:
        with self._lock:
            instance = self._instances.get(project_id)
            self._stopping.add(project_id)
        if instance is not None:
            self._terminate(instance)
            with self._lock:
                instance.status = "stopped"
        remove_running(project_id)
        if instance is None:
            return {"id": project_id, "status": "stopped"}
        return instance.snapshot()

    def _terminate(self, instance: ChildInstance) -> None:
        proc = instance.proc
        if proc is None:
            return
        if proc.poll() is not None:
            instance.proc = None
            return
        try:
            if os.name == "nt":
                proc.terminate()
            else:
                proc.send_signal(signal.SIGTERM)
        except OSError:
            instance.proc = None
            return
        try:
            proc.wait(timeout=_STOP_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            logger.warning(
                "supervisor: '%s' did not exit on SIGTERM — killing", instance.project_id
            )
            try:
                proc.kill()
                proc.wait(timeout=5.0)
            except (OSError, subprocess.TimeoutExpired):
                pass
        instance.proc = None

    # ── health check ─────────────────────────────────────────────────────────

    def _await_health(self, instance: ChildInstance) -> bool:
        port = instance.port
        if port is None:
            return False
        url = f"http://127.0.0.1:{port}/api/health"
        deadline = time.monotonic() + _HEALTH_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            proc = instance.proc
            if proc is not None and proc.poll() is not None:
                instance.last_error = f"process exited with code {proc.returncode} during startup"
                return False
            try:
                with urllib.request.urlopen(url, timeout=2.0) as resp:  # localhost
                    if resp.status == 200:
                        return True
            except OSError:
                pass
            time.sleep(_HEALTH_POLL_INTERVAL)
        return False

    # ── crash monitor / auto-restart ──────────────────────────────────────────

    def _ensure_monitor(self) -> None:
        with self._lock:
            if self._monitor is not None and self._monitor.is_alive():
                return
            self._monitor_stop.clear()
            self._monitor = threading.Thread(
                target=self._monitor_loop, name="supervisor-monitor", daemon=True
            )
            self._monitor.start()

    def _monitor_loop(self) -> None:
        while not self._monitor_stop.wait(1.0):
            with self._lock:
                candidates = [
                    inst
                    for inst in self._instances.values()
                    if inst.status == "running"
                    and inst.project_id not in self._stopping
                    and inst.proc is not None
                    and inst.proc.poll() is not None
                ]
            for instance in candidates:
                self._handle_crash(instance)

    def _handle_crash(self, instance: ChildInstance) -> None:
        code = instance.proc.returncode if instance.proc is not None else None
        logger.warning(
            "supervisor: '%s' exited unexpectedly (code=%s)", instance.project_id, code
        )
        now = time.monotonic()
        with self._lock:
            instance.proc = None
            instance._restart_times = [
                t for t in instance._restart_times if now - t <= _RESTART_WINDOW_SECONDS
            ]
            if len(instance._restart_times) >= _MAX_RESTARTS:
                instance.status = "crashed"
                instance.last_error = (
                    f"crashed {len(instance._restart_times)} times in "
                    f"{int(_RESTART_WINDOW_SECONDS)}s — giving up"
                )
                logger.error("supervisor: '%s' %s", instance.project_id, instance.last_error)
                return
            instance.restarts += 1
            attempt = len(instance._restart_times)
        backoff = min(_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)), _BACKOFF_MAX_SECONDS)
        logger.info(
            "supervisor: restarting '%s' in %.1fs (attempt %d)",
            instance.project_id, backoff, attempt,
        )
        time.sleep(backoff)
        with self._lock:
            if instance.project_id in self._stopping:
                return
            # A guard that refuses a fresh start must also refuse a respawn —
            # otherwise the one path nobody watches quietly reinstates what the
            # dashboard just told the operator it would not start.
            refusal = start_guards.refusal(instance.project_id)
            if refusal is not None:
                instance.status = "crashed"
                instance.last_error = refusal
                return
            entry = find_project(load_manifest(), instance.project_id)
            if entry is None or not Path(entry.path).expanduser().is_dir():
                instance.status = "crashed"
                instance.last_error = "project folder missing on restart"
                return
            project_path = Path(entry.path).expanduser()
            setup_state = operator_setup.state(project_path)
            if setup_state.status is not operator_setup.SetupStatus.COMPLETE:
                instance.status = "crashed"
                instance.last_error = (
                    "operator setup required"
                    if setup_state.status is operator_setup.SetupStatus.REQUIRED
                    else f"Project credentials are unavailable: {setup_state.error}"
                )
                return
            self._spawn_locked(instance, project_path, instance.port)
        if self._await_health(instance):
            with self._lock:
                instance.status = "running"
            upsert_running(instance.project_id, instance.port)

    # ── resume / shutdown ──────────────────────────────────────────────────────

    def resume_all(self) -> None:
        """Start every project recorded in the manifest's running set.

        Called once on manager startup so a reboot brings the panel back as it
        was. Projects are started concurrently — each :meth:`start` blocks up to
        the health timeout, so a serial resume of N projects would be O(N x that)
        on cold boot. Best-effort: a project whose folder vanished is skipped
        (and pruned from the running set) rather than aborting the resume.
        """
        manifest = load_manifest()
        resumable: list[str] = []
        for entry in list(manifest.running):
            project = find_project(manifest, entry.id)
            if project is None or not Path(project.path).expanduser().is_dir():
                logger.warning("supervisor: cannot resume '%s' — pruning", entry.id)
                remove_running(entry.id)
                continue
            resumable.append(entry.id)

        def _resume_one(project_id: str) -> None:
            try:
                self.start(project_id)
            except Exception:
                logger.exception("supervisor: resume of '%s' failed", project_id)

        threads = [
            threading.Thread(
                target=_resume_one, args=(pid,), name=f"resume-{pid}", daemon=True
            )
            for pid in resumable
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    def shutdown(self) -> None:
        """Stop the monitor and terminate all children (manager shutdown).

        Does NOT clear the persisted running set — so the next manager start
        resumes the same projects.
        """
        self._monitor_stop.set()
        with self._lock:
            instances = list(self._instances.values())
            for inst in instances:
                self._stopping.add(inst.project_id)
        for instance in instances:
            self._terminate(instance)

    # ── status ─────────────────────────────────────────────────────────────────

    def status(self, project_id: str) -> dict[str, Any] | None:
        validate_project_id(project_id)
        with self._lock:
            instance = self._instances.get(project_id)
            return instance.snapshot() if instance is not None else None

    def running_snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return [inst.snapshot() for inst in self._instances.values()]

    def port_for(self, project_id: str) -> int | None:
        """The live port for a running instance, or ``None`` if it isn't up."""
        validate_project_id(project_id)
        with self._lock:
            instance = self._instances.get(project_id)
            if instance is None or instance.status != "running":
                return None
            return instance.port

supervisor = Supervisor()
