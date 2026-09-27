"""Type checks on what a value is, where it comes from and what reads it.

Covers the diagnostics that judge a value's type against the field it fills:
`source-type`, `var-index`, `literal-type` / `literal-format`, component
instance values, `componentprop-*`, `widgetprop-*`, the values inside actions
and the write/toggle target checks. Every one of them is non-blocking — it lands
in `report.warnings`, never in `report.findings` — except the bare-literal
mismatch that was already a rejected write.
"""

from dataclasses import replace

import pytest
from core.validation import ValidationContext
from core.validation.report import ValidationReport
from core.validation.structure import (
    _validate_action,
    _validate_property_value,
    ctx_for_page_group,
    validate_page,
    validate_page_node_events,
    validate_widget_node,
)

_FLOAT = {"kind": "scalar", "base": "Float", "array": False}
_INTEGER = {"kind": "scalar", "base": "Integer", "array": False}
_BOOLEAN = {"kind": "scalar", "base": "Boolean", "array": False}

_MANIFEST = {
    "version": 2,
    "builtin": {
        "Label": {"name": "Label", "schema": {"text": {"type": "string"}, "size": {"type": "integer"}}},
        "Dropdown": {
            "name": "Dropdown",
            "schema": {"options": {"type": "option-list"}},
            "exportedProperties": [
                {"key": "selectedValue", "label": "Selected", "type": "string"},
                {"key": "row", "label": "Row", "type": "Struct",
                 "structSchema": [{"name": "count", "type": "Integer"}]},
                {"key": "raw", "label": "Raw"},
            ],
        },
        "Box": {"name": "Box", "schema": {}, "exportedProperties": []},
    },
    "custom": {"Other/Legacy": {"name": "Legacy", "schema": {}}},
}


@pytest.fixture()
def ctx() -> ValidationContext:
    return ValidationContext(
        widget_schemas=_MANIFEST,
        datasource_registry={
            "PLC": {
                "Speed": _FLOAT,
                "Count": _INTEGER,
                "Run": _BOOLEAN,
                "Flags": {"kind": "scalar", "base": "Boolean", "array": True, "length": 4},
                "Levels": {"kind": "scalar", "base": "Float", "array": True},
                "Motor": {"kind": "struct", "name": "Motor", "array": False, "fields": ["Speed"]},
                "Motor/Speed": _FLOAT,
            },
        },
        datasource_writable={"PLC": {"Speed": False, "Count": True, "Run": True, "Flags": True}},
        translation_keys=frozenset({"app.title"}),
    )


def _codes(report: ValidationReport) -> list[str]:
    assert report.findings == []
    return [w.code for w in report.warnings]


def _value(ctx, value, field, path="/p") -> ValidationReport:
    report = ValidationReport()
    _validate_property_value(value, field, ctx, path, report)
    return report


def _action(ctx, action) -> ValidationReport:
    report = ValidationReport()
    _validate_action(action, ctx, "/a", report)
    return report


# ── source-type ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "field"),
    [
        ({"$alarmCount": {"filter": "all"}}, {"type": "boolean"}),
        ({"$random": {"min": 0, "max": 1}}, {"type": "color"}),
        ({"$languages": {}}, {"type": "string"}),
        ({"$time": {}}, {"type": "integer"}),
        ({"$page": {"field": "title"}}, {"type": "integer"}),
        ({"$viewport": {"field": "size"}}, {"type": "Integer"}),
        ({"$recipe": {"type": "r", "field": "activeName"}}, {"type": "boolean"}),
        # A produced type fits its own field type only.
        ({"$compare": {"left": 1, "operator": ">", "right": 0}}, {"type": "string"}),
        ({"$formula": {"expression": "1"}}, {"type": "integer"}),
        ({"$alarmCount": {"filter": "all"}}, {"type": "float"}),
        ({"$stringExpr": {"template": "x"}}, {"type": "datetime"}),
        ({"$recipe": {"type": "r", "field": "loaded"}}, {"type": "string"}),
    ],
)
def test_a_fixed_type_source_the_field_does_not_take(ctx, value, field):
    report = _value(ctx, value, field)
    assert _codes(report) == ["source-type"]
    assert report.warnings[0].severity == "error"


@pytest.mark.parametrize(
    ("value", "field"),
    [
        ({"$alarmCount": {"filter": "all"}}, {"type": "integer"}),
        ({"$random": {"min": 0, "max": 1}}, {"type": "integer"}),
        ({"$compare": {"left": 1, "operator": ">", "right": 0}}, {"type": "boolean"}),
        # A number fills a duration.
        ({"$formula": {"expression": "1"}}, {"type": "duration"}),
        ({"$alarmCount": {"filter": "all"}}, {"type": "duration"}),
        ({"$time": {}}, {"type": "string"}),
        # Its `format` decides whether the text is a date, a time or both.
        ({"$time": {}}, {"type": "date"}),
        ({"$time": {"format": "HH:mm:ss"}}, {"type": "time"}),
        ({"$page": {"field": "depth"}}, {"type": "integer"}),
        ({"$user": {"field": "userList"}}, {"type": "string"}),
        ({"$user": {"field": "userList"}}, {"type": "option-list"}),
        # A choice the table does not know is not judged.
        ({"$page": {"field": "somethingNew"}}, {"type": "integer"}),
        # Any of a union's types will do.
        ({"$alarmCount": {"filter": "all"}}, {"type": ["string", "integer"]}),
        ({"$viewport": {"field": "width"}}, {"type": ["float", "integer"]}),
        # Sources that carry any type, and fields with no source rules.
        ({"$static": True}, {"type": "boolean"}),
        ({"$alarmCount": {"filter": "all"}}, {"type": "actions"}),
        ({"$alarmCount": {"filter": "all"}}, {"type": "integer[]"}),
        ({"$alarmCount": {"filter": "all"}}, None),
    ],
)
def test_a_source_the_field_takes_is_silent(ctx, value, field):
    assert _codes(_value(ctx, value, field)) == []


def test_a_branch_is_judged_on_the_propertys_type_and_the_condition_as_a_boolean(ctx):
    report = _value(
        ctx, {"$if": {"condition": {"$alarmCount": {}}, "true": {"$alarmCount": {}}, "false": 0}},
        {"type": "integer"},
    )
    assert _codes(report) == ["source-type"]
    assert report.warnings[0].path == "/p/$if/condition"


# ── var-index ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "ref",
    [
        {"path": "PLC:Speed", "index": 0},
        {"path": "PLC:Flags", "index": -1},
        {"path": "PLC:Flags", "index": "2"},
        {"path": "PLC:Flags", "index": 1.5},
        {"path": "PLC:Flags", "index": 4},
    ],
)
def test_an_index_that_names_no_element(ctx, ref):
    report = _value(ctx, {"$var": ref}, {"type": "boolean"})
    assert _codes(report) == ["var-index"]
    assert report.warnings[0].severity == "error"


@pytest.mark.parametrize(
    "ref",
    [
        {"path": "PLC:Flags", "index": 3},
        {"path": "PLC:Levels", "index": 99},
        {"path": "PLC:Flags", "index": 9, "repeatIndex": True},
    ],
)
def test_an_index_inside_the_array_is_silent(ctx, ref):
    field = {"type": "float"} if "Levels" in ref["path"] else {"type": "boolean"}
    # A Repeat index takes the copy's element, whatever `index` still says.
    in_repeater = replace(ctx, repeat_scope=True)
    assert _codes(_value(in_repeater, {"$var": ref}, field)) == []


# ── literals ─────────────────────────────────────────────────────────────────


def test_a_bare_literal_fits_any_scalar_of_a_union(ctx):
    report = _value(ctx, "motor", {"type": ["string", "integer", "float"]})
    assert report.findings == [] and report.warnings == []
    assert _value(ctx, 3, {"type": ["string", "integer"]}).findings == []


def test_a_bare_literal_that_fits_nothing_is_still_rejected(ctx):
    report = _value(ctx, True, {"type": ["integer", "float"]})
    assert [f.message for f in report.findings] == ["expected Integer or Float, got Boolean"]


def test_an_array_literal_is_checked_element_by_element(ctx):
    assert _codes(_value(ctx, [1, 2], {"type": "integer[]"})) == []
    report = _value(ctx, [1, "two"], {"type": "integer[]"})
    assert _codes(report) == ["literal-type"]
    assert report.warnings[0].severity == "error"
    # An array was a rejected write on a scalar field, and still is — unless
    # the field also lists an array type it fits.
    assert _value(ctx, ["a"], {"type": "string"}).findings
    assert _codes(_value(ctx, ["a"], {"type": ["string", "string[]"]})) == []
    # An editor kind first: its array types filter bindings, not its rows.
    rows = [{"label": "Espresso", "value": "espresso"}]
    assert _codes(_value(ctx, rows, {"type": ["option-list", "string[]", "integer[]"]})) == []


def test_a_static_payload_is_type_checked_without_blocking(ctx):
    report = _value(ctx, {"$static": "fast"}, {"type": "integer"})
    assert _codes(report) == ["literal-type"]
    assert _codes(_value(ctx, {"$static": 4}, {"type": "integer"})) == []
    assert _codes(_value(ctx, {"$static": [1, "x"]}, {"type": "integer[]"})) == ["literal-type"]


@pytest.mark.parametrize(
    ("value", "field_type"),
    [
        ("2026-13-40", "date"),
        ("16/06/2026", "date"),
        ("yesterday", "datetime"),
        ("25:00", "time"),
        ("five minutes", "duration"),
    ],
)
def test_a_temporal_literal_not_in_iso_form(ctx, value, field_type):
    report = _value(ctx, value, {"type": field_type})
    assert _codes(report) == ["literal-format"]
    assert report.warnings[0].severity == "warning"
    assert _codes(_value(ctx, {"$static": value}, {"type": field_type})) == ["literal-format"]


@pytest.mark.parametrize(
    ("value", "field"),
    [
        ("2026-06-16", {"type": "date"}),
        ("2026-06-16T14:30:00Z", {"type": "datetime"}),
        ("2026-06-16T14:30", {"type": "datetime"}),
        ("14:30:00", {"type": "time"}),
        ("PT1H30M", {"type": "duration"}),
        ("5400", {"type": "duration"}),
        (5400, {"type": "duration"}),
        ("", {"type": "date"}),
        # A text interpretation of the field makes any string fine.
        ("soon", {"type": ["string", "date"]}),
    ],
)
def test_an_iso_temporal_literal_is_silent(ctx, value, field):
    assert _codes(_value(ctx, value, field)) == []


# ── component instances ──────────────────────────────────────────────────────


@pytest.fixture()
def card_ctx(ctx) -> ValidationContext:
    return replace(
        ctx,
        component_ids={"card"},
        component_property_keys={"card": frozenset({"count", "speed", "mode", "body"})},
        component_properties={
            "card": {
                "count": {"type": "integer", "label": "Count"},
                "speed": {"type": "float", "label": "Speed", "write": True},
                "mode": {"type": "select", "label": "Mode", "optionType": "boolean"},
                "body": {"type": "widgets", "label": "Body"},
            }
        },
    )


def _instance(properties: dict) -> dict:
    return {"id": "c1", "type": "$component:card", "properties": properties}


def test_an_instance_value_is_typed_by_the_declaration(card_ctx):
    report = validate_widget_node(_instance({"count": "many"}), card_ctx)
    assert _codes(report) == ["literal-type"]
    assert _codes(validate_widget_node(_instance({"count": 3}), card_ctx)) == []


def test_an_instance_binding_is_typed_by_the_declaration(card_ctx):
    report = validate_widget_node(_instance({"count": {"$var": {"path": "PLC:Speed"}}}), card_ctx)
    assert _codes(report) == ["var-type"]
    # The declaration writes, and the variable is read-only.
    report = validate_widget_node(_instance({"speed": {"$var": {"path": "PLC:Speed"}}}), card_ctx)
    assert _codes(report) == ["var-readonly"]
    report = validate_widget_node(_instance({"mode": {"$alarmCount": {}}}), card_ctx)
    assert _codes(report) == ["source-type"]


def test_an_instance_of_an_unknown_interface_is_not_typed(ctx):
    unknown = replace(ctx, component_ids={"card"})
    assert _codes(validate_widget_node(_instance({"count": "many"}), unknown)) == []


# ── $componentProp ───────────────────────────────────────────────────────────

_INPUTS = {
    "setpoint": {"type": "float", "label": "Setpoint"},
    "target": {"type": "float", "label": "Target", "write": True},
    "slot": {"type": "widgets", "label": "Slot"},
    "motor": {
        "type": "struct",
        "label": "Motor",
        "structSchema": [
            {"kind": "variable", "name": "fSpeed", "type": "Float"},
            {"kind": "folder", "name": "stLimits", "children": [
                {"kind": "variable", "name": "fMax", "type": "Float", "write": True},
            ]},
            {"kind": "array", "name": "aHistory", "type": "Float"},
        ],
    },
}


@pytest.fixture()
def input_ctx(ctx) -> ValidationContext:
    return replace(ctx, input_schema=_INPUTS)


@pytest.mark.parametrize(
    ("name", "field"),
    [
        ("setpoint", {"type": "float"}),
        ("target", {"type": "float", "write": True}),
        ("motor/fSpeed", {"type": "float"}),
        ("motor/stLimits/fMax", {"type": "float", "write": True}),
        ("motor", {"type": "struct", "requiredFields": [{"name": "fSpeed", "type": "Float"}]}),
        # Below an array row the declaration says nothing.
        ("motor/aHistory/0", {"type": "integer"}),
        ("setpoint", None),
    ],
)
def test_a_component_prop_that_fits(input_ctx, name, field):
    assert _codes(_value(input_ctx, {"$componentProp": name}, field)) == []


@pytest.mark.parametrize(
    ("name", "field", "code", "severity"),
    [
        ("setpoint", {"type": "integer"}, "componentprop-type", "error"),
        ("setpoint", {"type": "float", "write": True}, "componentprop-type", "error"),
        ("motor/fSpeed", {"type": "boolean"}, "componentprop-type", "error"),
        ("motor", {"type": "string"}, "componentprop-type", "error"),
        ("slot", {"type": "string"}, "componentprop-type", "error"),
        ("missing", {"type": "string"}, "componentprop-unknown", "warning"),
        ("motor/nope", {"type": "float"}, "componentprop-unknown", "warning"),
    ],
)
def test_a_component_prop_that_does_not(input_ctx, name, field, code, severity):
    report = _value(input_ctx, {"$componentProp": name}, field)
    assert _codes(report) == [code]
    assert report.warnings[0].severity == severity


def test_a_component_prop_in_an_unknown_scope_is_not_typed(ctx):
    assert _codes(_value(ctx, {"$componentProp": "missing"}, {"type": "integer"})) == []


def _dialog_ctx(ctx) -> ValidationContext:
    """`detail` is a Dialogs-folder page inside the group `grp`."""
    return replace(
        ctx,
        dialogs_page_ids=frozenset({"detail", "grp"}),
        page_properties={"grp": {"title": {"type": "string"}, "n": {"type": "string"}}},
        dialog_ancestors={"detail": ("grp",), "grp": ()},
    )


def _label_page(text_prop: str) -> dict:
    return {
        "id": "detail",
        "componentProperties": {"n": {"type": "integer", "label": "N"}},
        "sections": {"content": [
            {"id": "l1", "type": "Label", "properties": {"text": {"$componentProp": text_prop}}},
        ]},
    }


def test_a_dialog_page_reads_its_own_and_its_groups_inputs(ctx):
    dialog = _dialog_ctx(ctx)
    assert _codes(validate_page(_label_page("title"), dialog)) == []
    assert _codes(validate_page(_label_page("zzz"), dialog)) == ["componentprop-unknown"]
    # The page's own `n` (an Integer) shadows the group's String one.
    assert _codes(validate_page(_label_page("n"), dialog)) == ["componentprop-type"]


def test_a_dialog_groups_events_read_its_inputs(ctx):
    dialog = _dialog_ctx(ctx)
    group = {
        "id": "grp",
        "type": "page-group",
        "events": {"onOpen": [{"type": "showToast", "message": {"$componentProp": "nope"}}]},
    }
    report = validate_page_node_events(group, ctx_for_page_group(dialog, group))
    assert _codes(report) == ["componentprop-unknown"]


def test_a_component_definition_reads_its_own_declarations(ctx):
    from api.config_api import _validate_component_tree

    component = {
        "componentProperties": {"n": {"type": "integer", "label": "N"}},
        "children": [
            {"id": "l1", "type": "Label", "properties": {"text": {"$componentProp": "n"}}},
            {"id": "l2", "type": "Label", "properties": {"size": {"$componentProp": "n"}}},
        ],
    }
    report = _validate_component_tree(component, ctx, "card")
    assert [(w.code, w.path) for w in report.warnings] == [
        ("componentprop-type", "/children/0/properties/text")
    ]


# ── $widgetProp ──────────────────────────────────────────────────────────────


def _widget_page(prop: dict, field: str = "text", *, source: str = "dd") -> dict:
    return {
        "id": "p",
        "sections": {"content": [
            {"id": "dd", "type": "Dropdown", "properties": {}},
            {"id": "legacy", "type": "Legacy", "properties": {}},
            {"id": "l1", "type": "Label",
             "properties": {field: {"$widgetProp": {"componentId": source, **prop}}}},
        ]},
    }


@pytest.mark.parametrize(
    ("prop", "field"),
    [
        ({"property": "selectedValue"}, "text"),
        ({"property": "raw"}, "text"),
        ({"property": "row", "path": "count"}, "size"),
        ({"property": "row", "path": "undeclared"}, "size"),
    ],
)
def test_a_widget_prop_that_fits(ctx, prop, field):
    assert _codes(validate_page(_widget_page(prop, field), ctx)) == []


@pytest.mark.parametrize(
    ("prop", "field", "source", "code"),
    [
        ({"property": "selectedValue"}, "size", "dd", "widgetprop-type"),
        ({"property": "raw"}, "size", "dd", "widgetprop-type"),
        ({"property": "row", "path": "count"}, "text", "dd", "widgetprop-type"),
        ({"property": "nope"}, "text", "dd", "widgetprop-unknown"),
        ({"property": "selectedValue"}, "text", "ghost", "widgetprop-unknown"),
    ],
)
def test_a_widget_prop_that_does_not(ctx, prop, field, source, code):
    report = validate_page(_widget_page(prop, field, source=source), ctx)
    assert _codes(report) == [code]
    assert report.warnings[0].severity == "error"


def test_a_widget_prop_resolves_across_the_project(ctx):
    elsewhere = replace(
        ctx, project_widgets={"shell": {"hdr": ("Dropdown", ())}, "page:p": {"stale": ("Dropdown", ())}}
    )
    assert _codes(validate_page(_widget_page({"property": "selectedValue"}, source="hdr"), elsewhere)) == []
    # The page's own saved copy is replaced by the draft being validated.
    report = validate_page(_widget_page({"property": "selectedValue"}, source="stale"), elsewhere)
    assert _codes(report) == ["widgetprop-unknown"]
    # A Repeater copy's scoped id names the template widget.
    assert _codes(validate_page(_widget_page({"property": "selectedValue"}, source="dd@2"), ctx)) == []


def test_a_widget_prop_of_unknown_exports_is_not_judged(ctx):
    assert _codes(validate_page(_widget_page({"property": "x"}, source="legacy"), ctx)) == []


# ── values inside actions ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("action", "code", "path"),
    [
        ({"type": "showToast", "message": {"$loc": "missing"}}, "loc-unknown", "/a/message"),
        ({"type": "showToast", "message": "Hi", "duration": "long"}, "literal-type", "/a/duration"),
        ({"type": "openPageOverlay", "pageId": "", "width": 400.5}, "literal-type", "/a/width"),
        ({"type": "loginUser", "username": {"$var": {"path": "PLC:Speed"}}}, "var-type", "/a/username"),
        ({"type": "setLanguage", "language": {"$alarmCount": {}}}, "source-type", "/a/language"),
        ({"type": "if", "condition": {"$var": {"path": "PLC:Nope"}}}, "var-unknown", "/a/condition"),
        ({"type": "showAlert", "title": {"$loc": 5}}, "value-invalid", "/a/title"),
        ({"type": "recipeLoad", "datasetId": "x", "verify": "yes"}, "literal-type", "/a/verify"),
    ],
)
def test_an_actions_values_are_checked(ctx, action, code, path):
    report = _action(replace(ctx, page_ids={""}), action)
    assert [(w.code, w.path) for w in report.warnings] == [(code, path)]
    assert report.findings == []


def test_open_dialog_inputs_are_typed_by_the_target(ctx):
    dialog = replace(
        ctx,
        page_ids={"detail"},
        page_property_keys={"detail": frozenset({"motorId"})},
        page_properties={"detail": {"motorId": {"type": "integer", "label": "Motor"}}},
    )
    action = {"type": "openDialog", "pageId": "detail", "componentProperties": {"motorId": "x"}}
    assert _codes(_action(dialog, action)) == ["literal-type"]
    action["componentProperties"] = {"motorId": {"$var": {"path": "PLC:Speed"}}}
    assert _codes(_action(dialog, action)) == ["var-type"]
    action["componentProperties"] = {"motorId": {"$var": {"path": "PLC:Count"}}}
    assert _codes(_action(dialog, action)) == []


def test_an_action_value_reads_the_surrounding_inputs(input_ctx):
    action = {"type": "showToast", "message": {"$componentProp": "nope"}}
    assert _codes(_action(input_ctx, action)) == ["componentprop-unknown"]


# ── write and toggle targets ─────────────────────────────────────────────────


def _write(path: str, value=None, **ref) -> dict:
    action = {"type": "writeDataVariable", "target": {"$var": {"path": path, **ref}}}
    if value is not None:
        action["value"] = value
    return action


def _toggle(path: str, **ref) -> dict:
    return {"type": "toggleDataVariable", "target": {"$var": {"path": path, **ref}}}


@pytest.mark.parametrize(
    ("action", "code"),
    [
        (_write("PLC:Motor"), "write-target-type"),
        (_write("PLC:Speed"), "write-target-type"),
        (_toggle("PLC:Count"), "toggle-target-type"),
        (_toggle("PLC:Flags"), "toggle-target-type"),
        (_toggle("PLC:Flags", index=7), "var-index"),
        # Access the registry does not state is read-only.
        (_write("PLC:Levels", [1.5]), "write-target-type"),
    ],
)
def test_a_target_the_action_cannot_write(ctx, action, code):
    report = _action(ctx, action)
    assert _codes(report) == [code]
    assert report.warnings[0].path == "/a/target"


@pytest.mark.parametrize(
    "action",
    [
        _write("PLC:Count", 1),
        _write("PLC:Flags", [True, False, True, False]),
        _toggle("PLC:Run"),
        _toggle("PLC:Flags", index=2),
    ],
)
def test_a_target_the_action_can_write(ctx, action):
    assert _codes(_action(ctx, action)) == []


def _entries(entries: dict):
    return lambda ds, path: entries.get(f"{ds}:{path}")


@pytest.fixture()
def entry_ctx(ctx) -> ValidationContext:
    return replace(
        ctx,
        datasource_entry=_entries({
            "PLC:Count": {"data_type": "Int16", "min": 0, "max": 100},
            "PLC:Flags": {"data_type": "Boolean", "is_array": True, "array_length": 4},
            "PLC:Run": {"data_type": "LocalizedText"},
        }),
    )


@pytest.mark.parametrize(
    ("action", "message"),
    [
        (_write("PLC:Count", "fast"), "Expected an Integer."),
        (_write("PLC:Count", {"$static": 1.5}), "This number cannot be stored exactly in this variable."),
        (_write("PLC:Count", 500), "The value is outside the variable's configured range."),
        (_write("PLC:Flags", True), "Expected an array."),
        (_write("PLC:Flags", [True]), "The array has the wrong number of elements."),
        (_write("PLC:Flags", [True], index=1), "Expected a single value, not an array."),
    ],
)
def test_a_value_the_write_path_would_reject(entry_ctx, action, message):
    report = _action(entry_ctx, action)
    assert _codes(report) == ["write-value-type"]
    warning = report.warnings[0]
    assert (warning.path, warning.severity) == ("/a/value", "error")
    assert warning.message.endswith(message)


@pytest.mark.parametrize(
    "action",
    [
        _write("PLC:Count", "42"),
        _write("PLC:Count", {"$static": 7}),
        _write("PLC:Flags", False, index=1),
        # A type the write path does not know is not judged.
        _write("PLC:Run", "x"),
    ],
)
def test_a_value_the_write_path_accepts(entry_ctx, action):
    assert _codes(_action(entry_ctx, action)) == []


def test_a_sourced_write_value_is_typed_by_the_target(input_ctx):
    action = _write("PLC:Count", {"$componentProp": "setpoint"})
    assert _codes(_action(input_ctx, action)) == ["componentprop-type"]
    assert _codes(_action(input_ctx, _write("PLC:Speed", {"$componentProp": "setpoint"}))) == [
        "write-target-type"
    ]


@pytest.fixture()
def repeat_ctx(ctx) -> ValidationContext:
    return replace(ctx, repeat_scope=True, repeat_items={"$var": {"path": "PLC:Flags"}})


def test_a_repeat_item_target_is_judged_on_the_element(repeat_ctx):
    toggle = {"type": "toggleDataVariable", "target": {"$repeatItem": {}}}
    assert _codes(_action(repeat_ctx, toggle)) == []
    levels = replace(repeat_ctx, repeat_items={"$var": {"path": "PLC:Levels"}})
    assert _codes(_action(levels, toggle)) == ["toggle-target-type"]


# ── review follow-ups ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "field"),
    [
        ({"$page": {"field": "icon"}}, {"type": "icon"}),
        ({"$recipeList": {"type": ""}}, {"type": "item-list"}),
        ({"$recipeList": {"type": ""}}, {"type": "record-list"}),
        ({"$user": {"field": "groups"}}, {"type": "option-list"}),
        ({"$user": {"field": "groups"}}, {"type": "item-list"}),
    ],
)
def test_list_and_icon_sources_that_fit(ctx, value, field):
    assert _codes(_value(ctx, value, field)) == []


def test_an_instance_actions_input_naming_a_missing_page_does_not_block(card_ctx):
    ctx = replace(
        card_ctx,
        page_ids={"home"},
        component_property_keys={"card": frozenset({"onPress"})},
        component_properties={"card": {"onPress": {"type": "actions", "label": "On press"}}},
    )
    node = _instance({"onPress": [{"type": "openDialog", "pageId": "gone"}]})
    report = validate_widget_node(node, ctx)
    assert report.ok
    assert [(w.code, w.path) for w in report.warnings] == [
        ("action-page-unknown", "/properties/onPress/0")
    ]


def test_a_builtin_actions_field_naming_a_missing_page_still_blocks(ctx):
    manifest = {**_MANIFEST, "builtin": {"Button": {"name": "Button", "schema": {"onPress": {"type": "actions"}}}}}
    node = {"id": "b", "type": "Button", "properties": {"onPress": [{"type": "openDialog", "pageId": "gone"}]}}
    assert not validate_widget_node(node, replace(ctx, widget_schemas=manifest)).ok


def test_a_widget_prop_id_reused_across_the_project_takes_any_match(ctx):
    manifest = {**_MANIFEST, "builtin": {**_MANIFEST["builtin"], "Button": {"name": "Button", "schema": {}, "exportedProperties": []}}}
    elsewhere = replace(
        ctx,
        widget_schemas=manifest,
        project_widgets={"page:a": {"row": ("Button", ())}, "page:b": {"row": ("Dropdown", ())}},
    )
    assert _codes(validate_page(_widget_page({"property": "selectedValue"}, source="row"), elsewhere)) == []
    # No candidate exports it: reported, naming the first.
    report = validate_page(_widget_page({"property": "nope"}, source="row"), elsewhere)
    assert _codes(report) == ["widgetprop-unknown"]


def test_a_builtin_export_list_wins_over_a_stale_custom_row(ctx):
    manifest = {
        **_MANIFEST,
        "custom": {
            **_MANIFEST["custom"],
            "Inputs/Dropdown": {"name": "Dropdown", "schema": {"options": {"type": "option-list"}}},
        },
    }
    stale = replace(ctx, widget_schemas=manifest)
    assert [e["key"] for e in stale.widget_exports("Dropdown")] == ["selectedValue", "row", "raw"]
    report = validate_page(_widget_page({"property": "nope"}), stale)
    assert _codes(report) == ["widgetprop-unknown"]


def test_an_actions_role_is_walked_from_the_table(ctx, monkeypatch):
    from core.validation import structure

    fields = {**structure.ACTION_FIELDS["showToast"], "onTimeout": "actions"}
    monkeypatch.setitem(structure.ACTION_FIELDS, "showToast", fields)
    action = {"type": "showToast", "message": "x", "onTimeout": [{"type": "showToast", "message": {"$loc": "nope"}}]}
    assert [(w.code, w.path) for w in _action(ctx, action).warnings] == [
        ("loc-unknown", "/a/onTimeout/0/message")
    ]


def test_a_page_role_is_checked_from_the_table(ctx):
    report = _action(replace(ctx, page_ids={"home"}), {"type": "closePageOverlay", "pageId": "gone"})
    assert [f.message for f in report.findings] == ["action target page 'gone' does not exist"]
    assert _action(replace(ctx, page_ids={"home"}), {"type": "closePageOverlay", "pageId": ""}).ok


def test_slot_content_reads_the_instances_inputs(card_ctx):
    node = _instance({})
    node["children"] = [
        {"id": "l1", "type": "Label", "properties": {"size": {"$componentProp": "count"}}},
        {"id": "l2", "type": "Label", "properties": {"text": {"$componentProp": "pageInput"}}},
    ]
    # The caller is a navigable page: its own `$componentProp` reads nothing,
    # but slot content renders inside the instance and reads the card's.
    caller = replace(card_ctx, input_scope=False, component_slots={"card": frozenset({"content"})})
    report = validate_widget_node(node, caller)
    assert [(w.code, w.path) for w in report.warnings] == [
        ("componentprop-unknown", "/children/1/properties/text")
    ]


def test_a_bad_literal_in_slot_content_still_blocks(card_ctx):
    node = _instance({"count": "many"})
    node["children"] = [{"id": "l1", "type": "Label", "properties": {"size": "big"}}]
    report = validate_widget_node(node, replace(card_ctx, component_slots={"card": frozenset({"content"})}))
    assert [f.path for f in report.findings] == ["/children/0/properties/size"]
    assert [w.code for w in report.warnings] == ["literal-type"]


def test_a_write_value_is_not_judged_without_an_entry(ctx):
    no_entry = replace(ctx, datasource_entry=lambda ds, path: None)
    assert _codes(_action(no_entry, _write("PLC:Count", "fast"))) == []


def test_a_repeat_item_struct_member_target(ctx):
    motors = replace(
        ctx,
        repeat_scope=True,
        repeat_items={"$var": {"path": "PLC:Motors"}},
        datasource_registry={
            "PLC": {
                "Motors": {"kind": "struct", "name": "M", "array": True, "fields": ["Run", "Speed"]},
                "Motors/[0]": {"kind": "struct", "name": "M", "array": False, "fields": ["Run", "Speed"]},
                "Motors/[0]/Run": _BOOLEAN,
                "Motors/[0]/Speed": _FLOAT,
            }
        },
        datasource_writable={"PLC": {"Motors/[0]/Run": True, "Motors/[0]/Speed": False}},
    )

    def toggle(member=None):
        return {"type": "toggleDataVariable", "target": {"$repeatItem": {"member": member} if member else {}}}

    assert _codes(_action(motors, toggle("Run"))) == []
    assert _codes(_action(motors, toggle("Speed"))) == ["toggle-target-type"]
    write = {"type": "writeDataVariable", "target": {"$repeatItem": {"member": "Speed"}}, "value": 1}
    assert _codes(_action(motors, write)) == ["write-target-type"]
    whole = {"type": "writeDataVariable", "target": {"$repeatItem": {}}, "value": 1}
    assert _codes(_action(motors, whole)) == ["write-target-type"]


def test_a_toggle_on_a_type_the_write_path_does_not_know(entry_ctx):
    report = _action(entry_ctx, _toggle("PLC:Run"))
    assert _codes(report) == ["toggle-target-type"]
    assert "'LocalizedText'" in report.warnings[0].message


def test_a_scalar_literal_after_a_leading_array_type(ctx):
    field = {"type": ["string[]", "integer"]}
    assert _codes(_value(ctx, 3, field)) == []
    # Never a rejected write: a field led by an array type was never checked.
    assert _codes(_value(ctx, True, field)) == ["literal-type"]


def test_a_whole_float_index_is_an_index(ctx):
    assert _codes(_value(ctx, {"$var": {"path": "PLC:Flags", "index": 2.0}}, {"type": "boolean"})) == []
    assert _codes(_value(ctx, {"$var": {"path": "PLC:Flags", "index": 4.0}}, {"type": "boolean"})) == ["var-index"]


def test_a_component_draft_is_not_resolved_against_its_saved_copy(ctx):
    from api.config_api import _validate_component_tree

    saved = replace(ctx, project_widgets={"component:card": {"dd": ("Dropdown", ())}})
    component = {
        "children": [
            {"id": "l1", "type": "Label",
             "properties": {"text": {"$widgetProp": {"componentId": "dd", "property": "selectedValue"}}}},
        ],
    }
    assert _codes(_validate_component_tree(component, saved, "card")) == ["widgetprop-unknown"]
    assert _codes(_validate_component_tree(component, saved, "other")) == []
