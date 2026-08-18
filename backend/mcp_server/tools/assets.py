from __future__ import annotations

import base64
import mimetypes
import re
from pathlib import Path
from typing import Any

from core.exceptions import (
    ConfigConflictError,
    ConfigNotFoundError,
    ConfigValidationError,
)
from core.storage import (
    active_assets_dir,
    active_components_dir,
    active_icons_dir,
    active_images_dir,
    active_pages_dir,
    read_json,
    write_bytes_atomic,
    write_text_atomic,
)

from .. import idempotency, locks
from ..confirm import applied_response, dry_run_response
from ..pagination import paginated_payload
from ..server import expose_read_tool, get_agent_label, register_tool
from ..write_helpers import emit_change

_NAME_RE = re.compile(r"^[A-Za-z0-9_\-.]+$")
_MAX_SVG_BYTES = 5 * 1024 * 1024
_MAX_IMAGE_BYTES = 5 * 1024 * 1024
_ASSET_REF_TYPES = frozenset({"image", "icon"})

# SVG payloads are rendered inline in the HMI; strip the elements/attrs that
# would let an uploaded asset run script in the host page.
_SVG_FORBIDDEN_TAG_RE = re.compile(
    r"<\s*(?:script|foreignObject)\b[^>]*>.*?<\s*/\s*(?:script|foreignObject)\s*>",
    re.IGNORECASE | re.DOTALL,
)
_SVG_FORBIDDEN_SELF_CLOSING_RE = re.compile(
    r"<\s*(?:script|foreignObject)\b[^>]*/?>",
    re.IGNORECASE,
)
_SVG_ON_ATTR_RE = re.compile(
    r"""\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)""",
)
_SVG_JS_HREF_RE = re.compile(
    r"""(\s+(?:xlink:)?href\s*=\s*['"])\s*javascript:[^'"]*""",
    re.IGNORECASE,
)


def _sanitize_svg(svg: str) -> str:
    svg = _SVG_FORBIDDEN_TAG_RE.sub("", svg)
    svg = _SVG_FORBIDDEN_SELF_CLOSING_RE.sub("", svg)
    svg = _SVG_ON_ATTR_RE.sub("", svg)
    svg = _SVG_JS_HREF_RE.sub(r"\1", svg)
    return svg


def _validate_name(name: str) -> None:
    """Validate a (possibly nested) asset name, e.g. ``pump.svg`` or ``machines/pump.svg``."""
    segments = name.split("/")
    if not segments or any(
        not _NAME_RE.match(segment) or segment in {".", ".."} or segment.startswith(".")
        for segment in segments
    ):
        raise ConfigValidationError("Invalid asset name")


def _resolve_target(group: str, name: str) -> Path:
    if group == "icons":
        base = active_icons_dir()
    elif group == "images":
        base = active_images_dir()
    else:
        raise ConfigValidationError("group must be 'icons' or 'images'")
    target = (base / name).resolve()
    if not target.is_relative_to(base.resolve()):
        raise ConfigValidationError("Invalid asset name")
    return target


def _value_references_asset(value: Any, asset_path: str) -> bool:
    """Match a property value (possibly a `$static` source).

    Handles bare string filenames, `$static` string payloads, and structured
    `$static` icon/image payloads (`{ path }` / `{ type, path }`).
    """
    if isinstance(value, str) and value == asset_path:
        return True
    if isinstance(value, dict):
        inner = value.get("$static")
        if isinstance(inner, str) and inner == asset_path:
            return True
        if isinstance(inner, dict):
            path = inner.get("path")
            if isinstance(path, str) and path == asset_path:
                return True
            if _value_references_asset(inner, asset_path):
                return True
    return False


def _walk_widget_node(node: Any, asset_path: str, schemas: dict) -> bool:
    if not isinstance(node, dict):
        return False
    wtype = node.get("type")
    schema: dict | None = None
    if isinstance(wtype, str):
        if wtype in schemas.get("builtin", {}):
            schema = schemas["builtin"][wtype].get("schema", {})
        else:
            for key, entry in schemas.get("custom", {}).items():
                if key.split("/")[-1] == wtype:
                    schema = entry.get("schema", {})
                    break
    props = node.get("properties", {})
    if isinstance(props, dict) and isinstance(schema, dict):
        for key, value in props.items():
            field = schema.get(key)
            if isinstance(field, dict) and field.get("type") in _ASSET_REF_TYPES:  # noqa: SIM102 -- no autofix offered, left as-is per the mechanical-only policy for this family
                if _value_references_asset(value, asset_path):
                    return True
    for child in node.get("children", []) if isinstance(node.get("children"), list) else []:
        if _walk_widget_node(child, asset_path, schemas):
            return True
    return False


def _asset_referenced(asset_path: str) -> bool:
    """Schema-aware reference check across pages and reusable components."""
    from core.validation.structure import load_widget_manifest
    schemas = load_widget_manifest()
    for path in active_pages_dir().glob("*.json"):
        try:
            doc = read_json(path)
        except Exception:
            continue
        sections = doc.get("sections", {}) if isinstance(doc, dict) else {}
        if isinstance(sections, dict):
            for children in sections.values():
                if isinstance(children, list):
                    for child in children:
                        if _walk_widget_node(child, asset_path, schemas):
                            return True
    for path in active_components_dir().glob("*.json"):
        try:
            doc = read_json(path)
        except Exception:
            continue
        tree = doc.get("tree", []) if isinstance(doc, dict) else []
        for node in tree if isinstance(tree, list) else []:
            if _walk_widget_node(node, asset_path, schemas):
                return True
    return False


def _list_items() -> list[tuple[str, str, dict]]:
    items: list[tuple[str, str, dict]] = []
    for asset_dir, asset_type in (
        (active_icons_dir(), "icon"),
        (active_images_dir(), "image"),
    ):
        if not asset_dir.exists():
            continue
        for entry in sorted(asset_dir.rglob("*")):
            if not entry.is_file():
                continue
            mime, _ = mimetypes.guess_type(entry.name)
            rel_path = f"{asset_dir.name}/{entry.relative_to(asset_dir).as_posix()}"
            summary = {
                "name": entry.name,
                "path": rel_path,
                "type": asset_type,
                "mime": mime or "application/octet-stream",
                "size": entry.stat().st_size,
            }
            items.append((rel_path, rel_path, summary))
    return items


def _list_payload(cursor: str | None = None, limit: int | None = None) -> dict[str, Any]:
    return paginated_payload(_list_items(), cursor=cursor, limit=limit)


assets_list = expose_read_tool(
    _list_payload,
    name="assets_list",
    description=(
        "List asset metadata. Each item: ``{ name, path, type, mime, size }``. "
        "Binaries are fetched separately via ``GET /assets/<path>`` — this tool "
        "returns metadata only."
    ),
)


@register_tool()
async def assets_upload(
    name: str,
    group: str,
    content: str,
    encoding: str,
    mime: str | None = None,
    overwrite: bool = False,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Upload an asset. ``group`` is ``icons`` or ``images``.

    ``encoding`` selects the payload format:
    - ``"svg"``  — ``content`` is UTF-8 SVG markup; sanitized before write.
      ``mime`` defaults to ``image/svg+xml``.
    - ``"base64"`` — ``content`` is base64-encoded binary (png/jpg/webp).
      ``mime`` is required and round-tripped in the response.
    """
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    _validate_name(name)
    target = _resolve_target(group, name)
    rel_path = f"{group}/{name}"

    if encoding == "svg":
        if len(content.encode("utf-8")) > _MAX_SVG_BYTES:
            raise ConfigValidationError("SVG payload exceeds 5 MB limit")
        sanitized = _sanitize_svg(content)
        resolved_mime = mime or "image/svg+xml"
        async with locks.acquire(("asset", rel_path)):
            if target.exists() and not overwrite:
                raise ConfigConflictError(
                    f"Asset '{rel_path}' already exists; pass overwrite=true to replace"
                )
            write_text_atomic(target, sanitized)
            response = applied_response(
                f"Uploaded SVG '{rel_path}'", None, {"path": rel_path, "mime": resolved_mime}
            )
            response["path"] = rel_path
    elif encoding == "base64":
        if not mime:
            raise ConfigValidationError("mime is required when encoding='base64'")
        try:
            decoded = base64.b64decode(content, validate=True)
        except Exception as exc:
            raise ConfigValidationError(f"Invalid base64 payload: {exc}") from exc
        if len(decoded) > _MAX_IMAGE_BYTES:
            raise ConfigValidationError("Image payload exceeds 5 MB limit")
        async with locks.acquire(("asset", rel_path)):
            if target.exists() and not overwrite:
                raise ConfigConflictError(
                    f"Asset '{rel_path}' already exists; pass overwrite=true to replace"
                )
            write_bytes_atomic(target, decoded)
            response = applied_response(
                f"Uploaded image '{rel_path}' ({mime})", None, {"path": rel_path, "mime": mime}
            )
            response["path"] = rel_path
    else:
        raise ConfigValidationError("encoding must be 'svg' or 'base64'")

    await emit_change(
        artifact_type="asset",
        artifact_ids=[rel_path],
        summary=response["summary"],
        diff=response["diff"]
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response


@register_tool()
async def assets_delete(
    path: str,
    confirm: bool = False,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Delete an asset. Refuses if any page or component references it."""
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    if not isinstance(path, str) or "/" not in path or ".." in path.split("/"):
        raise ConfigValidationError("Invalid asset path")
    assets_dir = active_assets_dir()
    assets_root = assets_dir.resolve()
    target = (assets_dir / path).resolve()
    if not target.is_relative_to(assets_root):
        raise ConfigValidationError("Invalid asset path")
    if not target.exists() or not target.is_file():
        raise ConfigNotFoundError(f"Asset '{path}' not found")
    if not confirm:
        # Best-effort reference check — a confirmed delete re-checks under the
        # asset lock so a concurrent widget write can't drop an asset reference
        # right before the unlink without us seeing it.
        if _asset_referenced(path):
            raise ConfigConflictError(
                f"Asset '{path}' is referenced by one or more pages or components"
            )
        return dry_run_response(f"Would delete asset '{path}'", {"path": path}, None)
    async with locks.acquire(("asset", path)):
        if _asset_referenced(path):
            raise ConfigConflictError(
                f"Asset '{path}' is referenced by one or more pages or components"
            )
        target.unlink(missing_ok=True)
        response = applied_response(f"Deleted asset '{path}'", {"path": path}, None)
    await emit_change(
        artifact_type="asset",
        artifact_ids=[path],
        summary=response["summary"],
        diff=response["diff"]
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response
