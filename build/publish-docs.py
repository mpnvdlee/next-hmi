#!/usr/bin/env python3
"""Publish the user guide to the website, keeping older releases readable.

    python build/publish-docs.py <site-docs-dir> 1.2.3 [base-url] [--from-git-tags]
                                 [--allow-dropped-pages]

Layout it maintains:

    <site-docs-dir>/                 the latest release — the URL people link
    <site-docs-dir>/v1.2.3/          a frozen copy of each published release
    <site-docs-dir>/versions.json    what the in-page version picker reads
    <site-docs-dir>/sitemap.xml      the latest pages, for search engines

Publishing refuses to drop a page the site already serves — see
``dropped_pages``. That is the guard against publishing an ``oss`` render over
a site whose guide was built with the enterprise pages in it.

Run it against a checkout of the published site (``promotion-website/docs``),
then upload. Re-running for a version that already exists replaces that copy,
which is what you want after fixing a typo in a shipped guide.

A release candidate (any version with a hyphen) gets its ``v<version>/``
directory and a manifest entry exactly like a final release, including the
root copy — there is no version gate on what may serve as the latest guide.

Only the website gets this treatment. The docs inside a release zip are rendered
by ``render-docs.py`` alone and describe exactly the executable they ship beside
— a picker there would offer versions the operator does not have.
"""

from __future__ import annotations

import datetime
import json
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
    if archived:
        command.append("--archived")
    result = subprocess.run(command, check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def is_prerelease(version: str) -> bool:
    """A hyphen marks a candidate — the same rule the release workflow gates on."""
    return "-" in version


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


def write_manifest(
    site_dir: Path, latest: str, base_url: str, *, from_git: bool
) -> list[dict[str, object]]:
    archived: list[str] | None = None
    if from_git:
        archived = released_tags()
        if archived is None:
            print("[docs] no git tags readable — falling back to a directory scan")
    if archived is None:
        # Same rule the tag list applies: candidates are not published versions,
        # so they never appear in the picker — including the one being written
        # right now, which is already on disk by the time this runs.
        archived = sorted(
            (
                p.name
                for p in site_dir.iterdir()
                if p.is_dir() and p.name.startswith("v") and not is_prerelease(p.name)
            ),
            key=version_sort_key,
            reverse=True,
        )
    base = base_url.rstrip("/") or "/"
    entries: list[dict[str, object]] = [{"version": latest, "path": base, "latest": True}]

    for name in archived:
        version = name.lstrip("v")
        if any(entry["version"] == version for entry in entries):
            continue
        entries.append({"version": version, "path": f"{base}/{name}", "latest": False})
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
    from_git = "--from-git-tags" in argv
    allow_dropped = "--allow-dropped-pages" in argv
    if len(args) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    site_dir = Path(args[0]).resolve()
    version = args[1]
    base_url = args[2] if len(args) > 2 else "/docs"
    site_dir.mkdir(parents=True, exist_ok=True)

    archive_dir = site_dir / f"v{version}"
    render(archive_dir, version, base_url, archived=True)

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

    entries = write_manifest(site_dir, version, base_url, from_git=from_git)
    print(f"[docs] published {version} → {site_dir}")
    if dropped and allow_dropped:
        print("[docs] dropped on request: " + ", ".join(dropped))
    print(f"[docs] versions.json lists {len(entries)}: "
          + ", ".join(str(e["version"]) for e in entries))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
