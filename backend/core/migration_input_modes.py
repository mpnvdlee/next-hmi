"""Format 11 → 12: every input is a Value or a Binding.

An input of a component, or of a page or page group, used to pass whatever it
was given straight through: a variable stayed live, and so did a formula, which
kept computing inside the dialog. An input now declares a ``mode``. A
``"value"`` is read once, when the dialog opens or the instance appears, and is
then that screen's or instance's own state; a ``"binding"`` takes a variable
and follows it live.

The mode is derived from what reaches the input. An input becomes a Binding
when every opener or instance that passes it passes a variable — a ``$var``,
a ``$repeatItem``, or a ``$componentProp`` forwarding an input that is itself a
Binding (resolved over the whole chain) — and at least one passes it; an input that declares write access is a Binding too, since only a
Binding writes a variable. Everything else becomes a Value. A dialog's openers
are the ``openDialog`` actions naming the node, a group around it or a page
inside it, since a value passed to any of those reaches the node's scope. A
node of the Pages section is opened by nothing, so its inputs are Values: the
page variables, which start at their default.

A Value that some opener fed a live source — a formula, a condition, a
variable — now reads it once. Each such case gets a migration note naming the
file, so the author can make the input a Binding and compute inside instead.

Types that hold no writable value (actions, a widget slot, icon, image, video)
take no mode, and a struct is always a Binding; neither is written. The step is
re-runnable: a declaration that already has a ``mode`` is left alone.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

from core.page_index import (
    collect_group_ancestors,
    collect_page_group_properties,
    declared_properties,
    root_nodes,
)
from core.storage import read_json, write_json
from core.validation.component_property import input_mode, is_struct_input

STEP_NAME = "input-modes"

_COMPONENT_PREFIX = "$component:"
# A whole value that stands for a variable rather than computing one.
_VARIABLE_SOURCES = frozenset({"$var", "$componentProp", "$repeatItem"})


def _dicts(value: Any) -> Iterator[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from _dicts(item)
    elif isinstance(value, list):
        for item in value:
            yield from _dicts(item)


def _is_variable(value: Any) -> bool:
    return isinstance(value, dict) and len(value) == 1 and next(iter(value)) in _VARIABLE_SOURCES


def _is_live(value: Any) -> bool:
    return any(key in ("$var", "$componentProp") for d in _dicts(value) for key in d)


def _undecided(declared: Any) -> list[tuple[str, dict[str, Any]]]:
    """The declarations of ``declared`` that need a mode and have none."""
    if not isinstance(declared, dict):
        return []
    return [
        (key, decl)
        for key, decl in declared.items()
        if isinstance(decl, dict)
        and "mode" not in decl
        and input_mode(decl) is not None
        and not is_struct_input(str(decl.get("type", "")))
    ]


def _scopes(docs: Mapping[str, tuple[Path, Any]], config: Any) -> dict[str, dict[str, dict[str, Any]]]:
    """File label -> the declarations a ``$componentProp`` in it reads: a
    component's own, a page's or dialog's over its enclosing groups'.
    shortcut: a whole file is one scope, so slot content inside an instance
    reads the file's inputs rather than the component's; walk the instances if
    a project forwards from slot content."""
    scopes = {label: declared_properties(doc) for label, (_, doc) in docs.items() if label.startswith("components/")}
    for root in ("pages", "dialogs"):
        nodes = root_nodes(config, root)
        groups = collect_page_group_properties(nodes)
        ancestors = collect_group_ancestors(nodes)
        for label, (_, doc) in docs.items():
            if label.startswith(f"{root}/"):
                scope: dict[str, dict[str, Any]] = {}
                for gid in reversed(ancestors.get(Path(label).stem, ())):
                    scope.update(groups.get(gid) or {})
                scopes[label] = {**scope, **declared_properties(doc)}
    return scopes


def _relatives(nodes: list[Any]) -> dict[str, set[str]]:
    """Node id -> itself, the groups around it and every node inside it: the
    ids an ``openDialog`` may name to reach its scope."""
    related: dict[str, set[str]] = {}

    def walk(items: Any, ancestors: list[str]) -> list[str]:
        below: list[str] = []
        for node in items if isinstance(items, list) else []:
            node_id = node.get("id") if isinstance(node, dict) else None
            if not isinstance(node_id, str):
                continue
            inside = walk(node.get("children"), [*ancestors, node_id])
            related[node_id] = {node_id, *ancestors, *inside}
            below += [node_id, *inside]
        return below

    walk(nodes, [])
    return related


def migrate_input_modes(paths: Mapping[str, Path], project_root: Path) -> Any:
    """The step body. `paths` maps target name -> staged path (see the coordinator)."""
    from core.project_migrations import StepResult

    result = StepResult()
    docs: dict[str, tuple[Path, Any]] = {}
    config_path = paths["config"]
    if config_path.is_file():
        docs["config.json"] = (config_path, read_json(config_path))
    for label in ("pages", "dialogs", "components"):
        directory = paths[label]
        if directory.is_dir():
            for path in sorted(directory.rglob("*.json")):
                docs[f"{label}/{path.relative_to(directory).as_posix()}"] = (path, read_json(path))

    instances: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    openers: list[tuple[str, str, dict[str, Any]]] = []
    for label, (_, doc) in docs.items():
        for node in _dicts(doc):
            kind = node.get("type")
            if not isinstance(kind, str):
                continue
            if kind.startswith(_COMPONENT_PREFIX):
                props = node.get("properties")
                instances.setdefault(kind[len(_COMPONENT_PREFIX) :], []).append(
                    (label, props if isinstance(props, dict) else {})
                )
            elif kind == "openDialog" and isinstance(node.get("pageId"), str):
                args = node.get("componentProperties")
                openers.append((label, node["pageId"], args if isinstance(args, dict) else {}))

    config = docs.get("config.json", (None, None))[1]
    related = _relatives(root_nodes(config, "dialogs"))

    def opened_by(node_id: str) -> list[tuple[str, dict[str, Any]]]:
        ids = related.get(node_id, {node_id})
        return [(label, args) for label, target, args in openers if target in ids]

    # (file label, owner, its declarations, what reaches them, whether anything opens it)
    targets: list[tuple[str, str, Any, list[tuple[str, dict[str, Any]]], bool]] = []
    for label, (_, doc) in docs.items():
        if not isinstance(doc, dict):
            continue
        if label == "config.json":
            for root in ("pages", "dialogs"):
                for group in _dicts(root_nodes(doc, root)):
                    if group.get("type") != "page-group" or not isinstance(group.get("id"), str):
                        continue
                    in_dialogs = root == "dialogs"
                    targets.append((
                        label,
                        f"{'dialog group' if in_dialogs else 'page group'} '{group['id']}'",
                        group.get("componentProperties"),
                        opened_by(group["id"]) if in_dialogs else [],
                        in_dialogs,
                    ))
        elif label.startswith("components/"):
            component_id = Path(label).stem
            targets.append((
                label,
                f"component '{component_id}'",
                doc.get("componentProperties"),
                instances.get(component_id, []),
                True,
            ))
        else:
            page_id = Path(label).stem
            in_dialogs = label.startswith("dialogs/")
            targets.append((
                label,
                f"{'dialog' if in_dialogs else 'page'} '{page_id}'",
                doc.get("componentProperties"),
                opened_by(page_id) if in_dialogs else [],
                in_dialogs,
            ))

    scopes = _scopes(docs, config)

    def is_variable(label: str, value: Any) -> bool:
        if not _is_variable(value):
            return False
        forwarded = value.get("$componentProp")
        if not isinstance(forwarded, str):
            return True
        decl = scopes.get(label, {}).get(forwarded.partition("/")[0])
        # An input the scope does not declare is judged as before: a variable.
        return decl is None or input_mode(decl) == "binding"

    pending = [(target, key, decl) for target in targets for key, decl in _undecided(target[2])]
    # Start every undecided input as a Binding and demote until nothing moves:
    # a forward is a variable only while the input it forwards is a Binding.
    for _, _, decl in pending:
        decl["mode"] = "binding"
    moved = True
    while moved:
        moved = False
        for (_, _, _, passed, opened), key, decl in pending:
            given = [(label, values[key]) for label, values in passed if key in values]
            binding = opened and (
                decl.get("write") is True
                or (bool(given) and all(is_variable(label, v) for label, v in given))
            )
            mode = "binding" if binding else "value"
            if decl["mode"] != mode:
                decl["mode"] = mode
                moved = True

    changed_labels = list(dict.fromkeys(target[0] for target, _, _ in pending))
    for (_, owner, _, passed, _), key, decl in pending:
        if decl["mode"] == "binding":
            continue
        when = "when the dialog opens" if owner.startswith("dialog") else "when the instance appears"
        given = [(label, values[key]) for label, values in passed if key in values]
        for label in dict.fromkeys(label for label, v in given if _is_live(v)):
            result.diagnostics.append(
                f"{owner}, input '{key}': {label} passes it a live value, which is now "
                f"read once {when}. To keep it live, make the input a Binding, pass it "
                "the variable and compute inside"
            )

    for label in changed_labels:
        path, doc = docs[label]
        write_json(path, doc)
        result.files_changed.append(label)
    return result
