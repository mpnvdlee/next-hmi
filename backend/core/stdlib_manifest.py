"""Reader for the baked stdlib-widget manifest.

The product's standard-library widgets are compiled on the build machine (see
``services.widget_compiler.generate_stdlib_manifest``) and their catalog rows
ship with the frontend. As far as validation and the MCP tools are concerned
those widgets *are* built-ins — they simply live outside ``widgetRegistry.tsx``
now — so ``core.validation.structure.load_widget_manifest`` overlays them onto
the manifest's ``builtin`` map.

The manifest ships as a *pair* of files: a runtime half every frontend route
imports statically, and an editor half only the editor's chunk pulls in (see
``generate_stdlib_manifest``). Validation needs whole schemas, so this reader
always merges the two back together — a caller here never sees the split.

This lives in ``core`` rather than beside the compiler that writes it because
``core`` must never import ``services``, and every reader of the merged manifest
is in ``core`` or above it.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from core.storage import repo_root

logger = logging.getLogger(__name__)


def stdlib_manifest_path() -> Path | None:
    """Locate the baked stdlib manifest, or None when there is none to read.

    Two shapes, both handled here so this works from a checkout and from a
    packaged runtime: the frontend source tree holds it under ``src/generated/``
    (the app imports it statically from there), and ``publish_stdlib_assets``
    copies it next to the served modules for a build that ships only ``dist/``.
    """
    dist = os.environ.get("NEXTHMI_FRONTEND_DIST")
    if dist:
        published = Path(dist).resolve() / "stdlib-js" / "manifest.json"
        if published.is_file():
            return published
    generated = repo_root() / "frontend" / "src" / "generated" / "stdlibManifest.json"
    return generated if generated.is_file() else None


def editor_manifest_path(manifest_path: Path) -> Path:
    """The editor half's path, derived from the runtime half's.

    One rule shared by the writer and every reader, so the pair travels together
    from a checkout (``stdlibManifest.json`` / ``stdlibManifest.editor.json``)
    into a packaged runtime (``manifest.json`` / ``manifest.editor.json``)
    without a second CLI flag or a second resolver to keep in step.
    """
    return manifest_path.with_name(f"{manifest_path.stem}.editor{manifest_path.suffix}")


def _mtime_ns(path: Path) -> int:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return 0


CatalogVersion = tuple[int, int]

_NO_CATALOG: CatalogVersion = (0, 0)


def _catalog_state() -> tuple[Path | None, CatalogVersion]:
    """The manifest pair's path and cache key, resolved in a single pass.

    Every page-write validation needs both, and each resolver call costs a
    stat per candidate location, so they are derived together rather than
    re-derived by each caller.
    """
    path = stdlib_manifest_path()
    if path is None:
        return None, _NO_CATALOG
    return path, (_mtime_ns(path), _mtime_ns(editor_manifest_path(path)))


def stdlib_catalog_version() -> CatalogVersion:
    """Cache key for the manifest's current contents: both halves' mtimes.

    Both halves count — they are written by the same build but land as two
    files, and a catalog cached off the runtime half alone would survive an
    editor half that changed underneath it. The two stay separate rather than
    combining into one number: a checkout, a stash, a rebase, a tarball extract
    or an rsync all set mtimes to arbitrary values, so offsetting moves on the
    pair would cancel out and pin the previous build's catalog.

    ``(0, 0)`` when there is no manifest to read.

    Callers that cache something *derived* from the catalog key on this so their
    entry invalidates with it.
    """
    return _catalog_state()[1]


_catalog_cache: tuple[CatalogVersion, dict[str, dict[str, Any]]] | None = None


def stdlib_catalog() -> tuple[CatalogVersion, dict[str, dict[str, Any]]]:
    """The cached catalog together with the version it was read at.

    Both in one call because ``load_widget_manifest`` keys its own cache on the
    version and would otherwise re-resolve the manifest path and re-stat both
    halves just to ask for it again.
    """
    global _catalog_cache
    path, version = _catalog_state()
    if _catalog_cache is not None and _catalog_cache[0] == version:
        return version, _catalog_cache[1]
    entries = _read_catalog_entries(path) if path is not None else {}
    _catalog_cache = (version, entries)
    return version, entries


def stdlib_catalog_entries() -> dict[str, dict[str, Any]]:
    """Stdlib widgets in the manifest's ``builtin`` shape, keyed by widget type.

    Mtime-cached like every other generated-file reader in
    ``core/validation/structure.py``. A packaged runtime never rewrites the
    manifest, but a dev checkout does — ``npm run dev`` runs ``build:stdlib``
    while the backend is already up — so a read-once cache would pin whatever
    (possibly empty) catalog existed at first call until restart.
    """
    return stdlib_catalog()[1]


def _load(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as err:
        logger.warning("Could not read the stdlib manifest at %s: %s", path, err)
        return None


def _merge_schema(runtime: Any, editor: Any) -> dict[str, Any]:
    """Put a field's editor-only attributes back on top of its runtime ones.

    Field order comes from the runtime half, which is the half that carries
    every field — the editor half only holds the attributes that half dropped,
    and omits a field entirely when it has none left.
    """
    if not isinstance(runtime, dict):
        return {}
    if not isinstance(editor, dict):
        return runtime
    merged: dict[str, Any] = {}
    for key, field in runtime.items():
        extra = editor.get(key)
        if isinstance(field, dict) and isinstance(extra, dict):
            merged[key] = {**field, **extra}
        else:
            merged[key] = field
    return merged


def _read_catalog_entries(path: Path) -> dict[str, dict[str, Any]]:
    rows = _load(path)
    if not isinstance(rows, list):
        return {}
    editor_rows = _load(editor_manifest_path(path))
    editor = editor_rows if isinstance(editor_rows, dict) else {}
    entries: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("name"), str):
            continue
        extra = editor.get(row.get("key"))
        if not isinstance(extra, dict):
            extra = {}
        entry: dict[str, Any] = {
            "name": row.get("displayName") or row["name"],
            "category": row.get("category") or "Other",
            "schema": _merge_schema(row.get("schema"), extra.get("schema")),
        }
        for optional in ("description", "icon"):
            if extra.get(optional) is not None:
                entry[optional] = extra[optional]
        if row.get("hostsChildren") is not None:
            entry["hostsChildren"] = row["hostsChildren"]
        entries[row["name"]] = entry
    return entries
