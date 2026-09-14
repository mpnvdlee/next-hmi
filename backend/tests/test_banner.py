"""Terminal splash rendering (``core.banner``)."""
from pathlib import Path

from core.banner import BannerFields, render_banner


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


def test_runtime_banner_shows_default_project_and_projects_link() -> None:
    out = render_banner("runtime", _fields())
    assert "Default project" in out
    assert "Projects" in out
    assert "http://127.0.0.1:8000/projects" in out


def test_runtime_banner_lists_the_other_addresses_under_the_primary() -> None:
    out = render_banner(
        "runtime",
        BannerFields(
            runtime_home=Path("/srv/nexthmi-home"),
            open_url="http://panel-pc:8000",
            alt_urls=("http://192.168.1.10:8000", "http://127.0.0.1:8000"),
            version="1.0.0",
        ),
    )
    lines = [line for line in out.splitlines() if ":8000" in line]
    assert [line.split()[-1] for line in lines[:3]] == [
        "http://panel-pc:8000",
        "http://192.168.1.10:8000",
        "http://127.0.0.1:8000",
    ]
    assert "Default project" in lines[0]
    assert "Projects" in lines[3]


def test_dev_banner_lists_the_other_addresses_under_the_frontend() -> None:
    """The alternates hang off Frontend, the URL a developer opens — and stay
    between it and the Projects link derived from the same primary."""
    out = render_banner(
        "dev",
        BannerFields(
            runtime_home=Path("/srv/nexthmi-home"),
            open_url="http://panel-pc:8000",
            frontend_url="http://panel-pc:5173",
            alt_urls=("http://192.168.1.10:5173", "http://127.0.0.1:5173"),
        ),
    )
    rows = [line.split()[-1] for line in out.splitlines() if "://" in line]
    assert rows == [
        "http://panel-pc:8000",
        "http://panel-pc:5173",
        "http://192.168.1.10:5173",
        "http://127.0.0.1:5173",
        "http://panel-pc:5173/projects",
    ]


def test_dev_banner_shows_both_urls() -> None:
    out = render_banner("dev", _fields())
    assert "http://127.0.0.1:8000" in out
    assert "http://localhost:5173" in out


def test_dev_banner_shows_projects_link_off_the_frontend_url() -> None:
    out = render_banner("dev", _fields())
    assert "Projects" in out
    assert "http://localhost:5173/projects" in out


def test_banner_never_prints_a_log_path() -> None:
    """Issue #21 — the log file is reachable from Config → Admin; the splash
    only carries the workspace path."""
    for mode in ("runtime", "dev"):
        out = render_banner(mode, _fields())
        assert "Logs" not in out
        assert "nexthmi.log" not in out
