"""Integrity checks for project-testbench's curated asset library (backlog #41).

``assets/icons/`` and ``assets/images/`` are a curated picker catalog, kept
available in the editor's asset picker even when no saved page currently
references a given file. This test enforces the two invariants
``project-testbench/assets/PROVENANCE.md`` promises: every asset on disk has
a recorded provenance entry (and vice versa), and every file is at least
minimally decodable as the image/icon format its extension claims.
"""

import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSETS_DIR = REPO_ROOT / "project-testbench" / "assets"
PROVENANCE_PATH = REPO_ROOT / "project-testbench" / "assets" / "PROVENANCE.md"

# project-testbench/ lives in the private enterprise repo and is cloned in for
# dev; it is absent from a public checkout, so these content tests skip there.
pytestmark = pytest.mark.skipif(not ASSETS_DIR.exists(), reason="project-testbench not present")

# Minimal magic-byte checks — enough to catch a truncated/corrupt/placeholder
# file without adding an image-decoding dependency to the backend.
_MAGIC_BYTES: dict[str, bytes] = {
    ".jpg": b"\xff\xd8\xff",
    ".jpeg": b"\xff\xd8\xff",
    ".webp": b"RIFF",  # followed by size + "WEBP", checked separately below
}


def _documented_filenames() -> set[str]:
    text = PROVENANCE_PATH.read_text(encoding="utf-8")
    # Table rows: "| `filename` | ..." — first backtick-quoted cell of each row.
    return set(re.findall(r"^\| `([^`]+)` \|", text, flags=re.MULTILINE))


def _actual_filenames() -> set[str]:
    names = set()
    for sub in ("icons", "images"):
        d = ASSETS_DIR / sub
        if not d.exists():
            continue
        names |= {p.name for p in d.iterdir() if p.is_file() and p.name != ".gitkeep"}
    return names


def test_every_asset_has_a_provenance_entry_and_vice_versa():
    documented = _documented_filenames()
    actual = _actual_filenames()
    missing_docs = actual - documented
    stale_docs = documented - actual
    assert not missing_docs, (
        f"Asset(s) with no PROVENANCE.md entry: {sorted(missing_docs)} — "
        "add a source/license row before committing a new testbench asset."
    )
    assert not stale_docs, (
        f"PROVENANCE.md documents file(s) no longer on disk: {sorted(stale_docs)} — "
        "remove the stale row, or restore the file."
    )


def _all_asset_files():
    for sub in ("icons", "images"):
        d = ASSETS_DIR / sub
        if not d.exists():
            continue
        yield from (p for p in d.iterdir() if p.is_file() and p.name != ".gitkeep")


def test_every_asset_is_minimally_decodable():
    for path in _all_asset_files():
        suffix = path.suffix.lower()
        data = path.read_bytes()
        assert len(data) > 0, f"{path.name} is empty"
        if suffix == ".svg":
            root = ET.fromstring(data)
            assert root.tag.endswith("svg"), f"{path.name} root element is not <svg>: {root.tag}"
        elif suffix == ".webp":
            assert data[:4] == b"RIFF" and data[8:12] == b"WEBP", (
                f"{path.name} is not a valid RIFF/WEBP file"
            )
        elif suffix in (".jpg", ".jpeg"):
            assert data[:3] == _MAGIC_BYTES[suffix], f"{path.name} is not a valid JPEG"
        else:
            raise AssertionError(
                f"{path.name}: unrecognized asset extension {suffix!r} — "
                "add a decodability check above for this format."
            )
