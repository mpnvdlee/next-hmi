"""
opcua.routing — map struct and array-of-struct leaves to their folder fields.

Pure functions over a DatasourceEntry's folder registry; the engine uses them
to route a datachange to the O(1) struct-field patch instead of a folder rebuild.
"""

from collections.abc import Iterator
from typing import Any


def _composite_leaf_steps(
    folder_entry: dict,
    folder_registry: dict,
    steps: tuple[str | int, ...] = (),
    *,
    cross_arrays: bool = True,
) -> Iterator[tuple[tuple[str | int, ...], str]]:
    """Yield ``(steps, child_path)`` for every leaf of a folder's composite value.

    ``steps`` is where the leaf's value sits in the composite — a ``str`` a dict
    field, an ``int`` an element's position — so an array stays a list however
    its element folders are named (``[0]``, TwinCAT's ``aArr[1]``). An array's
    value is its elements, as in ``DatasourceManager``'s snapshot. Every array
    the composite holds is crossed: binding a struct subscribes and reads the
    leaves of its nested arrays too. Without *cross_arrays*, an array below
    *folder_entry* is left out, its leaves being that array's own routes.
    """
    if folder_entry.get("_is_array"):
        if steps and not cross_arrays:
            return
        for idx, elem_path in enumerate(folder_entry.get("_element_paths", [])):
            elem_entry = folder_registry.get(elem_path)
            if elem_entry is not None:
                yield from _composite_leaf_steps(
                    elem_entry, folder_registry, (*steps, idx), cross_arrays=cross_arrays,
                )
        return
    for child_path, field_name in folder_entry.get("_child_paths", {}).items():
        yield (*steps, field_name), child_path
    for nested_name, nested_fp in folder_entry.get("_nested_fields", {}).items():
        nested_entry = folder_registry.get(nested_fp)
        if nested_entry is not None:
            yield from _composite_leaf_steps(
                nested_entry, folder_registry, (*steps, nested_name), cross_arrays=cross_arrays,
            )


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


def _struct_field_routes(ds_entry: Any) -> dict[str, tuple[str, tuple[str | int, ...]]]:
    """Map each struct/array-of-struct leaf variable path to the
    ``(folder_path, steps)`` pair ``DatasourceManager.update_struct_field()``
    expects, so datachange notifications for that leaf can take the O(1)
    single-field patch path instead of a full folder rebuild. ``steps`` is
    where the leaf sits in that folder's value, as ``_composite_leaf_steps``
    yields it.

    A leaf routes to the innermost array holding it, or to its root folder
    when no array does: the route is the composite the leaf patches into
    existence, and an array's touched element is cached and emitted under its
    own key, for ``{path, index}`` bindings, whoever reads the array. Every
    array routes its own elements' leaves, one nested in a struct or in
    another array included: on a real PLC, an 8,000-leaf EtherCAT slave array
    left to the per-change rebuild cost 8 ms per datachange, stalling the
    event loop for tens of seconds per page switch.
    """
    folder_registry = ds_entry.folder_registry
    roots = _root_folder_paths(folder_registry)
    return {
        child_path: (folder_path, steps)
        for folder_path, fentry in folder_registry.items()
        if fentry.get("_is_array") or folder_path in roots
        for steps, child_path in _composite_leaf_steps(fentry, folder_registry, cross_arrays=False)
    }
