"""``build/render-docs.py`` writes llms-full.txt for the live web copy only."""

import importlib.util
import re
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "build" / "render-docs.py"


@pytest.fixture(scope="module")
def renderer():
    spec = importlib.util.spec_from_file_location("render_docs", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_live_web_copy_gets_llms_full(renderer, tmp_path):
    assert (
        renderer.render(tmp_path, "1.0.0", "oss", offline=False, canonical_base="/docs")
        == 0
    )
    text = (tmp_path / "llms-full.txt").read_text(encoding="utf-8")
    assert "Source: /docs/mcp.html" in text
    assert "](/docs/install.html" in text
    assert not re.search(r"\]\((?!https?:)[^)]*\.md", text)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"offline": True},
        {"offline": False, "canonical_base": "/docs", "archived": True},
    ],
)
def test_other_copies_do_not(renderer, tmp_path, kwargs):
    assert renderer.render(tmp_path, "1.0.0", "oss", **kwargs) == 0
    assert not (tmp_path / "llms-full.txt").exists()


def test_web_copy_leaves_out_unreleased_changelog(renderer, tmp_path):
    assert renderer.render(tmp_path, "1.0.0", "oss", offline=False, canonical_base="/docs") == 0
    for name in ("changelog.html", "llms-full.txt", "search-index.js"):
        assert "Unreleased" not in (tmp_path / name).read_text(encoding="utf-8"), name
    assert "1.1.0" in (tmp_path / "changelog.html").read_text(encoding="utf-8")
