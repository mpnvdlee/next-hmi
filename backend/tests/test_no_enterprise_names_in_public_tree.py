"""No enterprise *feature* is named in the public source or docs tree (item 34).

The artifact/import checks elsewhere prove the public *build* carries no
enterprise code:

- ``test_edition_separation.py`` — no backend module imports the enterprise
  package, and only ``launcher.py`` names an ee entrypoint.
- ``.github/workflows/ci.yml`` — the default frontend bundle carries no marker
  from a stand-in enterprise registry.
- ``build/nexthmi.spec`` — the oss binary refuses the enterprise SPA / tree.

This test covers the half those miss: *prose*. A docs page or a comment that
describes an enterprise module — its internals, or the planned module sequence —
leaks the private roadmap into the public repository even though no code shipped.
It fails if a known enterprise feature name appears anywhere under the scanned
roots except at a reviewed exclusion marker.

Distinguish two things that share the word "audit":

- the **audit-event seam** (``backend/core/audit.py``) is public by design and
  inert in the oss build — its identifiers ("audit-event", "audited",
  ``AuditEvent``) are fine and are *not* denied here;
- the **audit trail** is the enterprise *feature* built on that seam. The phrase
  "audit trail" belongs only in the private repo (or in a line that names it
  solely to say it is *not* public — see ``ALLOWED``).

When a new enterprise module is added, add its distinguishing name to
``ENTERPRISE_FEATURE_NAMES`` here in the same change.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

SCAN_ROOTS = (
    REPO_ROOT / "docs",
    REPO_ROOT / "backend",
    REPO_ROOT / "frontend" / "src",
)

TEXT_SUFFIXES = {".md", ".py", ".ts", ".tsx", ".js", ".jsx", ".txt"}

# Paths whose *segments* exclude them from the scan: build caches and deps.
EXCLUDED_SEGMENTS = {"__pycache__", "node_modules", "dist"}

# This test necessarily contains the denied phrases as literals.
SELF = Path(__file__).name

# Enterprise feature/module names that must never appear in the public tree.
# Keyed by a human label; the value is a case-insensitive regex. Add a row per
# enterprise module as it is created.
ENTERPRISE_FEATURE_NAMES: dict[str, str] = {
    "audit trail (enterprise feature)": r"audit[ _-]trail",
    "license issuer": r"\bgenerate_license\b",
}

# Reviewed exceptions: lines that name an enterprise thing *only to mark it
# excluded from the public build/repo*, which is compliant with item 34 (they
# exclude, they do not describe). Matched as an exact substring of the line.
# Each entry is a (repo-relative path, substring) pair.
ALLOWED: set[tuple[str, str]] = {
    (
        "docs/dev/architecture/backend.md",
        "audit trail is an enterprise feature",
    ),
    (
        "docs/dev/operations/release.md",
        "generate_license.py",
    ),
    (
        # A functioning link, not a description — but the href necessarily
        # repeats the private repo's real filename, which the pattern matches
        # too. The <!-- ee-only --> wrapper around it (see render-docs.py's
        # strip_edition_blocks) already guarantees no oss render ever shows
        # this row, in the offline panel or on the website.
        "docs/user/INDEX.md",
        "enterprise/docs/user/audit-trail.md",
    ),
}


def _scanned_files() -> list[Path]:
    files: list[Path] = []
    seen: set[Path] = set()
    for root in SCAN_ROOTS:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
                continue
            if path.name == SELF or set(path.parts) & EXCLUDED_SEGMENTS:
                continue
            if path not in seen:  # backend/src roots can overlap; dedupe
                seen.add(path)
                files.append(path)
    return files


def test_public_tree_has_no_ee_feature_names():
    patterns = {label: re.compile(rx, re.IGNORECASE) for label, rx in ENTERPRISE_FEATURE_NAMES.items()}
    offenders: list[str] = []

    for path in _scanned_files():
        rel = path.relative_to(REPO_ROOT).as_posix()
        for lineno, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), start=1):
            for label, pattern in patterns.items():
                if not pattern.search(line):
                    continue
                if any(rel == a_path and a_sub in line for a_path, a_sub in ALLOWED):
                    continue
                offenders.append(f"{rel}:{lineno}: names {label!r}: {line.strip()}")

    assert not offenders, (
        "Enterprise feature name(s) found in the public tree. Remove the mention, "
        "or — if it names the feature only to mark it excluded — add it to ALLOWED "
        "with review:\n" + "\n".join(offenders)
    )
