"""Tests for the 5 → 6 step that collapses `padding` into the four sides.

A side already present always outranked the shorthand at render, so filling in
whichever of the four sides a node doesn't already carry and dropping the
shorthand reproduces exactly what was rendering before. A literal shorthand is
parsed by the CSS 1/2/3/4-value box rule first — copying the raw string onto
every longhand instead would go invalid wherever the shorthand held more than
one value, since a longhand like `padding-top` cannot itself take a
multi-value string. A `$switch` of literal shorthands is read the same way,
branch by branch, into four `$switch`es of sides. A bare `$var`, any other
property source (`$if` included), a `$switch` with an unreadable branch, or a
literal string this step's own space-split parse cannot make sense of (a space
inside a function call, `calc(8px + 2px) 4px`) is genuinely unknowable —
copying that carries the same multi-value risk with no way to rule it out, so
it is dropped and reported instead, same as the 4 → 5 step reports its own
unresolvable flex keys.
"""

import json
import shutil
from pathlib import Path

import pytest
from core.migration_padding import _expand_padding_layout, migrate_padding


def _node(node_id: str, **layout) -> dict:
    return {"id": node_id, "type": "Container", "layout": layout, "children": []}


def _expand(layout: dict) -> tuple[bool, list[str]]:
    """Unit-test shorthand for `_expand_padding_layout`, supplying a throwaway
    `where`/`notes` and handing the notes back for inspection."""
    notes: list[str] = []
    changed = _expand_padding_layout(layout, "node", notes)
    return changed, notes


def _switch(phone, tablet, default) -> dict:
    return {
        "$switch": {
            "value": {"$viewport": {"field": "size"}},
            "cases": [{"when": "phone", "then": phone}, {"when": "tablet", "then": tablet}],
            "default": default,
        }
    }


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "pages").mkdir()
    (tmp_path / "components").mkdir()
    (tmp_path / "config.json").write_text(json.dumps({"header": [], "pages": []}))
    return tmp_path


def _paths(root: Path) -> dict[str, Path]:
    return {"config": root / "config.json", "pages": root / "pages", "components": root / "components"}


# ── unit: _expand_padding_layout ──────────────────────────────────────────────


def test_a_shorthand_alone_fills_in_all_four_sides():
    layout = {"padding": "8px"}
    changed, notes = _expand(layout)
    assert changed is True
    assert notes == []
    assert layout == {
        "paddingTop": "8px",
        "paddingRight": "8px",
        "paddingBottom": "8px",
        "paddingLeft": "8px",
    }


@pytest.mark.parametrize(
    "shorthand, expected",
    [
        ("8px", {"paddingTop": "8px", "paddingRight": "8px", "paddingBottom": "8px", "paddingLeft": "8px"}),
        (
            "8px 16px",
            {"paddingTop": "8px", "paddingRight": "16px", "paddingBottom": "8px", "paddingLeft": "16px"},
        ),
        (
            "12px 0 0",
            {"paddingTop": "12px", "paddingRight": "0", "paddingBottom": "0", "paddingLeft": "0"},
        ),
        (
            "1px 2px 3px 4px",
            {"paddingTop": "1px", "paddingRight": "2px", "paddingBottom": "3px", "paddingLeft": "4px"},
        ),
    ],
)
def test_a_multi_value_shorthand_is_parsed_by_the_css_box_rule_not_copied_whole(shorthand, expected):
    """A longhand like `padding-top` cannot itself take a multi-value string —
    copying `"8px 16px"` onto all four sides verbatim would go invalid on every
    side but the one it happened to render correctly on before."""
    layout = {"padding": shorthand}
    _expand(layout)
    assert layout == expected


def test_an_explicit_side_keeps_its_own_value_over_the_shorthand():
    layout = {"padding": "8px", "paddingTop": "20px"}
    _expand(layout)
    assert layout == {
        "paddingTop": "20px",
        "paddingRight": "8px",
        "paddingBottom": "8px",
        "paddingLeft": "8px",
    }


def test_an_explicit_side_keeps_its_own_value_over_a_multi_value_shorthand():
    layout = {"padding": "8px 16px", "paddingTop": "20px"}
    _expand(layout)
    assert layout == {
        "paddingTop": "20px",
        "paddingRight": "16px",
        "paddingBottom": "8px",
        "paddingLeft": "16px",
    }


def test_all_four_sides_already_explicit_just_drops_the_shorthand():
    layout = {
        "padding": "8px",
        "paddingTop": "1px",
        "paddingRight": "2px",
        "paddingBottom": "3px",
        "paddingLeft": "4px",
    }
    _expand(layout)
    assert layout == {
        "paddingTop": "1px",
        "paddingRight": "2px",
        "paddingBottom": "3px",
        "paddingLeft": "4px",
    }


def test_a_switch_of_literal_shorthands_is_read_branch_by_branch():
    """Every branch is in the file, same as a `$switch` of lengths in the
    4 → 5 step — read it rather than falling back to the bound-and-unknowable
    path a `$var` has no choice but to take."""
    layout = {"padding": _switch("4px", "8px 16px", "12px 0 0")}
    changed, notes = _expand(layout)
    assert changed is True
    assert notes == []
    assert layout == {
        "paddingTop": _switch("4px", "8px", "12px"),
        "paddingRight": _switch("4px", "16px", "0"),
        "paddingBottom": _switch("4px", "8px", "0"),
        "paddingLeft": _switch("4px", "16px", "0"),
    }


def test_a_switch_of_shorthands_still_respects_an_explicit_side():
    layout = {"padding": _switch("4px", "8px", "12px"), "paddingTop": "99px"}
    _expand(layout)
    assert layout["paddingTop"] == "99px"
    assert layout["paddingRight"] == _switch("4px", "8px", "12px")


def test_a_switch_with_an_unreadable_branch_is_dropped_and_reported():
    """A branch bound to another property source (or anything else this step
    cannot read as a literal string) makes the whole switch as unknowable as a
    bare `$var` — there is no file-visible value to parse for that branch."""
    layout = {"padding": _switch("4px", {"$var": {"path": "MyPLC:Pad"}}, "12px")}
    changed, notes = _expand(layout)
    assert changed is True
    assert layout == {}
    assert len(notes) == 1
    assert "dropped padding" in notes[0]


def test_a_bare_bound_shorthand_is_dropped_and_reported_not_copied():
    """Copying a `$var`'s wrapper onto all four sides — as an earlier version
    of this step did — silently blanks every side if the binding ever resolves
    to a multi-value string, since a longhand can't take one. Unknowable at
    migration time, so it is dropped like the 4 → 5 step's own unresolvable
    flex keys, not guessed at."""
    bound = {"$var": {"path": "MyPLC:Padding"}}
    layout = {"padding": bound, "paddingTop": "20px"}
    changed, notes = _expand(layout)
    assert changed is True
    assert layout == {"paddingTop": "20px"}
    assert len(notes) == 1
    assert "node: dropped padding" in notes[0]


def test_an_if_bound_shorthand_is_dropped_and_reported_not_copied():
    """`$if` declares the same `any` result type a shorthand does, so it is
    authorable on the pre-migration padding row same as `$var`/`$switch` — but
    this step only splits a `$switch` of literal branches, so any other
    property source is exactly as unreadable as a bare `$var`."""
    bound = {"$if": {"condition": {"$var": {"path": "MyPLC:Wide"}}, "true": "8px", "false": "16px"}}
    layout = {"padding": bound}
    changed, notes = _expand(layout)
    assert changed is True
    assert layout == {}
    assert len(notes) == 1
    assert "dropped padding" in notes[0]


def test_a_shorthand_with_a_space_inside_a_function_call_is_dropped_not_corrupted():
    """A naive space-split would misread `calc(8px + 2px) 4px` as four
    unrelated tokens (`calc(8px`, `+`, `2px)`, `4px`), corrupting a value that
    rendered correctly before this step ever touched it. Safer to drop and
    report, matching how any other value this step cannot read is handled."""
    layout = {"padding": "calc(8px + 2px) 4px"}
    changed, notes = _expand(layout)
    assert changed is True
    assert layout == {}
    assert len(notes) == 1
    assert "dropped padding" in notes[0]


def test_no_shorthand_is_a_no_op():
    layout = {"paddingTop": "8px"}
    changed, notes = _expand(layout)
    assert changed is False
    assert notes == []
    assert layout == {"paddingTop": "8px"}


# ── project-level ─────────────────────────────────────────────────────────────


def test_the_step_expands_a_shorthand_only_node(project: Path):
    row = _node("row", padding="8px")
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    result = migrate_padding(_paths(project), project)

    page = json.loads((project / "pages" / "p.json").read_text())
    layout = page["sections"]["content"][0]["layout"]
    assert layout == {
        "paddingTop": "8px",
        "paddingRight": "8px",
        "paddingBottom": "8px",
        "paddingLeft": "8px",
    }
    assert result.files_changed == ["pages/p.json"]
    assert result.diagnostics == []


def test_the_step_leaves_a_sides_only_node_untouched(project: Path):
    row = _node("row", paddingTop="8px", paddingLeft="4px")
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    result = migrate_padding(_paths(project), project)

    page = json.loads((project / "pages" / "p.json").read_text())
    layout = page["sections"]["content"][0]["layout"]
    assert layout == {"paddingTop": "8px", "paddingLeft": "4px"}
    assert result.files_changed == []


def test_the_step_keeps_an_explicit_side_over_a_mixed_shorthand(project: Path):
    row = _node("row", padding="8px", paddingTop="20px")
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    migrate_padding(_paths(project), project)

    page = json.loads((project / "pages" / "p.json").read_text())
    layout = page["sections"]["content"][0]["layout"]
    assert layout == {
        "paddingTop": "20px",
        "paddingRight": "8px",
        "paddingBottom": "8px",
        "paddingLeft": "8px",
    }


def test_the_step_reads_a_switch_shorthand_branch_by_branch(project: Path):
    row = _node("row", padding=_switch("4px", "8px 16px", "12px 0 0"))
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    result = migrate_padding(_paths(project), project)

    page = json.loads((project / "pages" / "p.json").read_text())
    layout = page["sections"]["content"][0]["layout"]
    assert layout["paddingTop"] == _switch("4px", "8px", "12px")
    assert layout["paddingLeft"] == _switch("4px", "16px", "0")
    assert result.diagnostics == []


def test_the_step_drops_and_reports_a_bare_bound_shorthand(project: Path):
    bound = {"$var": {"path": "MyPLC:Padding"}}
    row = _node("row", padding=bound)
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    result = migrate_padding(_paths(project), project)

    page = json.loads((project / "pages" / "p.json").read_text())
    layout = page["sections"]["content"][0]["layout"]
    assert "padding" not in layout
    assert not any(key.startswith("padding") for key in layout)
    assert len(result.diagnostics) == 1
    assert "dropped padding" in result.diagnostics[0]
    assert result.files_changed == ["pages/p.json"]


def test_the_step_recurses_through_children_shell_and_dialogs(project: Path):
    child = _node("kid", padding="4px")
    parent = _node("row", padding="8px")
    parent["children"] = [child]
    config = {
        "header": [_node("h", padding="2px")],
        "pages": [],
        "dialogs": [{"id": "d1", "widgets": [_node("dw", padding="6px")]}],
    }
    (project / "config.json").write_text(json.dumps(config))
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [parent]}}))

    result = migrate_padding(_paths(project), project)

    page = json.loads((project / "pages" / "p.json").read_text())
    parent_layout = page["sections"]["content"][0]["layout"]
    child_layout = page["sections"]["content"][0]["children"][0]["layout"]
    assert parent_layout["paddingTop"] == "8px"
    assert child_layout["paddingTop"] == "4px"

    saved_config = json.loads((project / "config.json").read_text())
    assert saved_config["header"][0]["layout"]["paddingTop"] == "2px"
    assert saved_config["dialogs"][0]["widgets"][0]["layout"]["paddingTop"] == "6px"
    assert set(result.files_changed) == {"config.json", "pages/p.json"}


def test_the_step_recurses_through_component_definitions(project: Path):
    definition = {"children": [_node("root", padding="8px")]}
    (project / "components" / "c1.json").write_text(json.dumps(definition))

    result = migrate_padding(_paths(project), project)

    saved = json.loads((project / "components" / "c1.json").read_text())
    assert saved["children"][0]["layout"]["paddingTop"] == "8px"
    assert result.files_changed == ["components/c1.json"]


def test_the_step_is_idempotent(project: Path):
    row = _node("row", padding="8px", paddingTop="20px")
    (project / "pages" / "p.json").write_text(json.dumps({"sections": {"content": [row]}}))

    migrate_padding(_paths(project), project)
    once = (project / "pages" / "p.json").read_text()
    result = migrate_padding(_paths(project), project)

    assert (project / "pages" / "p.json").read_text() == once
    assert result.files_changed == []


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

    result = migrate_padding(_paths(tmp_path), tmp_path)

    assert result.files_changed == []
