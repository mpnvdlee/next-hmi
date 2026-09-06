"""The 4 → 5 step must not move pixels on a project already on the size modes.

Its unit tests check one rule at a time, and every rule passed while the step
was still collapsing real pages: the failures lived in what the *runtime* makes
of a layout, not in the keys themselves. A key can be dropped correctly and
still change the render, because a size mode substitutes its own value for a
missing one — `Fill` means `basis: 0`, and a `basis: 0` child of a parent with
no definite size collapses to nothing.

So this walks the real testbench project before and after the step and compares
the *effective* flex geometry of every node: what CSS would actually receive
once the size modes resolve. `_effective` below models that resolution as a
frozen reference — the mode vocabulary (`Fill` → `grow`/`basis: 0`, `Hug`/
`Fixed` → `shrink: 0`, …) it encodes hasn't changed, but it is no longer the
Python twin of a live frontend function: the runtime moved from computing
these flex keys in JS (`axisModePatch`/`withResolvedSizeModes`, both since
removed) to emitting axis-neutral `--w-*`/`--h-*` custom properties that
`hmi.css`'s flow-translation block resolves against a flex parent's own
`data-flow-direction` at render — a mechanism this harness does not model and
does not need to, since idempotency (below) only needs *a* consistent
resolution, not the live one.

A dev checkout's testbench is already migrated, so what this really pins is the
step's idempotency over a real project of 300-odd nodes: every rule that fires a
second time has to be a no-op. The first conversion off the raw flex keys is
deliberately *not* geometry-preserving — Hug and Fixed gain `shrink: 0` and Fill
resolves its `basis` to `0`, both stated intents of the model — so pointing this
at an unmigrated project reports those, correctly, as movement.

Margin is the one intended difference that is excluded outright: nothing emits
it any more, so its removal cannot change a render.

Known gap: a `$component:` instance's fold onto the definition's first root is
modelled here (`_folded`), but not faithfully enough to catch a regression in
it — reintroducing one historically did not fail this test. If a fold regression
is what you are chasing, this harness is not the thing that will catch it.
"""

import functools
import json
import shutil
from pathlib import Path
from typing import Any

import pytest
from core.migration_size_modes import (
    _DIALOG_AXIS,
    _PAGE_AXIS,
    _RETIRED_FLEX_KEYS,
    _SHELL_AXES,
    _child_axis,
    _widget_types,
    migrate_size_modes,
)
from core.storage import read_json

REPO_ROOT = Path(__file__).resolve().parents[2]
PROJECT_TESTBENCH = REPO_ROOT / "project-testbench"

# project-testbench/ lives in the private enterprise repo and is cloned in for
# dev; it is absent from a public checkout, so this content test skips there.
pytestmark = pytest.mark.skipif(not PROJECT_TESTBENCH.exists(), reason="project-testbench not present")

SIZE_MODES = {"hug", "fill", "fixed"}


@functools.cache
def _types():
    """The testbench's widget declarations, read once — `_widget_types` parses
    every widget under `custom-widgets/`, and the walk below asks per node."""
    return _widget_types(PROJECT_TESTBENCH)

# The project sizes by viewport, so a layout value is often a `$switch` on
# `$viewport.size`. The runtime resolves those (`useResolvedLayout`) before
# `selfLayoutStyle` ever sees them, so the comparison has to resolve them too —
# per branch, since a switch can mean a different mode at each width.
VIEWPORTS = ("phone", "tablet", "laptop")


def _resolve(value: Any, viewport: str) -> Any:
    """A `$switch` on `$viewport.size` reduced to the branch *viewport* takes.
    Anything else (a `$var`, a literal) is returned unchanged."""
    if not isinstance(value, dict) or set(value) != {"$switch"}:
        return value
    body = value["$switch"]
    if not isinstance(body, dict) or body.get("value") != {"$viewport": {"field": "size"}}:
        return value
    for case in body.get("cases") or []:
        if isinstance(case, dict) and case.get("when") == viewport:
            return case.get("then")
    return body.get("default")


def _resolved_layout(layout: dict, viewport: str) -> dict:
    return {key: _resolve(value, viewport) for key, value in layout.items()}


def _is_main(axis_key: str, flow_axis: str) -> bool:
    """Width is the main axis of a row, height of a column — the same rule the
    now-removed `isMainAxis` stated in the frontend before this file's frozen
    model took over (see the module docstring)."""
    return (axis_key == "width") == (flow_axis == "row")


def _axis_mode_patch(mode: str, axis_key: str, flow: tuple[str, str], layout: dict) -> dict:
    """Frozen model of the now-removed `axisModePatch` (see the module
    docstring)."""
    flow_axis, flow_align = flow
    if _is_main(axis_key, flow_axis):
        if mode == "fixed":
            return {"grow": None, "basis": None, "shrink": 0}
        if mode == "fill":
            grow = layout.get("grow")
            return {
                axis_key: None,
                "grow": grow if isinstance(grow, (int, float)) and not isinstance(grow, bool) else 1,
                "basis": "0",
                "shrink": None,
            }
        return {axis_key: None, "grow": None, "basis": None, "shrink": 0}
    if mode == "fixed":
        return {"alignSelf": None}
    if mode == "fill":
        return {axis_key: None, "alignSelf": None if flow_align == "stretch" else "stretch"}
    return {axis_key: None, "alignSelf": "flex-start" if flow_align == "stretch" else None}


def _effective(layout: dict, flow: tuple[str, str]) -> dict:
    """What CSS ends up with, per this file's frozen model (see the module
    docstring): the old `withResolvedSizeModes`, then the CSS defaults."""
    resolved = dict(layout)
    width_mode = layout.get("widthMode")
    height_mode = layout.get("heightMode")
    if isinstance(width_mode, str) and width_mode in SIZE_MODES:
        resolved.update(_axis_mode_patch(width_mode, "width", flow, layout))
    if isinstance(height_mode, str) and height_mode in SIZE_MODES:
        resolved.update(_axis_mode_patch(height_mode, "height", flow, layout))
    return {
        "grow": resolved.get("grow") if resolved.get("grow") is not None else 0,
        "shrink": resolved.get("shrink") if resolved.get("shrink") is not None else 1,
        "basis": resolved.get("basis") if resolved.get("basis") is not None else "auto",
        "width": resolved.get("width"),
        "height": resolved.get("height"),
        "alignSelf": resolved.get("alignSelf"),
        "minWidth": resolved.get("minWidth"),
        "maxWidth": resolved.get("maxWidth"),
        "minHeight": resolved.get("minHeight"),
        "maxHeight": resolved.get("maxHeight"),
    }


# What an instance folds onto the definition's first root, overriding whatever
# the definition sized itself as. Read from the fixture `SELF_LAYOUT_KEYS` in
# layoutUtils.ts is asserted against (`layoutUtils.test.ts`), not copied: a self
# key added on one side and not the other left this harness folding the wrong
# keys and comparing geometry that no longer matched the runtime's.
#
# The retired raw flex keys are folded on top of it. The runtime dropped them
# with the panel rows that authored them, so the fixture rightly no longer lists
# them — but the *input* side of this comparison is a project as authored, and on
# an unmigrated one those three are exactly what an instance sizes itself with.
# Folding only the fixture would read a pre-migration instance as unsized and
# compare the definition's own geometry against the migrated instance's.
SELF_LAYOUT_KEYS = (
    tuple(
        json.loads(
            (
                REPO_ROOT / "frontend" / "src" / "shared" / "types" / "__fixtures__"
                / "selfLayoutKeys.json"
            ).read_text(encoding="utf-8")
        )
    )
    + _RETIRED_FLEX_KEYS
)


def _definition_roots(root: Path) -> dict:
    """Every component definition's first root layout, keyed by component name."""
    out: dict = {}
    components_dir = root / "components"
    if not components_dir.is_dir():
        return out
    for path in sorted(components_dir.rglob("*.json")):
        definition = read_json(path)
        if not isinstance(definition, dict):
            continue
        children = definition.get("children")
        if isinstance(children, list) and children and isinstance(children[0], dict):
            name = f"{path.parent.name}/{path.stem}" if path.parent != components_dir else path.stem
            out[name] = children[0].get("layout") or {}
    return out


def _folded(instance_layout: dict, definition_root: dict) -> dict:
    """`withInstanceSizing`: the instance's self-layout keys win on the root."""
    folded = dict(definition_root)
    for key in SELF_LAYOUT_KEYS:
        if key in instance_layout:
            folded[key] = instance_layout[key]
    return folded


def _collect(nodes: Any, flow: tuple[str, str], where: str, out: dict, roots: dict) -> None:
    if not isinstance(nodes, list):
        return
    for i, node in enumerate(nodes):
        if not isinstance(node, dict):
            continue
        key = f"{where}/{node.get('id') or i}"
        layout = node.get("layout")
        if isinstance(layout, dict):
            out[key] = {
                viewport: _effective(_resolved_layout(layout, viewport), flow)
                for viewport in VIEWPORTS
            }
            # A `$component:` instance renders as the definition's first root
            # with its own keys folded over — that fold is where a dropped key
            # stops meaning "neutral" and starts meaning "whatever the
            # definition says", so it is the geometry worth comparing.
            node_type = str(node.get("type") or "")
            if node_type.startswith("$component:"):
                definition_root = roots.get(node_type[len("$component:"):])
                if definition_root is not None:
                    out[f"{key}<folded"] = {
                        viewport: _effective(
                            _resolved_layout(_folded(layout, definition_root), viewport), flow
                        )
                        for viewport in VIEWPORTS
                    }
        align = layout.get("align") if isinstance(layout, dict) else None
        child_align = align if isinstance(align, str) and align != "" else "stretch"
        # `_child_axis` is what the migration threads too; where it can't answer,
        # the runtime still has a real flow, and the same one before and after.
        child_axis = _child_axis(node, _types())
        _collect(node.get("children"), (child_axis or flow[0], child_align), key, out, roots)


def _collect_project(root: Path) -> dict:
    out: dict = {}
    roots = _definition_roots(root)
    config_path = root / "config.json"
    if config_path.is_file():
        config = read_json(config_path)
        for region, axis in _SHELL_AXES.items():
            align = "center" if axis == "row" else "flex-start"
            _collect(config.get(region), (axis, align), region, out, roots)
        for dialog in config.get("dialogs") or []:
            if isinstance(dialog, dict):
                _collect(dialog.get("widgets"), (_DIALOG_AXIS, "stretch"), f"d{dialog.get('id')}", out, roots)
    pages_dir = root / "pages"
    if pages_dir.is_dir():
        for path in sorted(pages_dir.rglob("*.json")):
            sections = read_json(path).get("sections")
            if isinstance(sections, dict):
                for section_id, widgets in sections.items():
                    _collect(widgets, (_PAGE_AXIS, "stretch"), f"{path.name}:{section_id}", out, roots)
    components_dir = root / "components"
    if components_dir.is_dir():
        for path in sorted(components_dir.rglob("*.json")):
            definition = read_json(path)
            if isinstance(definition, dict):
                # A definition's roots are placed by whatever hosts the instance;
                # the walk still needs a flow, and the axis a root is judged
                # against is the same one before and after, so any is fine here.
                _collect(definition.get("children"), (_PAGE_AXIS, "stretch"), path.stem, out, roots)
    return out


def test_the_step_leaves_every_node_s_effective_geometry_alone(tmp_path: Path) -> None:
    staged = tmp_path / "project"
    shutil.copytree(PROJECT_TESTBENCH, staged, ignore=shutil.ignore_patterns("*.pre-migration-backup-*"))

    before = _collect_project(staged)
    migrate_size_modes(
        {"config": staged / "config.json", "pages": staged / "pages", "components": staged / "components"},
        staged,
    )
    after = _collect_project(staged)

    assert set(before) == set(after)
    moved = {key: (before[key], after[key]) for key in before if before[key] != after[key]}
    assert moved == {}, f"{len(moved)} node(s) changed effective geometry, e.g. {list(moved.items())[:3]}"


def test_running_the_step_twice_changes_nothing_the_second_time(tmp_path: Path) -> None:
    """Idempotency: the coordinator runs a step once, but a project that has
    already been through it must be left alone if it is ever seen again."""
    staged = tmp_path / "project"
    shutil.copytree(PROJECT_TESTBENCH, staged, ignore=shutil.ignore_patterns("*.pre-migration-backup-*"))
    paths = {
        "config": staged / "config.json",
        "pages": staged / "pages",
        "components": staged / "components",
    }

    migrate_size_modes(paths, staged)
    once = _collect_project(staged)
    migrate_size_modes(paths, staged)

    assert _collect_project(staged) == once
