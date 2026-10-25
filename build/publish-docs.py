#!/usr/bin/env python3
"""Publish the user guide to the website, keeping older releases readable.

    python build/publish-docs.py <site-docs-dir> 1.2.3 [base-url] [--allow-dropped-pages]

Layout it maintains:

    <site-docs-dir>/                 the newest minor line — the URL people link
    <site-docs-dir>/v1.2/            one copy per minor line, which each patch
                                     release overwrites, changelog included
    <site-docs-dir>/versions.json    what the in-page version picker reads
    <site-docs-dir>/sitemap.xml      the latest pages, for search engines

Publishing refuses to drop a page the site already serves — see
``dropped_pages``. That is the guard against publishing an ``oss`` render over
a site whose guide was built with the enterprise pages in it.

Run it against a checkout of the published site (``promotion-website/public_html/docs``),
then upload. A patch for an older line (``1.0.2`` once ``1.1.0`` is out) updates
only ``v1.0/``; the root stays on the newest line. The lines come from the
repository's final tags, so run it from a checkout that has them.

Set ``NEXTHMI_DOCS_ANALYTICS_TAG_FILE`` to a file holding an HTML snippet and
every published page carries it — that is how the site counts page views. Leave
it unset and the guide is published without any. See ``ANALYTICS_TAG_ENV``.

A release candidate (any version with a hyphen) writes its line's directory,
manifest entry and — when its line is the newest — the root copy, exactly like
a final release.

Only the website gets this treatment. The docs inside a release zip are rendered
by ``render-docs.py`` alone and describe exactly the executable they ship beside
— a picker there would offer versions the operator does not have.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

BUILD_DIR = Path(__file__).resolve().parent
RENDERER = BUILD_DIR / "render-docs.py"

# Sitemap entries must be absolute, so the one place in the build that knows the
# published host says it here. Everything else the renderer emits — canonical
# URLs included — stays root-relative and host-agnostic.
SITE_ORIGIN = "https://next-hmi.com"

# Path to an HTML snippet the published pages carry in their ``<head>`` —
# whatever the site counts page views with. Read from the environment rather
# than named here because this file is public: a path baked into it would make
# every fork that publishes a guide report its readers to the account of
# whoever wrote the tag. Unset means no analytics, which is the right default
# for anyone who is not the person publishing next-hmi.com.
ANALYTICS_TAG_ENV = "NEXTHMI_DOCS_ANALYTICS_TAG_FILE"


def version_sort_key(name: str) -> tuple[int, ...]:
    """Newest first. Non-numeric segments sort low rather than raising."""
    parts: list[int] = []
    for chunk in name.lstrip("v").replace("-", ".").split("."):
        parts.append(int(chunk) if chunk.isdigit() else -1)
    return tuple(parts)


def render(out_dir: Path, version: str, base_url: str, *, archived: bool) -> None:
    """Render one copy of the guide for the published site.

    ``base_url`` is the path the *latest* guide is served from. It reaches the
    renderer twice: as the manifest URL the version picker fetches, and as the
    canonical base every page points at — which is what stops an archived copy
    competing with the live page it duplicates.
    """
    base = base_url.rstrip("/") or ""
    command = [
        sys.executable,
        str(RENDERER),
        str(out_dir),
        version,
        "--web",
        "--versions-url",
        f"{base}/versions.json",
        "--canonical-base",
        base or "/",
    ]
    # Archived copies get the tag too: which version a reader lands on is the
    # question the numbers are worth having for.
    tag_file = os.environ.get(ANALYTICS_TAG_ENV, "").strip()
    if tag_file:
        command += ["--analytics-tag-file", tag_file]
    if archived:
        command.append("--archived")
    result = subprocess.run(command, check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def minor_line(version: str) -> str:
    """``1.0.2`` → ``1.0``: the docs keep one copy per minor line."""
    return ".".join(version.lstrip("v").split("-")[0].split(".")[:2])


def released_tags() -> list[str] | None:
    """Final ``vX.Y.Z`` tags, newest first. ``None`` only when git itself fails.

    Preferred over scanning the output directory when it works: in CI the site
    does not exist yet, and the tag list is authoritative about what has
    actually shipped. Pre-release tags (any with a hyphen) are excluded — they
    never produce a Release, so their docs are never published either.
    """
    try:
        result = subprocess.run(
            ["git", "tag", "--list", "v*"],
            capture_output=True,
            text=True,
            check=True,
            cwd=BUILD_DIR.parent,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    tags = [t.strip() for t in result.stdout.splitlines() if t.strip() and "-" not in t]
    # An empty list is an answer — a repo whose only tags are release
    # candidates has published nothing — and must not fall back to a scan.
    return sorted(tags, key=version_sort_key, reverse=True)


def published_lines(site_dir: Path, version: str) -> dict[str, str]:
    """Newest version per minor line, newest line first, ``version`` included."""
    names = released_tags()
    if names is None:
        print("[docs] no git tags readable — falling back to a directory scan")
        names = [
            p.name
            for p in site_dir.iterdir()
            if p.is_dir() and re.fullmatch(r"v\d+\.\d+", p.name)
        ]
    newest: dict[str, str] = {}
    for name in sorted(names, key=version_sort_key):
        newest[minor_line(name)] = name.lstrip("v")
    # The copy on disk is the one being published, even when it re-publishes an
    # older patch, and the picker selects its entry by exact version.
    newest[minor_line(version)] = version
    return dict(sorted(newest.items(), key=lambda kv: version_sort_key(kv[0]), reverse=True))


def write_manifest(site_dir: Path, lines: dict[str, str], base_url: str) -> list[dict[str, object]]:
    base = base_url.rstrip("/") or "/"
    entries: list[dict[str, object]] = [
        {"version": version, "path": base if i == 0 else f"{base}/v{line}", "latest": i == 0}
        for i, (line, version) in enumerate(lines.items())
    ]
    (site_dir / "versions.json").write_text(
        json.dumps({"versions": entries}, indent=2) + "\n", encoding="utf-8"
    )
    return entries


def dropped_pages(site_dir: Path, staging: Path) -> list[str]:
    """Pages the live root serves that this render did not produce.

    Publishing overwrites the root, so anything only the old tree has is a URL
    about to start 404ing. The usual cause is an edition mismatch — an ``oss``
    render over a site whose guide was built with the enterprise pages in it.
    """
    published = {p.name for p in site_dir.glob("*.html")}
    rendered = {p.name for p in staging.glob("*.html")}
    return sorted(published - rendered)


def write_sitemap(site_dir: Path, base_url: str) -> int:
    """A sitemap for the guide, written where the guide is.

    Hand-listing generated pages in the website's own sitemap.xml guarantees
    drift: the page list is decided here, one directory down, every release.
    A sitemap may only cover its own directory and below, which is exactly the
    tree this writes — the site's root sitemap links to it rather than
    restating it. Only the latest copy is listed; archived versions carry
    ``noindex`` and canonicalise here.
    """
    base = base_url.rstrip("/")
    today = datetime.date.today().isoformat()
    urls: list[str] = []
    for page in sorted(site_dir.glob("*.html")):
        path = f"{base}/" if page.name == "index.html" else f"{base}/{page.name}"
        urls.append(f"  <url><loc>{SITE_ORIGIN}{path}</loc><lastmod>{today}</lastmod></url>")
    (site_dir / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!-- Written by build/publish-docs.py. The page list follows the guide,\n"
        "     so it cannot drift from what was rendered. -->\n"
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(urls)
        + "\n</urlset>\n",
        encoding="utf-8",
    )
    return len(urls)


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    allow_dropped = "--allow-dropped-pages" in argv
    if len(args) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    site_dir = Path(args[0]).resolve()
    version = args[1]
    base_url = args[2] if len(args) > 2 else "/docs"
    site_dir.mkdir(parents=True, exist_ok=True)

    lines = published_lines(site_dir, version)
    line = minor_line(version)
    render(site_dir / f"v{line}", version, base_url, archived=True)
    if line != next(iter(lines)):
        write_manifest(site_dir, lines, base_url)
        print(f"[docs] published {version} → v{line}/; the root stays on {next(iter(lines.values()))}")
        return 0

    # The latest copy is rendered separately rather than copied, so a future
    # change to how "latest" is presented does not need the archive rebuilt.
    # It is rendered *before* anything published is removed, so the two page
    # sets can be compared while both still exist.
    staging = site_dir / ".latest"
    if staging.exists():
        shutil.rmtree(staging)
    render(staging, version, base_url, archived=False)
    dropped = dropped_pages(site_dir, staging)
    if dropped and not allow_dropped:
        shutil.rmtree(staging)
        print(
            "[docs] this render is missing pages the site already publishes: "
            + ", ".join(dropped),
            file=sys.stderr,
        )
        print(
            "[docs] usually an edition mismatch — the site is an ee tree and "
            "this checkout has no enterprise/ to render from. Re-run with "
            "NEXTHMI_EDITION=ee from a checkout that has it, or pass "
            "--allow-dropped-pages if the pages are meant to go.",
            file=sys.stderr,
        )
        return 1
    for child in site_dir.iterdir():
        if child == staging:
            continue
        if child.is_file():
            child.unlink()
        elif not child.name.startswith("v"):
            shutil.rmtree(child)
    for child in staging.iterdir():
        shutil.move(str(child), site_dir / child.name)
    shutil.rmtree(staging)
    write_sitemap(site_dir, base_url)

    entries = write_manifest(site_dir, lines, base_url)
    print(f"[docs] published {version} → {site_dir}")
    if dropped and allow_dropped:
        print("[docs] dropped on request: " + ", ".join(dropped))
    print(f"[docs] versions.json lists {len(entries)}: "
          + ", ".join(str(e["version"]) for e in entries))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
