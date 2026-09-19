"""Tests for the 4 → 5 step that rewrites stored layouts into the size modes.

The step runs three passes and the tests follow them: each pass's unit half
drives its own ``_*_layout`` directly, one rule per test, and a few per pass run
that pass over a project tree, which is what proves the axis and align a node is
judged against actually come from its parent. The last section runs the whole
step, where the passes have to compose.

The load-bearing rule across all three is the one about ``shrink``: it is only
ever dropped where a mode is written to take its place, since a bare node
inherits CSS's ``flex-shrink: 1`` and would start shrinking where the author had
pinned it.

``test_migration_size_modes_geometry.py`` is the other half of the coverage: it
runs the step over the real testbench project and compares the *effective* flex
geometry of every node before and after.
"""

import json
import shutil
from pathlib import Path

import pytest
from core import project_migrations as pm
from core.migration_size_modes import (
    _mode_fields_layout,
    _normalise_flex,
    _normalise_layout,
    _retire_raw_keys,
    _retire_raw_keys_layout,
    _retire_visit,
    _widget_types,
    _WidgetTypes,
    _write_mode_fields,
    migrate_size_modes,
)


def _node(node_id: str, **layout) -> dict:
    return {"id": node_id, "type": "Container", "layout": layout, "children": []}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "pages").mkdir()
    (tmp_path / "components").mkdir()
    (tmp_path / "config.json").write_text(json.dumps({"header": [], "pages": []}))
    return tmp_path


def _paths(root: Path) -> dict[str, Path]:
    return {"config": root / "config.json", "pages": root / "pages", "components": root / "components"}


# What the shipped catalogs say, read the way the step reads them: the built-in
# `Container` declares `flowsChildren`, and a fixture project owns no widgets.
# Read rather than written out, so a Container that stopped declaring it fails
# these tests instead of quietly changing what every child is judged against.
TYPES = _widget_types(Path("/nonexistent"))


def run_pass(pass_fn, paths: dict[str, Path], types: _WidgetTypes = TYPES) -> pm.StepResult:
    """Drive one pass over a project tree, as the step does."""
    result = pm.StepResult()
    pass_fn(paths, result, types)
    return result


def retire_visit(node: dict, flow, where: str, notes: list[str], types: _WidgetTypes = TYPES):
    """`_retire_visit` with the catalogs the step would have read."""
    return _retire_visit(node, flow, where, notes, types=types)


def viewport_switch(phone: object, tablet: object, default: object) -> dict:
    return {
        "$switch": {
            "value": {"$viewport": {"field": "size"}},
            "cases": [{"when": "phone", "then": phone}, {"when": "tablet", "then": tablet}],
            "default": default,
        }
    }


# ══ pass 1: normalising the raw flex keys ════════════════════════════════════


def normalise(layout: dict, axis: str | None) -> tuple[dict, list[str]]:
    notes: list[str] = []
    _normalise_layout(layout, axis, "w", notes)
    return layout, notes


def normalise_explicit(layout: dict, axis: str | None) -> tuple[dict, list[str]]:
    notes: list[str] = []
    _normalise_layout(layout, axis, "w", notes, explicit=True)
    return layout, notes


# ── the three modes ───────────────────────────────────────────────────────────


def test_hug_drops_the_flex_keys_and_pins_shrink_off() -> None:
    layout, notes = normalise({"grow": 0, "shrink": 1, "basis": "auto"}, "row")
    assert layout == {"shrink": 0}
    assert notes == []


def test_fixed_keeps_its_length_and_pins_shrink_off() -> None:
    layout, _ = normalise({"grow": 0, "shrink": 1, "basis": "auto", "width": "200px"}, "row")
    assert layout == {"width": "200px", "shrink": 0}


def test_an_existing_fill_is_left_exactly_as_authored() -> None:
    """It already reads as Fill in the panel, and `basis: 0` under a parent with
    no definite size collapses the widget — migrating must not move pixels."""
    layout, notes = normalise({"grow": 1, "shrink": 1, "basis": "auto"}, "row")
    assert layout == {"grow": 1, "shrink": 1, "basis": "auto"}
    assert notes == []


def test_the_axis_decides_which_length_a_mode_writes() -> None:
    """The same stored basis is a width under a row parent and a height under a column."""
    assert normalise({"grow": 0, "basis": "154px"}, "row")[0] == {"width": "154px", "shrink": 0}
    assert normalise({"grow": 0, "basis": "154px"}, "column")[0] == {"height": "154px", "shrink": 0}


# ── the rules that do more than delete ────────────────────────────────────────


def test_a_length_basis_becomes_the_axis_length_rather_than_being_dropped() -> None:
    layout, notes = normalise({"grow": 0, "shrink": 0, "basis": "154px"}, "row")
    assert layout == {"width": "154px", "shrink": 0}
    assert notes == []


def test_a_basis_that_was_overriding_a_width_wins_and_says_so() -> None:
    """flex-basis outranks width, so the basis is the size the widget really had."""
    layout, notes = normalise({"grow": 0, "basis": "154px", "width": "999px"}, "row")
    assert layout == {"width": "154px", "shrink": 0}
    assert "was 999px" in notes[0] and "154px" in notes[0]


def test_a_weighted_grow_is_kept_but_reported() -> None:
    """The panel calls any positive grow Fill; evening it to 1 is a Fill click's job."""
    layout, notes = normalise({"grow": 1.5, "shrink": 1, "basis": "0"}, "row")
    assert layout == {"grow": 1.5, "shrink": 1, "basis": "0"}
    assert "kept grow 1.5" in notes[0]


def test_fill_keeps_a_length_sitting_beside_it() -> None:
    layout, _ = normalise({"grow": 1, "basis": "0", "width": "200px"}, "row")
    assert layout == {"grow": 1, "basis": "0", "width": "200px"}


def test_align_self_is_never_touched_by_the_normalise_pass() -> None:
    """The cross-axis mode is still read off it here, so it is current data, not
    a leftover — pass 3 is what finally retires it."""
    layout, _ = normalise({"grow": 0, "basis": "auto", "alignSelf": "flex-start"}, "row")
    assert layout["alignSelf"] == "flex-start"


def test_the_bounds_survive_every_mode() -> None:
    layout, _ = normalise({"grow": 0, "basis": "auto", "minWidth": "5rem", "maxWidth": "40rem"}, "row")
    assert layout["minWidth"] == "5rem"
    assert layout["maxWidth"] == "40rem"


# ── what it refuses to touch ──────────────────────────────────────────────────


@pytest.mark.parametrize("key", ["grow", "basis", "shrink"])
def test_a_bound_value_is_left_exactly_as_authored(key: str) -> None:
    """A `$switch` on `$viewport` is per-breakpoint sizing no single mode can state."""
    source = {"$switch": {"value": {"$viewport": {"field": "size"}}, "default": 1}}
    layout, notes = normalise({"grow": 0, "shrink": 1, "basis": "auto", key: source}, "row")
    assert layout[key] == source
    assert layout == {"grow": 0, "shrink": 1, "basis": "auto", key: source}
    assert "bound to a property source" in notes[0]


def test_a_bound_axis_length_leaves_the_whole_node_alone() -> None:
    layout, notes = normalise({"grow": 0, "basis": "auto", "width": {"$var": "w"}}, "row")
    assert layout == {"grow": 0, "basis": "auto", "width": {"$var": "w"}}
    assert "width is bound" in notes[0]


def test_no_axis_strips_only_what_provably_does_nothing() -> None:
    layout, notes = normalise({"grow": 0, "shrink": 0, "basis": "auto"}, None)
    assert layout == {"shrink": 0}
    assert notes == []


def test_no_axis_keeps_a_real_length_it_cannot_place() -> None:
    """Without a parent axis a `154px` basis could be a width or a height."""
    layout, notes = normalise({"grow": 0, "basis": "154px"}, None)
    assert layout == {"grow": 0, "basis": "154px"}
    assert "parent axis is decided elsewhere" in notes[0]


# ── component instances, where "absent" does not mean "default" ───────────────


def test_an_instance_states_its_neutral_values_instead_of_omitting_them() -> None:
    """`withInstanceSizing` folds only the keys the instance carries, so dropping
    `grow: 0` hands sizing to the definition root — usually a filling card."""
    layout, _ = normalise_explicit({"grow": 0, "shrink": 1, "basis": "auto"}, "row")
    assert layout == {"grow": 0, "basis": "auto", "shrink": 0}


def test_an_instance_that_already_fills_is_left_alone_like_any_other() -> None:
    layout, _ = normalise_explicit({"grow": 2, "shrink": 0, "basis": "auto"}, "row")
    assert layout == {"grow": 2, "shrink": 0, "basis": "auto"}


def test_an_instance_with_no_parent_axis_is_left_entirely_alone() -> None:
    layout, notes = normalise_explicit({"grow": 0, "shrink": 0, "basis": "auto"}, None)
    assert layout == {"grow": 0, "shrink": 0, "basis": "auto"}
    assert "component instance" in notes[0]


def test_the_normalise_pass_spots_an_instance_by_its_type(project: Path) -> None:
    row = _node("row", direction="row")
    row["children"] = [
        {"id": "card", "type": "$component:card", "layout": {"grow": 0, "basis": "auto"}},
        _node("plain", grow=0, basis="auto"),
    ]
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    run_pass(_normalise_flex, _paths(project))

    kids = json.loads((project / "pages" / "p.json").read_text())["sections"]["content"][0]
    by_id = {n["id"]: n["layout"] for n in kids["children"]}
    assert by_id["card"] == {"grow": 0, "basis": "auto", "shrink": 0}
    assert by_id["plain"] == {"shrink": 0}


def test_a_layout_with_no_flex_keys_is_left_untouched() -> None:
    layout, notes = normalise({"direction": "row", "gap": "8px"}, "row")
    assert layout == {"direction": "row", "gap": "8px"}
    assert notes == []


# ── the pass, over a project tree ─────────────────────────────────────────────


def test_a_child_is_judged_against_its_container_direction(project: Path) -> None:
    """The same basis under a row parent and a column parent lands on different keys."""
    row = _node("row", direction="row")
    row["children"] = [_node("a", grow=0, basis="100px")]
    column = _node("col", direction="column")
    column["children"] = [_node("b", grow=0, basis="100px")]
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row, column]}}))

    run_pass(_normalise_flex, _paths(project))

    page = json.loads((project / "pages" / "p.json").read_text())
    written = {n["id"]: n["children"][0]["layout"] for n in page["sections"]["content"]}
    assert written["row"] == {"width": "100px", "shrink": 0}
    assert written["col"] == {"height": "100px", "shrink": 0}


def test_the_normalise_pass_reads_a_shell_bar_as_a_row_and_a_sidebar_as_a_column(project: Path) -> None:
    config = {
        "header": [_node("h", grow=0, basis="60px")],
        "leftSidebar": [_node("s", grow=0, basis="60px")],
    }
    (project / "config.json").write_text(json.dumps(config))

    run_pass(_normalise_flex, _paths(project))

    written = json.loads((project / "config.json").read_text())
    assert written["header"][0]["layout"] == {"width": "60px", "shrink": 0}
    assert written["leftSidebar"][0]["layout"] == {"height": "60px", "shrink": 0}


def test_a_component_root_gets_no_axis_but_its_children_do(project: Path) -> None:
    root = _node("root", direction="row", grow=0, basis="154px")
    root["children"] = [_node("inner", grow=0, basis="20px")]
    (project / "components" / "c.json").write_text(json.dumps({"children": [root]}))

    result = run_pass(_normalise_flex, _paths(project))

    written = json.loads((project / "components" / "c.json").read_text())["children"][0]
    assert written["layout"]["basis"] == "154px"  # untouched: axis unknown
    assert written["children"][0]["layout"] == {"width": "20px", "shrink": 0}
    assert any("parent axis is decided elsewhere" in note for note in result.diagnostics)


def test_a_non_container_parent_gives_its_children_no_axis(project: Path) -> None:
    """An ImageContainer places children absolutely — its `direction` means nothing."""
    host = {"id": "img", "type": "ImageContainer", "layout": {"direction": "row"}}
    host["children"] = [_node("pin", grow=0, basis="30px")]
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [host]}}))

    run_pass(_normalise_flex, _paths(project))

    page = json.loads((project / "pages" / "p.json").read_text())
    assert page["sections"]["content"][0]["children"][0]["layout"]["basis"] == "30px"


# ══ pass 2: writing the stored mode fields ═══════════════════════════════════


def write_modes(layout: dict, axis: str | None, align: str = "stretch") -> tuple[dict, list[str]]:
    notes: list[str] = []
    _mode_fields_layout(layout, axis, align, "w", notes)
    return layout, notes


# ── the main axis ────────────────────────────────────────────────────────────


def test_a_bare_main_axis_reads_as_hug() -> None:
    layout, notes = write_modes({}, "row")
    assert layout == {"widthMode": "hug", "heightMode": "fill"}
    assert notes == []


def test_positive_grow_on_the_main_axis_reads_as_fill_and_grow_is_kept() -> None:
    layout, _ = write_modes({"grow": 1.5, "basis": "0", "shrink": 1}, "row")
    assert layout["widthMode"] == "fill"
    assert layout["grow"] == 1.5
    assert "basis" not in layout
    assert "shrink" not in layout


def test_a_literal_length_on_the_main_axis_reads_as_fixed() -> None:
    layout, _ = write_modes({"width": "200px", "shrink": 0}, "row")
    assert layout["widthMode"] == "fixed"
    assert layout["width"] == "200px"  # the magnitude is kept, not dropped
    assert "shrink" not in layout


def test_the_axis_decides_which_key_a_mode_is_written_under() -> None:
    assert write_modes({}, "row")[0]["widthMode"] == "hug"
    assert write_modes({}, "column")[0]["heightMode"] == "hug"


# ── the cross axis ───────────────────────────────────────────────────────────


def test_a_bare_cross_axis_reads_the_parents_default_align() -> None:
    layout, _ = write_modes({}, "row", align="stretch")
    assert layout["heightMode"] == "fill"

    layout, _ = write_modes({}, "row", align="center")
    assert layout["heightMode"] == "hug"


def test_an_explicit_align_self_outranks_the_parents_default() -> None:
    layout, _ = write_modes({"alignSelf": "flex-start"}, "row", align="stretch")
    assert layout["heightMode"] == "hug"
    assert "alignSelf" not in layout

    layout, _ = write_modes({"alignSelf": "stretch"}, "row", align="center")
    assert layout["heightMode"] == "fill"


def test_a_literal_length_on_the_cross_axis_reads_as_fixed() -> None:
    layout, _ = write_modes({"height": "80px"}, "row")
    assert layout["heightMode"] == "fixed"
    assert layout["height"] == "80px"


# ── what it refuses to touch ─────────────────────────────────────────────────


@pytest.mark.parametrize("key", ["grow", "shrink"])
def test_a_bound_main_axis_key_leaves_that_axis_alone(key: str) -> None:
    source = {"$var": {"path": "MyPLC:G"}}
    layout, notes = write_modes({key: source}, "row")
    assert "widthMode" not in layout
    assert layout[key] == source
    assert layout["heightMode"] == "fill"  # the cross axis still converts
    assert any("bound to a property source" in n for n in notes)


def test_a_bound_align_self_leaves_the_cross_axis_alone() -> None:
    source = {"$var": {"path": "MyPLC:A"}}
    layout, notes = write_modes({"alignSelf": source}, "row")
    assert "heightMode" not in layout
    assert layout["alignSelf"] == source
    assert layout["widthMode"] == "hug"  # the main axis still converts
    assert any("bound to a property source" in n for n in notes)


def test_a_bound_length_leaves_that_axis_alone() -> None:
    source = {"$var": {"path": "MyPLC:W"}}
    layout, notes = write_modes({"width": source}, "row")
    assert "widthMode" not in layout
    assert layout["width"] == source
    assert any("bound to a property source" in n for n in notes)


def test_no_axis_leaves_the_whole_node_alone() -> None:
    layout, notes = write_modes({"grow": 1, "basis": "0"}, None)
    assert layout == {"grow": 1, "basis": "0"}
    assert "no parent axis" in notes[0]


def test_an_already_migrated_node_is_left_alone() -> None:
    """Idempotent: a node already carrying a mode (e.g. authored fresh, not
    migrated) is not re-derived — mode is the source of truth once present."""
    layout, notes = write_modes({"widthMode": "fill", "grow": 3}, "row")
    assert layout == {"widthMode": "fill", "grow": 3}
    assert notes == []


def test_a_layout_with_no_flex_keys_still_gets_a_mode() -> None:
    """An unset node is a legitimate Hug/Fill just as much as an explicit one."""
    layout, notes = write_modes({"direction": "row", "gap": "8px"}, "row")
    assert layout["widthMode"] == "hug"
    assert layout["heightMode"] == "fill"
    assert notes == []


# ── the pass, over a project tree ────────────────────────────────────────────


def test_a_child_is_judged_against_its_container_direction_and_align(project: Path) -> None:
    row = _node("row", direction="row", align="center")
    row["children"] = [_node("a")]
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    run_pass(_write_mode_fields, _paths(project))

    page = json.loads((project / "pages" / "p.json").read_text())
    child_layout = page["sections"]["content"][0]["children"][0]["layout"]
    assert child_layout["widthMode"] == "hug"
    # The row's align is "center", not the CSS default "stretch" — its child's
    # cross axis (height) reads as Hug rather than Fill.
    assert child_layout["heightMode"] == "hug"


def test_the_mode_pass_reads_a_shell_bar_as_a_row_and_a_sidebar_as_a_column(project: Path) -> None:
    # `grow: 1` on each proves which axis is judged main per region; neither
    # bar's own align is the CSS-default "stretch" (header centers, sidebars
    # left-align — see `_SHELL_AXES` above, frozen at what the shell regions'
    # own `data-flow-align` states today), so the *other* axis reads Hug rather
    # than Fill either way.
    config = {
        "header": [_node("h", grow=1)],
        "leftSidebar": [_node("s", grow=1)],
    }
    (project / "config.json").write_text(json.dumps(config))

    run_pass(_write_mode_fields, _paths(project))

    # The content floor lands on whichever axis the region made main, which is
    # the same thing said twice: `grow` over an absent (`auto`) basis grew from
    # the content size, and Fill starts from zero.
    written = json.loads((project / "config.json").read_text())
    assert written["header"][0]["layout"] == {
        "widthMode": "fill",
        "heightMode": "hug",
        "grow": 1,
        "minWidth": "auto",
    }
    assert written["leftSidebar"][0]["layout"] == {
        "widthMode": "hug",
        "heightMode": "fill",
        "grow": 1,
        "minHeight": "auto",
    }


def test_a_component_root_gets_no_mode_but_its_children_do(project: Path) -> None:
    root = _node("root", direction="row", grow=0, basis="auto")
    root["children"] = [_node("inner")]
    (project / "components" / "c.json").write_text(json.dumps({"children": [root]}))

    result = run_pass(_write_mode_fields, _paths(project))

    written = json.loads((project / "components" / "c.json").read_text())["children"][0]
    assert "widthMode" not in written["layout"]  # untouched: axis unknown
    assert written["children"][0]["layout"] == {"widthMode": "hug", "heightMode": "fill"}
    assert any("no parent axis" in note for note in result.diagnostics)


# ══ pass 3: retiring every key the panel has no row for ══════════════════════


def retire(layout: dict, axis: str | None, align: str = "stretch") -> tuple[dict, list[str]]:
    notes: list[str] = []
    _retire_raw_keys_layout(layout, axis, align, "w", notes)
    return layout, notes


# ── margin ───────────────────────────────────────────────────────────────────


def test_margin_is_dropped_and_reported() -> None:
    layout, notes = retire({"margin": "8px", "width": "10px"}, "row")

    assert "margin" not in layout
    assert len(notes) == 1
    assert "dropped margin" in notes[0]


def test_every_margin_side_is_dropped_in_one_note() -> None:
    layout, notes = retire({"marginTop": "4px", "marginLeft": "8px", "width": "10px"}, "row")

    assert not [key for key in layout if key.startswith("margin")]
    assert "marginTop, marginLeft" in notes[0]


# ── the rule that keeps pixels where they are ────────────────────────────────


def test_shrink_is_dropped_only_once_a_mode_replaces_it() -> None:
    layout, _ = retire({"shrink": 0, "width": "154px"}, "row")

    assert layout == {"widthMode": "fixed", "width": "154px", "heightMode": "fill"}


def test_raw_flex_keys_go_where_no_axis_resolves() -> None:
    """Which axis `basis`/`shrink` size is the very thing that is unknown here, so
    a mode written against a guess would size the node wrongly while looking
    authored. The panel has no row for either key, so they go, reported."""
    layout, notes = retire({"shrink": 0, "basis": "154px"}, None)

    assert layout == {}
    assert "dropped basis, shrink" in notes[0]
    assert "no parent axis to read a mode against" in notes[0]


def test_a_grow_survives_where_no_axis_resolves() -> None:
    """Which axis owns the weight is the unknown here, so no read can call one
    stale: a `widthMode: fixed` rules the weight out only if Width is the main
    axis, and under a column parent the same node is a live Fill. The frontend
    spares the same nodes for the same reason — see `reachableSizeKeys` in
    `frontend/src/config/components/ui/LayoutFields/index.tsx` — though it no
    longer needs to know which axis is main to do it: a flex parent's own
    `data-flow-direction` resolves that in CSS regardless of what this
    migration step could determine."""
    layout, _ = retire({"grow": 2, "alignSelf": "stretch"}, None)
    assert layout == {"grow": 2}

    kept, notes = retire({"grow": 2, "widthMode": "fixed"}, None)
    assert kept == {"grow": 2, "widthMode": "fixed"}
    assert not any("dropped grow" in note for note in notes)


def test_a_grow_over_a_bound_basis_keeps_the_binding() -> None:
    """Fill renders as `flex: <grow> 1 0` — it has no basis of its own to carry
    the binding into, and `_write_main_mode`'s move onto the axis key is closed
    by the `grow`. Pass 1 already refuses this node; retiring it here would
    delete a `$var` the project has no other copy of."""
    bound = {"$var": {"path": "MyPLC:PanelWidth"}}
    layout, notes = retire({"grow": 1, "basis": bound}, "row")

    assert layout["grow"] == 1
    assert layout["basis"] == bound
    # The cross axis is unaffected — it reads off the parent's align, not `basis`.
    assert "widthMode" not in layout
    assert any("the basis is bound to a property source" in note for note in notes)


def test_a_bound_main_axis_becomes_fixed_over_the_same_binding() -> None:
    """No mode can be read from a `$var`, but Fixed leaves the axis's own key
    alone at render — so the binding keeps sizing the node, and nothing the panel
    cannot edit is left in the file."""
    bound = {"$var": {"path": "MyPLC:Width"}}
    layout, notes = retire({"shrink": 0, "width": bound}, "row")

    assert layout["widthMode"] == "fixed"
    assert layout["width"] == bound
    assert "shrink" not in layout
    assert any("Fixed over a bound length" in note for note in notes)


def test_a_bound_shrink_goes_with_the_mode_that_replaces_it() -> None:
    layout, notes = retire({"shrink": {"$var": {"path": "MyPLC:S"}}, "width": "154px"}, "row")

    assert layout["widthMode"] == "fixed"
    assert "shrink" not in layout
    assert any("dropped a bound shrink" in note for note in notes)


# ── promoting a literal basis, as pass 1 had it ──────────────────────────────


def test_a_literal_basis_outranks_width_and_becomes_the_fixed_length() -> None:
    layout, _ = retire({"basis": "154px", "width": "40px", "shrink": 0}, "row")

    assert layout["width"] == "154px"
    assert layout["widthMode"] == "fixed"
    assert "basis" not in layout


# ── a switch of lengths becomes a switch of modes ────────────────────────────


def test_a_bound_basis_becomes_a_mode_switch_beside_a_length_switch() -> None:
    basis = viewport_switch("auto", "calc(25% - 7.5px)", "154px")
    layout, _ = retire({"basis": basis, "shrink": 0}, "row")

    assert layout["width"] == basis
    assert layout["widthMode"] == viewport_switch("hug", "fixed", "fixed")
    assert "basis" not in layout
    assert "shrink" not in layout


def test_a_switch_with_a_non_literal_branch_becomes_fixed_over_the_switch() -> None:
    """One `$var` branch makes the whole switch unreadable as modes, so it is
    handled as any other binding: promoted onto `width` under Fixed."""
    basis = viewport_switch("auto", {"$var": {"path": "MyPLC:W"}}, "154px")
    layout, notes = retire({"basis": basis, "shrink": 0}, "row")

    assert layout["width"] == basis
    assert layout["widthMode"] == "fixed"
    assert "basis" not in layout
    assert "shrink" not in layout
    assert any("Fixed over a bound length" in note for note in notes)


def test_a_switch_with_no_default_still_converts() -> None:
    body = {"value": {"$viewport": {"field": "size"}}, "cases": [{"when": "phone", "then": "auto"}]}
    layout, _ = retire({"width": {"$switch": body}}, "row")

    assert layout["widthMode"] == {
        "$switch": {**body, "cases": [{"when": "phone", "then": "hug"}]}
    }


# ── the cross axis ───────────────────────────────────────────────────────────


def test_the_cross_axis_gets_its_mode_and_loses_align_self() -> None:
    layout, _ = retire({"alignSelf": "flex-start", "width": "10px"}, "row", align="stretch")

    assert layout["heightMode"] == "hug"
    assert "alignSelf" not in layout


def test_a_bound_cross_length_reads_as_fixed() -> None:
    bound = {"$var": {"path": "MyPLC:H"}}
    layout, notes = retire({"height": bound, "width": "10px"}, "row")

    assert layout["heightMode"] == "fixed"
    assert layout["height"] == bound
    assert any("Fixed over a bound length" in note for note in notes)


def test_a_bound_align_self_falls_back_to_the_parent_align() -> None:
    """What the binding resolves to cannot be read here and no row can keep it,
    so the axis reads as an unset `alignSelf` does: the parent's `align-items`."""
    bound = {"$var": {"path": "MyPLC:A"}}
    layout, notes = retire({"alignSelf": bound, "width": "10px"}, "row", align="stretch")

    assert layout["heightMode"] == "fill"
    assert "alignSelf" not in layout
    assert any("dropped a bound alignSelf" in note for note in notes)


# ── idempotency ──────────────────────────────────────────────────────────────


def test_a_fully_migrated_node_is_left_alone() -> None:
    layout, notes = retire({"widthMode": "fixed", "width": "10px", "heightMode": "fill"}, "row")

    assert layout == {"widthMode": "fixed", "width": "10px", "heightMode": "fill"}
    assert notes == []


def test_each_axis_is_guarded_on_its_own_mode() -> None:
    """A node pass 2 could only half-read — a main mode written, the cross one
    left bound — would keep its `alignSelf` forever under a guard that skipped
    the whole node once either mode was present."""
    layout, _ = retire({"widthMode": "fixed", "width": "10px", "alignSelf": "flex-start"}, "row")

    assert layout == {"widthMode": "fixed", "width": "10px", "heightMode": "hug"}


def test_the_retire_pass_is_idempotent() -> None:
    once, _ = retire({"shrink": 0, "basis": "154px", "alignSelf": "stretch"}, "row")
    twice, notes = retire(dict(once), "row")

    assert twice == once
    assert notes == []


def test_a_stale_grow_goes_with_a_mode_that_cannot_read_it() -> None:
    """`axisModePatch` clears the weight at render under any main-axis mode but
    Fill, and the panel shows its row only where it can be read — so a weight
    left under Fixed draws nothing and has nowhere to be reverted."""
    stale = {"widthMode": "fixed", "width": "10px", "grow": 2, "heightMode": "fill"}
    layout, notes = retire(stale, "row")

    assert "grow" not in layout
    assert any("dropped grow" in note for note in notes)


def test_a_grow_stays_under_a_mode_that_may_still_read_it() -> None:
    bound = {"$var": {"path": "MyPLC:Mode"}}
    kept, _ = retire({"widthMode": bound, "grow": 2, "heightMode": "fill"}, "row")
    assert kept["grow"] == 2

    # The cross axis never owned the weight, so its mode says nothing about it.
    cross, _ = retire({"heightMode": "hug", "grow": 2, "widthMode": "fill"}, "row")
    assert cross["grow"] == 2


# ── Fill must not be read as a fixed zero ────────────────────────────────────


def test_the_canonical_fill_shape_stays_fill() -> None:
    """`grow: 1, basis: "0"` is how Fill is spelled. Promoting that basis into
    `width` would pin the node to zero — the collapse this test guards."""
    layout, _ = retire({"grow": 1, "shrink": 1, "basis": "0", "minWidth": "0"}, "row")

    assert layout["widthMode"] == "fill"
    assert layout.get("width") != "0"
    assert layout["grow"] == 1
    assert "basis" not in layout


def test_a_weighted_fill_keeps_its_weight() -> None:
    layout, _ = retire({"grow": 2.5, "basis": "0"}, "row")

    assert layout["widthMode"] == "fill"
    assert layout["grow"] == 2.5


def test_a_bound_grow_over_a_zero_basis_is_still_fill() -> None:
    """Fill re-renders as exactly `grow` over `basis: "0"`, so naming the mode
    changes nothing the binding does — including where it resolves to 0."""
    grow = {"$var": {"path": "P:G"}}
    layout, _ = retire({"grow": grow, "basis": "0", "shrink": 0}, "row")

    assert layout["widthMode"] == "fill"
    assert layout["grow"] == grow
    assert "basis" not in layout
    assert "shrink" not in layout


def test_a_bound_grow_over_a_content_basis_fills_on_a_content_floor() -> None:
    layout, notes = retire({"grow": {"$var": {"path": "P:G"}}, "basis": "auto", "shrink": 0}, "row")

    assert layout["widthMode"] == "fill"
    assert layout["minWidth"] == "auto"
    assert "basis" not in layout
    assert any("content basis as Fill" in note for note in notes)


def test_growing_from_a_content_basis_fills_on_a_content_floor() -> None:
    """`grow` over `basis: auto` grows from the content size, which no mode
    spells: Fill starts every item at zero. `minHeight: auto` pins that content
    size back on as a floor, since `hmi.css` defaults the min to `0`."""
    layout, notes = retire({"grow": 1, "basis": "auto", "shrink": 0}, "column")

    assert layout["heightMode"] == "fill"
    assert layout["minHeight"] == "auto"
    assert layout["grow"] == 1
    assert "basis" not in layout
    assert any("content basis as Fill" in note for note in notes)


def test_grow_with_no_basis_at_all_gets_the_same_floor() -> None:
    """An absent basis is CSS `auto`, so it grows from content just the same."""
    layout, _ = retire({"grow": 1, "shrink": 0}, "column")

    assert layout["heightMode"] == "fill"
    assert layout["minHeight"] == "auto"


def test_an_authored_floor_is_not_overwritten() -> None:
    layout, _ = retire({"grow": 1, "basis": "auto", "minHeight": "40px"}, "column")

    assert layout["minHeight"] == "40px"
    assert layout["grow"] == 1


# ── the container half of a layout ───────────────────────────────────────────


def test_an_instance_loses_the_container_half_of_its_layout() -> None:
    """`ComponentRenderer` folds only `SELF_LAYOUT_KEYS`, and the panel renders an
    instance in `leaf` mode — so these keys rendered nothing and no row edited
    them."""
    notes: list[str] = []
    node = {
        "type": "$component:card",
        "layout": {
            "direction": "column",
            "gap": "8px",
            "padding": "4px",
            "radius": "2px",
            "align": "center",
            "width": "154px",
        },
    }

    retire_visit(node, ("row", "stretch"), "w", notes)

    assert node["layout"] == {"width": "154px", "widthMode": "fixed", "heightMode": "fill"}
    assert any("only a widget that flows its children" in note for note in notes)


def test_every_non_container_loses_the_container_half_of_its_layout() -> None:
    """`containerLayoutProps` has one caller. An `ImageContainer` hosts children
    and pins them to image slots; a leaf has none at all. Neither reads a
    container key, and neither is offered a row for one."""
    notes: list[str] = []
    node = {"type": "ImageContainer", "layout": {"gap": "8px", "padding": "4px"}}

    assert retire_visit(node, ("row", "stretch"), "w", notes) is True
    assert "gap" not in node["layout"]
    assert "padding" not in node["layout"]


def test_a_container_keeps_the_container_half_of_its_layout() -> None:
    notes: list[str] = []
    node = {"type": "Container", "layout": {"direction": "column", "gap": "8px"}}

    retire_visit(node, ("row", "stretch"), "w", notes)

    assert node["layout"]["direction"] == "column"
    assert node["layout"]["gap"] == "8px"


def test_a_widget_the_project_owns_keeps_the_container_half() -> None:
    """`containerLayoutProps` is on the custom-widget SDK, so a project widget
    that hosts children can read every one of these keys. This step cannot see
    its source, so it cannot call them inert."""
    notes: list[str] = []
    node = {"type": "TankLevel", "layout": {"direction": "column", "gap": "8px"}}

    retire_visit(
        node, ("row", "stretch"), "w", notes, _WidgetTypes(TYPES.flows, frozenset({"TankLevel"}))
    )

    assert node["layout"]["direction"] == "column"
    assert node["layout"]["gap"] == "8px"
    assert any("a widget this project owns" in note for note in notes)


def test_a_sized_container_keeps_the_container_half() -> None:
    notes: list[str] = []
    node = {"type": "Container", "layout": {"direction": "column", "gap": "8px", "width": "10px"}}

    retire_visit(node, ("row", "stretch"), "w", notes)

    assert node["layout"]["direction"] == "column"
    assert node["layout"]["gap"] == "8px"


# ── the pass, over a project tree ────────────────────────────────────────────


def test_the_retire_pass_walks_pages_and_reports_what_it_changed(tmp_path: Path) -> None:
    pages = tmp_path / "pages"
    pages.mkdir()
    (pages / "p.json").write_text(
        json.dumps(
            {
                "sections": {
                    "content": [
                        {
                            "id": "row",
                            "type": "Container",
                            "layout": {"direction": "row"},
                            "children": [
                                {"id": "kid", "layout": {"margin": "8px", "shrink": 0, "basis": "20px"}}
                            ],
                        }
                    ]
                }
            }
        )
    )
    paths = {"config": tmp_path / "config.json", "pages": pages, "components": tmp_path / "none"}

    result = run_pass(_retire_raw_keys, paths)

    kid = json.loads((pages / "p.json").read_text())["sections"]["content"][0]["children"][0]
    assert kid["layout"]["widthMode"] == "fixed"
    assert kid["layout"]["width"] == "20px"
    assert "margin" not in kid["layout"]
    assert "shrink" not in kid["layout"]
    assert result.files_changed == ["pages/p.json"]


def test_a_page_file_that_is_not_an_object_is_skipped(tmp_path: Path) -> None:
    """A stray export or hand-written fixture under `pages/` must not abort the
    step: the coordinator turns any exception into a `MigrationFailedError` and
    the backend then refuses to start on a project it could have migrated."""
    pages = tmp_path / "pages"
    pages.mkdir()
    (pages / "stray.json").write_text(json.dumps(["not", "a", "page"]))
    (pages / "p.json").write_text(
        json.dumps({"sections": {"content": [{"id": "kid", "layout": {"margin": "8px"}}]}})
    )
    paths = {"config": tmp_path / "config.json", "pages": pages, "components": tmp_path / "none"}

    result = run_pass(_retire_raw_keys, paths)

    assert result.files_changed == ["pages/p.json"]


def test_a_component_instance_is_migrated_like_any_other_node(tmp_path: Path) -> None:
    """An instance's self keys fold onto the definition's first root, which
    renders under the instance's own parent flow — so the mode written here
    resolves against the axis those keys were already resolving against, and the
    translation is not the rendering change a bare drop would be."""
    pages = tmp_path / "pages"
    pages.mkdir()
    (pages / "p.json").write_text(
        json.dumps(
            {
                "sections": {
                    "content": [
                        {
                            "id": "card",
                            "type": "$component:card",
                            "layout": {"basis": "154px", "grow": 0, "shrink": 0, "margin": "4px"},
                        }
                    ]
                }
            }
        )
    )
    paths = {"config": tmp_path / "config.json", "pages": pages, "components": tmp_path / "none"}

    run_pass(_retire_raw_keys, paths)

    layout = json.loads((pages / "p.json").read_text())["sections"]["content"][0]["layout"]
    # A page section stacks its children in a column, so that basis was a height.
    assert layout["heightMode"] == "fixed"
    assert layout["height"] == "154px"
    assert not [key for key in ("basis", "shrink", "margin") if key in layout]


def write_project(tmp_path: Path, page: dict, definitions: dict[str, dict]) -> dict:
    """A project of one page plus named component definitions, as the step's
    `paths` mapping."""
    pages = tmp_path / "pages"
    pages.mkdir()
    (pages / "p.json").write_text(json.dumps(page))
    components = tmp_path / "components"
    components.mkdir()
    for name, definition in definitions.items():
        (components / f"{name}.json").write_text(json.dumps(definition))
    return {"config": tmp_path / "config.json", "pages": pages, "components": components}


def instance(component: str, node_id: str | None = None) -> dict:
    return {"id": node_id or component, "type": f"$component:{component}", "layout": {}}


def container(node_id: str, direction: str, children: list[dict]) -> dict:
    return {
        "id": node_id,
        "type": "Container",
        "layout": {"direction": direction},
        "children": children,
    }


def definition_with_root_basis() -> dict:
    return {"children": [{"id": "root", "layout": {"basis": "154px", "shrink": 0}}]}


def test_a_definition_root_takes_the_flow_its_instances_sit_under(tmp_path: Path) -> None:
    """A root has no axis locally, but the instances that place it are in the same
    project — so the pass reads one off them rather than leaving the raw keys."""
    page = {"sections": {"content": [container("row", "row", [instance("card")])]}}
    paths = write_project(tmp_path, page, {"card": definition_with_root_basis()})

    run_pass(_retire_raw_keys, paths)

    root = json.loads((paths["components"] / "card.json").read_text())["children"][0]
    assert root["layout"]["widthMode"] == "fixed"
    assert root["layout"]["width"] == "154px"
    assert "basis" not in root["layout"]


def test_a_definition_whose_instances_disagree_loses_its_raw_keys(tmp_path: Path) -> None:
    """One instance in a row and one in a column: the root's `basis` is a width in
    the first and a height in the second, and no single rewrite is both. Nothing
    is guessed — the keys go, reported, and the panel's own rows are what puts a
    mode back."""
    page = {
        "sections": {
            "content": [
                container("row", "row", [instance("card")]),
                container("col", "column", [instance("card", "card2")]),
            ]
        }
    }
    paths = write_project(tmp_path, page, {"card": definition_with_root_basis()})

    result = run_pass(_retire_raw_keys, paths)

    root = json.loads((paths["components"] / "card.json").read_text())["children"][0]
    assert root["layout"] == {}
    assert any("two different flows" in note for note in result.diagnostics)


def test_a_definition_with_no_instances_loses_its_raw_keys(tmp_path: Path) -> None:
    paths = write_project(
        tmp_path,
        {"sections": {"content": []}},
        {"card": definition_with_root_basis()},
    )

    run_pass(_retire_raw_keys, paths)

    root = json.loads((paths["components"] / "card.json").read_text())["children"][0]
    assert root["layout"] == {}


# ══ the whole step, where the passes have to compose ═════════════════════════


def test_the_step_carries_a_raw_flex_layout_all_the_way_to_a_mode(project: Path) -> None:
    """The three passes in sequence: pass 1 promotes the `basis` onto `width` and
    pins `shrink`, pass 2 reads Fixed off it, pass 3 sweeps the margin."""
    row = _node("row", direction="row")
    row["children"] = [_node("kid", grow=0, shrink=1, basis="154px", margin="8px")]
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    result = migrate_size_modes(_paths(project), project)

    page = json.loads((project / "pages" / "p.json").read_text())
    kid = page["sections"]["content"][0]["children"][0]["layout"]
    assert kid == {"width": "154px", "widthMode": "fixed", "heightMode": "fill"}
    assert result.files_changed == ["pages/p.json"]


def test_the_step_leaves_a_switch_sized_node_fully_moded(project: Path) -> None:
    """Passes 1 and 2 both bail on a bound `basis`; pass 3 is what reads the
    switch's branches and leaves nothing the panel cannot edit."""
    basis = viewport_switch("auto", "50%", "154px")
    row = _node("row", direction="row")
    row["children"] = [_node("kid", basis=basis, shrink=0)]
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    migrate_size_modes(_paths(project), project)

    page = json.loads((project / "pages" / "p.json").read_text())
    kid = page["sections"]["content"][0]["children"][0]["layout"]
    assert kid["width"] == basis
    assert kid["widthMode"] == viewport_switch("hug", "fixed", "fixed")
    assert not [key for key in ("basis", "shrink", "alignSelf") if key in kid]


def test_the_step_is_idempotent(project: Path) -> None:
    row = _node("row", direction="row")
    row["children"] = [_node("kid", grow=0, shrink=1, basis="154px", alignSelf="flex-start")]
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    migrate_size_modes(_paths(project), project)
    once = (project / "pages" / "p.json").read_text()
    result = migrate_size_modes(_paths(project), project)

    assert (project / "pages" / "p.json").read_text() == once
    assert result.files_changed == []


@pytest.mark.parametrize(
    "basis, floored",
    [("100px", True), ("50%", True), (None, True), ("0", False)],
)
def test_the_step_floors_a_fill_that_grew_from_a_content_basis(
    project: Path, basis: str | None, floored: bool
) -> None:
    """The content floor is pass 3's rule, and pass 2 has to write it too.

    Pass 2 reads Fill off a positive `grow` and drops the `basis` with it, so a
    node that reached pass 3 already moded took the branch that never floors —
    which is how the rule came to be stated in one pass and fire in neither, and
    how `grow: 1` over a 100px basis migrated to a Fill starting at zero.
    Only `basis: "0"` is exempt: Fill re-renders as exactly those two keys.
    """
    child = _node("kid", grow=1, shrink=1) if basis is None else _node("kid", grow=1, shrink=1, basis=basis)
    row = _node("row", direction="row")
    row["children"] = [child]
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    result = migrate_size_modes(_paths(project), project)

    kid = json.loads((project / "pages" / "p.json").read_text())
    kid = kid["sections"]["content"][0]["children"][0]["layout"]
    assert kid["widthMode"] == "fill"
    assert (kid.get("minWidth") == "auto") is floored
    assert any("floor keeps the content size" in note for note in result.diagnostics) is floored


def test_the_step_reports_the_end_state_not_the_first_pass(project: Path) -> None:
    """Every pass reads what the one before it wrote, so the result a run reports
    is the end state — which is why a dry run stages a throwaway copy and lets
    the step write to it for real (see `test_project_migrations.py`) rather than
    asking the step to predict itself."""
    row = _node("row", direction="row")
    row["children"] = [_node("kid", grow=0, shrink=1, basis="154px")]
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    result = migrate_size_modes(_paths(project), project)

    # Pass 1 alone reports no mode at all; only the full chain names one.
    assert result.files_changed == ["pages/p.json"]
    assert not any("left size mode undetermined" in note for note in result.diagnostics)


def test_the_step_reads_the_custom_widgets_folder_from_the_project_not_the_staging(
    project: Path, tmp_path: Path
) -> None:
    """A dry run stages the targets somewhere else entirely, so the folder that
    says which widgets this project owns can only be found from the real root."""
    (project / "custom-widgets" / "Process" / "TankLevel").mkdir(parents=True)
    (project / "custom-widgets" / "Process" / "TankLevel" / "index.tsx").write_text(
        "export default function TankLevel() { return null; }\n"
    )
    staged = tmp_path / "staged"
    staged.mkdir()
    (staged / "pages").mkdir()
    (staged / "components").mkdir()
    (staged / "config.json").write_text(json.dumps({"header": [], "pages": []}))
    node = {"type": "TankLevel", "layout": {"direction": "column", "gap": "8px"}}
    (staged / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [node]}}))

    result = migrate_size_modes(_paths(staged), project)

    page = json.loads((staged / "pages" / "p.json").read_text())
    assert page["sections"]["content"][0]["layout"]["gap"] == "8px"
    assert any("a widget this project owns" in note for note in result.diagnostics)


@pytest.mark.parametrize("template", ["project-seed", "project-example"])
def test_bundled_templates_are_already_in_the_current_format(template: str, tmp_path: Path) -> None:
    """A new project is stamped current straight from its template, never
    migrated, so a template this step would still change would ship broken."""
    source = Path(__file__).resolve().parents[2] / template
    for name in ("config.json", "pages", "components"):
        if (source / name).is_dir():
            shutil.copytree(source / name, tmp_path / name)
        elif (source / name).exists():
            shutil.copy2(source / name, tmp_path / name)

    result = migrate_size_modes(_paths(tmp_path), tmp_path)

    assert result.files_changed == []
