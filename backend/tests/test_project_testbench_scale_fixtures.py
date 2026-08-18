"""Integrity check for project-testbench's deliberate scale fixture (backlog #40).

``project-testbench/pages/testbindingpage.json`` is not duplication to
compact — it's kept at its current size on purpose, to protect the
editor/runtime against a page with many simultaneous variable-bound widgets.
A cleanup pass that doesn't know this could plausibly "simplify" it down to a
handful of entries; this test fails loudly if that happens, without pinning an
exact count that would make routine edits to the file needlessly fragile.
"""

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PROJECT_TESTBENCH = REPO_ROOT / "project-testbench"

# project-testbench/ lives in the private enterprise repo and is cloned in for
# dev; it is absent from a public checkout, so this content test skips there.
pytestmark = pytest.mark.skipif(not PROJECT_TESTBENCH.exists(), reason="project-testbench not present")

# Order-of-magnitude floor, not an exact count — routine edits to the fixture
# shouldn't need to touch this file; only a drastic, unintentional shrink will.
MIN_TESTBINDINGPAGE_WIDGETS = 100


def _count_widgets(node: dict) -> int:
    return 1 + sum(_count_widgets(c) for c in node.get("children", []))


def test_testbindingpage_is_still_a_large_binding_fixture():
    data = json.loads((PROJECT_TESTBENCH / "pages" / "testbindingpage.json").read_text())
    total = sum(
        _count_widgets(node) for section in data.get("sections", {}).values() for node in section
    )
    assert total >= MIN_TESTBINDINGPAGE_WIDGETS, (
        f"testbindingpage.json dropped to {total} widgets — it's a deliberate "
        "many-simultaneous-bindings scale fixture (maintenance-backlog #40), not "
        "duplication to compact. If this shrink was intentional, update "
        "MIN_TESTBINDINGPAGE_WIDGETS."
    )
