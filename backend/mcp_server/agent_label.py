from __future__ import annotations

import re
from contextvars import ContextVar

_AGENT_LABEL_MAX = 64
_AGENT_LABEL_RE = re.compile(r"[^A-Za-z0-9_\- ]")

_header_label: ContextVar[str | None] = ContextVar("_header_label", default=None)


def normalize_label(value: str) -> str:
    if not value:
        return "unknown"
    cleaned = _AGENT_LABEL_RE.sub("_", value).strip()
    if not cleaned:
        return "unknown"
    if len(cleaned) > _AGENT_LABEL_MAX:
        cleaned = cleaned[:_AGENT_LABEL_MAX]
    return cleaned or "unknown"


def format_client_info(name: str | None, version: str | None) -> str:
    if not name:
        return "unknown"
    raw = f"{name}@{version}" if version else name
    return normalize_label(raw)


def resolve_label(session) -> str:
    header_label = _header_label.get()
    if header_label:
        return normalize_label(header_label)
    if session is not None:
        params = getattr(session, "client_params", None)
        client_info = getattr(params, "clientInfo", None) if params is not None else None
        if client_info is not None:
            return format_client_info(
                getattr(client_info, "name", None),
                getattr(client_info, "version", None),
            )
    return "unknown"
