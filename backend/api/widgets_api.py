import contextlib
import json
import mimetypes
from pathlib import Path

from core.exceptions import NotFoundError
from core.storage import (
    BUILD_STATUS_PATH,
    active_custom_widgets_dir,
    active_icons_dir,
    active_images_dir,
)
from core.validation.structure import load_widget_manifest
from fastapi import APIRouter, Request
from services import widget_compiler

router = APIRouter()

# Allowed asset types per subfolder
_ICON_EXTENSIONS = {".svg"}
_IMAGE_EXTENSIONS = {".png", ".webp", ".jpg", ".jpeg", ".gif", ".svg"}


def _scan_assets(root: Path, subfolder: str, extensions: set[str], asset_type: str) -> list[dict]:
    """Recursively scan `root` (assets/<subfolder>) for files, preserving any nested folder path."""
    result: list[dict] = []
    if not root.exists():
        return result
    for entry in sorted(root.rglob("*")):
        if entry.is_file() and entry.suffix.lower() in extensions:
            rel = entry.relative_to(root).as_posix()
            mime, _ = mimetypes.guess_type(entry.name)
            result.append({
                "name": entry.name,
                "path": f"{subfolder}/{rel}",
                "type": asset_type,
                "mime": mime or "application/octet-stream",
                "size": entry.stat().st_size,
            })
    return result


@router.get("/api/assets")
async def list_assets() -> list[dict]:
    """
    List custom icons and images from the live project's assets/icons and assets/images folders,
    including any nested subfolders.
    Returns: [{ name, path, type ('icon'|'image'), mime, size }]
    All paths are relative to the assets root so they can be used as /assets/{path}.
    """
    result: list[dict] = []
    result.extend(_scan_assets(active_icons_dir(), "icons", _ICON_EXTENSIONS, "icon"))
    result.extend(_scan_assets(active_images_dir(), "images", _IMAGE_EXTENSIONS, "image"))
    return result


@router.get("/api/widgets")
async def list_components() -> list[dict]:
    """Scan the live project's custom-widgets folder and return metadata per widget.

    Layouts:
      Flat     `custom-widgets/<Name>/index.tsx`             → group: null
      Grouped  `custom-widgets/<Group>/<Name>/index.tsx`     → group: "<Group>"

    Returns: [{ key, name, group, hasStyle, hasFonts, buildOk, buildError, buildTs,
                category, description, icon, schema, exportedProperties, schemaError }]

    The catalog half (everything from ``category`` on) is read from the compiled
    ``widget-schemas.json`` so the client can register a widget — schema, drawer
    entry, `$widgetProp` list — without importing its module. That is what lets
    the modules load lazily on first render instead of all at once at boot.
    """
    custom_widgets_dir = active_custom_widgets_dir()
    if not custom_widgets_dir.exists():
        return []

    build_status: dict = {}
    if BUILD_STATUS_PATH.exists():
        with contextlib.suppress(Exception):
            build_status = widget_compiler.decode_build_status(
                json.loads(BUILD_STATUS_PATH.read_text(encoding="utf-8"))
            )

    # mtime-cached: the manifest only changes when the compiler rebuilds it, and
    # this endpoint is hit again after every single-widget recompile.
    custom = load_widget_manifest().get("custom")
    catalog: dict = custom if isinstance(custom, dict) else {}

    def _entry(entry: Path, key: str, group: str | None) -> dict:
        status = build_status.get(key)
        metadata = catalog.get(key) if isinstance(catalog.get(key), dict) else {}
        return {
            "key": key,
            "name": entry.name,
            "group": group,
            "hasStyle": (entry / "style.css").exists(),
            "hasFonts": (entry / "fonts").is_dir(),
            "buildOk": status["ok"] if status is not None else None,
            "buildError": status.get("error") if status and not status.get("ok") else None,
            "buildTs": status.get("ts") if status else None,
            "displayName": metadata.get("displayName"),
            "hostsChildren": metadata.get("hostsChildren"),
            "category": metadata.get("category"),
            "description": metadata.get("description"),
            "icon": metadata.get("icon"),
            "schema": metadata.get("schema"),
            "exportedProperties": metadata.get("exportedProperties"),
            # Set when the widget compiled but its exports could not be reduced
            # to literals: it renders, yet has no property fields and no
            # `$widgetProp` exports, which is invisible without saying so.
            "schemaError": metadata.get("schemaError"),
        }

    result: list[dict] = []
    for source in widget_compiler.find_entries(custom_widgets_dir):
        key = widget_compiler.widget_key(source, custom_widgets_dir)
        parts = key.split("/")
        result.append(_entry(source.parent, key, parts[0] if len(parts) == 2 else None))
    return result


async def _recompile(entry: Path | None) -> list[dict]:
    """Recompile one entry (or every entry when ``entry`` is None), broadcasting
    a ``widget_updated`` event per widget so open browsers reload. Returns the
    refreshed widget metadata (same shape as ``GET /api/widgets``)."""
    from services.websocket_manager import websocket_manager  # local — avoids circular

    await widget_compiler.recompile(websocket_manager.broadcast_widget_updated, entry=entry)
    return await list_components()


@router.post("/api/widgets/recompile")
async def recompile_all_widgets() -> list[dict]:
    """Recompile every custom widget and regenerate the schema manifest."""
    return await _recompile(None)


@router.post("/api/widgets/recompile/{key:path}")
async def recompile_widget(key: str, request: Request) -> list[dict]:
    """Recompile a single custom widget identified by its registry ``key``
    (flat ``<Name>`` or grouped ``<Group>/<Name>``)."""
    raw_path = request.scope.get("raw_path", b"")
    raw_prefix = b"/api/widgets/recompile/"
    raw_key = raw_path.partition(raw_prefix)[2]
    if b"%" in raw_key:
        raise NotFoundError(f"Custom widget not found: {key}")
    entry = widget_compiler.entry_for_key(key)
    if entry is None:
        raise NotFoundError(f"Custom widget not found: {key}")
    return await _recompile(entry)


@router.get("/api/widget-schemas")
async def get_widget_schemas() -> dict:
    """Return the build-time widget schema manifest.

    Regenerated by ``backend.services.widget_compiler`` whenever a custom
    widget changes (lifespan + watchfiles). Validators use this to type-check
    widget property writes.

    Read through the shared loader rather than the file, so the response carries
    the same stdlib-overlaid ``builtin`` map the validators see. The overlay is
    the reason there is no ``widget-schemas.json`` existence check here: stdlib
    widgets ship with the product, so a runtime home that has never compiled
    still has a catalog to serve. Only a manifest with nothing in either map —
    no stdlib build, no compile — is a 404.
    """
    manifest = load_widget_manifest()
    if not manifest.get("builtin") and not manifest.get("custom"):
        raise NotFoundError(
            "Widget schema manifest not built — start the backend or run "
            "`python -m services.widget_compiler --once` from backend/."
        )
    return manifest
