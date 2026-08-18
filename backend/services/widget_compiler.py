"""Custom-widget TSX compiler and schema-manifest generator.

Single source of truth for compiling ``<project>/custom-widgets/<Name>/index.tsx``
to ``<WIDGET_BUILD_DIR>/<Name>/index.js`` (with a per-component SDK banner)
and for regenerating ``widget-schemas.json``. Replaces the historical Vite
plugin so that Docker / PyInstaller deployments — which ship no Node — have
the same hot-reload story as a dev checkout.

Public surface:
  * ``compile_all()`` — one-shot recompile of every entry.
  * ``compile_entry(path)`` — single-file recompile.
  * ``regenerate_widget_schemas()`` — rewrite the manifest.
  * ``start_watcher(callback)`` — watchfiles-backed change loop.
  * CLI: ``python -m services.widget_compiler --once``.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import threading
from collections.abc import Awaitable, Callable, Iterable
from pathlib import Path
from typing import Any

from core.stdlib_manifest import editor_manifest_path
from core.storage import (
    BUILD_STATUS_PATH,
    WIDGET_BUILD_DIR,
    active_custom_widgets_dir,
    active_external_libraries_dir,
    repo_root,
    write_json,
    write_text_atomic,
)
from core.time_utils import iso_now

from services.frontend_serve import build_import_map
from services.widget_schemas import ExtractionError, extract_schemas

logger = logging.getLogger(__name__)

# Mirror of frontend/src/shared/utils/nextHmiSdkNames.ts. Kept in sync by
# ``backend/tests/test_widget_compiler_sdk_names.py`` (parity test).
SDK_NAMES: tuple[str, ...] = (
    "React",
    "useState",
    "useEffect",
    "useMemo",
    "useCallback",
    "useRef",
    "createPortal",
    "useStructVariable",
    "useEvalContext",
    "sendWsMessage",
    "useHmiScope",
    "selfLayoutStyle",
    "containerLayoutStyle",
    "widgetColorStyle",
    "bindingKey",
    "parseVarKey",
    "getPropString",
    "getPropNumber",
    "getPropBoolean",
    "getPropBinding",
    "getPropBindingOrStatic",
    "usePropVar",
    "usePropString",
    "usePropNumber",
    "usePropBoolean",
    "usePropStruct",
    "useRecordListProp",
    "useCssVar",
    "useVariable",
    "useBindingValue",
    "useVariableMeta",
    "usePublishWidgetProp",
    "useUsersData",
    "useUserGroupsData",
    "useLanguagesData",
    "useLanguageSelection",
    "usePageGroup",
    "usePageTitle",
    "resolvePageTitle",
    "useNavigateToPage",
    "useVisiblePages",
    "useActiveAlarms",
    "useAlarmSummary",
    "useAlarmText",
    "useAlarmUsername",
    "alarmLevelClass",
    "levelDotClass",
    "formatAlarmTimeShort",
    "formatAlarmDateTime",
    "ackAlarm",
    "ackAllAlarms",
    "AlarmDetailDialog",
    "getBuiltinIconComponent",
    "isBuiltinIconId",
    "isCustomIconAssetPath",
    "useInlineSvg",
    "withBase",
    "apiJson",
    "isApiError",
    "executeWidgetActions",
    "useRecipeConfig",
    "useRecipeState",
    "recipeDownload",
    "recipeUpload",
    "Recharts",
    "VirtualKeyboard",
    "VirtualNumpad",
    "CloseButton",
    "useWriteVariable",
)

BUILD_STATUS_VERSION = 2

# Basename ``publish_stdlib_assets`` will clear and rewrite. The publish root
# arrives from a CLI flag and is emptied before it is refilled, so requiring the
# name bounds a mistyped ``--publish-dir`` to the tree it is meant to own.
PUBLISH_DIR_NAME = "stdlib-js"


class _StatusState:
    """The build-status map for one ``.build-status.json`` path, shared by every
    ``CompileTarget`` that resolves to it.

    Per-target maps regress the file. ``start_watcher`` holds one target for the
    process lifetime while ``recompile()`` and ``compile_entry()`` each build
    their own, and ``_prepare_status`` re-reads disk only until a target is
    loaded: an admin recompile would write a newer stamp that the watcher's
    already-loaded target then overwrote with its stale copy on the next save,
    walking the ``?t=`` cache-buster backwards so browsers keep the module they
    have cached. Keying the state by path — rather than making it module-global
    as it once was — keeps a stdlib build out of the live project's file.

    The lock is a plain mutex, not an ``asyncio.Lock``: it guards only
    synchronous sections (never held across an ``await``), and a state that
    outlives one event loop must not carry a loop-bound primitive.
    """

    def __init__(self) -> None:
        self.status: dict[str, dict[str, Any]] = {}
        self.lock = threading.Lock()
        self.loaded = False


_status_states: dict[Path, _StatusState] = {}


def _status_state(status_path: Path) -> _StatusState:
    key = status_path.resolve()
    state = _status_states.get(key)
    if state is None:
        state = _StatusState()
        _status_states[key] = state
    return state


class CompileTarget:
    """One compile target: a source root, a build root, and the build-status
    map that belongs to that pair.

    Status used to be a single module-level dict re-keyed on whichever root the
    last caller passed, which meant every status-touching function had to be
    handed the same ``out_dir`` or a stdlib build would rewrite the live
    project's ``.build-status.json``. Binding each target to the state of *its
    own* status file makes that mistake unrepresentable while every target on
    one file still shares one map (see ``_StatusState``), and the two parallel
    ``src_dir`` / ``out_dir`` optionals collapse into one object below the
    public API.

    Roots are resolved by ``compile_target()`` rather than here, so the
    defaults — which move when the active project switches, and which tests
    rebind on this module — are read at call time, not at import time.

    The status map starts empty and is filled from disk by ``_prepare_status``
    on first use, so a target built per public call still accumulates every
    widget's entry rather than truncating the file to whatever it just compiled.
    """

    def __init__(self, src_dir: Path, out_dir: Path) -> None:
        self.src_dir = src_dir
        self.out_dir = out_dir
        self._state = _status_state(self.status_path)

    @property
    def status_path(self) -> Path:
        # BUILD_STATUS_PATH is WIDGET_BUILD_DIR/.build-status.json; deriving the
        # name here keeps a redirected target's status beside its own artifacts.
        return self.out_dir / BUILD_STATUS_PATH.name

    @property
    def status(self) -> dict[str, dict[str, Any]]:
        return self._state.status

    @property
    def lock(self) -> threading.Lock:
        return self._state.lock

    @property
    def loaded(self) -> bool:
        return self._state.loaded

    @loaded.setter
    def loaded(self, value: bool) -> None:
        self._state.loaded = value

    @property
    def schemas_path(self) -> Path:
        return self.out_dir / "widget-schemas.json"

    def status_document(self) -> dict[str, Any]:
        return {"version": BUILD_STATUS_VERSION, "widgets": self.status}

    def write_status_unlocked(self) -> None:
        """Persist the status map. Caller holds ``self.lock``."""
        write_json(self.status_path, self.status_document())


def compile_target(src_dir: Path | None = None, out_dir: Path | None = None) -> CompileTarget:
    """Resolve a target from the optional roots the public API accepts.

    ``src_dir`` defaults to the live project's ``custom-widgets/``; ``out_dir``
    to the runtime-home widget cache. The stdlib build passes both so a
    build-machine compile never touches runtime-home state. Names are looked up
    on the module so ``tests/test_widget_compiler.py``'s ``widget_workspace``
    fixture can rebind them.
    """
    return CompileTarget(
        src_dir if src_dir is not None else active_custom_widgets_dir(),
        out_dir if out_dir is not None else WIDGET_BUILD_DIR,
    )


def _registry_path() -> Path:
    """Path to the built-in ``widgetRegistry.tsx``. Lives in the repo tree
    (frontend source); resolved from the repo root so it works both from a
    checkout and from a packaged runtime where the frontend dist is bundled
    elsewhere — for those cases the registry is read from the seed."""
    return repo_root() / "frontend" / "src" / "hmi" / "registry" / "widgetRegistry.tsx"


def _esbuild_binary() -> str:
    """Locate the esbuild binary.

    Order:
      1. ``ESBUILD_BINARY_PATH`` env var (Docker / PyInstaller set this).
      2. ``shutil.which("esbuild")`` — system install.
      3. Dev fallback: ``frontend/node_modules/.bin/esbuild`` from the repo.
    """
    explicit = os.environ.get("ESBUILD_BINARY_PATH")
    if explicit:
        return explicit
    found = shutil.which("esbuild")
    if found:
        return found
    repo_root = Path(__file__).resolve().parent.parent.parent
    fallback = repo_root / "frontend" / "node_modules" / ".bin" / "esbuild"
    if fallback.is_file():
        return str(fallback)
    raise RuntimeError(
        "esbuild binary not found — set ESBUILD_BINARY_PATH or install esbuild "
        "(dev: run `npm install` in frontend/)"
    )


_SDK_NAME_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (name, re.compile(rf"(?<![\w$]){re.escape(name)}(?![\w$])")) for name in SDK_NAMES
)


def sdk_names_used(js_source: str) -> list[str]:
    """SDK names ``js_source`` actually references, in ``SDK_NAMES`` order."""
    return [name for name, pattern in _SDK_NAME_PATTERNS if pattern.search(js_source)]


def build_sdk_banner(js_source: str) -> str:
    """Generate the ``const { … } = window.__nextHMI__;`` banner containing
    only the SDK names actually referenced by ``js_source``. Empty string if
    none are referenced (avoids an unused destructuring statement)."""
    return _banner_for(sdk_names_used(js_source))


def _banner_for(used: list[str]) -> str:
    if not used:
        return ""
    return f"const {{ {', '.join(used)} }} = window.__nextHMI__;\n"


_IMPORT_SPECIFIER_RE = re.compile(
    r"""import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]"""
)

def _external_imports(src_dir: Path | None = None) -> set[str]:
    """Import-map keys available to widgets in this project.

    The browser map and compiler deliberately share ``build_import_map`` so a
    widget cannot compile in development and then fail in the packaged runtime
    (or vice versa). When a caller supplies a custom widget root, use its
    sibling project directories; tests and one-off validation rely on that.
    """
    if src_dir is None:
        libraries_dir = active_external_libraries_dir()
    else:
        libraries_dir = src_dir.parent / "external-libraries"
    override_path = libraries_dir.parent / "external-modules.json"
    return set(build_import_map(libraries_dir, override_path)["imports"])


def _is_external_import(specifier: str, external_imports: set[str]) -> bool:
    return specifier in external_imports or any(
        key.endswith("/") and specifier.startswith(key) for key in external_imports
    )


def _disallowed_import(
    tsx_source: str, external_imports: set[str] | None = None
) -> str | None:
    """First unsupported non-relative import specifier, or ``None``.

    Sibling imports are bundled. Bare imports are only valid when the active
    project's import map registers them; React and application modules still
    come from SDK globals rather than the frontend dependency graph.
    """
    allowed = external_imports or set()
    for match in _IMPORT_SPECIFIER_RE.finditer(tsx_source):
        specifier = match.group(1)
        if not specifier.startswith(".") and not _is_external_import(
            specifier, allowed
        ):
            return specifier
    return None


def _esbuild_external_args(external_imports: set[str]) -> list[str]:
    """Translate import-map keys to esbuild external patterns."""
    return [
        f"--external:{key}*" if key.endswith("/") else f"--external:{key}"
        for key in sorted(external_imports)
    ]


_TOP_LEVEL_DECL_RE = re.compile(
    r"(?:^|\n)\s*(?:export\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)"
)

_WIDGET_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_WINDOWS_RESERVED_SEGMENTS = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


def _sdk_name_collisions(js_source: str) -> list[str]:
    """SDK global names that are also declared locally in the compiled
    output. Such a declaration collides with the banner's
    ``const { Name } = window.__nextHMI__;`` and throws ``Identifier 'Name'
    has already been declared`` at module-load time (§4.1)."""
    declared = {m.group(1) for m in _TOP_LEVEL_DECL_RE.finditer(js_source)}
    return [name for name in SDK_NAMES if name in declared]


def _is_ignored(name: str) -> bool:
    return name.startswith(".") or name.startswith("_")


def _is_widget_segment(name: str) -> bool:
    """Whether one filesystem/URL segment has one unambiguous identity.

    Keeping the persisted identity ASCII and URL-unreserved makes the contract
    identical on POSIX and Windows and excludes encoded separators, alternate
    slash glyphs, drive prefixes, dot segments, and query/fragment aliases.
    """
    return (
        _WIDGET_SEGMENT_RE.fullmatch(name) is not None
        and name.upper() not in _WINDOWS_RESERVED_SEGMENTS
    )


def _widget_key_from_parts(parts: tuple[str, ...]) -> str:
    if len(parts) not in (2, 3) or parts[-1] != "index.tsx":
        raise ValueError(f"unexpected widget path: {'/'.join(parts)}")
    segments = parts[:-1]
    if not all(_is_widget_segment(segment) for segment in segments):
        raise ValueError(f"unsafe widget path: {'/'.join(parts)}")
    return "/".join(segments)


def _has_symlink_from_root(path: Path, root: Path) -> bool:
    try:
        rel = path.relative_to(root)
    except ValueError:
        return True
    current = root
    if current.is_symlink():
        return True
    for part in rel.parts:
        current = current / part
        if current.is_symlink():
            return True
    return False


def _exclude_casefold_collisions(entries: list[Path], root: Path) -> list[Path]:
    by_casefold: dict[str, list[Path]] = {}
    for entry in entries:
        key = _widget_key_from_parts(entry.relative_to(root).parts)
        by_casefold.setdefault(key.casefold(), []).append(entry)
    collisions = {
        folded for folded, matches in by_casefold.items() if len(matches) > 1
    }
    for folded in sorted(collisions):
        logger.error(
            "Ignoring custom widgets with case-insensitive identity collision: %s",
            ", ".join(
                sorted(
                    _widget_key_from_parts(entry.relative_to(root).parts)
                    for entry in by_casefold[folded]
                )
            ),
        )
    return [
        entry
        for entry in entries
        if _widget_key_from_parts(entry.relative_to(root).parts).casefold()
        not in collisions
    ]


def find_entries(src_dir: Path | None = None) -> list[Path]:
    """Discover every ``<Name>/index.tsx`` and ``<Group>/<Name>/index.tsx``
    file under ``src_dir`` (defaults to the live project's custom-widgets dir). Sorted by
    full path so output ordering is deterministic."""
    root = src_dir if src_dir is not None else active_custom_widgets_dir()
    if not root.is_dir() or root.is_symlink():
        return []
    out: list[Path] = []
    for level1 in sorted(root.iterdir()):
        if (
            not level1.is_dir()
            or level1.is_symlink()
            or _is_ignored(level1.name)
            or not _is_widget_segment(level1.name)
        ):
            continue
        flat = level1 / "index.tsx"
        if flat.is_file() and not flat.is_symlink():
            out.append(flat)
            continue
        for level2 in sorted(level1.iterdir()):
            if (
                not level2.is_dir()
                or level2.is_symlink()
                or _is_ignored(level2.name)
                or not _is_widget_segment(level2.name)
            ):
                continue
            grouped = level2 / "index.tsx"
            if grouped.is_file() and not grouped.is_symlink():
                out.append(grouped)
    return _exclude_casefold_collisions(out, root)


def widget_key(tsx_path: Path, src_dir: Path | None = None) -> str:
    """Identifier used in ``widget-schemas.json``'s ``custom`` map:
    flat layout → ``<Name>``, grouped → ``<Group>/<Name>``.
    """
    root = src_dir if src_dir is not None else active_custom_widgets_dir()
    if _has_symlink_from_root(tsx_path, root):
        raise ValueError(f"symlinked widget path is not allowed: {tsx_path}")
    rel = tsx_path.relative_to(root)
    return _widget_key_from_parts(rel.parts)


def _entry_name(tsx_path: Path) -> str:
    """Human-facing leaf name retained in REST and WebSocket payloads."""
    return tsx_path.parent.name


def is_canonical_widget_key(key: str) -> bool:
    parts = key.split("/")
    return len(parts) in (1, 2) and all(_is_widget_segment(part) for part in parts)


def discovered_entries_by_key(root: Path) -> dict[str, Path]:
    return {widget_key(entry, root): entry for entry in find_entries(root)}


def decode_build_status(raw: Any) -> dict[str, dict[str, Any]]:
    """Decode only the canonical build-status envelope.

    Anything else — a corrupt file, or the leaf-keyed map written by builds
    before ``BUILD_STATUS_VERSION`` 2 — decodes to an empty map, which costs
    one rebuild of every widget and is why no migration is kept for it.
    """
    if not isinstance(raw, dict) or raw.get("version") != BUILD_STATUS_VERSION:
        return {}
    widgets = raw.get("widgets")
    if not isinstance(widgets, dict):
        return {}
    return {
        key: value
        for key, value in widgets.items()
        if isinstance(key, str)
        and is_canonical_widget_key(key)
        and isinstance(value, dict)
    }


def _build_status_on_disk(target: CompileTarget) -> dict[str, dict[str, Any]]:
    """The last compile's per-widget result for this target, read from disk.

    Disk rather than ``target.status`` because a caller that only publishes
    never ran ``_prepare_status`` and would otherwise see an empty map.
    """
    status_path = target.status_path
    if not status_path.exists():
        return {}
    try:
        return decode_build_status(json.loads(status_path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError):
        logger.warning("Ignoring unreadable widget build status: %s", status_path)
        return {}


async def _prepare_status(target: CompileTarget) -> None:
    """Fill ``target.status`` from disk, then rewrite it in canonical form.

    A file this build cannot decode leaves the status empty rather than
    failing, so the startup ``compile_all`` rebuilds every widget once and the
    canonical envelope is on disk before compilation starts.
    """
    status_path = target.status_path
    with target.lock:
        if target.loaded:
            return

        raw: Any = {}
        if status_path.exists():
            try:
                raw = json.loads(status_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                logger.warning("Ignoring unreadable widget build status: %s", status_path)

        target.status.clear()
        target.status.update(decode_build_status(raw))
        target.loaded = True
        target.write_status_unlocked()


def find_built_artifacts(build_dir: Path | None = None) -> dict[str, Path]:
    """Discover canonical generated entry files, excluding cache metadata.

    Only exact flat/grouped ``index.js`` paths below real, safe-named
    directories qualify. Top-level metadata files and symlinked directories are
    never considered deletion targets.
    """
    root = build_dir if build_dir is not None else WIDGET_BUILD_DIR
    if not root.is_dir():
        return {}
    artifacts: dict[str, Path] = {}
    for level1 in sorted(root.iterdir()):
        if (
            not level1.is_dir()
            or level1.is_symlink()
            or not _is_widget_segment(level1.name)
        ):
            continue
        flat = level1 / "index.js"
        if flat.is_file():
            artifacts[level1.name] = flat
        for level2 in sorted(level1.iterdir()):
            if (
                not level2.is_dir()
                or level2.is_symlink()
                or not _is_widget_segment(level2.name)
            ):
                continue
            grouped = level2 / "index.js"
            if grouped.is_file():
                artifacts[f"{level1.name}/{level2.name}"] = grouped
    return artifacts


async def _prune_status(target: CompileTarget, entries: list[Path]) -> set[str]:
    await _prepare_status(target)
    current_keys = {widget_key(entry, target.src_dir) for entry in entries}
    artifacts = find_built_artifacts(target.out_dir)
    with target.lock:
        stale_status = set(target.status) - current_keys
        for key in stale_status:
            del target.status[key]
        if stale_status:
            target.write_status_unlocked()
    stale_artifacts = set(artifacts) - current_keys
    for key in stale_artifacts:
        artifacts[key].unlink(missing_ok=True)
    return stale_status | stale_artifacts


def _content_hash(module_source: str, stylesheet: Path) -> str:
    """Digest of everything a browser fetches for one widget.

    Used as the cache-busting build identity in the baked stdlib manifest. A
    wall-clock stamp would do that job too, but the manifest is a *tracked*
    file regenerated by every ``npm run dev`` — a timestamp there dirties the
    working tree on every build and conflicts on every rebase. A digest changes
    exactly when the bytes the browser caches change, which is also the more
    correct cache key: rebuilding unchanged sources must not invalidate a
    module the browser already holds.
    """
    digest = hashlib.sha256(module_source.encode("utf-8"))
    if stylesheet.is_file():
        digest.update(b"\0style\0")
        digest.update(stylesheet.read_bytes())
    return digest.hexdigest()[:16]


async def _compile_discovered_entry(target: CompileTarget, tsx_path: Path, key: str) -> bool:
    rel = tsx_path.relative_to(target.src_dir)
    out_path = target.out_dir / rel.with_suffix(".js")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        await _prepare_status(target)
        source = tsx_path.read_text(encoding="utf-8")
        external_imports = _external_imports(target.src_dir)
        bad_import = _disallowed_import(source, external_imports)
        if bad_import is not None:
            raise RuntimeError(
                f"disallowed import '{bad_import}' — custom widgets may not import "
                "react or app/package modules unless registered in the project's "
                "external-libraries import map; use SDK globals from "
                "window.__nextHMI__ for HMI APIs"
            )
        proc = await asyncio.create_subprocess_exec(
            _esbuild_binary(),
            str(tsx_path),
            "--bundle",
            "--external:react",
            "--format=esm",
            "--target=es2020",
            "--jsx=transform",
            "--jsx-factory=React.createElement",
            "--jsx-fragment=React.Fragment",
            "--log-level=silent",
            *_esbuild_external_args(external_imports),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="replace").strip() or "esbuild failed"
            raise RuntimeError(err)
        compiled = stdout.decode("utf-8")
        collisions = _sdk_name_collisions(compiled)
        if collisions:
            raise RuntimeError(
                "local declaration(s) collide with reserved SDK name(s): "
                f"{', '.join(collisions)} — rename to avoid shadowing window.__nextHMI__"
            )
        used = sdk_names_used(compiled)
        module = _banner_for(used) + compiled
        write_text_atomic(out_path, module)
        with target.lock:
            # ``usesRecharts`` is recorded here rather than re-derived later:
            # the scan that builds the banner already knows the answer, and
            # ``generate_stdlib_manifest`` would otherwise re-read and re-scan
            # every compiled module to find it again.
            target.status[key] = {
                "ok": True,
                "ts": iso_now("milliseconds"),
                "hash": _content_hash(module, tsx_path.parent / "style.css"),
                "usesRecharts": "Recharts" in used,
            }
            target.write_status_unlocked()
        logger.info("Compiled widget: %s", rel)
        return True
    except Exception as err:  # record any failure, don't crash
        with target.lock:
            target.status[key] = {
                "ok": False,
                "error": str(err),
                "ts": iso_now("milliseconds"),
            }
            target.write_status_unlocked()
        logger.error("Compile error in %s: %s", rel, err)
        return False


async def compile_entry(
    tsx_path: Path, src_dir: Path | None = None, out_dir: Path | None = None
) -> bool:
    """Compile one authoritative discovered entry, returning False otherwise."""
    target = compile_target(src_dir, out_dir)
    key_by_entry = {
        entry: key for key, entry in discovered_entries_by_key(target.src_dir).items()
    }
    key = key_by_entry.get(tsx_path)
    if key is None:
        logger.error("Refusing undiscovered custom-widget entry: %s", tsx_path)
        return False
    return await _compile_discovered_entry(target, tsx_path, key)


async def compile_all(src_dir: Path | None = None, out_dir: Path | None = None) -> bool:
    """Compile every custom-widget entry under ``src_dir``. Failures are
    isolated per-widget — a broken widget doesn't prevent others from
    compiling. Returns whether every discovered entry compiled."""
    target = compile_target(src_dir, out_dir)
    entries = find_entries(target.src_dir)
    await _prune_status(target, entries)
    if not entries:
        return True
    # Names the source root because this path is shared: the same call compiles
    # the project's custom widgets and, from the build step, the product stdlib.
    # Calling both "custom widgets" made a 34-widget stdlib build read as if the
    # project had 34 custom widgets.
    logger.info("Compiling %d widget(s) from %s…", len(entries), target.src_dir)
    results = await asyncio.gather(
        *(
            _compile_discovered_entry(target, entry, widget_key(entry, target.src_dir))
            for entry in entries
        )
    )
    return all(results)


def _widget_updated_payload(target: CompileTarget, path: Path, schema_ok: bool) -> dict[str, Any]:
    """Build the ``widget_updated`` broadcast payload for a freshly compiled
    entry. Shared by the watcher loop and on-demand ``recompile``."""
    key = widget_key(path, target.src_dir)
    return {
        "type": "widget_updated",
        "key": key,
        "name": _entry_name(path),
        "ts": target.status.get(key, {}).get("ts", iso_now("milliseconds")),
        "schema_ok": schema_ok,
    }


async def recompile(
    on_change: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    *,
    entry: Path | None = None,
    src_dir: Path | None = None,
    out_dir: Path | None = None,
) -> bool:
    """On-demand recompile of one entry (``entry``) or every entry, then
    regenerate the schema manifest. Mirrors a single watcher iteration but
    triggered manually (e.g. the admin "Recompile" buttons): for each compiled
    entry, invoke ``on_change`` with a ``widget_updated`` payload so open
    browsers reload the module. Returns the schema-regeneration result."""
    target = compile_target(src_dir, out_dir)
    discovered = discovered_entries_by_key(target.src_dir)
    key_by_entry = {path: key for key, path in discovered.items()}
    if entry is None:
        entries = list(discovered.values())
    elif entry in key_by_entry:
        entries = [entry]
    else:
        entries = []
    if entry is None:
        await _prune_status(target, entries)
    if entries:
        await asyncio.gather(
            *(
                _compile_discovered_entry(target, path, key_by_entry[path])
                for path in entries
            )
        )
    schema_ok = regenerate_widget_schemas(target.src_dir, target.out_dir)
    if on_change is not None:
        for path in entries:
            try:
                await on_change(_widget_updated_payload(target, path, schema_ok))
            except Exception:
                logger.exception("widget_updated broadcast callback failed")
    return schema_ok


def regenerate_widget_schemas(src_dir: Path | None = None, out_dir: Path | None = None) -> bool:
    """Rewrite ``widget-schemas.json`` from the registry plus every custom
    widget. Returns True on success, False if extraction failed (the previous
    manifest stays on disk in that case).

    A custom widget the extractor cannot read does not fail the run: it lands in
    the manifest carrying ``schemaError`` instead of a schema, so every other
    widget still gets one. Only a broken registry or an I/O error is fatal.

    The file describes exactly what this compile produced. Stdlib widgets are
    overlaid onto ``builtin`` by the single reader,
    ``core.validation.structure.load_widget_manifest`` — they ship with the
    product, so they must be visible even where no compile has ever run.
    """
    return _regenerate_widget_schemas(compile_target(src_dir, out_dir))


def _regenerate_widget_schemas(target: CompileTarget) -> bool:
    root = target.src_dir
    registry_path = _registry_path()
    try:
        if registry_path.is_file():
            registry_source = registry_path.read_text(encoding="utf-8")
        else:
            # Deployed runtimes without the frontend source tree get an empty
            # registry — built-in schemas ship as part of the bundled manifest
            # baked at build time.
            registry_source = "export const widgetRegistry = {};"
        sources: list[dict[str, str]] = []
        for entry in find_entries(root):
            sources.append(
                {
                    "key": widget_key(entry, root),
                    "file": str(entry),
                    "source": entry.read_text(encoding="utf-8"),
                }
            )
        manifest = extract_schemas(
            registry_source=registry_source,
            registry_file=str(registry_path),
            custom_widget_sources=sources,
        )
        for key, entry in manifest["custom"].items():
            if entry.get("schemaError"):
                logger.error(
                    "Widget-schema extraction failed for %s: %s",
                    key,
                    entry["schemaError"],
                )
        write_json(target.schemas_path, manifest)
        return True
    except ExtractionError as err:
        logger.error("Widget-schema extractor failed: %s", err)
        return False
    except OSError as err:
        logger.error("Widget-schema extractor I/O error: %s", err)
        return False


# The only schema-field attributes the *runtime* reads: `type` and
# `requiredFields` are what `useBindingStatus` needs to decide whether a bound
# variable fits the slot it is bound to (see hmi/utils/bindingValidation.ts).
# Everything else on a field — label, group, options, defaults, placeholders,
# visibleWhen, min/max/step — only ever reaches the properties panel.
_RUNTIME_SCHEMA_KEYS = frozenset({"type", "requiredFields"})

# Row-level metadata with the same story: read only by the editor's palette,
# widget tree and `$widgetProp` picker, never by a rendering HMI page.
_EDITOR_ROW_KEYS = ("description", "icon", "exportedProperties")


def _split_schema(schema: Any) -> tuple[Any, dict[str, Any]]:
    """Divide one widget's schema into its runtime half and its editor half.

    The runtime half keeps every field — dropping one would silently stop
    validating a binding — and strips each down to the attributes the runtime
    reads. The editor half holds only the stripped attributes, and omits a field
    that had none, so nothing is stored twice.
    """
    if not isinstance(schema, dict):
        return schema, {}
    runtime: dict[str, Any] = {}
    editor: dict[str, Any] = {}
    for key, field in schema.items():
        if not isinstance(field, dict):
            runtime[key] = field
            continue
        runtime[key] = {k: v for k, v in field.items() if k in _RUNTIME_SCHEMA_KEYS}
        rest = {k: v for k, v in field.items() if k not in _RUNTIME_SCHEMA_KEYS}
        if rest:
            editor[key] = rest
    return runtime, editor


def generate_stdlib_manifest(
    manifest_path: Path,
    src_dir: Path | None = None,
    out_dir: Path | None = None,
) -> bool:
    """Emit the baked stdlib manifest the frontend imports statically.

    Written as two files — ``manifest_path`` and the ``.editor.json`` sibling
    ``core.stdlib_manifest.editor_manifest_path`` names — because the frontend
    pays for them in different places. The runtime half is imported by
    ``widgetRegistry.tsx``, which every route reaches, so it lands in the shared
    entry chunk that a plain HMI page loads; the editor half is imported only
    from ``src/config/``, so it lands in the editor's own chunk and an operator
    running an HMI page never fetches it. Both halves are static imports: the
    palette is still fully populated at first paint, editor descriptions and
    icons included. Splitting is what makes an editor-only byte free for the
    runtime; deferring it would not.

    Every reader that needs the whole picture — config validation, the MCP
    tools — goes through ``core.stdlib_manifest``, which merges the pair back.

    Same row shape as ``GET /api/widgets`` so one registration path serves both,
    plus two fields the runtime endpoint has no need for:

    * ``origin`` — tells the loader to fetch from ``/stdlib-js/`` rather than
      ``/widget-js/``.
    * ``usesRecharts`` — whether the compiled module actually references the
      Recharts global. Without it the loader must populate ``window.__nextHMI__
      .Recharts`` before *every* stdlib import, which would drag the chart
      library into first paint on pages that have no chart. Recorded by the
      compile that wrote the module, which already scanned it to build the SDK
      banner; re-reading every artifact here would ask the same question twice.

    Baking this at build time is what keeps the registry synchronous at module
    eval: schemas, categories and icons are present before first render, and only
    the component modules load lazily.

    ``buildTs`` carries the compile's *content hash* here, not its timestamp:
    this file is tracked and every ``npm run dev`` regenerates it, so a
    wall-clock stamp would dirty the working tree and conflict on every rebase.
    The loader only ever appends it as the ``?t=`` cache-buster, and a digest
    busts the cache exactly when the served bytes change. The runtime endpoint
    keeps a real timestamp — the admin panel renders that one as a clock time.
    """
    target = compile_target(src_dir, out_dir)
    root = target.src_dir
    try:
        schemas = json.loads(target.schemas_path.read_text(encoding="utf-8"))
        catalog = schemas.get("custom") if isinstance(schemas.get("custom"), dict) else {}
        status = decode_build_status(
            json.loads(target.status_path.read_text(encoding="utf-8"))
        )

        rows: list[dict[str, Any]] = []
        editor: dict[str, dict[str, Any]] = {}
        for source in find_entries(root):
            key = widget_key(source, root)
            parts = key.split("/")
            metadata = catalog.get(key) if isinstance(catalog.get(key), dict) else {}
            entry_status = status.get(key) or {}
            runtime_schema, editor_schema = _split_schema(metadata.get("schema"))
            rows.append(
                {
                    "key": key,
                    "name": source.parent.name,
                    "group": parts[0] if len(parts) == 2 else None,
                    "origin": "stdlib",
                    "hasStyle": (source.parent / "style.css").exists(),
                    "hasFonts": (source.parent / "fonts").is_dir(),
                    "usesRecharts": entry_status.get("usesRecharts") is True,
                    "buildOk": entry_status.get("ok"),
                    "buildTs": entry_status.get("hash"),
                    "displayName": metadata.get("displayName"),
                    "hostsChildren": metadata.get("hostsChildren"),
                    "category": metadata.get("category"),
                    "schema": runtime_schema,
                    "schemaError": metadata.get("schemaError"),
                }
            )
            half = {k: metadata[k] for k in _EDITOR_ROW_KEYS if metadata.get(k) is not None}
            if editor_schema:
                half["schema"] = editor_schema
            if half:
                editor[key] = half

        rows.sort(key=lambda row: row["key"])
        write_json(manifest_path, rows)
        editor_path = editor_manifest_path(manifest_path)
        write_json(editor_path, dict(sorted(editor.items())))
        logger.info(
            "Wrote stdlib manifest (%d widget(s)): %s + %s",
            len(rows),
            manifest_path,
            editor_path.name,
        )
        return True
    except (OSError, json.JSONDecodeError) as err:
        logger.error("Stdlib manifest generation failed: %s", err)
        return False


def publish_stdlib_assets(
    publish_dir: Path,
    src_dir: Path | None = None,
    out_dir: Path | None = None,
    manifest_path: Path | None = None,
) -> bool:
    """Copy the servable half of a stdlib build into the frontend's public tree.

    The build root also holds ``.build-status.json`` and ``widget-schemas.json``
    — intermediates that must not ship. Only ``<key>/index.js``, each widget's
    source ``style.css`` and its ``fonts/`` directory are published, so the
    public tree contains exactly what a browser fetches, plus both halves of the
    manifest: the frontend imports those statically from ``src/generated/``, but
    a packaged runtime has no ``src/`` and still needs stdlib schemas to
    validate pages against.

    The publish root is emptied before it is refilled — a widget deleted from
    the sources must not keep serving — so it must be the directory this build
    owns. ``publish_dir`` comes from a CLI flag, and dropping one path segment
    off ``frontend/public/stdlib-js`` would otherwise delete every public asset
    the app ships; the basename check makes that typo a refusal.

    A widget whose compile failed is skipped rather than published: an
    incremental build over an existing build root still holds the *previous*
    run's ``index.js``, which would copy cleanly and serve a module that no
    longer matches its source — and with no ``buildTs`` for a failed widget the
    cache-buster never changes either. Skipping is what removes it, since the
    publish root is rewritten from scratch. The rest of the tree still
    publishes, and the run still fails.
    """
    if publish_dir.name != PUBLISH_DIR_NAME:
        logger.error(
            "Refusing to publish into %s: the publish root is cleared before it is "
            "rewritten, so it must be a directory named %r",
            publish_dir,
            PUBLISH_DIR_NAME,
        )
        return False
    target = compile_target(src_dir, out_dir)
    root, build_root = target.src_dir, target.out_dir
    status = _build_status_on_disk(target)
    try:
        if publish_dir.exists():
            shutil.rmtree(publish_dir)
        published = 0
        complete = True
        for source in find_entries(root):
            key = widget_key(source, root)
            compiled = build_root / f"{key}/index.js"
            if status.get(key, {}).get("ok") is False:
                logger.error(
                    "Skipping stdlib publish of %s: it failed to compile in this build", key
                )
                complete = False
                continue
            if not compiled.is_file():
                logger.error("Missing compiled artifact for stdlib widget %s", key)
                complete = False
                continue
            dest = publish_dir / key
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy2(compiled, dest / "index.js")
            stylesheet = source.parent / "style.css"
            if stylesheet.is_file():
                shutil.copy2(stylesheet, dest / "style.css")
            fonts = source.parent / "fonts"
            if fonts.is_dir() and not fonts.is_symlink():
                # A widget's @font-face rules resolve relative to its published
                # stylesheet, so the faces have to travel with it.
                shutil.copytree(fonts, dest / "fonts", dirs_exist_ok=True)
            published += 1
        if manifest_path is not None and manifest_path.is_file():
            published_manifest = publish_dir / "manifest.json"
            shutil.copy2(manifest_path, published_manifest)
            # Both halves travel: a packaged runtime has no `src/`, and config
            # validation there still has to see whole schemas.
            editor_source = editor_manifest_path(manifest_path)
            if editor_source.is_file():
                shutil.copy2(editor_source, editor_manifest_path(published_manifest))
        logger.info("Published %d stdlib widget(s): %s", published, publish_dir)
        return complete
    except OSError as err:
        logger.error("Stdlib publish failed: %s", err)
        return False


def entry_for_key(key: str, src_dir: Path | None = None) -> Path | None:
    """Inverse of ``widget_key``: map a registry key (flat ``<Name>`` or grouped
    ``<Group>/<Name>``) back to its ``index.tsx`` path, or None if no entry
    matches. The key *is* the relative path, so resolve it directly rather than
    scanning every entry."""
    root = src_dir if src_dir is not None else active_custom_widgets_dir()
    if not is_canonical_widget_key(key):
        return None
    return discovered_entries_by_key(root).get(key)


async def start_watcher(
    on_change: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    *,
    src_dir: Path | None = None,
) -> None:
    """Watch ``src_dir`` (default: the live project's custom-widgets dir) for ``*.tsx``
    changes. For each batch, recompile the touched entries, regenerate the
    schema manifest, and invoke ``on_change`` with a ``widget_updated``
    payload so the websocket layer can broadcast to browsers.

    Runs forever — designed to be wrapped in ``asyncio.create_task`` and
    cancelled on shutdown.
    """
    from watchfiles import awatch  # imported lazily to keep dep light at import time

    target = compile_target(src_dir)
    root = target.src_dir
    if not root.is_dir():
        logger.info("Custom widgets dir absent (%s); watcher idle", root)
        return

    # WATCHFILES_FORCE_POLLING is read by watchfiles itself; we set it in the
    # Docker entrypoint where inotify across the volume mount is unreliable.
    async for changes in awatch(root, recursive=True):
        touched = _collect_touched_entries(changes, root)
        removed = await _prune_status(target, find_entries(root))
        if not touched and not removed:
            continue
        try:
            await asyncio.gather(
                *(
                    _compile_discovered_entry(target, path, widget_key(path, root))
                    for path in touched
                )
            )
            schema_ok = regenerate_widget_schemas(root)
        except Exception:
            # One bad file must not permanently kill hot-reload for every
            # other widget (§8.1) — log and keep watching.
            logger.exception(
                "Widget watcher iteration failed for %s; hot-reload continues", touched,
            )
            continue
        if on_change is None:
            continue
        for path in touched:
            try:
                await on_change(_widget_updated_payload(target, path, schema_ok))
            except Exception:
                logger.exception("widget_updated broadcast callback failed")
        for key in sorted(removed):
            try:
                await on_change({
                    "type": "widget_updated",
                    "key": key,
                    "name": key.rsplit("/", 1)[-1],
                    "ts": iso_now("milliseconds"),
                    "schema_ok": schema_ok,
                })
            except Exception:
                logger.exception("widget_updated deletion broadcast callback failed")


def _collect_touched_entries(
    changes: Iterable[tuple[Any, str]], root: Path
) -> list[Path]:
    """Reduce a batch of watchfiles changes to the unique ``index.tsx`` files
    they affect.

    A change anywhere inside ``<Name>/`` (e.g. a sibling ``foo.ts`` that
    ``index.tsx`` imports) is treated as a change to that widget's entry —
    mirrors the Vite plugin's behaviour where any save in the dir invalidated
    the module graph for that widget."""
    entries = find_entries(root)
    seen: set[Path] = set()
    out: list[Path] = []
    for _change, path_str in changes:
        path = Path(path_str)
        for entry in entries:
            try:
                path.relative_to(entry.parent)
            except ValueError:
                continue
            if entry not in seen:
                seen.add(entry)
                out.append(entry)
    return out


def _run_once(
    src_dir: Path | None = None,
    out_dir: Path | None = None,
    manifest_path: Path | None = None,
    publish_dir: Path | None = None,
) -> int:
    """Synchronous wrapper for ``--once``: compile every entry then
    regenerate the schema manifest. Used by Docker image build, the stdlib
    build step and any CI one-shot.

    ``manifest_path`` additionally emits the frontend-consumable stdlib
    manifest — the baked registry the app imports statically.
    ``publish_dir`` copies the servable artifacts into the frontend public tree.
    """
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    async def main() -> int:
        compile_ok = await compile_all(src_dir, out_dir)
        schema_ok = regenerate_widget_schemas(src_dir, out_dir)
        manifest_ok = True
        if manifest_path is not None:
            manifest_ok = generate_stdlib_manifest(manifest_path, src_dir, out_dir)
        publish_ok = True
        if publish_dir is not None and manifest_ok:
            publish_ok = publish_stdlib_assets(
                publish_dir, src_dir, out_dir, manifest_path
            )
        elif publish_dir is not None:
            # A previous run's manifest.json is still on disk and would copy
            # cleanly, shipping a served tree whose schemas describe a build
            # that no longer exists.
            logger.error("Skipping stdlib publish: manifest generation failed")
        return 0 if compile_ok and schema_ok and manifest_ok and publish_ok else 1

    return asyncio.run(main())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="python -m services.widget_compiler")
    parser.add_argument(
        "--once",
        action="store_true",
        help="compile every entry and regenerate the schema manifest, then exit",
    )
    parser.add_argument(
        "--src-dir",
        type=Path,
        help="widget source root (default: the live project's custom-widgets/)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        help="build output root (default: the runtime-home widget cache)",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        help="also emit the frontend-consumable stdlib manifest at this path",
    )
    parser.add_argument(
        "--publish-dir",
        type=Path,
        help="also copy index.js + style.css per widget into this served directory",
    )
    args = parser.parse_args()
    if args.once:
        sys.exit(_run_once(args.src_dir, args.out_dir, args.manifest, args.publish_dir))
    parser.print_help()
    sys.exit(2)
