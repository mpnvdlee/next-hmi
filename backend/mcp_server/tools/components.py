from __future__ import annotations

from typing import Any

from core.exceptions import ConfigNotFoundError, ConfigValidationError
from core.storage import component_files, read_json
from core.validation import is_valid_component_id

from ..pagination import paginated_payload
from ..server import expose_read_tool


def _list_items() -> list[tuple[str, str, dict]]:
    items: list[tuple[str, str, dict]] = []
    for path, _group in component_files():
        if path.stem.startswith("__"):
            continue
        try:
            doc = read_json(path)
        except Exception:
            continue
        summary = {
            "id": doc.get("id", path.stem) if isinstance(doc, dict) else path.stem,
            "name": doc.get("name", path.stem) if isinstance(doc, dict) else path.stem,
        }
        items.append((summary["name"], summary["id"], summary))
    return items


def _get_component_payload(component_id: str) -> dict[str, Any]:
    if not is_valid_component_id(component_id):
        raise ConfigValidationError(f"Invalid component id: {component_id!r}")
    for path, _group in component_files():
        if path.stem == component_id:
            return read_json(path)
    raise ConfigNotFoundError(f"Component '{component_id}' not found")


def _list_payload(cursor: str | None = None, limit: int | None = None) -> dict[str, Any]:
    return paginated_payload(_list_items(), cursor=cursor, limit=limit)


components_list = expose_read_tool(
    _list_payload,
    name="components_list",
    description="List component summaries. Each item: ``{ id, name }``.",
)
components_get = expose_read_tool(
    _get_component_payload,
    name="components_get",
    description=(
        "Full component definition — ``componentProperties`` + ``tree``. "
        "Raises not-found when the component does not exist."
    ),
)
