"""Format 5 → 6: collapse the `padding` shorthand into the four sides.

The layout panel used to offer one merged padding row backed by five stored
keys: a `padding` shorthand plus `paddingTop`/`paddingRight`/`paddingBottom`/
`paddingLeft` overrides, mirroring how a CSS `padding` shorthand and its own
longhands coexist. It no longer does — `LayoutConfig` carries only the four
sides now, and the panel gives each of them its own plain row
(see `frontend/src/config/components/ui/LayoutFields`).

A side already present always rendered ahead of the shorthand — a plain style
object sets `padding` and then any of the four longhands in the same object,
and the longhand wins for its side, same as a stylesheet's `padding` followed
by `padding-top` would. So a node's shorthand only ever needs to fill in
whichever of the four sides it doesn't already carry, and the shorthand can
then go — there is no side left it was still deciding.

A literal shorthand is parsed the same way a stylesheet's own `padding` would
be — 1/2/3/4 space-separated values expanding to the four sides by the CSS
box-shorthand rule (`_parse_spacing`) — not copied onto every side verbatim: a longhand
like `padding-top` cannot itself take a multi-value string, so a 2- or 3-value
shorthand copied whole would silently go invalid (the CSSOM refuses the
assignment outright) on every side.

A `$switch` of literal shorthands is just as readable as a literal one — every
branch is in the file — so it is rewritten branch-by-branch into four
`$switch`es of sides (`_switch_sides`), the same way `_mode_switch` in
`migration_size_modes.py` rewrites a `$switch` of lengths into a `$switch` of
modes. A bare `$var`, a `$switch` with a branch this step cannot read as a
literal string, any other property source (`$if` included — it declares the
same `any` result type a shorthand does, so it is authorable here too, just
not branch-splittable by this step), or a literal string this step's own
space-split parse cannot make sense of (a value with a space inside a function
call, `calc(8px + 2px) 4px`) is treated as unreadable: nothing safely says what
each side should get, so it is not parsed, and copying it onto every side
verbatim — as an earlier version of this step did — carries the same risk a
multi-value literal does, except silent, since nothing here can rule out a
multi-value result at the far end of the binding. That case is dropped and
reported, same as the 4 → 5 step reports the flex keys it cannot express under
a mode: a key with no row is a key the panel can no longer show, edit or
revert, so it does not get to linger.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from core.storage import read_json, write_json

_PADDING_SIDES = ("paddingTop", "paddingRight", "paddingBottom", "paddingLeft")
_SIDE_NAMES = ("top", "right", "bottom", "left")


def _parse_spacing(text: str) -> dict[str, str] | None:
    """CSS box-shorthand parsing: 1/2/3/4 space-separated values expand to the
    four sides the same way a stylesheet's own `padding` would. An empty string
    (no parts) means no sides at all, same as the shorthand key being absent.
    None means unparseable, not empty: a naive space-split breaks on a value
    with a space inside a function call (`calc(8px + 2px) 4px`), silently
    misreading each argument as its own side. The panel's `LengthField` cannot
    author one (number + unit only), so this only reaches hand-edited or
    imported JSON — but corrupting a shorthand that rendered correctly is
    exactly the failure this step exists to avoid, so it is reported and
    dropped like any other value this step cannot read, rather than guessed at."""
    if "(" in text:
        return None
    parts = text.split()
    if not parts:
        return {}
    if len(parts) == 1:
        return {"top": parts[0], "right": parts[0], "bottom": parts[0], "left": parts[0]}
    if len(parts) == 2:
        return {"top": parts[0], "bottom": parts[0], "right": parts[1], "left": parts[1]}
    if len(parts) == 3:
        return {"top": parts[0], "right": parts[1], "left": parts[1], "bottom": parts[2]}
    return {"top": parts[0], "right": parts[1], "bottom": parts[2], "left": parts[3]}


def _switch_branches(value: Any) -> list[Any] | None:
    """Every branch value a `$switch` can resolve to, or None if *value* is not
    a `$switch`. A malformed switch returns None too — this step reads
    switches, it does not repair them. Deliberately self-contained rather than
    imported from `migration_size_modes` — a frozen step's behaviour must not
    shift under it because a sibling module's helper later changed."""
    if not isinstance(value, dict) or set(value) != {"$switch"}:
        return None
    body = value["$switch"]
    if not isinstance(body, dict) or "cases" not in body:
        return None
    cases = body.get("cases")
    if not isinstance(cases, list):
        return None
    branches = [case.get("then") for case in cases if isinstance(case, dict)]
    if len(branches) != len(cases):
        return None
    if "default" in body:
        branches.append(body["default"])
    return branches


def _switch_sides(value: Any) -> dict[str, Any] | None:
    """A `$switch` of padding shorthands rewritten as one `$switch` per side, or
    None when any branch is not a literal string this step can parse."""
    branches = _switch_branches(value)
    if branches is None or any(not isinstance(branch, str) for branch in branches):
        return None
    parsed = [_parse_spacing(branch) for branch in branches]
    if any(p is None for p in parsed):
        return None

    body = value["$switch"]
    cases = [case for case in body["cases"] if isinstance(case, dict)]
    out: dict[str, Any] = {}
    for side in _SIDE_NAMES:
        side_cases = [
            {**case, "then": parsed[i].get(side)} for i, case in enumerate(cases)
        ]
        side_switch = {**body, "cases": side_cases}
        if "default" in body:
            side_switch["default"] = parsed[-1].get(side)
        out[side] = {"$switch": side_switch}
    return out


def _expand_padding_layout(layout: dict[str, Any], where: str, notes: list[str]) -> bool:
    """Rewrite one node's `layout` in place. Returns whether anything changed."""
    if "padding" not in layout:
        return False
    shorthand = layout.pop("padding")

    if isinstance(shorthand, str):
        parsed = _parse_spacing(shorthand)
        if parsed is not None:
            for side, key in zip(_SIDE_NAMES, _PADDING_SIDES, strict=True):
                if key not in layout and side in parsed:
                    layout[key] = parsed[side]
            return True
    else:
        switch_sides = _switch_sides(shorthand)
        if switch_sides is not None:
            for side, key in zip(_SIDE_NAMES, _PADDING_SIDES, strict=True):
                if key not in layout:
                    layout[key] = switch_sides[side]
            return True

    notes.append(
        f"{where}: dropped padding — bound to a property source, or written in a "
        "form, this step cannot split into four sides on its own (not a literal "
        "space-separated shorthand, and not a $switch of literal branches); "
        "copying it onto all four sides risks a multi-value result silently "
        "blanking every side, since a longhand can't take one"
    )
    return True


def _migrate_node(node: Any, where: str, notes: list[str]) -> bool:
    if not isinstance(node, dict):
        return False
    label = f"{where}/{node.get('id') or node.get('type') or '?'}"
    changed = False
    layout = node.get("layout")
    if isinstance(layout, dict):
        changed |= _expand_padding_layout(layout, label, notes)
    for child in node.get("children") or []:
        changed |= _migrate_node(child, label, notes)
    return changed


def _migrate_nodes(nodes: Any, where: str, notes: list[str]) -> bool:
    if not isinstance(nodes, list):
        return False
    changed = False
    for node in nodes:
        changed |= _migrate_node(node, where, notes)
    return changed


def _migrate_page_tree(entries: Any, where: str, notes: list[str]) -> bool:
    """A page group's header/footer chrome, recursing through nested groups."""
    if not isinstance(entries, list):
        return False
    changed = False
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        label = f"{where}/{entry.get('id') or '?'}"
        for area in ("header", "footer"):
            changed |= _migrate_nodes(entry.get(area), f"{label}.{area}", notes)
        for key in ("children", "pages"):
            changed |= _migrate_page_tree(entry.get(key), label, notes)
    return changed


def migrate_padding(paths: Mapping[str, Path], project_root: Path) -> Any:
    """The step body. `paths` maps target name -> staged path (see the coordinator).

    *project_root* is unused — this step reads nothing outside the staged
    targets — but every step takes it, so the coordinator can call any of them
    the same way.
    """
    from core.project_migrations import StepResult

    result = StepResult()

    config_path = paths["config"]
    if config_path.is_file():
        config = read_json(config_path)
        changed = False
        for region in ("header", "footer", "leftSidebar", "rightSidebar"):
            changed |= _migrate_nodes(config.get(region), region, result.diagnostics)
        for dialog in config.get("dialogs") or []:
            if isinstance(dialog, dict):
                changed |= _migrate_nodes(
                    dialog.get("widgets"), f"dialog {dialog.get('id') or '?'}", result.diagnostics
                )
        changed |= _migrate_page_tree(config.get("pages"), "pages", result.diagnostics)
        if changed:
            result.files_changed.append("config.json")
            write_json(config_path, config)

    pages_dir = paths["pages"]
    if pages_dir.is_dir():
        for path in sorted(pages_dir.rglob("*.json")):
            page = read_json(path)
            if not isinstance(page, dict):
                continue
            sections = page.get("sections")
            if not isinstance(sections, dict):
                continue
            changed = False
            for section_id, widgets in sections.items():
                changed |= _migrate_nodes(widgets, f"{path.name}:{section_id}", result.diagnostics)
            if changed:
                result.files_changed.append(f"pages/{path.name}")
                write_json(path, page)

    components_dir = paths["components"]
    if components_dir.is_dir():
        for path in sorted(components_dir.rglob("*.json")):
            definition = read_json(path)
            if not isinstance(definition, dict):
                continue
            if _migrate_nodes(definition.get("children"), path.stem, result.diagnostics):
                result.files_changed.append(f"components/{path.name}")
                write_json(path, definition)

    return result
