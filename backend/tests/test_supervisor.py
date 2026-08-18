"""Supervisor unit tests — start/stop/status without spawning real children.

``subprocess.Popen`` and the health check are stubbed so the tests exercise the
state machine, manifest bookkeeping, and crash handling deterministically.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest
from core import manifest as manifest_mod
from core import runtime_home, start_guards
from services import supervisor as supervisor_mod


@pytest.fixture
def home(monkeypatch, tmp_path: Path) -> Path:
    home_dir = tmp_path / "runtime-home"
    home_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home_dir)
    monkeypatch.setattr(runtime_home, "logs_dir", lambda: home_dir / ".logs")
    monkeypatch.setattr(runtime_home, "widget_build_dir", lambda: home_dir / ".widget-build")
    return home_dir


class _FakeProc:
    def __init__(self) -> None:
        self.pid = 4242
        self.returncode = None
        self._alive = True
        self.signals: list = []

    def poll(self):
        return None if self._alive else self.returncode

    def send_signal(self, sig):
        self.signals.append(sig)
        self._alive = False
        self.returncode = 0

    def terminate(self):
        self.send_signal("TERM")

    def wait(self, timeout=None):
        self._alive = False
        if self.returncode is None:
            self.returncode = 0
        return self.returncode

    def kill(self):
        self._alive = False
        self.returncode = -9


def _register_project(home: Path, tmp_path: Path, *, name: str = "Plant") -> str:
    target = tmp_path / name
    metadata = manifest_mod.ensure_project_metadata(target, name=name)
    (target / "users.json").write_text(
        json.dumps({"settings": {}, "groups": [], "users": []}), encoding="utf-8"
    )
    manifest = manifest_mod.load_manifest()
    manifest.projects.append(
        manifest_mod.ProjectEntry(
            id=metadata.id, name=name, path=str(target), addedAt="2026-06-14T00:00:00Z"
        )
    )
    manifest_mod.save_manifest(manifest)
    return metadata.id


def _make_supervisor(monkeypatch, *, healthy: bool = True) -> supervisor_mod.Supervisor:
    sup = supervisor_mod.Supervisor()
    monkeypatch.setattr(supervisor_mod.subprocess, "Popen", lambda *a, **k: _FakeProc())
    monkeypatch.setattr(sup, "_await_health", lambda instance: healthy)
    return sup


def test_base_path_for_defaults_to_runtime_alias() -> None:
    """The spawn-time default matches the primary /runtime/<slug>/ access path
    (not the removed /p/<id>/ alias) so a child's own generated absolute URLs
    are correct even before the manager's X-Forwarded-Prefix overrides it for
    an /editor/<slug>/ hit (backlog R24/R51)."""
    assert supervisor_mod.base_path_for("plant-a") == "/runtime/plant-a/"


def test_start_unknown_project_raises(home: Path) -> None:
    sup = supervisor_mod.Supervisor()
    with pytest.raises(ValueError):
        sup.start("does-not-exist")


@pytest.mark.parametrize("project_id", ["../../escape", "a/b", ".hidden", "CON"])
def test_project_id_cannot_escape_runtime_or_widget_paths(home: Path, project_id: str) -> None:
    with pytest.raises(ValueError):
        supervisor_mod.base_path_for(project_id)
    with pytest.raises(ValueError):
        supervisor_mod._instance_log_dir(project_id)
    with pytest.raises(ValueError):
        supervisor_mod.Supervisor().start(project_id)


def test_start_and_stop_are_serialized_per_project(home: Path, monkeypatch) -> None:
    sup = supervisor_mod.Supervisor()
    entered = threading.Event()
    release = threading.Event()
    order: list[str] = []

    def starting(_project_id: str):
        order.append("start-enter")
        entered.set()
        assert release.wait(5)
        order.append("start-exit")
        return {"id": "project-1", "status": "running"}

    def stopping(_project_id: str):
        order.append("stop")
        return {"id": "project-1", "status": "stopped"}

    monkeypatch.setattr(sup, "_start_serialized", starting)
    monkeypatch.setattr(sup, "_stop_serialized", stopping)
    start_thread = threading.Thread(target=sup.start, args=("project-1",))
    stop_thread = threading.Thread(target=sup.stop, args=("project-1",))
    start_thread.start()
    assert entered.wait(5)
    stop_thread.start()
    time.sleep(0.05)
    assert order == ["start-enter"]
    release.set()
    start_thread.join(5)
    stop_thread.join(5)
    assert order == ["start-enter", "start-exit", "stop"]


def test_start_rejects_project_with_pending_operator_setup(
    home: Path, tmp_path: Path
) -> None:
    project_id = _register_project(home, tmp_path)
    project = manifest_mod.find_project(manifest_mod.load_manifest(), project_id)
    assert project is not None
    (Path(project.path) / "users.json").write_text(
        json.dumps(
                {
                    "settings": {},
                    "groups": [
                        {"id": "guest", "label": "Guest"},
                        {"id": "admin", "label": "Admin"},
                    ],
                    "users": [
                        {
                            "id": "guest",
                            "username": "guest",
                            "password": "",
                            "groups": ["guest"],
                        }
                    ],
                    "operatorSetup": {"version": 1, "required": True},
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="operator password"):
        supervisor_mod.Supervisor().start(project_id)


def test_start_rechecks_credentials_before_returning_running_instance(
    home: Path, tmp_path: Path
) -> None:
    project_id = _register_project(home, tmp_path)
    project = manifest_mod.find_project(manifest_mod.load_manifest(), project_id)
    assert project is not None
    proc = _FakeProc()
    sup = supervisor_mod.Supervisor()
    sup._instances[project_id] = supervisor_mod.ChildInstance(
        project_id=project_id,
        name="Plant",
        path=project.path,
        base_path=f"/runtime/{project_id}/",
        proc=proc,
        status="running",
    )
    (Path(project.path) / "users.json").unlink()

    with pytest.raises(ValueError, match=r"users\.json is missing"):
        sup.start(project_id)


def test_crash_restart_fails_closed_when_credentials_become_corrupt(
    home: Path, tmp_path: Path, monkeypatch
) -> None:
    project_id = _register_project(home, tmp_path)
    project = manifest_mod.find_project(manifest_mod.load_manifest(), project_id)
    assert project is not None
    proc = _FakeProc()
    proc._alive = False
    proc.returncode = 1
    instance = supervisor_mod.ChildInstance(
        project_id=project_id,
        name="Plant",
        path=project.path,
        base_path=f"/runtime/{project_id}/",
        proc=proc,
        status="running",
    )
    sup = supervisor_mod.Supervisor()
    sup._instances[project_id] = instance
    (Path(project.path) / "users.json").write_text("{not-json", encoding="utf-8")
    monkeypatch.setattr(supervisor_mod.time, "sleep", lambda _seconds: None)

    sup._handle_crash(instance)

    assert instance.status == "crashed"
    assert instance.proc is None
    assert instance.last_error == (
        "Project credentials are unavailable: users.json is unreadable or corrupt"
    )


class TestStartGuards:
    """``core.start_guards`` consulted on every path that spawns a child.

    Nothing in the public build registers a guard, so these drive the seam
    directly. The enterprise edition's runtime activation is the real consumer.
    """

    @pytest.fixture
    def refusing(self):
        guard = lambda _project_id: "not activated"  # noqa: E731
        start_guards.register_guard(guard)
        yield guard
        start_guards.unregister_guard(guard)

    def test_start_is_refused_with_the_guard_s_own_words(
        self, home: Path, tmp_path: Path, monkeypatch, refusing
    ) -> None:
        project_id = _register_project(home, tmp_path)
        sup = _make_supervisor(monkeypatch, healthy=True)

        with pytest.raises(ValueError, match="not activated"):
            sup.start(project_id)

        assert sup.status(project_id) is None
        assert manifest_mod.running_entry(manifest_mod.load_manifest(), project_id) is None

    def test_resume_skips_refused_projects_without_aborting(
        self, home: Path, tmp_path: Path, monkeypatch, refusing
    ) -> None:
        """A cold boot under a refusing guard comes up with nothing running."""
        project_id = _register_project(home, tmp_path)
        manifest_mod.upsert_running(project_id, 9001)
        sup = _make_supervisor(monkeypatch, healthy=True)

        sup.resume_all()

        assert sup.running_snapshot() == []

    def test_a_crashed_instance_is_not_respawned(
        self, home: Path, tmp_path: Path, monkeypatch, refusing
    ) -> None:
        """A process that already exited is not one that is 'kept running'.

        Leaving this path unguarded would quietly reinstate exactly what the
        dashboard just refused to start.
        """
        project_id = _register_project(home, tmp_path)
        project = manifest_mod.find_project(manifest_mod.load_manifest(), project_id)
        assert project is not None
        proc = _FakeProc()
        proc._alive = False
        proc.returncode = 1
        instance = supervisor_mod.ChildInstance(
            project_id=project_id,
            name="Plant",
            path=project.path,
            base_path=f"/runtime/{project_id}/",
            proc=proc,
            status="running",
        )
        sup = _make_supervisor(monkeypatch, healthy=True)
        sup._instances[project_id] = instance
        monkeypatch.setattr(supervisor_mod.time, "sleep", lambda _seconds: None)

        sup._handle_crash(instance)

        assert instance.status == "crashed"
        assert instance.last_error == "not activated"
        assert instance.proc is None

    def test_an_allowing_guard_changes_nothing(
        self, home: Path, tmp_path: Path, monkeypatch
    ) -> None:
        project_id = _register_project(home, tmp_path)
        guard = lambda _project_id: None  # noqa: E731
        start_guards.register_guard(guard)
        sup = _make_supervisor(monkeypatch, healthy=True)
        try:
            assert sup.start(project_id)["status"] == "running"
        finally:
            start_guards.unregister_guard(guard)


def test_start_records_running_and_status(home: Path, tmp_path: Path, monkeypatch) -> None:
    project_id = _register_project(home, tmp_path)
    sup = _make_supervisor(monkeypatch, healthy=True)

    snap = sup.start(project_id)
    assert snap["status"] == "running"
    assert snap["basePath"] == f"/runtime/{project_id}/"
    assert snap["port"]

    # Persisted to the manifest's running set.
    running = manifest_mod.running_entry(manifest_mod.load_manifest(), project_id)
    assert running is not None
    assert running.port == snap["port"]

    # Idempotent: starting again returns the same running instance.
    again = sup.start(project_id)
    assert again["pid"] == snap["pid"]


def test_failed_health_marks_crashed(home: Path, tmp_path: Path, monkeypatch) -> None:
    project_id = _register_project(home, tmp_path)
    sup = _make_supervisor(monkeypatch, healthy=False)
    snap = sup.start(project_id)
    assert snap["status"] == "crashed"
    assert snap["lastError"]


def test_stop_terminates_and_clears_running(home: Path, tmp_path: Path, monkeypatch) -> None:
    project_id = _register_project(home, tmp_path)
    sup = _make_supervisor(monkeypatch, healthy=True)
    sup.start(project_id)

    snap = sup.stop(project_id)
    assert snap["status"] == "stopped"
    assert manifest_mod.running_entry(manifest_mod.load_manifest(), project_id) is None
    assert sup.port_for(project_id) is None


def test_resume_all_prunes_missing_projects(home: Path, monkeypatch) -> None:
    # A running entry pointing at a project that no longer exists is pruned.
    manifest = manifest_mod.load_manifest()
    manifest.running = [manifest_mod.RunningEntry(id="ghost", port=5111)]
    manifest_mod.save_manifest(manifest)

    sup = supervisor_mod.Supervisor()
    sup.resume_all()
    assert manifest_mod.load_manifest().running == []


# ── real-subprocess coverage ──────────────────────────────────────────────
#
# The tests above stub Popen entirely. These spawn an actual child process — a
# tiny stand-in server, not the real launcher — to exercise genuine spawn,
# health-poll-over-HTTP, SIGTERM/SIGKILL, and crash-detection/restart
# mechanics that a fake Popen can't prove.

_CHILD_SERVER_SOURCE = '''
import argparse
import http.server
import os
import signal
import threading
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--marker", required=True)
parser.add_argument("--ignore-sigterm", action="store_true")
parser.add_argument("--crash-after", type=float, default=None)
args = parser.parse_args()

if args.ignore_sigterm:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, *a):
        pass


class Server(http.server.HTTPServer):
    # HTTPServer.server_bind reverse-resolves the bound address purely to fill
    # in server_name. On CPython 3.14 that lookup waits out the resolver
    # timeout (~35s) for an address with no PTR record, which is far longer
    # than the supervisor's health-check window.
    def server_bind(self):
        http.server.socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


server = Server(("127.0.0.1", args.port), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

marker = Path(args.marker)
crash_this_run = args.crash_after is not None and not marker.exists()
if crash_this_run:
    marker.write_text("used")
    time.sleep(args.crash_after)
    os._exit(1)

while True:
    time.sleep(3600)
'''


@pytest.fixture
def child_script(tmp_path: Path) -> Path:
    path = tmp_path / "fake_child_server.py"
    path.write_text(_CHILD_SERVER_SOURCE, encoding="utf-8")
    return path


def _fake_child_command(script: Path, marker: Path, *, ignore_sigterm=False, crash_after=None):
    def build(args: list[str]) -> list[str]:
        port = args[args.index("--port") + 1]
        cmd = [sys.executable, str(script), "--port", port, "--marker", str(marker)]
        if ignore_sigterm:
            cmd.append("--ignore-sigterm")
        if crash_after is not None:
            cmd.extend(["--crash-after", str(crash_after)])
        return cmd

    return build


def _wait_until(predicate, *, timeout: float = 6.0, interval: float = 0.05) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def test_real_subprocess_passes_health_and_stop_sends_sigterm(
    home: Path, tmp_path: Path, monkeypatch, child_script: Path
) -> None:
    project_id = _register_project(home, tmp_path)
    marker = tmp_path / "marker"
    monkeypatch.setattr(
        supervisor_mod, "_child_command", _fake_child_command(child_script, marker)
    )
    sup = supervisor_mod.Supervisor()

    snap = sup.start(project_id)
    assert snap["status"] == "running"
    pid = snap["pid"]
    assert pid and os.kill(pid, 0) is None  # really alive

    stopped = sup.stop(project_id)
    assert stopped["status"] == "stopped"
    assert sup.is_fully_stopped(project_id)
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM is not ignorable on Windows")
def test_real_subprocess_escalates_to_sigkill_when_sigterm_is_ignored(
    home: Path, tmp_path: Path, monkeypatch, child_script: Path
) -> None:
    project_id = _register_project(home, tmp_path)
    marker = tmp_path / "marker"
    monkeypatch.setattr(
        supervisor_mod,
        "_child_command",
        _fake_child_command(child_script, marker, ignore_sigterm=True),
    )
    monkeypatch.setattr(supervisor_mod, "_STOP_GRACE_SECONDS", 0.3)
    sup = supervisor_mod.Supervisor()

    snap = sup.start(project_id)
    assert snap["status"] == "running"
    pid = snap["pid"]

    started = time.monotonic()
    stopped = sup.stop(project_id)
    elapsed = time.monotonic() - started

    assert stopped["status"] == "stopped"
    assert elapsed >= 0.3  # actually waited out the grace period before escalating
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_real_subprocess_crash_triggers_auto_restart(
    home: Path, tmp_path: Path, monkeypatch, child_script: Path
) -> None:
    project_id = _register_project(home, tmp_path)
    marker = tmp_path / "marker"
    monkeypatch.setattr(
        supervisor_mod,
        "_child_command",
        _fake_child_command(child_script, marker, crash_after=1.0),
    )
    monkeypatch.setattr(supervisor_mod, "_BACKOFF_BASE_SECONDS", 0.05)
    sup = supervisor_mod.Supervisor()

    first = sup.start(project_id)
    assert first["status"] == "running"
    first_pid = first["pid"]

    try:
        restarted = _wait_until(
            lambda: sup.status(project_id)["restarts"] >= 1
            and sup.status(project_id)["status"] == "running",
            timeout=10.0,
        )
        assert restarted, sup.status(project_id)
        status = sup.status(project_id)
        assert status["pid"] != first_pid
        assert marker.exists()  # the crashing run did happen, not a fluke pass
    finally:
        sup.stop(project_id)
