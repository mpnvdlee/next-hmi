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
    out = render_banner("runtime", _fields())
    assert "Runtime home" in out
    assert "/srv/nexthmi-home" in out
    assert "http://127.0.0.1:8000" in out
    assert "v1.0.0" in out


def test_dev_banner_shows_both_urls() -> None:
    out = render_banner("dev", _fields())
    assert "http://127.0.0.1:8000" in out
    assert "http://localhost:5173" in out


def test_banner_never_prints_a_log_path() -> None:
    """Issue #21 — the log file is reachable from Config → Admin; the splash
    only carries the workspace path."""
    for mode in ("runtime", "dev"):
        out = render_banner(mode, _fields())
        assert "Logs" not in out
        assert "nexthmi.log" not in out
