"""Shared reusable-component direct-variable binding validation."""

from __future__ import annotations

import json
import os
import stat
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DIRECT_BINDING_MESSAGE = (
    "reusable components cannot bind directly to variables; use $componentProp"
)

NESTED_PROP_MESSAGE = (
    "$componentProp is only substituted as a property's whole value; nested here "
    "it renders once and then stops updating. Compute the value on the instance "
    "and pass the result through a plain $componentProp"
)


def _pointer_segment(value: object) -> str:
    return str(value).replace("~", "~0").replace("/", "~1")


def _source_paths(value: Any, path: str, source: str) -> Iterator[str]:
    """Yield a JSON pointer for every occurrence of ``source`` as a key."""
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}/{_pointer_segment(key)}"
            if key == source:
                yield child_path
            yield from _source_paths(child, child_path, source)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _source_paths(child, f"{path}/{index}", source)


def _walk_component_values(
    component: Any,
    walk_tree: Callable[[Any, str], Iterator[str]],
    walk_default: Callable[[Any, str], Iterator[str]],
) -> list[str]:
    """Apply the walks to the two places a component holds authored values.

    Reusable-component widget trees and component-property defaults may contain
    arbitrarily nested literals and property sources, so both are walked
    recursively. Other component-property schema metadata is not a value and is
    intentionally outside these rules. The tree takes its own walk because a
    rule may care where in a node the value sits; a default is a bare value.
    """
    if not isinstance(component, dict):
        return []

    found = list(walk_tree(component.get("children"), "/children"))
    component_properties = component.get("componentProperties")
    if isinstance(component_properties, dict):
        for name, schema in component_properties.items():
            if isinstance(schema, dict) and "defaultValue" in schema:
                path = f"/componentProperties/{_pointer_segment(name)}/defaultValue"
                found.extend(walk_default(schema["defaultValue"], path))
    return found


def _var_source_paths(value: Any, path: str) -> Iterator[str]:
    return _source_paths(value, path, "$var")


def _component_prop_paths(value: Any, path: str) -> Iterator[str]:
    return _source_paths(value, path, "$componentProp")


def component_var_source_paths(component: Any) -> list[str]:
    """Return exact JSON pointers for prohibited ``$var`` sources."""
    return _walk_component_values(component, _var_source_paths, _var_source_paths)


def _is_bare_component_prop(value: Any) -> bool:
    """The one shape the runtime substitutes: a property whose entire value is
    ``{"$componentProp": "<key>"}``. ``useResolvedProperties`` rewrites exactly
    this before the widget renders, which is also what makes the forwarded
    ``$var`` visible to ``extractVarKeys`` and therefore live."""
    return isinstance(value, dict) and set(value) == {"$componentProp"}


def _nested_prop_paths_in_node(node: Any, path: str) -> Iterator[str]:
    if isinstance(node, list):
        for index, child in enumerate(node):
            yield from _nested_prop_paths_in_node(child, f"{path}/{index}")
        return
    if not isinstance(node, dict):
        return

    for key, value in node.items():
        key_path = f"{path}/{_pointer_segment(key)}"
        if key == "children":
            yield from _nested_prop_paths_in_node(value, key_path)
        elif key == "properties" and isinstance(value, dict):
            for prop_key, prop_value in value.items():
                prop_path = f"{key_path}/{_pointer_segment(prop_key)}"
                if _is_bare_component_prop(prop_value):
                    continue
                yield from _component_prop_paths(prop_value, prop_path)
        else:
            # Everything else — `layout` above all — never goes through the
            # substitution pass, so a $componentProp there resolves to nothing.
            yield from _component_prop_paths(value, key_path)


def component_nested_prop_paths(component: Any) -> list[str]:
    """Return JSON pointers for ``$componentProp`` uses the runtime cannot keep live."""
    # The tree takes the node-aware walk: only a `properties` entry's whole
    # value is substituted, so where in a node the source sits decides the rule.
    return _walk_component_values(
        component, _nested_prop_paths_in_node, _component_prop_paths
    )


@dataclass(frozen=True)
class ComponentBindingViolation:
    file: str
    source_path: str


@dataclass(frozen=True)
class ComponentScanError(Exception):
    file: str
    source_path: str
    reason: str

    def __str__(self) -> str:
        return f"{self.file}#{self.source_path}: {self.reason}"


FileIdentity = tuple[int, int, int, int, int]
DirectoryIdentity = tuple[int, int, int]


@dataclass(frozen=True)
class ScannedComponentFile:
    relative_path: str
    identity: FileIdentity
    data: dict[str, Any]


@dataclass(frozen=True)
class ProjectComponentScan:
    root_identity: DirectoryIdentity | None
    directory_identities: tuple[tuple[str, DirectoryIdentity], ...]
    files: tuple[ScannedComponentFile, ...]
    violations: tuple[ComponentBindingViolation, ...]


def _identity(value: os.stat_result) -> FileIdentity:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_size,
        value.st_mtime_ns,
    )


def _directory_identity(value: os.stat_result) -> DirectoryIdentity:
    return (value.st_dev, value.st_ino, value.st_mode)


def _is_link_or_reparse(value: os.stat_result) -> bool:
    attributes = getattr(value, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return stat.S_ISLNK(value.st_mode) or bool(attributes & reparse_flag)


def _scan_error(
    file: str, reason: str, exc: Exception | None = None
) -> ComponentScanError:
    del exc
    return ComponentScanError(file, "/", reason)


def _read_component_no_follow(
    path: Path, relative_path: str
) -> tuple[dict[str, Any], FileIdentity]:
    try:
        before = path.lstat()
    except OSError as exc:
        raise _scan_error(relative_path, "component file is unreadable", exc) from exc
    if _is_link_or_reparse(before):
        raise _scan_error(relative_path, "component file is a symlink or reparse point")
    if not stat.S_ISREG(before.st_mode):
        raise _scan_error(relative_path, "component path is not a regular file")

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise _scan_error(relative_path, "component file is unreadable", exc) from exc
    try:
        opened = os.fstat(descriptor)
        try:
            after = path.lstat()
        except OSError as exc:
            raise _scan_error(relative_path, "component file changed during scan", exc) from exc
        if (
            _is_link_or_reparse(after)
            or _identity(before) != _identity(opened)
            or _identity(opened) != _identity(after)
        ):
            raise _scan_error(relative_path, "component file changed during scan")
        with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
            descriptor = -1
            component = json.load(handle)
    except UnicodeError as exc:
        raise _scan_error(relative_path, "component file is not valid UTF-8", exc) from exc
    except json.JSONDecodeError as exc:
        raise _scan_error(relative_path, "component file contains malformed JSON", exc) from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if not isinstance(component, dict):
        raise _scan_error(relative_path, "component definition must be an object")
    return component, _identity(opened)


def scan_project_components(project_root: Path) -> ProjectComponentScan:
    """Scan persisted reusable components without modifying project data.

    An absent components directory is valid. Once the directory or a component
    file exists, failures are reported rather than treated as a clean scan.
    """
    components_root = project_root / "components"
    try:
        root_stat = components_root.lstat()
    except FileNotFoundError:
        return ProjectComponentScan(None, (), (), ())
    except OSError as exc:
        raise _scan_error("components", "component storage is unreadable", exc) from exc
    if _is_link_or_reparse(root_stat):
        raise _scan_error(
            "components", "component storage is a symlink or reparse point"
        )
    if not stat.S_ISDIR(root_stat.st_mode):
        raise _scan_error("components", "component storage is not a directory")

    violations: list[ComponentBindingViolation] = []
    files: list[ScannedComponentFile] = []
    directories: dict[str, DirectoryIdentity] = {
        "components": _directory_identity(root_stat)
    }

    def raise_walk_error(exc: OSError) -> None:
        raise _scan_error("components", "component storage is unreadable", exc)

    try:
        walker = os.walk(
            components_root,
            topdown=True,
            onerror=raise_walk_error,
            followlinks=False,
        )
        for current_root, dir_names, file_names in walker:
            current = Path(current_root)
            current_relative = current.relative_to(project_root).as_posix()
            current_stat = current.lstat()
            if _is_link_or_reparse(current_stat) or not stat.S_ISDIR(
                current_stat.st_mode
            ):
                raise _scan_error(
                    current_relative,
                    "component directory is a symlink or reparse point",
                )
            directories[current_relative] = _directory_identity(current_stat)
            dir_names.sort()
            for name in dir_names:
                directory = current / name
                relative = directory.relative_to(project_root).as_posix()
                directory_stat = directory.lstat()
                if _is_link_or_reparse(directory_stat):
                    raise _scan_error(
                        relative,
                        "component directory is a symlink or reparse point",
                    )
                if not stat.S_ISDIR(directory_stat.st_mode):
                    raise _scan_error(relative, "component path is not a directory")
                directories[relative] = _directory_identity(directory_stat)
            for name in sorted(file_names):
                if not name.endswith(".json"):
                    continue
                path = current / name
                relative_path = path.relative_to(project_root).as_posix()
                component, identity = _read_component_no_follow(path, relative_path)
                files.append(ScannedComponentFile(relative_path, identity, component))
                violations.extend(
                    ComponentBindingViolation(relative_path, source_path)
                    for source_path in component_var_source_paths(component)
                )
    except OSError as exc:
        raise _scan_error("components", "component storage is unreadable", exc) from exc

    return ProjectComponentScan(
        root_identity=_directory_identity(root_stat),
        directory_identities=tuple(sorted(directories.items())),
        files=tuple(files),
        violations=tuple(violations),
    )


def scan_project_component_bindings(
    project_root: Path,
) -> list[ComponentBindingViolation]:
    """Compatibility wrapper returning only recursive binding violations."""
    return list(scan_project_components(project_root).violations)
