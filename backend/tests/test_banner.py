"""Terminal splash rendering (``core.banner``)."""
import re
from pathlib import Path

from core.banner import BannerFields, render_banner

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _rows(out: str) -> list[str]:
    """The URL-bearing lines, colorless and unindented.

    ``render_banner`` paints when stdout is a TTY, which it is under
    ``pytest -s`` — comparing raw lines would pass in CI and fail in a
    terminal. Stripping the escapes keeps the column padding assertable.
    """
    return [_ANSI.sub("", line).strip() for line in out.splitlines() if "://" in line]


def _fields() -> BannerFields:
    return BannerFields(
        runtime_home=Path("/srv/nexthmi-home"),
        open_url="http://127.0.0.1:8000",
        version="1.0.0",
        frontend_url="http://localhost:5173",
    )


def test_runtime_banner_shows_the_workspace_path_and_url() -> None:
    fields = _fields()
    out = render_banner("runtime", fields)
    assert "Runtime home" in out
    # str(Path(...)) renders with the OS-native separator (backslashes on
    # Windows), so compare against the same rendering rather than a
    # hardcoded POSIX literal.
    assert str(fields.runtime_home) in out
    assert "http://127.0.0.1:8000" in out
    assert "v1.0.0" in out


def test_runtime_banner_shows_default_project_and_project_list_link() -> None:
    out = render_banner("runtime", _fields())
    assert "Default project" in out
    assert "Project list" in out
    assert "http://127.0.0.1:8000/projects" in out


def test_runtime_banner_prints_the_network_block_under_the_rows() -> None:
    """Loopback is what you click here and the wrong answer for the tablet, so
    both are printed — once each, and the two network spellings share a row
    because they are alternatives rather than two more things to open."""
    out = render_banner(
        "runtime",
        BannerFields(
            runtime_home=Path("/srv/nexthmi-home"),
            open_url="http://localhost:8000",
            network_urls=(("http://panel-pc:8000", "http://192.168.1.10:8000"),),
            version="1.0.0",
        ),
    )
    rows = _rows(out)
    assert rows == [
        "Default project   http://localhost:8000",
        "Project list      http://localhost:8000/projects",
        "On the network    http://panel-pc:8000 / http://192.168.1.10:8000",
    ]


def test_dev_banner_prints_the_network_block_under_the_rows() -> None:
    """One row per port — the app's and the API's — under a single heading."""
    out = render_banner(
        "dev",
        BannerFields(
            runtime_home=Path("/srv/nexthmi-home"),
            open_url="http://localhost:8001",
            frontend_url="http://localhost:8000",
            network_urls=(
                ("http://panel-pc:8000", "http://192.168.1.10:8000"),
                ("http://panel-pc:8001", "http://192.168.1.10:8001"),
            ),
        ),
    )
    rows = _rows(out)
    assert rows == [
        "Backend           http://localhost:8001",
        "Frontend          http://localhost:8000",
        "Project list      http://localhost:8000/projects",
        "On the network    http://panel-pc:8000 / http://192.168.1.10:8000",
        "http://panel-pc:8001 / http://192.168.1.10:8001",
    ]


def test_banner_omits_the_network_block_when_there_is_nowhere_to_reach_it_from() -> None:
    """A pinned bind, or a machine with no route off-box: core.net hands back
    no URLs and the splash gains no empty heading."""
    for mode in ("runtime", "dev"):
        out = render_banner(mode, _fields())
        assert "On the network" not in out


def test_the_network_heading_survives_an_empty_leading_row() -> None:
    """Rows arrive per port, and a port can resolve to nothing. The heading
    belongs to the first row that has URLs, not to the first tuple."""
    out = render_banner(
        "dev",
        BannerFields(
            runtime_home=Path("/srv/nexthmi-home"),
            open_url="http://localhost:8001",
            frontend_url="http://localhost:8000",
            network_urls=((), ("http://panel-pc:8001",)),
        ),
    )
    assert _rows(out)[-1] == "On the network    http://panel-pc:8001"


def test_dev_banner_shows_both_urls() -> None:
    out = render_banner("dev", _fields())
    assert "http://127.0.0.1:8000" in out
    assert "http://localhost:5173" in out


def test_dev_banner_shows_project_list_link_off_the_frontend_url() -> None:
    out = render_banner("dev", _fields())
    assert "Project list" in out
    assert "http://localhost:5173/projects" in out


def test_banner_never_prints_a_log_path() -> None:
    """Issue #21 — the log file is reachable from Config → Admin; the splash
    only carries the workspace path."""
    for mode in ("runtime", "dev"):
        out = render_banner(mode, _fields())
        assert "Logs" not in out
        assert "nexthmi.log" not in out
