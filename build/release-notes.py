#!/usr/bin/env python3
"""Short release notes for a GitHub Release, from CHANGELOG.md.

    python build/release-notes.py 1.0.1 owner/repo > notes.md

Keeps the section's intro and headings, and of each ``- **Title.** body`` entry
only the title; the full text stays one link away. Prints nothing when the
changelog has no section for the version, so the caller can fall back.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

CHANGELOG = Path(__file__).resolve().parent.parent / "CHANGELOG.md"


def short_notes(changelog: str, version: str, repo: str) -> str:
    lines = changelog.splitlines()
    head = f"## [{version}]"
    start = next((i for i, line in enumerate(lines) if line.startswith(head)), None)
    if start is None:
        return ""
    out: list[str] = []
    keep = True  # whether indented continuation lines belong in the output
    for line in lines[start + 1 :]:
        if line.startswith("## [") or re.match(r"\[[^]]+\]: ", line):
            break
        title = re.match(r"- \*\*(.+?)\*\*", line)
        if title:
            out.append(f"- {title.group(1).rstrip('.')}")
            keep = False
        elif line.startswith(("- ", "#")) or not line.strip():
            out.append(line)
            keep = True
        elif keep:
            out.append(line)
    body = re.sub(r"\n{3,}", "\n\n", "\n".join(out).strip())
    body = re.sub(r"\n\n(?=- )", "\n", body)
    # GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens.
    anchor = re.sub(r"[^a-z0-9 -]", "", lines[start][3:].lower()).replace(" ", "-")
    url = f"https://github.com/{repo}/blob/v{version}/CHANGELOG.md#{anchor}"
    return f"{body}\n\n[Full release notes]({url})\n"


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    sys.stdout.write(short_notes(CHANGELOG.read_text(encoding="utf-8"), *sys.argv[1:]))
