from __future__ import annotations

import re
from typing import Any

from core.exceptions import ConfigNotFoundError, ConfigValidationError
from core.storage import active_datasources_dir, read_json
from core.validation import is_valid_datasource_name

from ..pagination import paginated_payload
from ..server import expose_read_tool

# Stands in for a set secret so an agent can tell a password is configured
# without a read-scoped token carrying the PLC credentials away. An unset one
# stays "". No MCP tool writes a datasource's ``settings`` (the variables tools
# rewrite a datasource file from disk, never from this read), so the marker
# never reaches disk.
REDACTED = "<redacted>"

# The password of a URL carrying credentials, ``scheme://user:password@host``,
# which asyncua logs in with. It runs to the authority's last "@", as URL
# parsers read it; the user and host stay readable.
_URL_PASSWORD = re.compile(r"(://[^/?#:]*:)[^/?#]*@")


def _is_secret_setting(key: str) -> bool:
    key = key.lower()
    return key == "password" or key.endswith(("_password", "private_key"))


def _redact_setting(key: str, value: Any) -> Any:
    if value and _is_secret_setting(key):
        return REDACTED
    if isinstance(value, str):
        return _URL_PASSWORD.sub(rf"\g<1>{REDACTED}@", value)
    return value


def _redact_settings(doc: Any) -> Any:
    settings = doc.get("settings") if isinstance(doc, dict) else None
    if not isinstance(settings, dict):
        return doc
    redacted = {key: _redact_setting(key, value) for key, value in settings.items()}
    return {**doc, "settings": redacted}


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
    return _redact_settings(read_json(path))


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
        "Credentials in ``settings`` (``password``, ``*_password``, "
        "``client_private_key``) read as ``\"<redacted>\"`` when set and ``\"\"`` "
        "when not, and so does the password in a URL setting "
        "(``opc.tcp://user:<redacted>@host:4840``). "
        "Raises not-found when the datasource does not exist."
    ),
)
