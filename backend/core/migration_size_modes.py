"""Format 4 → 5: rewrite authored layouts into the Hug/Fill/Fixed sizing model.

The layout panel used to offer the raw flex four — ``basis``, ``grow``,
``shrink``, ``alignSelf`` — alongside Width and Height. It no longer does: a
widget's size on each axis is a stored ``widthMode``/``heightMode`` (see
``LayoutConfig`` in ``frontend/src/shared/types/config.ts``), and the runtime
emits axis-neutral custom properties for it (``selfLayoutStyle`` in
``frontend/src/hmi/components/layoutUtils.ts``) that a CSS translation block in
``hmi.css`` resolves against whichever axis the flex parent's own
``data-flow-direction`` names as main. Values a project already stored
under the old panel would otherwise keep affecting the render with no row left
to show or change them.

The governing rule is that **a project file holds only what the properties panel
can edit**: a key with no row is translated into one that has a row wherever the
translation is faithful, dropped where it is not, and never left in place. Every
drop that can move a widget is reported as a diagnostic.

The step runs as three passes over the project tree, in order. They were three
registered format steps while the model was being built and are one now, because
no build ever shipped a project stamped between them — but they stay separate
passes rather than one fused rewrite, because each reads a shape the one before
it produced and fusing them would change what a node converts to:

1. ``_normalise_flex`` re-expresses the raw flex keys as the shape the mode
   derivation reads — promoting a length ``basis`` onto the axis's own key,
   pinning ``shrink: 0`` under Hug and Fixed, leaving an existing Fill alone.
2. ``_write_mode_fields`` derives ``widthMode``/``heightMode`` from that shape
   and drops the ``basis``/``shrink``/``alignSelf`` the mode replaces.
3. ``_retire_raw_keys`` finishes the nodes pass 2 had to bail on — the ones
   sized by a property source — and sweeps up everything else the panel has no
   row for: ``margin``, a stale ``grow``, the container half of a node whose
   type does not declare that it flows its children (a widget the *project*
   owns keeps them either way; see ``_WidgetTypes``).

Passes 2 and 3 both write a mode over a dropped ``basis``, so both owe
``_write_content_floor`` — whichever reaches a node first. Stating that rule in
only one of them is how it came to fire in neither.

Pass 3 is the only one that can read a ``$switch``: a switch's branches are in
the file, so the mode each implies can be read off it and the whole switch
re-expressed as a mode switch beside a length switch. A ``$var`` cannot be read
at all, so a node sized by one becomes ``Fixed`` over that same binding — the
render is unchanged, since ``basis`` already outranked ``width`` in CSS, and
nothing uneditable is left behind.

What no pass will guess at is a node whose parent axis is unknowable: an
ImageContainer's absolutely-placed child, a container whose ``direction`` is
itself bound, a component definition root whose instances sit under two
different flows or under none. Which axis ``basis``/``shrink`` size and which
one ``alignSelf`` aligns is exactly what is unknown there, so pass 3 drops the
three rather than write a mode against a guess — reported, because a
``shrink: 0`` or an ``alignSelf`` that disagreed with its parent was
load-bearing.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any

from core.storage import read_json, write_json

# The raw flex keys pass 1 owns. `alignSelf` is deliberately not among them —
# at that point the cross-axis mode is still read off it, so it is current data.
FLEX_KEYS = ("grow", "shrink", "basis")

# The keys pass 3 retires. `grow` is not among them: it is the authored Fill
# weight the panel writes and the runtime reads.
_RETIRED_FLEX_KEYS = ("basis", "shrink", "alignSelf")
_MARGIN_KEYS = ("margin", "marginTop", "marginRight", "marginBottom", "marginLeft")

# The half of a layout that describes a node's insides rather than how it sits in
# its parent — the complement of the runtime's `SELF_LAYOUT_KEYS`.
_CONTAINER_KEYS = (
    "direction",
    "gap",
    "wrap",
    "align",
    "justify",
    "padding",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "radius",
)

# How each shell region arranged the widgets dropped straight into it, at the
# time of the 4 → 5 migration. Frozen history now, not a live twin of anything
# on the frontend: the editor and runtime used to resolve the mode rows against
# a shared `parentFlow.ts` table this was cross-checked against
# (`frontend/src/shared/types/__fixtures__/parentFlows.json`,
# `test_structure_parity.py`, `parentFlow.test.ts`) — all three gone once the
# runtime moved to resolving a child's axis from its flex parent's own
# `data-flow-direction` attribute at render, which needs no shared table to
# stay honest. What this constant fed stays correct regardless: it only
# describes what the format was at the moment of the one-shot upgrade, covered
# by this module's own migration tests.
_SHELL_AXES = {
    "header": "row",
    "footer": "row",
    "leftSidebar": "column",
    "rightSidebar": "column",
}
# A dialog body (`.hmi-modal__content`) is a wrapping row.
_DIALOG_AXIS = "row"
# Page sections and a page group's header/footer chrome stack their widgets.
_PAGE_AXIS = "column"

# (axis, parent align) — the per-node context every pass threads through the
# shared walk. Pass 1 reads only the axis half.
_Flow = tuple[str | None, str]

# How each region starts its children off.
_SHELL_FLOWS: dict[str, _Flow] = {
    region: (axis, "center" if axis == "row" else "flex-start")
    for region, axis in _SHELL_AXES.items()
}
_DIALOG_FLOW: _Flow = (_DIALOG_AXIS, "stretch")
_PAGE_FLOW: _Flow = (_PAGE_AXIS, "stretch")
# A definition's roots are placed by whatever hosts the instance, so they get no
# axis of their own; everything below them does.
_COMPONENT_ROOT_FLOW: _Flow = (None, "stretch")


@dataclass(frozen=True)
class _WidgetTypes:
    """What the widget catalogs say about the types this project's nodes name.

    Two different questions, deliberately kept apart:

    * *flows* — the types that declare ``flowsChildren``: they arrange their
      children with flexbox, so a child of one has a main axis to size against.
      Declared rather than hardcoded, because ``containerLayoutProps`` is on the
      custom-widget SDK and a project may ship its own flex container.
    * *owned* — the types this project implements itself. Whether a *declaration*
      is missing because the type does not flow, or because the widget was
      authored before there was anything to declare, is not knowable here — so a
      project widget keeps its container keys either way, and says so.
    """

    flows: frozenset[str]
    owned: frozenset[str]

    def flexes(self, node_type: str) -> bool:
        return node_type in self.flows


def _is_bound(value: Any) -> bool:
    """A property source (`{"$var": …}`, `{"$switch": …}`) rather than a literal."""
    return isinstance(value, dict)


def _length(value: Any) -> str | None:
    """The value as an explicit length, or None when it says "size yourself"."""
    if isinstance(value, str) and value.strip() not in ("", "auto"):
        return value
    return None


def _child_axis(node: dict[str, Any], types: _WidgetTypes) -> str | None:
    """The axis *node* lays its own children out on, or None if it doesn't flex.

    Read off the type's `flowsChildren` declaration, the same one `usesFlexLayout`
    reads in `parentFlow.ts` — a project shipping its own flex container must give
    its children the axis they actually render under, not the one an unrelated
    ancestor happens to have. An `ImageContainer` pins its children to image slots
    and a component instance arranges them inside its own definition, so neither
    declares it — and neither can a flex host whose `direction` is bound, since
    that flips at runtime.
    """
    if not types.flexes(str(node.get("type") or "")):
        return None
    direction = (node.get("layout") or {}).get("direction")
    if _is_bound(direction):
        return None
    return "column" if direction == "column" else "row"


def _child_flow(node: dict[str, Any], types: _WidgetTypes) -> _Flow:
    """The `(axis, align)` *node*'s own children are laid out under."""
    layout = node.get("layout")
    child_align = layout.get("align") if isinstance(layout, dict) else None
    child_align = child_align if isinstance(child_align, str) and child_align != "" else "stretch"
    return (_child_axis(node, types), child_align)


# ── the shared tree walk ──────────────────────────────────────────────────────

# A pass's per-node body. Returns True when it changed the node it was handed.
_Visit = Callable[[dict[str, Any], _Flow, str, list[str]], bool]


@dataclass(frozen=True)
class _Pass:
    """One pass of the walk: the per-node body, and the widget declarations the
    walk itself reads to thread each level's flow."""

    visit: _Visit
    types: _WidgetTypes


def _migrate_node(node: Any, flow: _Flow, where: str, notes: list[str], *, step: _Pass) -> bool:
    """Walk one node and its `children`, threading the flow each level sits under."""
    if not isinstance(node, dict):
        return False
    label = f"{where}/{node.get('id') or node.get('type') or '?'}"
    changed = step.visit(node, flow, label, notes)
    child_flow = _child_flow(node, step.types)
    for child in node.get("children") or []:
        changed |= _migrate_node(child, child_flow, label, notes, step=step)
    return changed


def _migrate_nodes(nodes: Any, flow: _Flow, where: str, notes: list[str], *, step: _Pass) -> bool:
    if not isinstance(nodes, list):
        return False
    changed = False
    for node in nodes:
        changed |= _migrate_node(node, flow, where, notes, step=step)
    return changed


def _migrate_page_tree(entries: Any, where: str, notes: list[str], *, step: _Pass) -> bool:
    """A page group's header/footer chrome, recursing through nested groups."""
    if not isinstance(entries, list):
        return False
    changed = False
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        label = f"{where}/{entry.get('id') or '?'}"
        for area in ("header", "footer"):
            changed |= _migrate_nodes(entry.get(area), _PAGE_FLOW, f"{label}.{area}", notes, step=step)
        for key in ("children", "pages"):
            changed |= _migrate_page_tree(entry.get(key), label, notes, step=step)
    return changed


def _walk_project(
    paths: Any,
    result: Any,
    step: _Pass,
    *,
    component_flow_for: Callable[[str], _Flow | None] | None = None,
) -> None:
    """Walk every node this step is allowed to touch — shell regions, dialogs,
    the page tree, `pages/*.json`, `components/*.json` — mutating *result* in
    place. Every pass sees the same tree under the same flows; only the per-node
    *visit* differs, so this is the one walk all three passes run.
    """
    config_path = paths["config"]
    if config_path.is_file():
        config = read_json(config_path)
        changed = False
        for region, flow in _SHELL_FLOWS.items():
            changed |= _migrate_nodes(config.get(region), flow, region, result.diagnostics, step=step)
        for dialog in config.get("dialogs") or []:
            if isinstance(dialog, dict):
                changed |= _migrate_nodes(
                    dialog.get("widgets"),
                    _DIALOG_FLOW,
                    f"dialog {dialog.get('id') or '?'}",
                    result.diagnostics,
                    step=step,
                )
        changed |= _migrate_page_tree(config.get("pages"), "pages", result.diagnostics, step=step)
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
                changed |= _migrate_nodes(
                    widgets, _PAGE_FLOW, f"{path.name}:{section_id}", result.diagnostics, step=step
                )
            if changed:
                result.files_changed.append(f"pages/{path.name}")
                write_json(path, page)

    components_dir = paths["components"]
    if components_dir.is_dir():
        for path in sorted(components_dir.rglob("*.json")):
            definition = read_json(path)
            if not isinstance(definition, dict):
                continue
            # A pass that can read the instances — `component_flow_for`, keyed by
            # the `$component:` id, which is the file's stem — answers for the
            # roots; every other pass leaves them axis-less.
            flow = _COMPONENT_ROOT_FLOW
            if component_flow_for is not None:
                from_instances = component_flow_for(path.stem)
                if from_instances is not None:
                    flow = from_instances
            if _migrate_nodes(definition.get("children"), flow, path.stem, result.diagnostics, step=step):
                result.files_changed.append(f"components/{path.name}")
                write_json(path, definition)


# ── pass 1: normalise the raw flex keys into the shape a mode is read from ────
#
# Two rules do more than delete:
#
# * A `basis` holding a real length becomes the main axis's length rather than
#   being dropped: flex-basis outranks width in CSS, so dropping it resizes the
#   widget.
# * Hug and Fixed gain `shrink: 0`. Both mean a size the author chose, CSS's
#   default `flex-shrink: 1` undercuts them, and there is no Shrink row left to
#   correct it with.
#
# A node already expressing Fill (`grow` above zero) is left exactly as authored,
# weighted `grow: 1.5` and `basis: auto` included: the panel already reads those
# as Fill, and rewriting them to `grow: 1, basis: 0` would collapse a child whose
# parent has no definite size on that axis. Migrating is not allowed to move
# pixels; normalising is what a Fill *click* is for.
#
# A `$component:` instance gets its flex keys written out in full rather than
# left to the CSS defaults: `ComponentRenderer.withInstanceSizing` folds only the
# keys present, so an absent `grow` means "whatever the definition chose" — and a
# definition root that fills would take over a widget the page had sized itself.


def _normalise_layout(
    layout: dict[str, Any],
    axis: str | None,
    where: str,
    notes: list[str],
    *,
    explicit: bool = False,
) -> bool:
    """Rewrite one node's `layout` in place. Returns whether anything changed.

    *explicit* keeps every flex key written out instead of leaning on the CSS
    default — see the section comment on component instances.
    """
    if not any(key in layout for key in FLEX_KEYS):
        return False

    bound = [key for key in FLEX_KEYS if _is_bound(layout.get(key))]
    if bound:
        notes.append(
            f"{where}: left {', '.join(bound)} as authored — bound to a property "
            "source, which no size mode can express"
        )
        return False

    if axis is None:
        # No parent axis: a `basis` here could be a width or a height and the
        # file cannot say which. Drop only what provably does nothing — and on an
        # instance not even that, since nothing it drops is provably nothing.
        if explicit:
            notes.append(
                f"{where}: left the flex keys as authored — a component instance with "
                "no parent axis to read a mode against"
            )
            return False
        if layout.get("grow") in (None, 0) and layout.get("basis") in (None, "auto"):
            changed = False
            for key in ("grow", "basis"):
                changed |= layout.pop(key, None) is not None
            return changed
        notes.append(
            f"{where}: left grow/basis as authored — the parent axis is decided "
            "elsewhere (a component root, an image slot, or a bound direction)"
        )
        return False

    main_key = "width" if axis == "row" else "height"
    if _is_bound(layout.get(main_key)):
        notes.append(f"{where}: left grow/basis/shrink as authored — {main_key} is bound")
        return False

    grow = layout.get("grow")
    if not isinstance(grow, (int, float)) or isinstance(grow, bool):
        grow = 0

    if grow > 0:
        # Already Fill, and the panel already reads it as Fill. Anything further
        # is a rendering change this pass has no mandate to make.
        if grow != 1:
            notes.append(
                f"{where}: kept grow {grow} — the panel calls it Fill, but a Fill click "
                "would even it out to 1, and the model has no ratios"
            )
        return False

    # Hug and Fixed from here: they differ only in whether a length is stored.
    basis = _length(layout.get("basis"))
    length = _length(layout.get(main_key))

    # A stored `basis` outranks `width`/`height` in CSS, so it is the size the
    # widget actually has today — promote it, and say so when it displaces a
    # different length that was never taking effect.
    if basis is not None:
        if length is not None and length != basis:
            notes.append(
                f"{where}: {main_key} was {length} but basis {basis} was the size in "
                f"effect; kept {basis}"
            )
        length = basis

    if explicit:
        layout["grow"] = 0
        layout["basis"] = "auto"
    else:
        layout.pop("grow", None)
        layout.pop("basis", None)
    layout["shrink"] = 0
    if length is None:
        layout.pop(main_key, None)
    else:
        layout[main_key] = length
    return True


def _normalise_visit(node: dict[str, Any], flow: _Flow, where: str, notes: list[str]) -> bool:
    layout = node.get("layout")
    if not isinstance(layout, dict):
        return False
    explicit = str(node.get("type") or "").startswith("$component:")
    return _normalise_layout(layout, flow[0], where, notes, explicit=explicit)


def _normalise_flex(paths: Any, result: Any, types: _WidgetTypes) -> None:
    _walk_project(paths, result, _Pass(_normalise_visit, types))


# ── pass 2: write the stored mode fields ──────────────────────────────────────
#
# Pass 1 left the mode implied by `width`/`grow`/`shrink`/`alignSelf` but never
# stored, so nothing could bind a `$var` to it. This pass writes it out as
# `widthMode`/`heightMode`, mirroring the derivation the editor used to do live,
# so a project reads identically before and after.
#
# Once a mode is written, `basis`/`shrink` (main axis) and `alignSelf` (cross
# axis) are dropped — the runtime recomputes all three from the mode. `grow` is
# kept as the authored Fill weight, `width`/`height` as the Fixed magnitude.
#
# Each axis converts independently. A bound flex key, a bound length, or an
# unknowable parent axis leaves that axis untouched for pass 3.


def _literal_length(value: Any) -> str | None:
    """A non-empty literal string, or None. Keyword lengths ('auto') included, so
    a migrated project reads the way the editor's live derivation did."""
    return value if isinstance(value, str) and value != "" else None


def _positive_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def _main_axis_mode(layout: dict[str, Any], key: str) -> str | None:
    """The main axis's mode: fixed > fill (grow > 0) > hug. None when
    `key`/`grow`/`shrink`/`basis` can't all be read as literals.

    `basis` is in that list because a bound one is the size in effect (it
    outranks `width` in CSS), so reading a mode off `width` and dropping the
    binding would resize the widget. Pass 3 reads those, one branch at a time.
    """
    if any(_is_bound(layout.get(k)) for k in (key, "grow", "shrink", "basis")):
        return None
    if _literal_length(layout.get(key)) is not None:
        return "fixed"
    return "fill" if _positive_number(layout.get("grow")) else "hug"


def _cross_axis_mode(layout: dict[str, Any], key: str, parent_align: str) -> str | None:
    """The cross axis's mode: fixed > fill/hug from `alignSelf`, falling back to
    the parent's own `align-items` when unset. None when `key`/`alignSelf` can't
    both be read as literals."""
    if any(_is_bound(layout.get(k)) for k in (key, "alignSelf")):
        return None
    if _literal_length(layout.get(key)) is not None:
        return "fixed"
    align_self = layout.get("alignSelf")
    align = parent_align if align_self in (None, "auto") else align_self
    return "fill" if align == "stretch" else "hug"


def _mode_fields_layout(
    layout: dict[str, Any], axis: str | None, align: str, where: str, notes: list[str]
) -> bool:
    """Rewrite one node's `layout` in place. Returns whether anything changed."""
    if axis is None:
        notes.append(
            f"{where}: left size mode undetermined — no parent axis to read it against "
            "(a component instance root, an image-slot child, or a bound container direction)"
        )
        return False

    main_key = "width" if axis == "row" else "height"
    cross_key = "height" if axis == "row" else "width"
    changed = False

    if "widthMode" not in layout and "heightMode" not in layout:
        main_mode = _main_axis_mode(layout, main_key)
        if main_mode is None:
            notes.append(
                f"{where}: left {main_key}/grow/shrink/basis as authored — bound to a property source"
            )
        else:
            # The same floor pass 3 writes, for the same reason and through the
            # same helper: Fill renders as `flex: <grow> 1 0`, so a node that was
            # growing from a content or length basis would start from zero
            # instead. Writing the mode here without it is how that rule came to
            # be stated twice and fire in neither.
            if main_mode == "fill" and _length(layout.get("basis")) != "0":
                _write_content_floor(layout, main_key, where, notes)
            layout[f"{main_key}Mode"] = main_mode
            layout.pop("basis", None)
            layout.pop("shrink", None)
            changed = True

        cross_mode = _cross_axis_mode(layout, cross_key, align)
        if cross_mode is None:
            notes.append(f"{where}: left {cross_key}/alignSelf as authored — bound to a property source")
        else:
            layout[f"{cross_key}Mode"] = cross_mode
            layout.pop("alignSelf", None)
            changed = True

    return changed


def _mode_fields_visit(node: dict[str, Any], flow: _Flow, where: str, notes: list[str]) -> bool:
    axis, align = flow
    layout = node.get("layout")
    if not isinstance(layout, dict):
        return False
    return _mode_fields_layout(layout, axis, align, where, notes)


def _write_mode_fields(paths: Any, result: Any, types: _WidgetTypes) -> None:
    _walk_project(paths, result, _Pass(_mode_fields_visit, types))


# ── pass 3: retire every key the panel has no row for ─────────────────────────
#
# Pass 2 bailed on every node sized by a property source. Right for a `$var`,
# whose value no migration can see; much too broad for a `$switch`, whose
# branches are in the file. A responsive project sizes by viewport, so nearly
# every length is a `$switch` — it would otherwise be left entirely on raw flex
# keys the panel has no row for.
#
# * A `$switch` on `basis` (or, absent one, on the axis's own `width`/`height`)
#   whose branches are all literal becomes `{axis}Mode` — the same switch, each
#   branch mapped to the mode it implies — alongside `{axis}` as the lengths.
# * Every remaining `basis`/`shrink`/`alignSelf` is dropped.
# * A sizing bound to a `$var` — or to a `$switch` with a branch that is one —
#   becomes `Fixed` over that same bound length.
# * `margin` and its four sides are dropped outright: no row, no replacement, and
#   `SELF_DIRECT_PROPS` no longer emits them, so a stored one had stopped
#   rendering anyway. Reported per removal, since losing one moves the widget.
# * A `grow` over a basis that is not `0` becomes Fill on a content floor.
# * The container half of a layout is dropped from every non-`Container`.
# * A `grow` the main axis's mode cannot read is dropped.
# * A component definition's own root nodes are migrated against the flow their
#   instances are placed under.


def _switch_branches(value: Any) -> list[Any] | None:
    """Every branch value a `$switch` can resolve to, or None if *value* is not
    a `$switch`. A malformed switch returns None too — this pass reads switches,
    it does not repair them."""
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


def _mode_for_length(value: Any) -> str | None:
    """The size mode a single literal length implies, or None if it is not one.

    `auto` is the CSS way of saying "size yourself", which is Hug; any other
    literal length is a size the author chose, which is Fixed.
    """
    if not isinstance(value, str) or value == "":
        return None
    return "hug" if value == "auto" else "fixed"


def _mode_switch(value: Any) -> Any | None:
    """A `$switch` of lengths rewritten as the same `$switch` of modes, or None
    when any branch is not a literal length this pass can read."""
    branches = _switch_branches(value)
    if branches is None:
        return None
    modes = [_mode_for_length(branch) for branch in branches]
    if any(mode is None for mode in modes):
        return None

    body = value["$switch"]
    cases = [
        {**case, "then": _mode_for_length(case.get("then"))}
        for case in body["cases"]
        if isinstance(case, dict)
    ]
    out: dict[str, Any] = {**body, "cases": cases}
    if "default" in body:
        out["default"] = _mode_for_length(body["default"])
    return {"$switch": out}


def _drop_keys(
    layout: dict[str, Any], keys: tuple[str, ...], where: str, notes: list[str], reason: str
) -> bool:
    """Remove *keys* from one layout, reporting every drop with *reason*."""
    dropped = [key for key in keys if key in layout]
    for key in dropped:
        layout.pop(key)
    if dropped:
        notes.append(f"{where}: dropped {', '.join(dropped)} — {reason}")
    return bool(dropped)


def _drop_margins(layout: dict[str, Any], where: str, notes: list[str]) -> bool:
    """Remove the margin family from one layout. Nothing emits a margin any
    more, so this is the one rewrite that applies to every node."""
    return _drop_keys(
        layout, _MARGIN_KEYS, where, notes,
        "the panel has no margin row and the runtime no longer emits one; space this widget "
        "with the parent's gap or padding",
    )


def _drop_container_keys(layout: dict[str, Any], where: str, notes: list[str]) -> bool:
    """Remove the container half of a layout from a node that does not flow its children.

    Only a type declaring `flowsChildren` reads these keys — `containerLayoutProps`
    is what consumes them, and that is the declaration for using it. An
    `ImageContainer` hosts children but pins them to image slots, a `$component:`
    instance arranges them inside its own definition — `ComponentRenderer` folds
    only `SELF_LAYOUT_KEYS` onto the definition's first root, so direction, gap
    and padding stay with the definition, where they belong — and a leaf has no
    children at all. The panel agrees: it renders `LayoutFields` in `leaf` mode
    for anything `usesFlexLayout` says no to, so none of these has a row. Stored,
    inert and uneditable.
    """
    return _drop_keys(
        layout, _CONTAINER_KEYS, where, notes,
        "only a widget that flows its children arranges them with these, and only its panel "
        "offers a row for one, so they never reached the DOM",
    )


def _drop_retired_keys(layout: dict[str, Any], where: str, notes: list[str]) -> bool:
    """Drop the raw flex keys from a node with no parent axis to read a mode against.

    Nothing faithful can be written in their place: which axis `basis`/`shrink`
    size and which one `alignSelf` aligns is exactly the thing that is unknown
    here, and a mode written against a guessed axis would size the node wrongly
    while looking authored. The panel has no row for any of the three, so the
    rule that leaves nothing uneditable behind leaves them nowhere to go.

    What the node falls back to is what an unset raw key means — the parent's
    own `align-items` on the cross axis, no growing and CSS's default shrink on
    the main one — which is also exactly what the panel now shows for it. Every
    drop is reported, since a `shrink: 0` or an `alignSelf` that disagreed with
    its parent was load-bearing.
    """
    return _drop_keys(
        layout, _RETIRED_FLEX_KEYS, where, notes,
        "no parent axis to read a mode against (an image-slot child, a bound container direction, "
        "or a definition root whose instances sit under two different flows, or under none at "
        "all), and the panel has no row for any of the three; set this widget's Width/Height mode "
        "if its size moved",
    )


def _drop_stale_grow(layout: dict[str, Any], main_key: str, where: str, notes: list[str]) -> bool:
    """Drop a `grow` the main axis cannot read.

    `grow` is the Fill weight, and the panel offers its row only where the main
    axis can read one: under a literal Fill, or under a mode no read resolves —
    an unset one, a `$var`, a `$switch` — which may still turn out to be Fill.
    Under any other literal mode the axis-neutral `--w-grow`/`--h-grow` custom
    property this axis emits is never consumed by the `hmi.css` translation
    block once that axis is main, so it is a key that draws nothing and has no
    row to be seen or reverted in.

    This is a one-shot, main-axis-only twin of `reachableSizeKeys` in
    `frontend/src/config/components/ui/LayoutFields/index.tsx`, frozen at what
    that function's main-axis case did when this migration step was written —
    it has since dropped its `main` argument entirely, because which axis is
    main is no longer this function's business (a flex *parent*'s own
    `data-flow-direction` decides that in CSS, not this per-axis check). It was
    never a twin of the *cross*-axis case: that also reads `True` for a literal
    Fill, which decides whether the panel still offers a row for the weight (so
    it stays visible and revertable, one shared key with the main axis's own
    row) — not whether anything renders through it, which only the main axis's
    own mode ever does.
    """
    if "grow" not in layout:
        return False
    mode = layout.get(f"{main_key}Mode")
    if not isinstance(mode, str) or mode == "fill":
        return False
    layout.pop("grow")
    notes.append(
        f"{where}: dropped grow — {main_key} reads {mode}, not Fill, so the weight drew nothing "
        "through this axis"
    )
    return True


def _grows(grow: Any) -> bool:
    """Whether a `grow` can take a share of the main axis — a positive weight, or
    a binding that may resolve to one. Both are Fill; `0` and an absent key are
    not."""
    if _is_bound(grow):
        return True
    return isinstance(grow, (int, float)) and not isinstance(grow, bool) and grow > 0


def _write_content_floor(
    layout: dict[str, Any], main_key: str, where: str, notes: list[str]
) -> None:
    """Keep the content size of a node that grew from it, now that it is Fill.

    `grow` over a basis that is not `0` grows *from* the content size, which the
    panel cannot spell: Fill starts every item at zero and splits the whole axis
    instead. `min-<axis>: auto` pins the content size back on as a floor —
    `hmi.css` defaults the min to `0`, so an unset one does not floor — which
    makes the two identical wherever this is the only growing child. Where it is
    not, each growing sibling's share shifts, and the note says so.
    """
    floor_key = "minWidth" if main_key == "width" else "minHeight"
    if floor_key not in layout:
        layout[floor_key] = "auto"
    notes.append(
        f"{where}: read a grow over a content basis as Fill with {floor_key} auto — the raw flex "
        "keys have no panel row, and the floor keeps the content size Fill would otherwise drop; "
        "check the split if this widget shares its parent with other Fill widgets"
    )


def _retire_raw_keys_layout(
    layout: dict[str, Any], axis: str | None, align: str, where: str, notes: list[str]
) -> bool:
    """Rewrite one node's `layout` in place. Returns whether anything changed.

    A retired flex key is only ever dropped where a mode is written to replace
    it: `shrink: 0` is load-bearing, and dropping it with nothing in its place
    would hand the node CSS's default `flex-shrink: 1` and let it shrink where
    the author had pinned it.
    """
    changed = _drop_margins(layout, where, notes)

    if axis is None:
        changed |= _drop_retired_keys(layout, where, notes)
        # No `_drop_stale_grow` here: which axis the weight belongs to is exactly
        # what is unknown, so reading it against `width` would delete a live
        # weight off a node whose parent turns out to be a column. The frontend
        # has no equivalent case any more — a flex parent's own
        # `data-flow-direction` resolves the axis in CSS regardless of whether
        # this migration step could determine it, so nothing there needs to
        # agree with sparing these nodes.
        return changed

    main_key = "width" if axis == "row" else "height"
    cross_key = "height" if axis == "row" else "width"

    # Each axis is guarded on its own mode rather than on either of them. A node
    # pass 2 could only half-read — a main mode written, the cross one left
    # bound — would otherwise keep its `alignSelf` forever, and a re-run would
    # skip the axis it never finished.
    if f"{main_key}Mode" in layout:
        # A written mode recomputes all three raw keys at render
        # (`axisModePatch`), so whatever is left of them is dead weight.
        for key in ("basis", "shrink"):
            changed |= layout.pop(key, None) is not None
    else:
        basis = layout.get("basis")
        grow = layout.get("grow")

        if _is_bound(basis) and _grows(grow):
            # Fill has no basis of its own — it renders as `flex: <grow> 1 0` —
            # so writing it here would take the binding with it. The two reads
            # that keep a bound `basis` are both closed: pass 1 refuses the node
            # outright, and `_write_main_mode`'s move onto the axis key needs the
            # basis to *be* the size, which a `grow` says it is not. So this node
            # keeps its raw keys, as pass 1 left them.
            main_written = False
            notes.append(
                f"{where}: left grow/basis as authored — the basis is bound to a property "
                f"source, which Fill has nowhere to carry; set {main_key}'s mode by hand if "
                "this widget should fill its parent"
            )
        elif _grows(grow):
            # Any `grow` that can take a share of the axis is Fill. Over
            # `basis: "0"` that is a pure rename — Fill re-renders as exactly
            # those two keys. Over any other basis it is not, and
            # `_write_content_floor` says what is done about it.
            layout[f"{main_key}Mode"] = "fill"
            main_written = True
            if _length(basis) != "0":
                _write_content_floor(layout, main_key, where, notes)
        else:
            main_written = _write_main_mode(layout, main_key, basis, where, notes)

        if main_written:
            for key in ("basis", "shrink"):
                changed |= layout.pop(key, None) is not None
            changed = True

    if f"{cross_key}Mode" in layout:
        changed |= layout.pop("alignSelf", None) is not None
    else:
        cross_mode = _cross_axis_mode(layout, cross_key, align)
        if cross_mode is None:
            cross_mode = _bound_cross_mode(layout, cross_key, align, where, notes)
        if cross_mode is not None:
            layout[f"{cross_key}Mode"] = cross_mode
            layout.pop("alignSelf", None)
            changed = True

    changed |= _drop_stale_grow(layout, main_key, where, notes)
    return changed


def _bound_cross_mode(
    layout: dict[str, Any], cross_key: str, align: str, where: str, notes: list[str]
) -> str | None:
    """The cross-axis mode for a node `_cross_axis_mode` refused, which it does
    only where the cross length or `alignSelf` is a property source.

    A bound length is the size in effect, so it reads as Fixed — the same call
    the main axis makes. A bound `alignSelf` is the harder one: what it resolves
    to cannot be read here and it has no panel row to stay in, so the axis falls
    back to what an unset `alignSelf` means, the parent's own `align-items`.
    """
    if _is_bound(layout.get(cross_key)):
        notes.append(
            f"{where}: read {cross_key} as Fixed over a bound length — no mode can be read from "
            "a property source, and the length itself is untouched"
        )
        return "fixed"
    if _is_bound(layout.get("alignSelf")):
        mode = "fill" if align == "stretch" else "hug"
        notes.append(
            f"{where}: dropped a bound alignSelf and read {cross_key} as {mode} from the parent's "
            f"align ({align}) — the panel has no alignSelf row to keep the binding in, so check "
            "this node if it aligned itself against its parent"
        )
        return mode
    return None


def _write_main_mode(
    layout: dict[str, Any], main_key: str, basis: Any, where: str, notes: list[str]
) -> bool:
    """Write the main axis's mode for a node that is not already Fill. Returns
    whether one was written — the caller only retires the raw flex keys if so.

    `basis` outranks `width`/`height` in CSS, so a stored one is the size in
    effect and the value a mode is read from, exactly as pass 1 had it.
    """
    source = basis if _is_bound(basis) or _length(basis) is not None else layout.get(main_key)

    mode_switch = _mode_switch(source)
    if mode_switch is not None:
        layout[f"{main_key}Mode"] = mode_switch
        layout[main_key] = source
        main_written = True
    elif _is_bound(source):
        # A bound size no mode can be *read* from — a `$var`, or a `$switch`
        # with a branch that is one. Fixed is the read that changes nothing: the
        # binding moves onto the axis's own key, where `basis` was already
        # outranking it in CSS, and Fixed leaves that key alone at render.
        # Keeping the raw key instead would leave a field in the project that
        # the panel has no row to edit.
        layout[f"{main_key}Mode"] = "fixed"
        layout[main_key] = source
        main_written = True
        notes.append(
            f"{where}: read {main_key} as Fixed over a bound length — no mode can be read from "
            "a property source, and the length itself is untouched"
        )
    else:
        if _length(basis) is not None:
            replaced = layout.get(main_key)
            layout[main_key] = basis
            if _is_bound(replaced):
                notes.append(
                    f"{where}: dropped a bound {main_key} — the stored basis outranked it in "
                    "CSS, so the render is unchanged, but the binding itself is gone"
                )
        if _is_bound(layout.get("shrink")):
            # `_main_axis_mode` refuses on a bound `shrink` too. Nothing authors
            # one now and no row can edit it, so the mode is read without it:
            # Fixed pins the axis, which is what a `shrink` on a sized node was
            # there to do.
            layout.pop("shrink")
            notes.append(
                f"{where}: dropped a bound shrink — it has no panel row, and the mode written "
                f"here pins {main_key} on its own"
            )
        mode = _main_axis_mode(layout, main_key)
        main_written = mode is not None
        if mode is not None:
            layout[f"{main_key}Mode"] = mode
        else:
            notes.append(
                f"{where}: left {main_key} sizing undetermined — a property source no size mode "
                "can be read from (a $var, or a $switch with a non-literal branch)"
            )

    return main_written


def _retire_visit(
    node: dict[str, Any],
    flow: _Flow,
    where: str,
    notes: list[str],
    *,
    types: _WidgetTypes,
) -> bool:
    axis, align = flow
    layout = node.get("layout")
    if not isinstance(layout, dict):
        return False
    # A `$component:` instance is migrated like any other node. Its self-sizing
    # keys are folded onto the definition's first root (`withInstanceSizing`),
    # where they override whatever the definition sizes itself as, so they are
    # *translated* rather than dropped: dropping one hands the definition's own
    # value control, which is a rendering change, while writing the mode that
    # replaces it is not. The root reads its flow from where the instance sits —
    # `ComponentRenderer` renders no flex parent of its own around a root, so
    # the axis in hand is the axis those keys were already resolving against.
    changed = _retire_raw_keys_layout(layout, axis, align, where, notes)
    node_type = str(node.get("type") or "")
    if node_type in types.owned:
        if any(key in layout for key in _CONTAINER_KEYS):
            notes.append(
                f"{where}: kept the container keys on {node_type} — it is a widget this project "
                "owns, and `containerLayoutProps` is on the custom-widget SDK, so this step cannot "
                "prove they draw nothing; the layout panel has no row for them"
            )
    elif not types.flexes(node_type):
        changed = _drop_container_keys(layout, where, notes) or changed
    return changed


def _definition_flows(paths: Any, types: _WidgetTypes) -> dict[str, _Flow]:
    """The flow each component definition's root nodes render under, read off the
    instances that place them.

    A definition's roots have no axis of their own, which is why the earlier
    passes left their raw flex keys alone. They are not unknowable, though, only
    unknowable *locally*: `ComponentRenderer` renders no flex parent of its own
    around a root, so a root sizes itself against the parent the **instance**
    sits in, and the instances are all in this same project. So walk it once,
    record where each `$component:` node sits, and hand a definition whose
    instances agree that
    flow on the real pass. A definition with no instances, or with instances
    under two different flows, gets nothing and is reported per node.
    """
    if not paths["components"].is_dir():
        return {}

    from core.project_migrations import StepResult

    seen: dict[str, set[_Flow]] = {}

    def collect(node: dict[str, Any], flow: _Flow, where: str, notes: list[str]) -> bool:
        node_type = str(node.get("type") or "")
        if node_type.startswith("$component:") and flow[0] is not None:
            seen.setdefault(node_type[len("$component:") :], set()).add(flow)
        return False

    _walk_project(paths, StepResult(), _Pass(collect, types))
    return {name: flows.pop() for name, flows in seen.items() if len(flows) == 1}


def _retire_raw_keys(paths: Any, result: Any, types: _WidgetTypes) -> None:
    _walk_project(
        paths,
        result,
        _Pass(partial(_retire_visit, types=types), types),
        component_flow_for=_definition_flows(paths, types).get,
    )


# ── the step ──────────────────────────────────────────────────────────────────


def migrate_size_modes(paths: Any, project_root: Path) -> Any:
    """The step body. `paths` maps target name -> staged path (see the coordinator).

    Both a real run and a dry run mutate the paths they are handed, and both run
    all three passes: each pass reads the shape the one before it wrote, so
    reporting what the step *would* do means letting it actually do it. Which of
    the two this is, the step never learns — the coordinator stages a dry run
    into a throwaway copy and deletes it afterwards.

    *project_root* is the real project, which the staged paths are not: it is
    where `custom-widgets/` lives, and a dry run's staging is somewhere else
    entirely.
    """
    from core.project_migrations import StepResult

    result = StepResult()
    _run_passes(paths, result, _widget_types(project_root))
    result.files_changed = list(dict.fromkeys(result.files_changed))
    return result


def _widget_types(project_root: Path) -> _WidgetTypes:
    """Read the declarations behind {@link _WidgetTypes} from the two catalogs.

    The built-in half ships with the running bundle, so it answers even in a
    runtime home that has never compiled. The project half is parsed straight
    from `custom-widgets/` with the compiler's own extractor rather than read
    from `widget-schemas.json`, which lives in the runtime home and describes
    whichever project was last compiled — not necessarily this one.

    A node's `type` may be either the full `<Group>/<Name>` key or its leaf, so
    both spellings are recorded.
    """
    from services.widget_compiler import discovered_entries_by_key
    from services.widget_schemas import extract_schemas

    from core.builtin_widgets_manifest import builtin_widgets_catalog

    _, builtin = builtin_widgets_catalog()
    flows = {
        name
        for name, entry in builtin.items()
        if isinstance(entry, dict) and entry.get("flowsChildren") is True
    }

    owned: set[str] = set()
    sources = []
    for key, entry in discovered_entries_by_key(project_root / "custom-widgets").items():
        owned |= {key, key.rsplit("/", 1)[-1]}
        try:
            sources.append({"key": key, "file": str(entry), "source": entry.read_text("utf-8")})
        except OSError:
            continue
    for key, entry in (extract_schemas(custom_widget_sources=sources).get("custom") or {}).items():
        if isinstance(entry, dict) and entry.get("flowsChildren") is True:
            flows |= {key, key.rsplit("/", 1)[-1]}

    return _WidgetTypes(frozenset(flows), frozenset(owned))


def _run_passes(paths: Any, result: Any, types: _WidgetTypes) -> None:
    _normalise_flex(paths, result, types)
    _write_mode_fields(paths, result, types)
    _retire_raw_keys(paths, result, types)
