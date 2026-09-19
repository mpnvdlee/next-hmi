"""Shared walk primitives for the page-index tree in ``config.json``.

The index is a nested list of nodes; each node has an ``id`` plus a ``type``
of either ``"page"`` (leaf — references a per-page JSON file) or
``"page-group"`` (carries metadata and a recursive ``children`` list).

The index has two roots of that same shape. ``pages`` is the navigable tree
the menus, tab bars and URLs are built from. ``dialogs`` holds pages and page
groups that are only ever shown by the ``openDialog`` action; nothing
navigates to them, and they are the only nodes whose ``componentProperties``
(input parameters) take effect.

REST and MCP write paths both need to test/remove/collect entries in this
tree. Centralising the walk here keeps the two paths in sync.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

INDEX_ROOTS: tuple[str, ...] = ("pages", "dialogs")


def page_document_dir(root: str) -> Path:
    """The directory holding one index root's page documents. Resolved per call,
    never snapshotted — the live project can change underneath."""
    from core.storage import active_dialogs_dir, active_pages_dir

    return active_dialogs_dir() if root == "dialogs" else active_pages_dir()


def page_document_dirs() -> list[tuple[str, Path]]:
    """Every index root paired with its document directory, in root order."""
    return [(root, page_document_dir(root)) for root in INDEX_ROOTS]


def page_document_files(*, skip_internal: bool = True) -> list[Path]:
    """Every page document of the project — both roots keep their own directory.

    ``skip_internal`` drops ``__``-prefixed stems, which are scratch documents
    rather than indexed pages.
    """
    files: list[Path] = []
    for _root, directory in page_document_dirs():
        if not directory.is_dir():
            continue
        files.extend(
            path
            for path in sorted(directory.glob("*.json"))
            if path.is_file() and not (skip_internal and path.stem.startswith("__"))
        )
    return files


def find_page_document(page_id: str) -> tuple[str, Path] | None:
    """The root whose directory actually holds this page's document."""
    for root, directory in page_document_dirs():
        path = directory / f"{page_id}.json"
        if path.exists():
            return root, path
    return None


def root_nodes(config: Any, root: str) -> list[Any]:
    """The top-level nodes stored under one index root, ``[]`` when absent."""
    value = config.get(root) if isinstance(config, dict) else None
    return value if isinstance(value, list) else []


def all_root_nodes(config: Any) -> list[Any]:
    """Both roots' top-level nodes in one list, for read-only walks that do not
    care which root a node lives under."""
    return [node for root in INDEX_ROOTS for node in root_nodes(config, root)]


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


def declared_property_keys(doc: Any) -> frozenset[str]:
    """The property names a document's ``componentProperties`` block declares.

    Shared by page groups (inline in ``config.json``) and pages (one JSON file
    each), which declare the same interface under the same key.
    """
    if not isinstance(doc, dict):
        return frozenset()
    declared = doc.get("componentProperties")
    return frozenset(declared) if isinstance(declared, dict) else frozenset()


def iter_page_groups(nodes: Any, path: str = "") -> Iterator[tuple[dict[str, Any], str]]:
    """Every page-group node under ``nodes``, depth first, with its label path.

    Groups nest, so the walk recurses; plain page nodes are skipped because a
    page carries no metadata in the index. The yielded path is built from node
    ids (``/{group}``, then ``/{group}/children/{nested}``) so a caller holding
    a node-relative report can reparent it onto the config document. Callers
    that only want the nodes ignore it.
    """
    if not isinstance(nodes, list):
        return
    for node in nodes:
        if not is_page_group(node):
            continue
        node_id = node.get("id")
        label = node_id if isinstance(node_id, str) and node_id else "?"
        node_path = f"{path}/{label}"
        yield node, node_path
        children = node.get("children")
        yield from iter_page_groups(
            children if isinstance(children, list) else [], f"{node_path}/children"
        )


def collect_page_group_property_keys(nodes: list[Any]) -> dict[str, frozenset[str]]:
    """Page-group id -> the property names its ``componentProperties`` declares.

    Only groups are collected: a leaf page node in the index carries no
    metadata (it lives in the page file), so its declarations come from
    ``core.validation.structure`` reading that file.
    """
    keys: dict[str, frozenset[str]] = {}
    for node, _path in iter_page_groups(nodes):
        node_id = node.get("id")
        if isinstance(node_id, str) and node_id:
            keys[node_id] = declared_property_keys(node)
    return keys


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
