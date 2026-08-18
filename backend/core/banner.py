"""Pretty terminal banner for both entry points (launcher + dev runner).

Both ``backend/launcher.py`` (binary) and ``start-dev.py`` (developer) print a
single splash on start: ASCII art, version, the URLs / paths the user
actually needs, and nothing else. Logs live in a file or behind
``--verbose`` — this module just renders the splash string.

Self-contained (no other backend imports) so ``start-dev.py`` can use it by
prepending ``backend/`` to ``sys.path``.
"""
from __future__ import annotations

import functools
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

# ── Color ────────────────────────────────────────────────────────────────────

_ANSI_RESET = "\x1b[0m"
_ANSI_BOLD = "\x1b[1m"
_ANSI_DIM = "\x1b[2m"
_ANSI_CYAN = "\x1b[36m"
_ANSI_BRIGHT_CYAN = "\x1b[96m"
_ANSI_MAGENTA = "\x1b[35m"


@functools.cache
def _windows_vt_enabled() -> bool:
    """Switch the console into VT mode so ANSI escape codes render as colors.

    Windows ≥10 conhost supports ANSI but the bit is off by default, so the
    raw ``\\x1b[36m`` sequences leak through as ``←[36m`` garbage in cmd.exe
    and the bundled PowerShell. Flipping ``ENABLE_VIRTUAL_TERMINAL_PROCESSING``
    on stdout's handle is a one-shot, process-wide fix. Returns ``False`` on
    older Windows / redirected stdout so callers fall back to plain text.
    """
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32
        STD_OUTPUT_HANDLE = -11
        ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
        INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
        handle = kernel32.GetStdHandle(STD_OUTPUT_HANDLE)
        if not handle or handle == INVALID_HANDLE_VALUE:
            return False
        mode = wintypes.DWORD()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(
            kernel32.SetConsoleMode(handle, mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING)
        )
    except Exception:
        return False


def _color_enabled() -> bool:
    """ANSI on iff stdout is a TTY and ``NO_COLOR`` is unset.

    Honors the de-facto ``NO_COLOR`` convention (https://no-color.org) so
    log-scrape pipelines and CI runs get plain text by default. On Windows
    we additionally need VT processing flipped on the console handle, or
    cmd.exe / conhost-based PowerShell print escapes literally.
    """
    if os.environ.get("NO_COLOR"):
        return False
    if not sys.stdout.isatty():
        return False
    if sys.platform == "win32" and not _windows_vt_enabled():
        return False
    return True


def _wrap(text: str, *codes: str) -> str:
    if not _color_enabled() or not codes:
        return text
    return "".join(codes) + text + _ANSI_RESET


# ── ASCII art ────────────────────────────────────────────────────────────────

# Figlet "Standard" rendering of "NEXT HMI". Kept as a list so the colorizer
# can paint each line independently if we ever want a gradient.
_LOGO_LINES: tuple[str, ...] = (
    r"  _   _ _______  _______   _   _ __  __ ___",
    r" | \ | | ____\ \/ /_   _| | | | |  \/  |_ _|",
    r" |  \| |  _|  \  /  | |   | |_| | |\/| || |",
    r" | |\  | |___ /  \  | |   |  _  | |  | || |",
    r" |_| \_|_____/_/\_\ |_|   |_| |_|_|  |_|___|",
)


def _render_logo() -> str:
    return "\n".join(_wrap(line, _ANSI_BRIGHT_CYAN, _ANSI_BOLD) for line in _LOGO_LINES)


# ── Field rendering ──────────────────────────────────────────────────────────

_LABEL_WIDTH = 14  # widest label + 2 spaces ("Runtime home")


def _row(label: str, value: str) -> str:
    """One ``  Label          value`` row with a dim-gray label and
    plain-or-colored value (caller paints the value as it sees fit)."""
    padded = label.ljust(_LABEL_WIDTH)
    return f"  {_wrap(padded, _ANSI_DIM)}{value}"


def _url(text: str) -> str:
    return _wrap(text, _ANSI_BRIGHT_CYAN)


def _muted(text: str) -> str:
    return _wrap(text, _ANSI_DIM)


# ── Public API ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class BannerFields:
    """Everything either entry point needs to feed into the banner."""

    runtime_home: Path
    open_url: str
    version: str = "dev"
    # Dev-mode only.
    frontend_url: str | None = None


def render_banner(mode: Literal["runtime", "dev"], fields: BannerFields) -> str:
    """Assemble the full splash string (logo + rows + footer). No trailing newline."""
    out: list[str] = ["", _render_logo(), ""]

    # Version sits one space in, dimmed, just under the logo.
    out.append(_muted(f"  v{fields.version}"))
    out.append("")

    out.append(_row("Runtime home", str(fields.runtime_home)))

    # The log file is reachable from Config → Admin and its path is derived from
    # the runtime home above, so printing it here only crowded the splash.
    if mode == "dev":
        out.append(_row("Backend", _url(fields.open_url)))
        if fields.frontend_url:
            out.append(_row("Frontend", _url(fields.frontend_url)))
    else:
        # Runtime: just the click-here URL. The bind address (e.g. 0.0.0.0:8000)
        # isn't a clickable URL, so it added noise without value.
        out.append(_row("Open", _url(fields.open_url)))

    out.append("")
    out.append(_muted("  Press Ctrl-C to stop."))
    out.append("")
    return "\n".join(out)


def print_banner(mode: Literal["runtime", "dev"], fields: BannerFields) -> None:
    """Render + write to stdout + flush. Convenience over ``print(render_banner(...))``."""
    print(render_banner(mode, fields))
    sys.stdout.flush()
