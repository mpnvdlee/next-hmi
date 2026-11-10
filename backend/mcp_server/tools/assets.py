from __future__ import annotations

import asyncio
import base64
import mimetypes
import re
from pathlib import Path
from typing import Any
from xml.parsers import expat
from xml.sax.saxutils import escape, quoteattr

from api.widgets_api import _ICON_EXTENSIONS, _IMAGE_EXTENSIONS
from core.exceptions import (
    ConfigConflictError,
    ConfigNotFoundError,
    ConfigValidationError,
)
from core.page_index import page_document_files
from core.storage import (
    active_assets_dir,
    active_icons_dir,
    active_images_dir,
    active_videos_dir,
    component_files,
    read_json,
    write_bytes_atomic,
)

from .. import idempotency, locks
from ..confirm import applied_response, dry_run_response
from ..pagination import paginated_payload
from ..server import expose_read_tool, get_agent_label, register_tool
from ..write_helpers import emit_change

_NAME_RE = re.compile(r"^[A-Za-z0-9_\-.]+$")
_MAX_SVG_BYTES = 5 * 1024 * 1024
_MAX_IMAGE_BYTES = 5 * 1024 * 1024
_ASSET_REF_TYPES = frozenset({"image", "icon", "video"})

# The same lists the editor's asset picker shows; a file with any other
# extension (.html, .js) would only be reachable by URL, as active content.
_UPLOAD_EXTENSIONS = {"icons": _ICON_EXTENSIONS, "images": _IMAGE_EXTENSIONS}
_RASTER_MAGIC = {
    ".png": (b"\x89PNG\r\n\x1a\n",),
    ".jpg": (b"\xff\xd8\xff",),
    ".jpeg": (b"\xff\xd8\xff",),
    ".gif": (b"GIF87a", b"GIF89a"),
}

# Icons are inlined into the HMI page, so an SVG keeps only shapes, paint
# servers and structure. Anything else (script, foreignObject, style, a, image,
# animate/set, …) is dropped together with its subtree.
_SVG_NS = "http://www.w3.org/2000/svg"
_XLINK_NS = "http://www.w3.org/1999/xlink"
_SVG_ELEMENTS = frozenset({
    "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon",
    "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask",
    "symbol", "use", "title", "desc", "text", "tspan",
})
# A reference out of the icon, in any attribute (a presentation attribute is
# CSS too): a url() that is not a `#fragment`, an @import, image(), image-set()
# or src() that can name a URL as a plain string, a backslash, since a CSS
# escape can spell `url(` unseen, or an old-IE expression(). OUTSIDE_REF in
# frontend/src/hmi/utils/useInlineSvg.ts drops the same values on inlining.
_OUTSIDE_REF = re.compile(
    r"""\\|@import|url\(\s*(?!['"]?\s*#)|image(?:-set)?\(|src\(|expression""", re.IGNORECASE,
)


def _has_raster_signature(ext: str, data: bytes) -> bool:
    if ext == ".webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    # An extension the asset picker gains later has no known signature: refused.
    return data.startswith(_RASTER_MAGIC.get(ext, ()))


def _attribute_problem(name: str, value: str) -> str | None:
    """Why an attribute is dropped, or ``None`` to keep it. Runs on the parsed
    value, so character references such as ``jav&#x61;script:`` are decoded.
    Names compare case-insensitively: the HTML parser that inlines an icon
    lowercases them."""
    name = name.lower()
    if name.startswith("on"):
        return "event handler"
    if name == "href" and not value.strip().startswith("#"):
        return "link outside the file"
    if _OUTSIDE_REF.search(value):
        return "reference outside the file"
    return None


def _sanitize_svg(data: str | bytes) -> tuple[str, dict[str, int]]:
    """Re-serialize *data* keeping only allowlisted SVG markup.

    Returns the clean SVG and a count per kind of removed item. Rejects input
    that is not well-formed XML, has no ``<svg>`` root, declares a DTD internal
    subset (entities) or references an undefined entity. Linear in the input:
    expat parses once and each event does constant work.
    """
    out: list[str] = []
    removed: dict[str, int] = {}
    stack: list[str] = []
    skip_depth = 0  # > 0 while inside a dropped element
    open_tag = False  # out[-1] is a start tag that may still become self-closing

    def note(what: str) -> None:
        removed[what] = removed.get(what, 0) + 1

    def start(name: str, attrs: dict[str, str]) -> None:
        nonlocal skip_depth, open_tag
        if skip_depth:
            skip_depth += 1
            return
        namespace, _, local = name.rpartition(" ")
        if not stack and (namespace not in ("", _SVG_NS) or local != "svg"):
            raise ConfigValidationError("SVG root element must be <svg>")
        if namespace not in ("", _SVG_NS) or local not in _SVG_ELEMENTS:
            note(f"<{local}> element")
            skip_depth = 1
            return
        kept: dict[str, str] = {}
        for key, value in attrs.items():
            attr_ns, _, attr = key.rpartition(" ")
            if attr_ns == _XLINK_NS and attr == "href":
                # SVG 2 ``href`` wins over ``xlink:href`` when both are set.
                if (problem := _attribute_problem("href", value)) is None:
                    kept.setdefault("href", value)
                    continue
            elif attr_ns:
                problem = "namespaced attribute"
            else:
                problem = _attribute_problem(attr, value)
                if problem is None:
                    kept[attr] = value
                    continue
            note(f"{attr} on <{local}> ({problem})")
        if not stack:
            kept = {"xmlns": _SVG_NS, **kept}
        rendered = "".join(f" {k}={quoteattr(v)}" for k, v in kept.items())
        out.append(f"<{local}{rendered}>")
        stack.append(local)
        open_tag = True

    def end(_name: str) -> None:
        nonlocal skip_depth, open_tag
        if skip_depth:
            skip_depth -= 1
            return
        local = stack.pop()
        if open_tag:
            out[-1] = out[-1][:-1] + "/>"
        else:
            out.append(f"</{local}>")
        open_tag = False

    def text(chunk: str) -> None:
        nonlocal open_tag
        if stack and not skip_depth:
            out.append(escape(chunk))
            open_tag = False

    def doctype(_name: str, _system: str | None, _public: str | None, internal_subset: int) -> None:
        if internal_subset:
            raise ConfigValidationError("SVG must not declare a DTD internal subset or entities")
        note("DOCTYPE")

    def skipped_entity(name: str, _is_parameter: int) -> None:
        raise ConfigValidationError(f"SVG references an undefined entity '&{name};'")

    def processing_instruction(target: str, _data: str) -> None:
        note(f"<?{target}?> processing instruction")

    parser = expat.ParserCreate(namespace_separator=" ")
    parser.buffer_text = True
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    parser.StartDoctypeDeclHandler = doctype
    parser.SkippedEntityHandler = skipped_entity
    parser.ProcessingInstructionHandler = processing_instruction
    try:
        parser.Parse(data, True)
    except expat.ExpatError as exc:
        raise ConfigValidationError(f"SVG is not well-formed XML: {exc}") from exc
    return "".join(out), removed


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
    page_documents = page_document_files(skip_internal=False)
    for path in page_documents:
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
    for path, _group in component_files():
        try:
            doc = read_json(path)
        except Exception:
            continue
        children = doc.get("children", []) if isinstance(doc, dict) else []
        for node in children if isinstance(children, list) else []:
            if _walk_widget_node(node, asset_path, schemas):
                return True
    return False


def _list_items() -> list[tuple[str, str, dict]]:
    items: list[tuple[str, str, dict]] = []
    for asset_dir, asset_type in (
        (active_icons_dir(), "icon"),
        (active_images_dir(), "image"),
        (active_videos_dir(), "video"),
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
    """Upload an asset. ``group`` is ``icons`` (``.svg``) or ``images``
    (``.png``, ``.jpg``, ``.jpeg``, ``.webp``, ``.gif``, ``.svg``); the file
    extension in ``name`` must be one of these.

    ``encoding`` selects the payload format:
    - ``"svg"``  — ``content`` is UTF-8 SVG markup. ``mime`` defaults to
      ``image/svg+xml``.
    - ``"base64"`` — ``content`` is base64-encoded binary. ``mime`` is
      required and round-tripped in the response.

    A raster image must start with its format's signature. Every SVG, in either
    encoding, is rebuilt from an allowlist: shapes, gradients, clip paths,
    masks, ``use``/``symbol``, ``title``/``desc`` and text; no script,
    ``foreignObject``, ``style`` element, event handler, DOCTYPE, or link or
    CSS reference (``url()``, ``image-set()``, a ``\\`` escape, …) outside
    the file. Each removal is listed in ``warnings`` (code
    ``svg-sanitized``), so check them: the stored icon may differ from the
    upload.
    """
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    _validate_name(name)
    target = _resolve_target(group, name)
    rel_path = f"{group}/{name}"
    ext = target.suffix.lower()
    if ext not in _UPLOAD_EXTENSIONS[group]:
        allowed = ", ".join(sorted(_UPLOAD_EXTENSIONS[group]))
        raise ConfigValidationError(f"'{group}' accepts {allowed} files, not '{name}'")

    data: str | bytes
    if encoding == "svg":
        if len(content.encode("utf-8")) > _MAX_SVG_BYTES:
            raise ConfigValidationError("SVG payload exceeds 5 MB limit")
        data = content
        resolved_mime = mime or "image/svg+xml"
    elif encoding == "base64":
        if not mime:
            raise ConfigValidationError("mime is required when encoding='base64'")
        try:
            data = base64.b64decode(content, validate=True)
        except Exception as exc:
            raise ConfigValidationError(f"Invalid base64 payload: {exc}") from exc
        if len(data) > _MAX_IMAGE_BYTES:
            raise ConfigValidationError("Image payload exceeds 5 MB limit")
        resolved_mime = mime
    else:
        raise ConfigValidationError("encoding must be 'svg' or 'base64'")

    warnings: list[dict[str, Any]] = []
    if ext == ".svg":
        # Off the event loop: the manager serves every project's proxy from it.
        svg, removed = await asyncio.to_thread(_sanitize_svg, data)
        payload = svg.encode("utf-8")
        summary = f"Uploaded SVG '{rel_path}'" + (" (sanitized)" if removed else "")
        warnings = [
            {
                "path": rel_path,
                "message": f"Removed {what}" + (f" ({count}x)" if count > 1 else ""),
                "severity": "warning",
                "code": "svg-sanitized",
            }
            for what, count in removed.items()
        ]
    elif isinstance(data, bytes) and _has_raster_signature(ext, data):
        payload = data
        summary = f"Uploaded image '{rel_path}' ({resolved_mime})"
    else:
        raise ConfigValidationError(f"Content is not a {ext[1:].upper()} image")

    async with locks.acquire(("asset", rel_path)):
        if target.exists() and not overwrite:
            raise ConfigConflictError(
                f"Asset '{rel_path}' already exists; pass overwrite=true to replace"
            )
        write_bytes_atomic(target, payload)
        response = applied_response(
            summary, None, {"path": rel_path, "mime": resolved_mime}, warnings=warnings
        )
        response["path"] = rel_path

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
