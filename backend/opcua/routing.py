"""
opcua.routing — map struct and array-of-struct leaves to their folder fields.

Pure functions over a DatasourceEntry's folder registry; the engine uses them
to route a datachange to the O(1) struct-field patch instead of a folder rebuild.
"""

from typing import Any


def _collect_struct_leaf_paths(
    folder_entry: dict,
    folder_registry: dict,
    field_prefix: str = "",
) -> list[tuple[str, str]]:
    """Recursively collect (field_path, child_path) for all leaf variables in a struct folder.

    Follows ``_nested_fields`` (sub-struct sub-folders) so that folder-only structs
    (those with no direct variable children) are expanded correctly.
    ``field_path`` is a ``'/'``-joined path of nested field names
    (e.g. ``"stSignalRaw/bVisible"``), used when assembling nested result dicts.
    """
    result: list[tuple[str, str]] = []
    for child_path, field_name in folder_entry.get("_child_paths", {}).items():
        full = f"{field_prefix}/{field_name}" if field_prefix else field_name
        result.append((full, child_path))
    for nested_name, nested_fp in folder_entry.get("_nested_fields", {}).items():
        nested_entry = folder_registry.get(nested_fp)
        if nested_entry is not None:
            prefix = f"{field_prefix}/{nested_name}" if field_prefix else nested_name
            result.extend(_collect_struct_leaf_paths(nested_entry, folder_registry, prefix))
    return result


def _root_folder_paths(folder_registry: dict) -> set[str]:
    """Folders in *folder_registry* that are not nested inside another folder.

    Mirrors the boundary logic in DatasourceEntry._wire_ancestor_map: a folder
    reachable via another registered folder's ``_nested_fields`` or
    ``_element_paths`` is not itself a broadcast root — its leaves roll up
    into that ancestor's folder-level composite key.
    """
    nested_or_elem: set[str] = set()
    for fentry in folder_registry.values():
        nested_or_elem.update(fentry.get("_nested_fields", {}).values())
        nested_or_elem.update(fentry.get("_element_paths", []))
    return set(folder_registry.keys()) - nested_or_elem


def _struct_field_routes(ds_entry: Any) -> dict[str, tuple[str, str]]:
    """Map each struct/array-of-struct leaf variable path to the
    ``(root_folder_path, field_name)`` pair ``DatasourceManager.update_struct_field()``
    expects, so datachange notifications for that leaf can take the O(1)
    single-field patch path instead of a full folder rebuild.

    ``field_name`` is a plain key for a direct struct field, a ``"/"``-joined
    nested path (mirrors ``_collect_struct_leaf_paths``) for a nested
    sub-struct field, or an ``"idx:name"`` reference (mirrors the
    ``array_elem`` encoding in ``read_current_values``) for a direct field of
    an array-of-struct element. Fields nested *inside* an array-of-struct
    element are intentionally left unmapped — those leaves fall back to the
    existing full-rebuild path via ``_node_to_path``, same as before this
    routing existed.
    """
    folder_registry = ds_entry.folder_registry
    routes: dict[str, tuple[str, str]] = {}
    for folder_path in _root_folder_paths(folder_registry):
        fentry = folder_registry[folder_path]
        if fentry.get("_is_array"):
            for idx, elem_path in enumerate(fentry.get("_element_paths", [])):
                elem_entry = folder_registry.get(elem_path)
                if elem_entry is None:
                    continue
                for child_path, field_name in elem_entry.get("_child_paths", {}).items():
                    routes[child_path] = (folder_path, f"{idx}:{field_name}")
        else:
            for field_path, child_path in _collect_struct_leaf_paths(fentry, folder_registry):
                routes[child_path] = (folder_path, field_path)
    return routes
