from __future__ import annotations

from typing import Any

from core.exceptions import ConfigNotFoundError, ConfigValidationError
from core.storage import active_datasources_dir, read_json
from core.validation import is_valid_datasource_name

from ..pagination import paginated_payload
from ..server import expose_read_tool


def _list_items() -> list[tuple[str, str, dict]]:
    items: list[tuple[str, str, dict]] = []
    if not active_datasources_dir().exists():
        return items
    for path in active_datasources_dir().glob("*.json"):
        try:
            doc = read_json(path)
        except Exception:
            continue
        name = doc.get("name", path.stem) if isinstance(doc, dict) else path.stem
        summary = {
            "name": name,
            "type": doc.get("type") if isinstance(doc, dict) else None,
            "enabled": doc.get("enabled", True) if isinstance(doc, dict) else True,
        }
        items.append((name, name, summary))
    return items


def _get_datasource_payload(name: str) -> dict[str, Any]:
    if not is_valid_datasource_name(name):
        raise ConfigValidationError(f"Invalid datasource name: {name!r}")
    path = active_datasources_dir() / f"{name}.json"
    if not path.exists():
        raise ConfigNotFoundError(f"Datasource '{name}' not found")
    return read_json(path)


def _list_payload(cursor: str | None = None, limit: int | None = None) -> dict[str, Any]:
    return paginated_payload(_list_items(), cursor=cursor, limit=limit)


datasources_list = expose_read_tool(
    _list_payload,
    name="datasources_list",
    description="List datasource summaries. Returns ``{ items, next_cursor? }``.",
)
datasources_get = expose_read_tool(
    _get_datasource_payload,
    name="datasources_get",
    description=(
        "Full datasource config including settings and declared variables. "
        "Raises not-found when the datasource does not exist."
    ),
)
