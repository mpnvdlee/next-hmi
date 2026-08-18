"""Shared walk primitives for the page-index tree in ``config.json``.

The index is a nested list of nodes; each node has an ``id`` plus a ``type``
of either ``"page"`` (leaf — references a per-page JSON file) or
``"page-group"`` (carries metadata and a recursive ``children`` list).

REST and MCP write paths both need to test/remove/collect entries in this
tree. Centralising the walk here keeps the two paths in sync.
"""

from __future__ import annotations

from typing import Any


def is_page_group(node: Any) -> bool:
    return isinstance(node, dict) and node.get("type") == "page-group"


def collect_page_ids(nodes: list[Any]) -> set[str]:
    """Recursively collect every node id (both page and page-group)."""
    ids: set[str] = set()
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        if isinstance(node_id, str):
            ids.add(node_id)
        if is_page_group(node):
            ids |= collect_page_ids(node.get("children", []))
    return ids


def collect_dialog_ids(dialogs: list[Any]) -> set[str]:
    """Collect non-empty string ids from a flat ``dialogs`` list."""
    return {
        d["id"]
        for d in dialogs
        if isinstance(d, dict) and isinstance(d.get("id"), str) and d["id"]
    }


def collect_dialog_property_keys(dialogs: list[Any]) -> dict[str, frozenset[str]]:
    """Dialog id -> the property names its ``componentProperties`` declares."""
    return {
        d["id"]: frozenset(d.get("componentProperties") or {})
        for d in dialogs
        if isinstance(d, dict) and isinstance(d.get("id"), str) and d["id"]
    }


def contains_page(nodes: list[Any], page_id: str) -> bool:
    """True if a leaf page with ``page_id`` exists anywhere in the tree."""
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if node.get("id") == page_id and not is_page_group(node):
            return True
        if is_page_group(node) and contains_page(node.get("children", []), page_id):
            return True
    return False


def remove_page(nodes: list[Any], page_id: str) -> bool:
    """Remove the first leaf page entry matching ``page_id``. Mutates ``nodes``.

    Returns True if a node was removed.
    """
    for i, node in enumerate(nodes):
        if not isinstance(node, dict):
            continue
        if node.get("id") == page_id and not is_page_group(node):
            nodes.pop(i)
            return True
        if is_page_group(node):
            children = node.get("children")
            if isinstance(children, list) and remove_page(children, page_id):
                return True
    return False
