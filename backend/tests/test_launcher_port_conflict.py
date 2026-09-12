"""``launcher._resolve_port_conflict`` — the "[2] Kill and reuse the port" path.

Reported from the field on Windows: the operator picks [2] and the port never
comes free, with no usable reason on screen. Which of the defects below
actually bit was never captured, so all of them are pinned here.

Everything runs on any OS: the prompt tests fake the clock so
``_wait_port_free``'s five-second deadline costs no wall time and fake
``_processes_on_port``/``_kill_pid``, while the scan tests fake ``sys.platform``
and the ``netstat -ano`` output.
"""
import launcher
import pytest


@pytest.fixture
def fast_clock(monkeypatch):
    """Virtual clock: ``_wait_port_free``'s 5s deadline costs no wall time."""
    now = {"t": 0.0}

    def sleep(seconds: float) -> None:
        now["t"] += seconds

    monkeypatch.setattr(launcher.time, "monotonic", lambda: now["t"])
    monkeypatch.setattr(launcher.time, "sleep", sleep)
    return now


class _Tty:
    @staticmethod
    def isatty() -> bool:
        return True


def _answer(monkeypatch, choices: list[str]) -> None:
    """Feed *choices* to the prompt; re-asking past the last one is a failure."""
    pending = list(choices)

    def fake_input(_prompt: str = "") -> str:
        assert pending, "prompt re-asked after the last scripted choice"
        return pending.pop(0)

    monkeypatch.setattr("builtins.input", fake_input)
    monkeypatch.setattr(launcher.sys, "stdin", _Tty())


def test_kill_waits_for_the_port_to_become_bindable(monkeypatch, fast_clock) -> None:
    """``taskkill`` returns before Windows has torn the socket down.

    The listener leaves the process table at once while the port stays
    unbindable for a moment after, so the single bindability check that follows
    the wait reports a working kill as a failure.
    """
    _answer(monkeypatch, ["2"])
    scans = {"n": 0}
    binds = {"n": 0}

    def processes_on_port(port: int):
        scans["n"] += 1
        return [(8204, "nexthmi.exe")] if scans["n"] == 1 else []

    def port_bindable(host: str, port: int) -> bool:
        binds["n"] += 1
        return binds["n"] > 2  # socket lingers for two checks

    monkeypatch.setattr(launcher, "_processes_on_port", processes_on_port)
    monkeypatch.setattr(launcher, "_port_bindable", port_bindable)
    monkeypatch.setattr(launcher, "_kill_pid", lambda pid: None)

    assert launcher._resolve_port_conflict("0.0.0.0", 8000) == 8000


def test_retry_rescans_instead_of_rekilling_the_first_pid(monkeypatch, fast_clock) -> None:
    """A second [2] must act on whoever holds the port *now*.

    The first kill succeeds but another listener still holds the port. Choosing
    [2] again has to re-scan: re-killing the PID from the opening scan can never
    free the port, so the prompt loops forever on a PID that is already gone.
    """
    _answer(monkeypatch, ["2", "2"])
    killed: list[int] = []

    def processes_on_port(port: int):
        if 8204 not in killed:
            return [(8204, "nexthmi.exe")]
        if 9999 not in killed:
            return [(9999, "other.exe")]
        return []

    def kill_pid(pid: int) -> str | None:
        killed.append(pid)
        return None

    monkeypatch.setattr(launcher, "_processes_on_port", processes_on_port)
    monkeypatch.setattr(launcher, "_kill_pid", kill_pid)
    monkeypatch.setattr(
        launcher, "_port_bindable", lambda host, port: not processes_on_port(port)
    )

    assert launcher._resolve_port_conflict("0.0.0.0", 8000) == 8000
    assert killed == [8204, 9999]


# ── `_processes_on_port`, Windows branch ────────────────────────────────────
#
# Run on any OS by faking `sys.platform` and the `netstat -ano` output. The
# layout below is real Windows output: whitespace-separated columns of proto,
# local address, foreign address, state, PID.
_NETSTAT = """
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:8000           0.0.0.0:0              LISTENING       8204
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1052
  TCP    [fe80::8000:1a2b:3c4d:5e6f%12]:139  [::]:0    LISTENING       4
  TCP    [::]:8000              [::]:0                 LISTENING       8204
  TCP    127.0.0.1:54321        127.0.0.1:8000         ESTABLISHED     9001
  TCP    192.168.1.10:18000     0.0.0.0:0              LISTENING       7777
"""


@pytest.fixture
def windows_netstat(monkeypatch):
    """Fake a Windows host whose ``netstat -ano`` prints ``_NETSTAT``."""
    monkeypatch.setattr(launcher.sys, "platform", "win32")

    def check_output(cmd, **_kwargs):
        if cmd[0] == "netstat":
            return _NETSTAT
        if cmd[0] == "tasklist":
            pid = cmd[2].rsplit(" ", 1)[1]
            return f'"nexthmi.exe","{pid}","Console","1","45,678 K"\n'
        raise AssertionError(f"unexpected command {cmd!r}")

    monkeypatch.setattr(launcher.subprocess, "check_output", check_output)


def test_scan_ignores_ipv6_groups_and_foreign_addresses(windows_netstat) -> None:
    """Only the local-address port counts.

    ``[fe80::8000:...]:139`` spells the port inside an IPv6 hex group and the
    ESTABLISHED row carries ``127.0.0.1:8000`` as its *foreign* address. A
    substring scan of the line harvests both, offering the operator an
    unrelated PID — PID 4 is System, which no taskkill will ever terminate.
    """
    found = launcher._processes_on_port(8000)

    assert [pid for pid, _ in found] == [8204]


def test_scan_does_not_confuse_a_longer_port(windows_netstat) -> None:
    """Port 8000 must not match the listener on 18000."""
    assert [pid for pid, _ in launcher._processes_on_port(18000)] == [7777]


def test_failed_kill_reports_why(monkeypatch, fast_clock, capsys) -> None:
    """The operator sees the reason, not just that it failed.

    Without it, "access is denied" on an elevated process and "no such process"
    on a stale PID look identical on screen — and there is no log on an
    operator's machine to tell them apart afterwards.
    """
    # "2" attempts the kill, "q" then leaves the prompt.
    _answer(monkeypatch, ["2", "q"])
    monkeypatch.setattr(
        launcher, "_processes_on_port", lambda port: [(8204, "nexthmi.exe")]
    )
    monkeypatch.setattr(launcher, "_port_bindable", lambda host, port: False)
    monkeypatch.setattr(
        launcher, "_kill_pid", lambda pid: "ERROR: Access is denied."
    )

    assert launcher._resolve_port_conflict("0.0.0.0", 8000) is None

    out = capsys.readouterr().out
    assert "Access is denied" in out
    assert "PID 8204" in out


# Dutch Windows: the State column reads LUISTEREN, and `netstat` is one of the
# commands Microsoft does translate. The last row carries a deliberately
# two-word state, which shifts the PID out of column five.
_NETSTAT_NL = """
Actieve verbindingen

  Proto  Lokaal adres           Extern adres           Status          PID
  TCP    0.0.0.0:8000           0.0.0.0:0              LUISTEREN       8204
  TCP    [::]:8000              [::]:0                 LUISTEREN       8204
  TCP    127.0.0.1:54321        127.0.0.1:8000         TOT_STAND_GEB   9001
  TCP    0.0.0.0:9000           0.0.0.0:0              WACHT OP AFSL   7777
"""


def test_scan_survives_a_localized_state_column(monkeypatch) -> None:
    """The listener is found on a Windows that does not speak English.

    Keying on the literal "LISTENING" found nothing at all on a localized
    host: the prompt then reported the port as busy without naming a single
    PID, leaving [2] with nothing to kill.
    """
    monkeypatch.setattr(launcher.sys, "platform", "win32")

    def check_output(cmd, **_kwargs):
        if cmd[0] == "netstat":
            return _NETSTAT_NL
        return '"nexthmi.exe","8204","Console","1","45,678 K"\n'

    monkeypatch.setattr(launcher.subprocess, "check_output", check_output)

    assert [pid for pid, _ in launcher._processes_on_port(8000)] == [8204]


def test_scan_reads_the_pid_from_the_end_of_the_row(monkeypatch) -> None:
    """A two-word translated state must not cost us the PID.

    Column five is the state's second word on such a row, so a fixed index
    picks up a word instead of a number and the listener vanishes.
    """
    monkeypatch.setattr(launcher.sys, "platform", "win32")

    def check_output(cmd, **_kwargs):
        if cmd[0] == "netstat":
            return _NETSTAT_NL
        return '"other.exe","7777","Console","1","1,234 K"\n'

    monkeypatch.setattr(launcher.subprocess, "check_output", check_output)

    assert [pid for pid, _ in launcher._processes_on_port(9000)] == [7777]
