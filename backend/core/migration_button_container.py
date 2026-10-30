"""Format 10 → 11, second half: a pressable Container becomes a Button Container.

During 1.1.0 development the Container ran press and release actions itself;
that moved to its own widget, ``ButtonContainer``, so a Container is a layout
box again. A Container with actions in ``actions.onPress`` or
``onRelease.onRelease`` changes type and keeps everything else. One whose lists
are empty only loses those keys, which it no longer has a field for.

A component definition could bind a whole field to one of its properties,
``{"$componentProp": "actions"}``; that becomes the one action
``runComponentActions`` in the list, which the editor shows like any other.

Walks every stored JSON document whole, like the other steps. Re-runnable: a
Container without the keys is left alone.
"""
from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from core.storage import read_json, write_json

_PRESS_FIELDS = (("actions", "onPress"), ("onRelease", "onRelease"))


def _unbind(props: dict[str, Any]) -> dict[str, Any]:
    out = dict(props)
    for key, event in _PRESS_FIELDS:
        bound = props.get(key)
        if isinstance(bound, dict) and isinstance(bound.get("$componentProp"), str):
            out[key] = {event: [{"type": "runComponentActions", "property": bound["$componentProp"]}]}
    return out


def _has_actions(props: dict[str, Any]) -> bool:
    for key, event in _PRESS_FIELDS:
        value = props.get(key)
        if isinstance(value, dict) and isinstance(value.get(event), list) and value[event]:
            return True
    return False


def _rewrite(value: Any) -> tuple[Any, bool]:
    """Return ``value`` with every pressable Container retyped, plus whether any was."""
    if isinstance(value, list):
        items = [_rewrite(item) for item in value]
        if any(changed for _, changed in items):
            return [item for item, _ in items], True
        return value, False
    if isinstance(value, dict):
        items_by_key = {key: _rewrite(item) for key, item in value.items()}
        changed = any(c for _, c in items_by_key.values())
        out = {key: item for key, (item, _) in items_by_key.items()} if changed else value
        props = out.get("properties")
        if out.get("type") == "Container" and isinstance(props, dict):
            props = _unbind(props)
            if _has_actions(props):
                return {**out, "type": "ButtonContainer", "properties": props}, True
            if any(key in props for key, _ in _PRESS_FIELDS):
                kept = {k: v for k, v in props.items() if k not in dict(_PRESS_FIELDS)}
                return {**out, "properties": kept}, True
        return out, changed
    return value, False


def _rewrite_file(path: Path, label: str, files_changed: list[str]) -> None:
    rewritten, changed = _rewrite(read_json(path))
    if changed:
        write_json(path, rewritten)
        files_changed.append(label)


def migrate_button_container(paths: Mapping[str, Path], project_root: Path) -> Any:
    """The step body. `paths` maps target name -> staged path (see the coordinator)."""
    from core.project_migrations import StepResult

    result = StepResult()
    config_path = paths["config"]
    if config_path.is_file():
        _rewrite_file(config_path, "config.json", result.files_changed)
    for label in ("pages", "dialogs", "components"):
        directory = paths[label]
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*.json")):
            _rewrite_file(
                path, f"{label}/{path.relative_to(directory).as_posix()}", result.files_changed
            )
    return result
