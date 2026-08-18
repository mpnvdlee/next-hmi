"""Regression guard for the LGPL carve-out in ``build/nexthmi.spec`` (item 1a/16).

asyncua (LGPL-3.0) and zeroconf (LGPL-2.1) must ship as *loose, replaceable*
package directories under ``lgpl/`` — never sealed inside the frozen PYZ — or the
proprietary/enterprise build violates LGPL §4. The mechanism has two subtle parts
the release log records getting wrong twice:

  1. the packages must **not** be in ``excludes`` (excluding them also drops their
     exclusive deps — ifaddr/aiofiles/aiosqlite), and must **not** be pulled in by
     ``collect_all`` via ``_collect_targets``; and
  2. after Analysis they must be stripped from ``a.pure``/``a.binaries``/``a.datas``
     so the loose copy on ``sys.path`` wins over the embedded one.

This only manifests in a frozen build, which no CI job exercises, so it is guarded
statically here. The runtime half is in ``test_launcher_lgpl.py``; the full
frozen smoke test (boot the binary, assert asyncua/zeroconf resolve loose) belongs
in the release workflow against a representative build.
"""
import re
from pathlib import Path

import pytest

_SPEC = Path(__file__).resolve().parents[2] / "build" / "nexthmi.spec"
_LGPL = ("asyncua", "zeroconf")


@pytest.fixture(scope="module")
def spec_text() -> str:
    assert _SPEC.is_file(), f"build spec missing at {_SPEC}"
    return _SPEC.read_text(encoding="utf-8")


def _bracketed_block(text: str, name: str) -> str:
    """Return the contents of a ``name = [ ... ]`` list or ``name = ( ... )`` tuple."""
    m = re.search(re.escape(name) + r"\s*=\s*[\[(](.*?)[\])]", text, re.DOTALL)
    assert m, f"could not locate collection `{name}` in the spec"
    return m.group(1)


def test_both_lgpl_packages_declared(spec_text):
    block = _bracketed_block(spec_text, "_LGPL_PKGS")
    for pkg in _LGPL:
        assert f'"{pkg}"' in block or f"'{pkg}'" in block, f"{pkg} not in _LGPL_PKGS"


def test_shipped_loose_under_lgpl_dir(spec_text):
    # datas gains a loose copy destined for lgpl/<pkg>.
    assert 'f"lgpl/{_lgpl_pkg}"' in spec_text or "lgpl/{_lgpl_pkg}" in spec_text


def test_stripped_from_archive_after_analysis(spec_text):
    for attr in ("a.pure", "a.binaries", "a.datas"):
        pattern = attr + r"\s*=\s*\[.*?_is_lgpl"
        assert re.search(pattern, spec_text, re.DOTALL), (
            f"{attr} is not filtered by _is_lgpl — LGPL pkgs would ship in the archive"
        )


@pytest.mark.parametrize("pkg", _LGPL)
def test_not_excluded_from_analysis(spec_text, pkg):
    # Gotcha #1: excluding them drops their exclusive dependency closure too.
    excludes = _bracketed_block(spec_text, "excludes")
    assert pkg not in excludes, f"{pkg} must NOT be in Analysis excludes (drops its deps)"


@pytest.mark.parametrize("pkg", _LGPL)
def test_not_collected(spec_text, pkg):
    # collect_all would re-embed them; they ship loose instead.
    collected = _bracketed_block(spec_text, "_collect_targets")
    assert pkg not in collected, f"{pkg} must NOT be in _collect_targets"
