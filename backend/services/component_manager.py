"""Component manager — CRUD for component definitions stored as per-component JSON files.

Each component is stored under the active project's ``components/`` directory.

Validation rules enforced here (hard boundary):
- Component children may NOT contain $var bindings (they must use $componentProp).
- Component-property `defaultValue`s may NOT contain $var bindings either — defaults
  must stay decoupled from any specific PLC variable.
- Persisted violations are reported and rejected rather than silently stripped.
- On save (create/update), recursive $var bindings cause a ValidationError.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from core.component_storage import BoundComponentStorage
from core.component_validation import (
    DIRECT_BINDING_MESSAGE,
    ComponentScanError,
    ProjectComponentScan,
    ScannedComponentFile,
    component_var_source_paths,
    scan_project_components,
)
from core.exceptions import (
    ComponentConflictError,
    ComponentNotFoundError,
    ComponentValidationError,
    ConflictError,
)
from core.ids import slug_id
from core.storage import active_components_dir
from core.validation import is_valid_component_folder
from models.component import ComponentDefinition

logger = logging.getLogger(__name__)

_OPTIONAL_COMPONENT_METADATA = ("description", "category", "icon", "width", "height")


def _persisted_component_data(definition: ComponentDefinition) -> dict[str, Any]:
    """Return the path-independent, compact component JSON representation."""
    data = definition.model_dump(exclude={"id", "group"})
    for field in _OPTIONAL_COMPONENT_METADATA:
        if data.get(field) is None:
            data.pop(field, None)
    return data


# ── Generic tree-walker ────────────────────────────────────────────────────────

VisitorFn = Callable[[dict, int, str], None]


def _walk_component_tree(
    children: list[Any],
    visitor: VisitorFn,
    path: str = "children",
) -> None:
    """Recursively visit every widget dict in a component's children tree.

    *visitor(child, index, path)* is called for each dict node before its own
    children are traversed. Raise to abort; mutate *child* in-place to patch
    the tree.
    """
    for i, child in enumerate(children):
        if not isinstance(child, dict):
            continue
        visitor(child, i, path)
        sub = child.get("children") or []
        if sub:
            _walk_component_tree(sub, visitor, f"{path}[{i}].children")


# ── Concrete walkers ───────────────────────────────────────────────────────────


def _check_no_var_bindings(definition: ComponentDefinition) -> None:
    """Reject the first recursive direct binding with its exact source path."""
    paths = component_var_source_paths(definition.model_dump())
    if paths:
        raise ComponentValidationError(
            f"{DIRECT_BINDING_MESSAGE} (found $var source at {paths[0]})"
        )


def _check_no_component_children(children: list[Any], path: str = "children") -> None:
    """Raise ValidationError if any nested $component: types exist anywhere in the tree."""

    def _visit(child: dict, i: int, current_path: str) -> None:
        comp_type = child.get("type") or ""
        if isinstance(comp_type, str) and comp_type.startswith("$component:"):
            raise ComponentValidationError(
                f"Reusable components cannot be nested inside other reusable components "
                f"(found component type '{comp_type}' at {current_path}[{i}].type)."
            )

    _walk_component_tree(children, _visit, path)


class ComponentManager:
    """Singleton manager for reusable component definitions.

    Components live at ``components/<id>.json`` (ungrouped) or
    ``components/<group>/<id>.json`` (grouped), where ``<group>`` may itself be
    a ``/``-joined path of arbitrarily many nested folders (e.g. ``"A/B/C"``).
    The subfolder is the authoritative source for a component's ``group``.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def load(self) -> None:
        """Ensure the component directory exists and migrate persisted metadata."""
        components_dir = active_components_dir()
        try:
            components_dir.lstat()
        except FileNotFoundError:
            components_dir.mkdir(parents=True)
        try:
            scan = scan_project_components(components_dir.parent)
        except ComponentScanError as exc:
            logger.error("Invalid reusable component at %s", exc)
            logger.info(
                "Component manager loaded (dir: %s, migrated files: 0, scan errors: 1)",
                components_dir,
            )
            return
        violations = scan.violations
        for violation in violations:
            logger.error(
                "Invalid reusable-component direct binding at %s#%s",
                violation.file,
                violation.source_path,
            )
        invalid_files = {violation.file for violation in violations}
        migrated = self._migrate_persisted_metadata(
            scan, exclude_files=invalid_files
        )
        logger.info(
            "Component manager loaded (dir: %s, migrated files: %d, binding violations: %d)",
            components_dir,
            migrated,
            len(violations),
        )

    def _migrate_persisted_metadata(
        self,
        scan: ProjectComponentScan,
        *,
        exclude_files: set[str] | None = None,
    ) -> int:
        """Remove path-derived identity fields and normalize optional metadata.

        The source path is authoritative for ``id`` and ``group``; API models
        still expose both, but component JSON files do not persist second copies.
        """
        migrated = 0
        project_root = active_components_dir().parent
        with BoundComponentStorage(project_root, scan) as storage:
            for scanned_file in scan.files:
                relative_path = scanned_file.relative_path
                if exclude_files and relative_path in exclude_files:
                    continue
                try:
                    data = dict(scanned_file.data)
                    changed = "id" in data or "group" in data
                    data.pop("id", None)
                    data.pop("group", None)
                    for field in _OPTIONAL_COMPONENT_METADATA:
                        if field in data and data[field] is None:
                            data.pop(field)
                            changed = True
                    if not changed:
                        continue
                    storage.atomic_write_json(
                        relative_path,
                        data,
                        operation="migrate",
                        expected_identity=scanned_file.identity,
                        create_parents=False,
                    )
                    migrated += 1
                except Exception as exc:
                    logger.error(
                        "Failed to migrate component metadata in %s: %s",
                        relative_path,
                        exc,
                    )
        return migrated

    # ── Path helpers ────────────────────────────────────────────────────────────

    @staticmethod
    def _scan_or_raise() -> ProjectComponentScan:
        try:
            return scan_project_components(active_components_dir().parent)
        except ComponentScanError as exc:
            raise ComponentValidationError(f"Invalid reusable component at {exc}") from exc

    @staticmethod
    def _entry(
        scanned_file: ScannedComponentFile,
    ) -> tuple[Path, str | None, dict[str, Any]]:
        relative = Path(scanned_file.relative_path).relative_to("components")
        group_path = relative.parent
        group = None if group_path == Path(".") else group_path.as_posix()
        return active_components_dir() / relative, group, dict(scanned_file.data)

    def _find(
        self, scan: ProjectComponentScan, component_id: str
    ) -> tuple[Path, str | None, dict[str, Any], ScannedComponentFile] | None:
        for scanned_file in scan.files:
            if Path(scanned_file.relative_path).stem == component_id:
                path, group, data = self._entry(scanned_file)
                return path, group, data, scanned_file
        return None

    def _load_from_data(
        self, data: dict, component_id: str, group: str | None
    ) -> ComponentDefinition:
        """Validate recursive direct bindings and parse persisted component data."""
        definition = ComponentDefinition.model_validate(data)
        _check_no_var_bindings(definition)
        return definition.model_copy(update={"id": component_id, "group": group})

    @staticmethod
    def _existing_ids(scan: ProjectComponentScan) -> set[str]:
        return {Path(item.relative_path).stem for item in scan.files}

    def _check_name_unique(
        self,
        scan: ProjectComponentScan,
        name: str,
        exclude_id: str | None = None,
    ) -> None:
        """Raise ConflictError if *name* is already used by another component."""
        for scanned_file in scan.files:
            if exclude_id and Path(scanned_file.relative_path).stem == exclude_id:
                continue
            try:
                existing = scanned_file.data
                if existing.get("name") == name:
                    raise ComponentConflictError(
                        f"Component name '{name}' is already used by another component"
                    )
            except ConflictError:
                raise
            except Exception:
                pass

    @staticmethod
    def _validate_group(group: str | None) -> None:
        if group is not None and not is_valid_component_folder(group):
            raise ComponentValidationError(f"Invalid component folder name: {group!r}")

    # ── Folders ─────────────────────────────────────────────────────────────────

    def list_folders(self) -> list[str]:
        """Return every folder path (any depth), ``/``-joined, including empty ones."""
        scan = self._scan_or_raise()
        return sorted(
            Path(relative).relative_to("components").as_posix()
            for relative, _identity in scan.directory_identities
            if relative != "components"
        )

    def create_folder(self, name: str) -> str:
        with self._lock:
            scan = self._scan_or_raise()
            name = "/".join(seg.strip() for seg in name.strip().split("/"))
            self._validate_group(name)
            try:
                with BoundComponentStorage(active_components_dir().parent, scan) as storage:
                    storage.create_directory(
                        f"components/{name}", operation="create_folder"
                    )
            except FileExistsError:
                raise ComponentConflictError(f"Folder '{name}' already exists") from None
            logger.info("Created component folder '%s'", name)
            return name

    def delete_folder(self, path: str) -> None:
        """Delete a folder and everything inside it — subfolders and components alike."""
        with self._lock:
            scan = self._scan_or_raise()
            self._validate_group(path)
            if f"components/{path}" not in dict(scan.directory_identities):
                raise ComponentNotFoundError(f"Folder '{path}' not found")
            with BoundComponentStorage(active_components_dir().parent, scan) as storage:
                storage.delete_directory(
                    f"components/{path}", operation="delete_folder"
                )
            logger.info("Deleted component folder '%s' (and its contents)", path)

    # ── CRUD ────────────────────────────────────────────────────────────────────

    def list_all(self) -> list[ComponentDefinition]:
        with self._lock:
            scan = self._scan_or_raise()
            results: list[ComponentDefinition] = []
            for scanned_file in scan.files:
                path, group, data = self._entry(scanned_file)
                try:
                    results.append(self._load_from_data(data, path.stem, group))
                except Exception as exc:
                    logger.error("Failed to load component %s: %s", path.stem, exc)
            return results

    def get(self, component_id: str) -> ComponentDefinition:
        with self._lock:
            scan = self._scan_or_raise()
            found = self._find(scan, component_id)
            if not found:
                raise ComponentNotFoundError(f"Component '{component_id}' not found")
            _path, group, data, _scanned_file = found
            return self._load_from_data(data, component_id, group)

    def create(self, definition: ComponentDefinition) -> ComponentDefinition:
        with self._lock:
            scan = self._scan_or_raise()
            self._validate_group(definition.group)
            self._check_name_unique(scan, definition.name)
            _check_no_var_bindings(definition)
            _check_no_component_children(definition.children)
            new_id = slug_id(definition.name, self._existing_ids(scan))
            definition = definition.model_copy(update={"id": new_id})
            relative_path = (
                f"components/{definition.group}/{new_id}.json"
                if definition.group
                else f"components/{new_id}.json"
            )
            with BoundComponentStorage(active_components_dir().parent, scan) as storage:
                storage.atomic_write_json(
                    relative_path,
                    _persisted_component_data(definition),
                    operation="create",
                    expected_identity=None,
                    create_parents=True,
                )
            logger.info(
                "Created component '%s' (%s) in folder %r",
                definition.name,
                definition.id,
                definition.group,
            )
            return definition

    def update(
        self, component_id: str, definition: ComponentDefinition
    ) -> ComponentDefinition:
        with self._lock:
            scan = self._scan_or_raise()
            found = self._find(scan, component_id)
            if not found:
                raise ComponentNotFoundError(f"Component '{component_id}' not found")
            old_path, _, _data, scanned_file = found
            self._validate_group(definition.group)
            self._check_name_unique(scan, definition.name, exclude_id=component_id)
            _check_no_var_bindings(definition)
            _check_no_component_children(definition.children)
            updated = ComponentDefinition(
                id=component_id, **definition.model_dump(exclude={"id"})
            )
            relative_path = (
                f"components/{updated.group}/{component_id}.json"
                if updated.group
                else f"components/{component_id}.json"
            )
            new_path = active_components_dir().parent / relative_path
            same_path = old_path == new_path
            with BoundComponentStorage(active_components_dir().parent, scan) as storage:
                storage.atomic_write_json(
                    relative_path,
                    _persisted_component_data(updated),
                    operation="update",
                    expected_identity=scanned_file.identity if same_path else None,
                    create_parents=True,
                )
                if not same_path:
                    storage.unlink_file(
                        scanned_file.relative_path,
                        operation="update_move_cleanup",
                        expected_identity=scanned_file.identity,
                    )
            logger.info(
                "Updated component '%s' (%s) in folder %r",
                updated.name,
                component_id,
                updated.group,
            )
            return updated

    def delete(self, component_id: str) -> None:
        with self._lock:
            scan = self._scan_or_raise()
            found = self._find(scan, component_id)
            if not found:
                raise ComponentNotFoundError(f"Component '{component_id}' not found")
            _path, _, _data, scanned_file = found
            with BoundComponentStorage(active_components_dir().parent, scan) as storage:
                storage.unlink_file(
                    scanned_file.relative_path,
                    operation="delete",
                    expected_identity=scanned_file.identity,
                )
            logger.info("Deleted component '%s'", component_id)


component_manager = ComponentManager()
