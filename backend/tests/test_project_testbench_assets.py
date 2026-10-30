"""Integrity check for project-testbench's asset library.

Every file under ``assets/icons/`` and ``assets/images/`` must be at least
minimally decodable as the image/icon format its extension claims, so a
truncated or placeholder file never reaches the editor's asset picker.
"""

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSETS_DIR = REPO_ROOT / "project-testbench" / "assets"

# project-testbench/ links to a sibling next-hmi-testbench checkout; it is
# absent from a public checkout, so these content tests skip there.
pytestmark = pytest.mark.skipif(not ASSETS_DIR.exists(), reason="project-testbench not present")

# Minimal magic-byte checks — enough to catch a truncated/corrupt/placeholder
# file without adding an image-decoding dependency to the backend.
_MAGIC_BYTES: dict[str, bytes] = {
    ".jpg": b"\xff\xd8\xff",
    ".jpeg": b"\xff\xd8\xff",
    ".webp": b"RIFF",  # followed by size + "WEBP", checked separately below
}


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
