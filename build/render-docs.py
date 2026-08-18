#!/usr/bin/env python3
"""Render the user guide (``docs/user/``) into a static HTML site.

Run from the repo root (the build scripts do this for you):

    python build/render-docs.py dist/nexthmi-macos-arm64/docs 1.2.3

``--web`` renders for next-hmi.com; the default assumes an offline panel and
drops everything that would reach the network — the webfonts, the GitHub button
in the top bar, the version picker. Hyperlinks written into the guide's prose
stay in both renders: a dead link is still a readable URL an operator can carry
to a machine that does have a network, and rewriting them per edition would give
the two builds different text. ``--edition ee`` overrides ``NEXTHMI_EDITION``.

``--versions-url``, ``--canonical-base`` and ``--archived`` place the render
inside a published site: where the version picker reads its manifest, where the
canonical URL of each page is, and whether this copy is a frozen archive that
should point at the live one instead of competing with it. ``publish-docs.py``
passes all three; a bare ``--web`` render keeps the defaults, which is what you
want for a local look.

Only the user guide is rendered. ``docs/dev/`` is read on GitHub, where it
already lives at the URLs people link — a second HTML copy of it has no reader,
and shipping it behind the editor's Help button is what put ``rest-api.md`` in
front of operators. Links from the guide into ``docs/dev/`` are rewritten to
GitHub URLs so they still resolve from the rendered site.

The output is self-contained — one stylesheet, one search index, one inline
script, no external requests — so it opens straight off the filesystem on a
shop-floor machine with no network, and the backend serves it at ``/help`` (see
``backend/api/docs_api.py``). Its stylesheet lives in
``build/docs-assets/docs.css``.

The guide is its own site, not a page of the promotion website. It borrows that
site's palette and faces and nothing else: no marketing nav, no marketing
footer. A reader is here to look something up, and every link that leaves for
next-hmi.com is a link out of the thing they are reading. The promotion site
links *in*; the guide does not link back out.

Enterprise guide pages are appended only when ``NEXTHMI_EDITION=ee`` (or
``--edition ee``). Presence of ``enterprise/`` is deliberately *not* the test —
a maintainer's checkout has it cloned in, and an ``oss`` build there must not
bundle it. A page shared by both editions can reference them anyway by
wrapping the reference in ``<!-- ee-only -->...<!-- /ee-only -->``: an ``oss``
render drops the block, an ``ee`` render keeps its content and discards just
the markers. See ``strip_edition_blocks``.

Build-time only: markdown-it-py is a dev/build dependency, never a runtime one.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import posixpath
import re
import shutil
import sys
from pathlib import Path

from markdown_it import MarkdownIt

# A Windows console hands Python a cp1252 stdout, which cannot encode the
# non-ASCII characters in the progress lines below.
for _stream in (sys.stdout, sys.stderr):
    _stream.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = Path(__file__).resolve().parent / "docs-assets"

GITHUB_BLOB = "https://github.com/mpnvdlee/next-hmi/blob/main/"

# Where the published site keeps its list of releases. Read at runtime by the
# version picker; build/publish-docs.py writes it, and passes --versions-url so
# a site served from another path still finds it.
DEFAULT_VERSIONS_URL = "/docs/versions.json"

# (source path relative to the repo root, section heading in the sidebar).
# Ordered — the sidebar, the page numbering, and the pager all follow this list.
USER_SOURCES: list[tuple[str, str]] = [
    ("docs/user/INDEX.md", "Get started"),
    ("docs/user/overview.md", "Get started"),
    ("docs/user/getting-started.md", "Get started"),
    ("docs/user/install.md", "Get started"),
    ("docs/user/projects.md", "Get started"),
    ("docs/user/files.md", "Get started"),
    ("docs/user/editor.md", "The editor"),
    ("docs/user/pages.md", "The editor"),
    ("docs/user/widgets.md", "The editor"),
    ("docs/user/layout.md", "The editor"),
    ("docs/user/actions.md", "The editor"),
    ("docs/user/datasources.md", "Data"),
    ("docs/user/subscribing.md", "Data"),
    ("docs/user/properties.md", "Data"),
    ("docs/user/historian.md", "Data"),
    ("docs/user/catalog.md", "Widgets & styling"),
    ("docs/user/theming.md", "Widgets & styling"),
    ("docs/user/translations.md", "Widgets & styling"),
    ("docs/user/alarms-recipes.md", "Widgets & styling"),
    ("docs/user/custom-widgets.md", "Widgets & styling"),
    ("docs/user/users.md", "Operations"),
    ("docs/user/diagnostics.md", "Operations"),
    ("docs/user/mcp.md", "Operations"),
    ("CHANGELOG.md", "Project"),
    (".github/SECURITY.md", "Project"),
    ("docs/user/licence.md", "Licensing"),
    ("COMMERCIAL.md", "Licensing"),
    ("LICENSING.md", "Licensing"),
    ("LICENSE", "Licensing"),
    ("LICENSE-EXCEPTION.md", "Licensing"),
    ("NOTICE", "Licensing"),
]

# Licensing first: activating the build is what an operator does before
# anything else in an ee install, including reading about the module.
ENTERPRISE_SOURCES: list[tuple[str, str]] = [
    ("enterprise/docs/user/licensing.md", "Enterprise"),
    ("enterprise/docs/user/audit-trail.md", "Enterprise"),
]

# Plain-text files that must still be readable in the browser — wrapped in a
# <pre> instead of being run through the Markdown parser, which would mangle
# licence text.
VERBATIM_SUFFIXES = {".txt", ""}

# The page shell is styled by classes the promotion website already defines, so
# Markdown's bare output needs the same classes bolted on. Everything else the
# stylesheet already covers; this bridges what hand-written HTML spelled out.
MARKDOWN_BRIDGE_CSS = """
.page ul, .page ol { margin: 14px 0 0; padding-left: 22px; }
.page li { font-size: 15.5px; color: var(--ink-2); margin-top: 7px; }
.page li > ul, .page li > ol { margin-top: 7px; }
.page a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.page a:hover { text-decoration-thickness: 2px; }
.page h4 { font-size: 15.5px; font-weight: 600; margin: 22px 0 0; }
.page hr { border: none; border-top: 1px solid var(--line); margin: 40px 0 0; }
.page blockquote { margin: 22px 0 0; padding-left: 16px; border-left: 3px solid var(--line); color: var(--ink-3); }
.page .code-card code { font-family: var(--mono); font-size: 13px; color: var(--code-fg); background: none; }
.page img { max-width: 100%; height: auto; display: block; }
.doc-figure { margin: 26px 0 0; }
.doc-figure img { border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-card); background: var(--paper-2); }
.doc-figure figcaption { margin-top: 10px; font-size: 13.5px; color: var(--ink-3); text-wrap: pretty; }
"""

CALLOUT_KINDS = {
    "NOTE": "note",
    "TIP": "note tip",
    "IMPORTANT": "note",
    "WARNING": "note warn",
    "CAUTION": "note warn",
}

CALLOUT_ICON = (
    '<span class="ci"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    'stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/>'
    '<path d="M12 8h.01M11 12h1v4h1"/></svg></span>'
)


def edition() -> str:
    return (os.environ.get("NEXTHMI_EDITION") or "oss").strip().lower()


def sources_for(current_edition: str) -> list[tuple[str, str]]:
    if current_edition == "ee":
        return USER_SOURCES + ENTERPRISE_SOURCES
    return list(USER_SOURCES)


# Two sources would otherwise both flatten onto ``licensing.html``: the root
# overview and the enterprise operator guide. The guide keeps the plain URL —
# it is the one already published and linked.
OUTPUT_OVERRIDES: dict[str, str] = {"LICENSING.md": "licensing-overview.html"}


def output_name(source: str) -> str:
    """Flat output filename for a source path (``docs/user/a.md`` → ``a.html``)."""
    if source in OUTPUT_OVERRIDES:
        return OUTPUT_OVERRIDES[source]
    stem = source
    for prefix in ("enterprise/docs/user/", "docs/user/", "docs/", ".github/"):
        if stem.startswith(prefix):
            stem = stem[len(prefix) :]
            break
    stem = stem.rsplit(".", 1)[0]
    return stem.replace("/", "-").lower() + ".html"


def page_title(source: str, text: str) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return Path(source).stem.replace("-", " ").title()


def rewrite_links(body: str, link_map: dict[str, str], source: str) -> str:
    """Point Markdown links at their rendered pages, or at GitHub.

    Every relative link is first resolved against the file it was written in,
    then looked up. Three outcomes: a link to another rendered page becomes its
    ``.html`` name; a link into ``docs/dev/`` — which is never rendered —
    becomes an absolute GitHub URL; anything else is left alone.

    Resolving *before* the lookup is what lets a page use the path that is also
    correct on GitHub. ``docs/user/licence.md`` linking ``../../COMMERCIAL.md``
    works when read in the repository *and* becomes ``commercial.html`` here.
    Matching the bare filename instead would force a page to choose which of
    the two audiences to break, and a hand-written GitHub URL — the third
    option — would keep pointing at GitHub for a page that is rendered right
    here beside it.

    The ``docs/dev/`` rewrite is the one case that deliberately leaves the
    guide for an external host, in both renders. Those pages have no rendered
    copy to point at, and an offline reader is better served by a URL they can
    read and carry off the panel than by link text that goes nowhere.
    """
    source_dir = posixpath.dirname(source)

    def rewrite(match: re.Match[str]) -> str:
        href = match.group(1)
        if href.startswith(("http://", "https://", "#", "mailto:", "/")):
            return match.group(0)
        path, _, anchor = href.partition("#")
        if not path:
            return match.group(0)
        resolved = posixpath.normpath(posixpath.join(source_dir, path))
        suffix = f"#{anchor}" if anchor else ""
        # Keep any ``#anchor`` — the heading ids added by ``apply_heading_ids``
        # make cross-page anchors resolve on the site as they do on GitHub.
        if resolved in link_map:
            return f'href="{link_map[resolved]}{suffix}"'
        if resolved.startswith("docs/dev/"):
            return f'href="{GITHUB_BLOB}{resolved}{suffix}"'
        return match.group(0)

    return re.sub(r'href="([^"]+)"', rewrite, body)


def apply_classes(body: str) -> str:
    """Give Markdown's output the classes the website stylesheet expects."""
    body = re.sub(
        r"<table>(.*?)</table>",
        lambda m: f'<div class="tbl-wrap scroll-x"><table class="data">{m.group(1)}</table></div>',
        body,
        flags=re.S,
    )
    body = re.sub(
        r"<pre>(<code.*?</code>)</pre>",
        lambda m: f'<div class="code-card"><pre>{m.group(1)}</pre></div>',
        body,
        flags=re.S,
    )
    # Inline code only — the fenced blocks above already carry their own wrapper.
    body = re.sub(r"<code>(?!</)", '<code class="inline-code">', body)
    body = body.replace('<div class="code-card"><pre><code class="inline-code">',
                        '<div class="code-card"><pre><code>')
    # The paragraph directly after the title reads as the page's standfirst.
    body = re.sub(r"(</h1>\s*)<p>", r'\1<p class="lead">', body, count=1)
    body = apply_figures(body)
    body = apply_heading_ids(body)
    return body


def heading_slug(text: str) -> str:
    """GitHub's heading slug, so ``[…](#same-page-anchor)`` resolves identically
    here and on GitHub — the same file is read in both places."""
    slug = re.sub(r"<[^>]+>", "", text)  # inline markup (code, emphasis, links)
    slug = html.unescape(slug).strip().lower()
    slug = re.sub(r"[^\w\s-]", "", slug)
    # One hyphen per whitespace character, not per run: "A & B" loses the "&"
    # and keeps both spaces, which GitHub renders as a double hyphen.
    return re.sub(r"\s", "-", slug)


def apply_heading_ids(body: str) -> str:
    """Give every h2–h4 a slug id. ``markdown-it`` emits bare heading tags, so
    without this every in-page anchor in the guide is a dead link on the site."""
    seen: dict[str, int] = {}

    def convert(match: re.Match[str]) -> str:
        level, inner = match.group(1), match.group(2)
        slug = heading_slug(inner)
        if not slug:
            return match.group(0)
        count = seen.get(slug, 0)
        seen[slug] = count + 1
        if count:
            slug = f"{slug}-{count}"
        return f'<h{level} id="{slug}">{inner}</h{level}>'

    return re.sub(r"<h([234])>(.*?)</h\1>", convert, body, flags=re.S)


def apply_figures(body: str) -> str:
    """A paragraph holding nothing but an image becomes a captioned figure.

    The alt text becomes the visible caption, and the image's own ``alt`` is
    emptied in the same move: the caption is right there in the reading order,
    so leaving both makes a screen reader announce the same sentence twice.
    An image used inline inside a sentence keeps its alt and is left alone.
    """

    def convert(match: re.Match[str]) -> str:
        tag = match.group(1)
        alt_match = re.search(r'alt="([^"]*)"', tag)
        alt = alt_match.group(1) if alt_match else ""
        if not alt:
            return f'<figure class="doc-figure">{tag}</figure>'
        tag = tag.replace(alt_match.group(0), 'alt=""', 1)
        return f'<figure class="doc-figure">{tag}<figcaption>{alt}</figcaption></figure>'

    return re.sub(r"<p>(<img[^>]*>)</p>", convert, body)


def apply_callouts(body: str) -> str:
    """``> [!NOTE]`` blockquotes become the site's callout cards.

    GitHub renders the same syntax natively, so the Markdown still reads
    correctly unrendered — which matters because these files are browsed there.
    """
    pattern = re.compile(r"<blockquote>\s*<p>\s*\[!(\w+)\]\s*(?:<br\s*/?>)?\s*", re.S)

    out = body
    while True:
        match = pattern.search(out)
        if match is None:
            return out
        css = CALLOUT_KINDS.get(match.group(1).upper())
        end = out.find("</blockquote>", match.end())
        if css is None or end == -1:
            return out
        inner = f"<p>{out[match.end():end]}"
        replacement = f'<div class="{css}">{CALLOUT_ICON}<div>{inner}</div></div>'
        out = out[: match.start()] + replacement + out[end + len("</blockquote>") :]


EDITION_BLOCK_RE = re.compile(r"<!--\s*ee-only\s*-->(.*?)<!--\s*/ee-only\s*-->\n?", re.S)


def strip_edition_blocks(text: str, current_edition: str) -> str:
    """Resolve ``<!-- ee-only -->...<!-- /ee-only -->`` blocks for one edition.

    Lets a page shared by both editions — the guide's ``INDEX.md`` table of
    contents, mainly — carry rows that only make sense once the enterprise
    pages exist. An ``oss`` render drops the block outright; an ``ee`` render
    keeps its content and discards just the markers. Runs before the generic
    comment-strip below, which would otherwise delete the markers themselves
    and leave an ``oss`` render showing enterprise-only content as plain text.
    """
    if current_edition == "ee":
        return EDITION_BLOCK_RE.sub(lambda m: m.group(1), text)
    return EDITION_BLOCK_RE.sub("", text)


def copy_images(out_dir: Path, current_edition: str) -> int:
    """Copy the guide's images beside the rendered pages.

    Sources keep them in ``images/`` next to the markdown, so the same relative
    link resolves both on GitHub and in the rendered output — no rewriting, and
    an author can see what they wrote before it is built. Copied rather than
    linked because the bundle has to work on a machine with no network.
    """
    sources = [REPO_ROOT / "docs/user/images"]
    if current_edition == "ee":
        sources.append(REPO_ROOT / "enterprise/docs/user/images")

    copied = 0
    for source in sources:
        if not source.is_dir():
            continue
        for item in sorted(source.iterdir()):
            if item.name.startswith(".") or not item.is_file():
                continue
            (out_dir / "images").mkdir(exist_ok=True)
            shutil.copyfile(item, out_dir / "images" / item.name)
            copied += 1
    return copied


TAG_RE = re.compile(r"<[^>]+>")
SEARCH_HEADING_RE = re.compile(r'<h([23]) id="([^"]+)">(.*?)</h\1>', re.S)


def search_text(fragment: str) -> str:
    """Rendered HTML down to the words a reader would search for."""
    return re.sub(r"\s+", " ", html.unescape(TAG_RE.sub(" ", fragment))).strip()


LEAD_RE = re.compile(r'<p class="lead">(.*?)</p>', re.S)
FIRST_P_RE = re.compile(r"<p>(.*?)</p>", re.S)


def page_description(body: str, limit: int = 155) -> str:
    """The page's standfirst, as the ``<meta name="description">`` text.

    Never written by hand: the paragraph under the title is already the summary
    an author wrote for this reader, so a search result that quotes it makes the
    same promise the page keeps. A verbatim page — a licence — has no paragraph,
    and gets no description rather than a truncated clause.
    """
    match = LEAD_RE.search(body) or FIRST_P_RE.search(body)
    if not match:
        return ""
    text = search_text(match.group(1))
    if len(text) <= limit:
        return text
    # Cut on a word, not mid-syllable; the ellipsis is part of the budget.
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:—-")
    return f"{cut}…"


def canonical_url(base: str, page: str) -> str:
    """Where this page lives on the website, for ``<link rel="canonical">``.

    ``base`` is the published root of the *latest* guide (``/docs``), so an
    archived version copy canonicalises to the current page rather than
    competing with it — every release would otherwise publish a full duplicate
    of every page. Root-relative rather than absolute: the site is one origin,
    and hard-coding the domain here would put it in the offline renderer too.
    """
    if not base:
        return ""
    base = base.rstrip("/")
    return f"{base}/" if page == "index.html" else f"{base}/{page}"


def search_sections(body: str) -> list[tuple[str, str, str]]:
    """Split a rendered page into ``(anchor, heading, text)`` search records.

    One record per ``h2``/``h3``, plus whatever sits above the first heading, so
    a hit can land on the section holding it instead of the top of the page.
    The ids ``apply_heading_ids`` already assigned are what makes that link.
    """
    heads = list(SEARCH_HEADING_RE.finditer(body))
    intro = body[: heads[0].start()] if heads else body
    # The h1 is the page title, which every record carries alongside its text.
    intro = re.sub(r"<h1>.*?</h1>", " ", intro, flags=re.S)
    records = [("", "", search_text(intro))]
    for position, match in enumerate(heads):
        end = heads[position + 1].start() if position + 1 < len(heads) else len(body)
        records.append(
            (match.group(2), search_text(match.group(3)), search_text(body[match.end() : end]))
        )
    return records


def build_search_index(
    pages: list[tuple[str, str, str]],
    bodies: list[tuple[str, str]],
    indexed: list[bool],
) -> str:
    """The whole guide as one JavaScript file the search box loads once.

    A separate file rather than an inline blob: every page would otherwise
    carry its own copy of the entire guide. It is loaded with ``<script src>``
    and not ``fetch`` because a browser refuses a ``file://`` fetch, and the
    offline bundle is opened exactly that way. Keys are one letter because this
    ships with every release and the text is already the payload.

    ``indexed`` drops the verbatim pages — the licence texts and NOTICE — from
    the corpus. They are a fifth of it by weight, they have no headings to land
    a hit on, and nobody full-text searches a licence from a guide's search box;
    their titles still reach the reader through the sidebar. Their page rows
    stay in place so ``pages`` and the record indices keep lining up.
    """
    page_rows = [
        [href, title]
        for (_src, _section, title), (href, _body) in zip(pages, bodies, strict=True)
    ]
    records: list[list[object]] = []
    for page_index, (_href, body) in enumerate(bodies):
        if not indexed[page_index]:
            continue
        for anchor, heading, text in search_sections(body):
            if not text and not heading:
                continue
            records.append([page_index, heading, anchor, text])
    payload = {"p": page_rows, "s": records}
    return (
        "window.__NEXTHMI_DOCS_SEARCH__ = "
        + json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        + ";\n"
    )


def render(
    out_dir: Path,
    version: str,
    current_edition: str,
    *,
    offline: bool,
    versions_url: str = DEFAULT_VERSIONS_URL,
    canonical_base: str = "",
    archived: bool = False,
) -> int:
    sources = sources_for(current_edition)
    present = [(src, section) for src, section in sources if (REPO_ROOT / src).is_file()]
    if not present:
        print("[docs] no sources found — nothing to render", file=sys.stderr)
        return 1

    claimed: dict[str, str] = {}
    for src, _section in present:
        name = output_name(src)
        if name in claimed:
            print(
                f"[docs] {src} and {claimed[name]} both render to {name} — "
                "add an OUTPUT_OVERRIDES entry",
                file=sys.stderr,
            )
            return 1
        claimed[name] = src

    link_map: dict[str, str] = {}
    for src, _section in present:
        rendered = output_name(src)
        parts = src.split("/")
        for i in range(len(parts)):
            link_map["/".join(parts[i:])] = rendered

    md = MarkdownIt("commonmark", {"html": False, "linkify": False}).enable("table")

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    stylesheet = (ASSETS_DIR / "docs.css").read_text(encoding="utf-8") + MARKDOWN_BRIDGE_CSS
    (out_dir / "style.css").write_text(stylesheet, encoding="utf-8")
    # /docs/style.css is a stable URL whose contents change every release, and
    # the site serves CSS with a long TTL — without this a reader keeps the
    # previous release's stylesheet and sees the new markup unstyled. Keyed on
    # content, not version, so re-rendering the same version still busts it.
    # Offline only ever loads from a freshly unzipped directory, and a query
    # string on a file:// URL is a risk with nothing to buy.
    stylesheet_query = "" if offline else "?v=" + hashlib.sha256(
        stylesheet.encode("utf-8")
    ).hexdigest()[:10]
    copy_images(out_dir, current_edition)

    pages = [
        (src, section, page_title(src, (REPO_ROOT / src).read_text(encoding="utf-8")))
        for src, section in present
    ]

    # Every body is rendered first: the search index is built from them, and
    # each page has to carry the index's cache-busting URL.
    bodies: list[tuple[str, str]] = []
    indexed: list[bool] = []
    for src, _section, title in pages:
        text = (REPO_ROOT / src).read_text(encoding="utf-8")
        verbatim = Path(src).suffix in VERBATIM_SUFFIXES
        if verbatim:
            body = f"<h1>{html.escape(title)}</h1><pre>{html.escape(text)}</pre>"
        else:
            text = strip_edition_blocks(text, current_edition)
            # The parser runs with html=False, which escapes comments rather than
            # dropping them — a generated-file marker would render as body text.
            text = re.sub(r"<!--.*?-->\s*", "", text, flags=re.S)
            body = apply_classes(apply_callouts(rewrite_links(md.render(text), link_map, src)))
        bodies.append((output_name(src), body))
        indexed.append(not verbatim)

    index_js = build_search_index(pages, bodies, indexed)
    (out_dir / "search-index.js").write_text(index_js, encoding="utf-8")
    # Same reasoning as the stylesheet above: a stable URL whose contents change
    # every release, served with a long TTL.
    search_query = "" if offline else "?v=" + hashlib.sha256(
        index_js.encode("utf-8")
    ).hexdigest()[:10]

    for index, ((_src, section, title), (page, body)) in enumerate(
        zip(pages, bodies, strict=True)
    ):
        (out_dir / page).write_text(
            _document(
                title,
                version,
                body,
                current=page,
                pages=pages,
                index=index,
                section=section,
                offline=offline,
                versions_url=versions_url,
                stylesheet_query=stylesheet_query,
                search_query=search_query,
                description=page_description(body),
                canonical=canonical_url(canonical_base, page) if not offline else "",
                archived=archived,
            ),
            encoding="utf-8",
        )

    # `index.html` is the entry point the Help button and a double-click both
    # land on; the guide's INDEX.md is already its hand-written table of
    # contents, and output_name() maps it straight onto index.html.
    if not (out_dir / "index.html").is_file():
        shutil.copyfile(out_dir / output_name(present[0][0]), out_dir / "index.html")

    print(f"[docs] rendered {len(pages)} pages ({current_edition}) → {out_dir}")
    return 0


def _nav(pages: list[tuple[str, str, str]], current: str) -> str:
    parts: list[str] = ['<nav class="sidenav" id="sidenav">']
    seen_section: str | None = None
    for number, (src, section, title) in enumerate(pages, start=1):
        if section != seen_section:
            parts.append(f'<div class="grp">{html.escape(section)}</div>')
            seen_section = section
        href = output_name(src)
        css = ' class="active"' if href == current else ""
        parts.append(
            f'<a href="{href}"{css}><span class="n">{number:02d}</span>{html.escape(title)}</a>'
        )
    parts.append("</nav>")
    return "".join(parts)


def _pager(pages: list[tuple[str, str, str]], index: int) -> str:
    parts: list[str] = []
    if index > 0:
        _, _, title = pages[index - 1]
        href = output_name(pages[index - 1][0])
        parts.append(
            f'<a class="prev" href="{href}"><div class="dir">← Previous</div>'
            f'<div class="pt">{html.escape(title)}</div></a>'
        )
    if index < len(pages) - 1:
        _, _, title = pages[index + 1]
        href = output_name(pages[index + 1][0])
        parts.append(
            f'<a class="next" href="{href}"><div class="dir">Next →</div>'
            f'<div class="pt">{html.escape(title)}</div></a>'
        )
    if not parts:
        return ""
    return f'<div class="pager">{"".join(parts)}</div>'


# The product mark, from enterprise/promotion-website/assets/logo.svg. Inlined
# rather than linked so the offline bundle stays self-contained, and its fixed
# hex values are swapped for theme tokens so it survives the dark toggle: the
# tile takes --ink and the knockouts --paper, which inverts cleanly. The indigo
# needs its own --logo-acc rather than --accent, because --accent is tuned for
# contrast against the page ground and washes out on the tile in both themes.
WORDMARK_LOGO = (
    '<svg class="mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" '
    'aria-hidden="true">'
    '<rect width="48" height="48" rx="11" fill="var(--ink)"/>'
    '<g fill="var(--paper)">'
    '<rect x="26" y="8" width="14" height="14" rx="3.5"/>'
    '<rect x="8" y="26" width="14" height="14" rx="3.5"/>'
    "</g>"
    '<path d="M14.42 8 22 15 14.42 22 8 22 15.58 15 8 8Z" fill="var(--logo-acc)"/>'
    '<rect x="26" y="26" width="14" height="14" rx="3.5" fill="var(--logo-acc)"/>'
    "</svg>"
)

# Same mark as the tab icon. A data: URI keeps it a single self-contained file,
# so the media query rather than a token carries the dark-tab-bar inversion.
FAVICON_SVG = (
    "data:image/svg+xml,"
    "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none'%3E"
    "%3Cstyle%3E.tile%7Bfill:%2317160f%7D.mark%7Bfill:%23faf9f6%7D.acc%7Bfill:%237b72ee%7D"
    "@media(prefers-color-scheme:dark)%7B.tile%7Bfill:%23faf9f6%7D.mark%7Bfill:%2317160f%7D"
    ".acc%7Bfill:%234f46e5%7D%7D%3C/style%3E"
    "%3Crect class='tile' width='48' height='48' rx='11'/%3E"
    "%3Cg class='mark'%3E"
    "%3Crect x='26' y='8' width='14' height='14' rx='3.5'/%3E"
    "%3Crect x='8' y='26' width='14' height='14' rx='3.5'/%3E"
    "%3C/g%3E"
    "%3Cpath class='acc' d='M14.42 8 22 15 14.42 22 8 22 15.58 15 8 8Z'/%3E"
    "%3Crect class='acc' x='26' y='26' width='14' height='14' rx='3.5'/%3E"
    "%3C/svg%3E"
)

# The site's faces — Space Grotesk for display, Archivo for body, IBM Plex Mono
# for everything mechanical. Website only: see the offline note in _document.
WEBFONTS = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    '<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600'
    "&amp;family=IBM+Plex+Mono:wght@400;500&amp;family=Space+Grotesk:wght@500;600;700"
    '&amp;display=swap" rel="stylesheet">'
)

TOPBAR_NAV_ICON = (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    'stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
)

TOPBAR_THEME_ICON = (
    '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
    'stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22'
    'M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2 12h2.4M19.6 12H22M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/>'
    '</svg><svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.3 6.3 0 0 0 10.5 10.5Z"/></svg>'
)

# Theme toggle and the mobile nav drawer. The hash router the website page used
# is gone — every page here is a real file.
SHELL_SCRIPT = """
(function () {
  var root = document.documentElement;
  var KEY = 'nexthmi-docs-theme';
  // Each page is a real document, so the choice has to outlive the navigation.
  try {
    var saved = localStorage.getItem(KEY);
    if (saved) root.setAttribute('data-theme', saved);
  } catch (e) { /* private mode */ }
  var tbtn = document.getElementById('theme-toggle');
  // Light unless the reader chose otherwise — the OS setting is deliberately
  // not consulted, so the stylesheet's default and this agree.
  function currentTheme() {
    return root.getAttribute('data-theme') || 'light';
  }
  tbtn.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
  });
  var sidenav = document.getElementById('sidenav');
  var backdrop = document.getElementById('backdrop');
  function closeNav() { sidenav.classList.remove('open'); backdrop.classList.remove('show'); }
  document.getElementById('nav-toggle').addEventListener('click', function () {
    if (sidenav.classList.contains('open')) { closeNav(); return; }
    sidenav.classList.add('open');
    backdrop.classList.add('show');
  });
  backdrop.addEventListener('click', closeNav);
})();
"""

# Website only. The list of published versions cannot be known when a release is
# rendered — later releases do not exist yet — so it is fetched rather than
# baked in, which keeps an old release's picker correct forever. Same-origin,
# and the offline bundle never receives this script.
VERSION_PICKER_SCRIPT = """
(function () {
  var select = document.getElementById('version-select');
  if (!select) return;
  var page = location.pathname.split('/').pop() || 'index.html';
  fetch('__VERSIONS_URL__', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.versions || !data.versions.length) return;
      select.innerHTML = '';
      data.versions.forEach(function (entry) {
        var option = document.createElement('option');
        option.value = entry.path;
        option.textContent = entry.version + (entry.latest ? ' (latest)' : '');
        if (entry.version === '__VERSION__') option.selected = true;
        select.appendChild(option);
      });
    })
    .catch(function () { /* offline or not yet published — keep the static label */ });
  select.addEventListener('change', function () {
    if (select.value) location.href = select.value.replace(/\\/$/, '') + '/' + page;
  });
})();
"""


SEARCH_ICON = (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    'stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>'
)

# Full-text search over the whole guide. The index is a sibling file the browser
# loads once and reuses across pages; when it fails to load — a browser that
# refuses the sibling script, an index that was never written — the trigger
# removes itself rather than opening an empty box.
SEARCH_SCRIPT = """
(function () {
  function init() {
  var trigger = document.getElementById('search-trigger');
  var modal = document.getElementById('search-modal');
  if (!trigger || !modal) return;
  var data = window.__NEXTHMI_DOCS_SEARCH__;
  if (!data || !data.s || !data.s.length) { trigger.remove(); modal.remove(); return; }

  var pages = data.p, records = data.s;
  var input = document.getElementById('search-input');
  var list = document.getElementById('search-results');
  var scrim = document.getElementById('search-scrim');
  var hits = [], active = -1, restore = null;

  // One lowercased copy of the corpus, built the first time the box opens so
  // the cost never lands on a reader who only came for the page.
  var hay = null;
  function ensureHaystack() {
    if (hay) return;
    hay = records.map(function (record) {
      return {
        title: pages[record[0]][1].toLowerCase(),
        head: (record[1] || '').toLowerCase(),
        body: (record[3] || '').toLowerCase()
      };
    });
  }

  // A hit that starts a word beats one buried inside a longer one, which is
  // what keeps "page" off every occurrence of "pages" in a code block.
  function atWordStart(text, token) {
    var at = text.indexOf(token);
    while (at !== -1) {
      if (at === 0 || !/[a-z0-9]/.test(text.charAt(at - 1))) return true;
      at = text.indexOf(token, at + 1);
    }
    return false;
  }

  function search(raw) {
    var query = raw.trim().toLowerCase();
    if (query.length < 2) return [];
    ensureHaystack();
    var tokens = query.split(/\\s+/);
    var scored = [];
    for (var i = 0; i < records.length; i++) {
      var entry = hay[i], score = 0, matched = true;
      for (var t = 0; t < tokens.length; t++) {
        var token = tokens[t], part = 0;
        if (entry.title.indexOf(token) !== -1) part += 12;
        if (entry.head.indexOf(token) !== -1) part += 8;
        if (entry.body.indexOf(token) !== -1) part += 3;
        // Every token has to appear somewhere, or the result is noise.
        if (!part) { matched = false; break; }
        if (atWordStart(entry.title, token) || atWordStart(entry.head, token) ||
            atWordStart(entry.body, token)) part += 3;
        score += part;
      }
      if (!matched) continue;
      if (tokens.length > 1) {
        if (entry.title.indexOf(query) !== -1 || entry.head.indexOf(query) !== -1) score += 16;
        else if (entry.body.indexOf(query) !== -1) score += 7;
      }
      // A page's opening section stands in for the page itself.
      if (!records[i][2]) score += 2;
      scored.push([score, i]);
    }
    scored.sort(function (a, b) { return b[0] - a[0] || a[1] - b[1]; });
    return scored.slice(0, 12).map(function (row) { return row[1]; });
  }

  function esc(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Escaping happens per slice rather than once up front, so a token can never
  // land inside an entity it helped produce.
  function highlight(text, tokens) {
    var lower = text.toLowerCase(), spans = [];
    tokens.forEach(function (token) {
      var from = 0, at;
      while ((at = lower.indexOf(token, from)) !== -1 && spans.length < 40) {
        spans.push([at, at + token.length]);
        from = at + token.length;
      }
    });
    if (!spans.length) return esc(text);
    spans.sort(function (a, b) { return a[0] - b[0]; });
    var out = '', cursor = 0;
    spans.forEach(function (span) {
      if (span[0] < cursor) return;
      out += esc(text.slice(cursor, span[0])) + '<mark>' + esc(text.slice(span[0], span[1])) +
        '</mark>';
      cursor = span[1];
    });
    return out + esc(text.slice(cursor));
  }

  // A window around the first hit, so the reader sees the phrase in context
  // rather than the section's opening sentence.
  function snippet(text, tokens) {
    var lower = text.toLowerCase(), at = -1;
    for (var i = 0; i < tokens.length && at === -1; i++) at = lower.indexOf(tokens[i]);
    if (at === -1) at = 0;
    var start = Math.max(0, at - 60);
    var end = Math.min(text.length, start + 190);
    return (start > 0 ? '\\u2026' : '') + text.slice(start, end).trim() +
      (end < text.length ? '\\u2026' : '');
  }

  // The caret never leaves the input, so the active row is announced through
  // aria-activedescendant rather than by moving focus.
  function point(id) {
    if (id) input.setAttribute('aria-activedescendant', id);
    else input.removeAttribute('aria-activedescendant');
  }

  function render(query) {
    hits = search(query);
    active = hits.length ? 0 : -1;
    input.setAttribute('aria-expanded', hits.length ? 'true' : 'false');
    point('');
    if (query.trim().length < 2) {
      list.innerHTML = '<div class="search-empty">Type to search the guide.</div>';
      return;
    }
    if (!hits.length) {
      list.innerHTML = '<div class="search-empty">No results for \\u201c' + esc(query.trim()) +
        '\\u201d.</div>';
      return;
    }
    var tokens = query.trim().toLowerCase().split(/\\s+/);
    list.innerHTML = hits.map(function (index, position) {
      var record = records[index], page = pages[record[0]];
      var href = page[0] + (record[2] ? '#' + record[2] : '');
      var heading = record[1]
        ? '<span class="sr-sep">\\u203a</span><span class="sr-head">' +
          highlight(record[1], tokens) + '</span>'
        : '';
      return '<a class="sr' + (position === 0 ? ' active' : '') + '" id="sr-' + position +
        '" href="' + href +
        '" role="option" aria-selected="' + (position === 0) + '">' +
        '<div class="sr-top"><span class="sr-page">' + esc(page[1]) + '</span>' + heading +
        '</div><div class="sr-snip">' +
        highlight(snippet(record[3] || record[1], tokens), tokens) + '</div></a>';
    }).join('');
    point('sr-0');
  }

  function rows() { return list.querySelectorAll('a.sr'); }

  function move(step) {
    var items = rows();
    if (!items.length) return;
    active = (active + step + items.length) % items.length;
    for (var i = 0; i < items.length; i++) {
      var on = i === active;
      items[i].classList.toggle('active', on);
      items[i].setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) { items[i].scrollIntoView({ block: 'nearest' }); point(items[i].id); }
    }
  }

  function open() {
    if (!modal.hidden) return;
    restore = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    input.select();
    input.focus();
    render(input.value);
  }

  function close() {
    if (modal.hidden) return;
    modal.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    point('');
    document.body.style.overflow = '';
    // Focus has to leave the panel before it stops rendering. Left inside, the
    // reader is typing into something invisible and the '/' shortcut — which
    // ignores keys aimed at an input — stops reopening the box. The trigger is
    // the fallback because 'whatever had focus' is usually the bare body.
    var back = restore && restore.focus && restore !== document.body ? restore : trigger;
    back.focus();
  }

  trigger.addEventListener('click', open);
  scrim.addEventListener('click', close);
  input.addEventListener('input', function () { render(input.value); });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter') {
      var items = rows();
      if (items[active]) { event.preventDefault(); items[active].click(); }
    } else if (event.key === 'Escape') { event.preventDefault(); close(); }
  });

  // A result on the page already showing only moves the hash, which leaves the
  // modal covering the section the reader just picked.
  list.addEventListener('click', function () { close(); });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) { close(); return; }
    if (!modal.hidden) return;
    var tag = (event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.target.isContentEditable) {
      return;
    }
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      open();
    } else if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      open();
    }
  });
  }

  // The index is a deferred sibling script: it runs after this inline one and
  // before DOMContentLoaded, so the wiring has to wait for that event or it
  // would decide the index is missing and remove the trigger.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
"""


def _search_ui() -> str:
    """The topbar trigger and the overlay it opens, on every page."""
    return (
        '<div class="search-modal" id="search-modal" hidden>'
        '<div class="search-scrim" id="search-scrim"></div>'
        '<div class="search-panel" role="dialog" aria-modal="true" '
        'aria-label="Search the guide">'
        f'<div class="search-field">{SEARCH_ICON}'
        # role="combobox" is what makes aria-expanded and aria-activedescendant
        # legal here: a bare searchbox supports neither, so a screen reader
        # would announce nothing as the arrow keys walk the results.
        '<input id="search-input" type="search" autocomplete="off" spellcheck="false" '
        'placeholder="Search the guide" aria-label="Search the guide" '
        'role="combobox" aria-autocomplete="list" '
        'aria-controls="search-results" aria-expanded="false">'
        '<kbd class="kbd">Esc</kbd></div>'
        '<div class="search-results" id="search-results" role="listbox" '
        'aria-label="Search results"></div>'
        '<div class="search-foot"><span>&uarr;&darr; to move</span>'
        "<span>&crarr; to open</span><span>/ to search</span></div>"
        "</div></div>"
    )


def _document(
    title: str,
    version: str,
    body: str,
    *,
    current: str,
    pages: list[tuple[str, str, str]],
    index: int,
    section: str,
    offline: bool,
    versions_url: str,
    stylesheet_query: str = "",
    search_query: str = "",
    description: str = "",
    canonical: str = "",
    archived: bool = False,
) -> str:
    # An offline panel has no internet; a link that cannot work is worse than
    # no link at all.
    github_button = (
        ""
        if offline
        else '<a class="btn btn-ghost" href="https://github.com/mpnvdlee/next-hmi" '
        'target="_blank" rel="noopener">GitHub</a>'
    )

    # And the site's faces. The stylesheet names them first and falls back to
    # the system stack, so an offline bundle loses the typography and nothing
    # else — it must not ask a shop-floor panel for a font it cannot fetch.
    webfonts = "" if offline else WEBFONTS

    # Offline docs describe exactly the executable they shipped beside, so the
    # version is a fact, not a choice. On the website it is a choice: older
    # releases stay published and the picker moves between them.
    version_label = f'<span class="doc-version">{html.escape(version)}</span>'
    picker_script = ""
    if not offline:
        version_label = (
            '<div class="version-picker"><select id="version-select" '
            f'aria-label="Documentation version"><option value="" selected>{html.escape(version)}'
            "</option></select></div>"
        )
        picker_script = VERSION_PICKER_SCRIPT.replace("__VERSIONS_URL__", versions_url).replace(
            "__VERSION__", version
        )

    # Search-engine metadata is website-only: the offline bundle is opened off a
    # filesystem, where a canonical URL points at a host the panel cannot reach.
    meta_description = (
        f'<meta name="description" content="{html.escape(description, quote=True)}">'
        if description and not offline
        else ""
    )
    # An archived version copy canonicalises to the live page and asks not to be
    # indexed: every release publishes a complete duplicate of every page, and
    # the reader searching for a topic wants the current release, not the sixth
    # copy of it. `follow` so the links inside it still carry weight.
    robots = '<meta name="robots" content="noindex, follow">' if archived and not offline else ""
    canonical_link = (
        f'<link rel="canonical" href="{html.escape(canonical, quote=True)}">' if canonical else ""
    )

    return (
        "<!doctype html>\n"
        '<html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{html.escape(title)} — NEXT HMI</title>"
        f"{meta_description}{robots}{canonical_link}"
        f"{webfonts}"
        f'<link rel="stylesheet" href="style.css{stylesheet_query}">'
        # Deferred, not inline: one copy of the guide's text is shared by every
        # page, and the page must render before it arrives.
        f'<script defer src="search-index.js{search_query}"></script>'
        f'<link rel="icon" type="image/svg+xml" href="{FAVICON_SVG}">'
        "</head><body>"
        '<header class="topbar"><div class="topbar-inner">'
        f'<button class="icon-btn" id="nav-toggle" aria-label="Open navigation">{TOPBAR_NAV_ICON}</button>'
        f'<a class="wordmark" href="index.html">{WORDMARK_LOGO}NEXT&nbsp;HMI'
        '<span class="doc-tag">Docs</span></a>'
        f"{version_label}"
        f'<div class="top-spacer"></div><div class="top-actions">'
        f'<button class="search-trigger" id="search-trigger" aria-label="Search the guide">'
        f'{SEARCH_ICON}<span class="st-label">Search</span>'
        f'<kbd class="kbd st-key">/</kbd></button>'
        f'<button class="icon-btn" id="theme-toggle" aria-label="Toggle color theme" '
        f'title="Toggle theme">{TOPBAR_THEME_ICON}</button>{github_button}'
        "</div></div></header>"
        '<div class="sidebar-backdrop" id="backdrop"></div>'
        f'<div class="layout">{_nav(pages, current)}'
        '<main class="main" id="main"><article class="page active">'
        f'<div class="crumb"><b>{html.escape(section)}</b> / {html.escape(title)}</div>'
        f"{body}{_pager(pages, index)}"
        "</article></main></div>"
        f"{_search_ui()}"
        f"<script>{SHELL_SCRIPT}{SEARCH_SCRIPT}{picker_script}</script>"
        "</body></html>\n"
    )


def main(argv: list[str]) -> int:
    positional: list[str] = []
    override_edition: str | None = None
    offline = True
    versions_url = DEFAULT_VERSIONS_URL
    canonical_base = ""
    archived = False
    rest = argv[1:]
    while rest:
        arg = rest.pop(0)
        if arg in ("--edition", "--versions-url", "--canonical-base"):
            if not rest:
                print(f"{arg} needs a value", file=sys.stderr)
                return 2
            value = rest.pop(0)
            if arg == "--edition":
                override_edition = value.strip().lower()
            elif arg == "--versions-url":
                versions_url = value
            else:
                canonical_base = value
        elif arg == "--web":
            offline = False
        elif arg == "--archived":
            archived = True
        else:
            positional.append(arg)

    if not positional:
        print(__doc__, file=sys.stderr)
        return 2
    out_dir = Path(positional[0]).resolve()
    version = positional[1] if len(positional) > 1 else "dev"
    return render(
        out_dir,
        version,
        override_edition or edition(),
        offline=offline,
        versions_url=versions_url,
        canonical_base=canonical_base,
        archived=archived,
    )


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
