"""``build/release-notes.py`` shortens a CHANGELOG section to entry titles."""

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[2] / "build" / "release-notes.py"
_spec = importlib.util.spec_from_file_location("release_notes", _SCRIPT)
release_notes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release_notes)

CHANGELOG = """# Changelog

## [Unreleased]

- **Not yet.** Body.

## [1.0.1] - 2026-10-24

Fixes only.

### Fixed

- **Browse finds struct members.** A struct tag stopped
  the walk.

- **Writes use the PLC's type**, not the imported one.
  - a nested detail

### Security

- Cookies are `Secure` over HTTPS,
  always.

## [1.0.0] - 2026-09-27

- **Older.** Body.

[1.0.0]: https://example.com
"""


def test_keeps_intro_headings_and_titles_only():
    assert release_notes.short_notes(CHANGELOG, "1.0.1", "o/r") == (
        "Fixes only.\n"
        "\n"
        "### Fixed\n"
        "- Browse finds struct members\n"
        "- Writes use the PLC's type\n"
        "\n"
        "### Security\n"
        "- Cookies are `Secure` over HTTPS,\n"
        "  always.\n"
        "\n"
        "[Full release notes](https://github.com/o/r/blob/v1.0.1/CHANGELOG.md"
        "#101---2026-10-24)\n"
    )


def test_last_section_stops_at_the_link_list():
    assert "example.com" not in release_notes.short_notes(CHANGELOG, "1.0.0", "o/r")


def test_missing_version_prints_nothing():
    assert release_notes.short_notes(CHANGELOG, "9.9.9", "o/r") == ""
