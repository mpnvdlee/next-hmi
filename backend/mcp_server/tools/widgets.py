from __future__ import annotations

from typing import Any

from core.validation.structure import load_widget_manifest

from ..server import expose_read_tool


def _schemas_payload() -> dict[str, Any]:
    return load_widget_manifest()


widgets_get_schemas = expose_read_tool(
    _schemas_payload,
    name="widgets_get_schemas",
    description=(
        "Full widget-schema manifest — ``{ version, builtin, custom }``. "
        "Always returned whole (unpaginated); the manifest is bounded by the "
        "registry size. ``builtin`` and ``custom`` entries use the same v2 "
        "catalog shape: ``{ name, category, description?, icon?, schema }``. "
        "Custom keys remain ``<source-folder>/<Name>``. Use to discover which "
        "widget ``type`` values are valid "
        "for ``pages_add_widget`` and what properties each accepts."
    ),
)
