"""Helpers shared across MCP write tool modules."""

from __future__ import annotations

from typing import Any

from core.exceptions import ConfigValidationError
from core.validation import ValidationReport

from .. import json_pointer


def raise_if_findings(report: ValidationReport) -> None:
    if not report.ok:
        raise ConfigValidationError(report.to_message())


def insert_at_position(
    children: list[dict],
    new_child: dict,
    *,
    index: int | None,
    before_id: str | None,
    after_id: str | None,
) -> list[dict]:
    supplied = sum(1 for value in (index, before_id, after_id) if value is not None)
    if supplied != 1:
        raise ConfigValidationError("Exactly one of index/before_id/after_id is required")
    if index is not None:
        clamped = max(0, min(index, len(children)))
        return [*children[:clamped], new_child, *children[clamped:]]
    target_id = before_id if before_id is not None else after_id
    offset = 0 if before_id is not None else 1
    for i, child in enumerate(children):
        if isinstance(child, dict) and child.get("id") == target_id:
            return [*children[: i + offset], new_child, *children[i + offset :]]
    raise ConfigValidationError(f"Widget '{target_id}' not found among siblings")


def find_widget(node: Any, widget_id: str) -> tuple[dict, list[dict]] | None:
    """Return ``(widget, parent_children_list)`` or ``None``.

    Walks ``node["children"]`` and any ``node["sections"]`` map.
    """
    if isinstance(node, dict):
        if isinstance(node.get("sections"), dict):
            for section_children in node["sections"].values():
                if isinstance(section_children, list):
                    result = _find_in_list(section_children, widget_id)
                    if result is not None:
                        return result
        if isinstance(node.get("children"), list):
            return _find_in_list(node["children"], widget_id)
    return None


def _find_in_list(children: list, widget_id: str) -> tuple[dict, list[dict]] | None:
    for child in children:
        if not isinstance(child, dict):
            continue
        if child.get("id") == widget_id:
            return child, children
        nested = find_widget(child, widget_id)
        if nested is not None:
            return nested
    return None


def parent_children_list(page: dict, parent_id: str | None) -> list[dict]:
    """Return the children-list to mutate.

    ``parent_id == None`` → first existing section's children (the page root
    container). If no sections exist yet, a ``content`` section is created.
    Otherwise locate the widget by id and return its children list (creating
    one if missing).
    """
    sections = page.get("sections") if isinstance(page, dict) else None
    if parent_id is None:
        if not isinstance(sections, dict) or not sections:
            page["sections"] = {"content": []}
            sections = page["sections"]
        # Pick the first existing list-valued section; only fall back to
        # creating "content" if every entry is malformed.
        for sid, value in sections.items():
            if isinstance(value, list):
                return value
            if value is None:
                sections[sid] = []
                return sections[sid]
        sections["content"] = []
        return sections["content"]
    result = find_widget(page, parent_id)
    if result is None:
        raise ConfigValidationError(f"Parent widget '{parent_id}' not found")
    widget, _ = result
    if not isinstance(widget.get("children"), list):
        widget["children"] = []
    return widget["children"]


def apply_json_pointer(target: dict, pointer: str, value: Any) -> None:
    """Set value at JSON Pointer (RFC 6901) inside the widget's ``properties`` map.

    ``pointer`` MAY start with ``/``; an empty pointer is a no-op error.
    Intermediate objects/lists are created lazily.
    """
    parts = json_pointer.split(pointer)
    if "properties" not in target or not isinstance(target["properties"], dict):
        target["properties"] = {}
    json_pointer.set_value(target["properties"], parts, value)


def merge_patch(target: dict, patch: dict) -> None:
    """RFC 7396 Merge Patch — null deletes, dict recurses, other types replace.

    Mutates ``target`` in place. Used by ``*_set_*`` and ``*_update_settings``.
    """
    if not isinstance(patch, dict):
        return
    for key, value in patch.items():
        if value is None:
            target.pop(key, None)
        elif isinstance(value, dict):
            current = target.get(key)
            if not isinstance(current, dict):
                current = {}
                target[key] = current
            merge_patch(current, value)
        else:
            target[key] = value
