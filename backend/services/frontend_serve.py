"""Production SPA serving with live import-map injection.

The Vite dev server handles the SPA on :5173 in a checkout, so this module is
inert in dev. In a deployed runtime (Docker, PyInstaller) Vite isn't around,
so the backend has to serve the built ``index.html`` and the hashed asset
bundle — and it has to splice a *fresh* import map into the HTML on every
request, because users can drop new files into ``external-libraries/`` at
runtime and the build-time map is frozen.

Public functions (in registration order in ``main.py``):
  * ``scan_external_libraries(dir)`` / ``read_overrides(file)`` /
    ``build_import_map(dir, file)`` — port of
    ``frontend/dev-plugins/externalModules.ts``. Pure, no caching.
  * ``render_index_html(dist_dir, libraries_dir, overrides_path)`` — reads
    ``<dist>/index.html``, strips the build-time import map (if any),
    injects a fresh one. mtime-tuple cached so the steady-state cost is a
    handful of ``stat`` calls.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from core.version import app_edition, app_version

logger = logging.getLogger(__name__)


def scan_external_libraries(libraries_dir: Path) -> dict[str, str]:
    """Scan ``<libraries_dir>`` and produce import-map entries.

    Rules — mirror ``frontend/dev-plugins/externalModules.ts``:
      * Loose ``<libraries_dir>/<name>.{js,mjs}`` → ``<name>`` entry.
      * Folder ``<libraries_dir>/<name>/`` → ``<name>/`` subpath root entry.
      * Folder ``<libraries_dir>/<name>/<name>.{js,mjs}`` → also a bare
        ``<name>`` entry (folder convention for multi-file libraries).
      * Entries beginning with ``.`` or ``_`` are skipped — convention for
        in-progress / disabled libraries.
    """
    if not libraries_dir.is_dir():
        return {}
    out: dict[str, str] = {}
    for entry in sorted(libraries_dir.iterdir()):
        if entry.name.startswith((".", "_")):
            continue
        if entry.is_file() and entry.suffix in (".js", ".mjs"):
            bare = entry.stem
            out[bare] = f"/external-libraries/{entry.name}"
        elif entry.is_dir():
            out[f"{entry.name}/"] = f"/external-libraries/{entry.name}/"
            # Convention: <name>/<name>.{js,mjs} is the bare entry.
            for suffix in (".js", ".mjs"):
                candidate = entry / f"{entry.name}{suffix}"
                if candidate.is_file():
                    out[entry.name] = (
                        f"/external-libraries/{entry.name}/{candidate.name}"
                    )
                    break
    return out


def read_overrides(override_path: Path) -> dict[str, str]:
    """Read user-provided ``external-modules.json`` overrides.

    Missing file → ``{}``. Malformed JSON or missing ``imports`` key → log
    + return ``{}`` so a typo doesn't take down the runtime.
    """
    if not override_path.is_file():
        return {}
    try:
        raw = json.loads(override_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        logger.error("external-modules.json is invalid: %s", err)
        return {}
    if not isinstance(raw, dict):
        return {}
    imports = raw.get("imports")
    if not isinstance(imports, dict):
        return {}
    # JSON object keys are strings; non-string URLs are invalid and ignored.
    return {key: value for key, value in imports.items() if isinstance(value, str)}


def build_import_map(
    libraries_dir: Path, override_path: Path
) -> dict[str, dict[str, str]]:
    """``{ imports: { <bare>: <url>, ... } }``. Overrides win over auto-derived
    entries on key collision, matching the TS plugin's spread order."""
    return {
        "imports": {
            **scan_external_libraries(libraries_dir),
            **read_overrides(override_path),
        }
    }


# ── index.html templating ────────────────────────────────────────────────────

# Strips a build-time ``<script type="importmap">…</script>`` tag *and* the
# trailing whitespace on its line so re-injection doesn't accumulate blank
# lines. The build embeds the tag on its own line inside <head>; user-written
# index.html sources never have one (Vite injects it at build).
_IMPORTMAP_RE = re.compile(
    r'[ \t]*<script\s+type="importmap"[^>]*>.*?</script>\s*\n?',
    re.DOTALL | re.IGNORECASE,
)

# Same treatment for a stale runtime-globals tag. A dist built by Vite carries
# one baked at build time (base "/", mode "manager" — there is no request to
# derive them from), and we inject ours right after <head>, i.e. *before* it.
# Left in place the baked tag runs last and wins, so every proxied project
# instance rendered as the manager dashboard (issue #20).
_GLOBALS_RE = re.compile(
    r"[ \t]*<script>\s*window\.__NEXTHMI_(?:BASE|MODE|VERSION)__\s*=.*?</script>\s*\n?",
    re.DOTALL | re.IGNORECASE,
)

_HEAD_OPEN_RE = re.compile(r"(<head[^>]*>)", re.IGNORECASE)


# mtime-tuple cache. Key: (dist_index_mtime_ns, libraries_dir_mtime_ns,
# override_path_mtime_ns, base_path, mode). Value: rendered HTML.
_render_cache: dict[tuple[int, int, int, str, str], str] = {}


def _safe_mtime_ns(path: Path) -> int:
    """``Path.stat().st_mtime_ns`` with a 0 sentinel for missing paths.

    The cache key has to be stable across runs even when files vanish —
    e.g. a user removes the override JSON between requests. Returning 0
    makes "missing" indistinguishable from "missing" rather than blowing up.
    """
    try:
        return path.stat().st_mtime_ns
    except FileNotFoundError:
        return 0


def render_index_html(
    dist_dir: Path,
    libraries_dir: Path,
    override_path: Path,
    base_path: str = "/",
    mode: str = "instance",
) -> str:
    """Read ``<dist_dir>/index.html``, replace any existing import map with
    a freshly-computed one against ``libraries_dir`` + ``override_path``,
    inject the runtime globals (``__NEXTHMI_BASE__`` / ``__NEXTHMI_MODE__`` /
    ``__NEXTHMI_VERSION__`` / ``__NEXTHMI_EDITION__``), and return the HTML.

    ``base_path`` is the URL prefix this document is served under — ``"/"`` for
    the manager dashboard and ``"/runtime/<slug>/"`` or ``"/editor/<slug>/"``
    for a proxied project instance. The SPA reads it to prefix its
    API/WebSocket calls and set the router basename.
    ``mode`` is ``"manager"`` for the dashboard, ``"instance"`` for a project
    (and the dev default when no globals are injected). Hashed asset URLs stay
    absolute (``/_app/…``) and are served at the origin root either way, so they
    need no rewrite.

    Cached by an mtime tuple plus (base_path, mode) — repeat hits in the same
    second cost three ``stat`` syscalls. The dir mtime catches file *adds/removes*;
    per-file edits to existing libraries don't matter because the import map only
    cares about the file list, not contents.
    """
    index_path = dist_dir / "index.html"
    key = (
        _safe_mtime_ns(index_path),
        _safe_mtime_ns(libraries_dir),
        _safe_mtime_ns(override_path),
        base_path,
        mode,
    )
    cached = _render_cache.get(key)
    if cached is not None:
        return cached

    html = index_path.read_text(encoding="utf-8")
    # Strip any existing importmap tag (build-time injection or stale render).
    html = _IMPORTMAP_RE.sub("", html)
    # Same for a build-time runtime-globals tag — ours is injected below and a
    # leftover would execute after it.
    html = _GLOBALS_RE.sub("", html)

    import_map = build_import_map(libraries_dir, override_path)
    # Under a proxy prefix the auto-derived /external-libraries/… URLs must carry
    # it too, or the browser resolves them at the origin root (the manager) and
    # 404s. Absolute http(s) overrides are left untouched.
    if base_path != "/":
        prefix = base_path.rstrip("/")
        import_map = {
            "imports": {
                key: (prefix + value if value.startswith("/") else value)
                for key, value in import_map["imports"].items()
            }
        }
    globals_script = (
        "    <script>"
        f"window.__NEXTHMI_BASE__={json.dumps(base_path)};"
        f"window.__NEXTHMI_MODE__={json.dumps(mode)};"
        f"window.__NEXTHMI_VERSION__={json.dumps(app_version())};"
        f"window.__NEXTHMI_EDITION__={json.dumps(app_edition())};"
        "</script>\n"
    )
    injection = (
        globals_script
        + f'    <script type="importmap">{json.dumps(import_map)}</script>\n'
    )

    # Inject immediately after <head>. If the html has no <head> (shouldn't
    # happen for a real Vite build), prepend at the top so the SPA still loads.
    if _HEAD_OPEN_RE.search(html):
        html = _HEAD_OPEN_RE.sub(r"\1\n" + injection, html, count=1)
    else:
        html = injection + html

    # Intentionally size-1: clear before insert so the dict only ever holds
    # the most recently rendered (index_mtime, override_mtime) tuple. The
    # mtime-keyed shape is for invalidation, not multi-tenancy — there is
    # only ever one dist + override pair per process.
    _render_cache.clear()
    _render_cache[key] = html
    return html


def reset_render_cache() -> None:
    """Test-only hook so the mtime cache doesn't leak state between
    monkeypatched fixtures."""
    _render_cache.clear()
