"""Format 8 → 9: a write target is a sourced value.

``writeDataVariable`` and ``toggleDataVariable`` used to name the variable they
write as a flat ``datasource`` / ``path`` pair. They now carry one ``target``
field holding a property source: ``{"$var": {"path": "<ds>:<path>"}}`` for a
variable, or — inside a Repeater — ``{"$repeatItem": {"member": ...}}`` for the
copy's own element. One field means one place to validate and resolve a target,
whichever action writes it, and the repeat element needs nothing of its own:
the runtime already turns a ``$repeatItem`` into the copy's ``$var``.

The pair becomes the ``$var`` path verbatim, an element suffix (``Speed[2]``)
included — the executor splits it back into the same pair the write message
carries. A pair with either half empty was a target not yet picked; it becomes
no ``target`` at all, which is what an unpicked target is now. The
``repeatItem`` field an in-development build wrote beside the pair becomes the
``$repeatItem`` target.

Walks every stored JSON document whole, the way the dialogs step does, since
actions sit under any actions-typed property, in menu items, lifecycle events,
``globalEvents`` and nested follow-up lists. Re-runnable: an action that already
carries ``target`` and no pair is left alone.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from core.storage import read_json, write_json

STEP_NAME = "write-target-source"

_WRITE_ACTIONS = frozenset({"writeDataVariable", "toggleDataVariable"})
_OLD_KEYS = ("datasource", "path", "repeatItem")


def _is_old_action(value: dict[str, Any]) -> bool:
    return value.get("type") in _WRITE_ACTIONS and any(key in value for key in _OLD_KEYS)


def _target_of(action: dict[str, Any]) -> dict[str, Any] | None:
    repeat = action.get("repeatItem")
    if isinstance(repeat, dict):
        member = repeat.get("member")
        return {"$repeatItem": {"member": member} if isinstance(member, str) and member else {}}
    datasource = action.get("datasource")
    path = action.get("path")
    if isinstance(datasource, str) and datasource and isinstance(path, str) and path:
        return {"$var": {"path": f"{datasource}:{path}"}}
    return None


def _rewrite_action(action: dict[str, Any]) -> dict[str, Any]:
    """The action with its pair replaced by ``target``, in the pair's position."""
    target = action.get("target") if "target" in action else _target_of(action)
    out: dict[str, Any] = {}
    for key, value in action.items():
        if key in _OLD_KEYS or key == "target":
            if target is not None and "target" not in out:
                out["target"] = target
            continue
        out[key] = value
    return out


def _rewrite_actions(value: Any) -> tuple[Any, bool]:
    """Return ``value`` with every write action rewritten, plus whether any was."""
    if isinstance(value, list):
        changed = False
        out = []
        for item in value:
            new_item, item_changed = _rewrite_actions(item)
            out.append(new_item)
            changed |= item_changed
        return (out, True) if changed else (value, False)
    if isinstance(value, dict):
        changed = False
        out_dict: dict[str, Any] = {}
        for key, item in value.items():
            new_item, item_changed = _rewrite_actions(item)
            out_dict[key] = new_item
            changed |= item_changed
        if _is_old_action(out_dict):
            return _rewrite_action(out_dict), True
        return (out_dict, True) if changed else (value, False)
    return value, False


def _rewrite_file(path: Path, label: str, files_changed: list[str]) -> None:
    rewritten, changed = _rewrite_actions(read_json(path))
    if changed:
        write_json(path, rewritten)
        files_changed.append(label)


def migrate_write_targets(paths: Mapping[str, Path], project_root: Path) -> Any:
    """The step body. `paths` maps target name -> staged path (see the coordinator).

    *project_root* is unused — this step reads nothing outside the staged
    targets — but every step takes it, so the coordinator can call any of them
    the same way.
    """
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
