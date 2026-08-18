from __future__ import annotations

from typing import Any

from services import users_manager

from ..pagination import paginated_payload
from ..server import expose_read_tool


def _project_user(user: dict) -> dict:
    return {
        "id": user.get("username", ""),
        "display_name": user.get("username", ""),
        "roles": list(user.get("groups", [])),
        "enabled": user.get("enabled", True),
    }


def _list_items() -> list[tuple[str, str, dict]]:
    items: list[tuple[str, str, dict]] = []
    try:
        doc = users_manager.load()
    except Exception:
        return items
    for user in doc.get("users", []):
        if isinstance(user, dict):
            projected = _project_user(user)
            items.append((projected["id"], projected["id"], projected))
    return items


def _list_payload(cursor: str | None = None, limit: int | None = None) -> dict[str, Any]:
    return paginated_payload(_list_items(), cursor=cursor, limit=limit)


users_list = expose_read_tool(
    _list_payload,
    name="users_list",
    description="List user summaries. Each item: ``{ id, display_name, roles, enabled }``.",
)
