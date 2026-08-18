"""Build Diagnostics catalog — one case per code in structure.py.

Every catalog code is non-blocking: it must land in `report.warnings`
(severity 'error' or 'warning'), never in `report.findings` (which would
reject the write with a 422).
"""

import pytest
from core.validation import ValidationContext
from core.validation.report import ValidationReport
from core.validation.structure import (
    _validate_action,
    _validate_property_value,
    validate_var_ref,
    validate_widget_node,
)


@pytest.fixture()
def ctx() -> ValidationContext:
    return ValidationContext(
        widget_schemas={"version": 2, "builtin": {}, "custom": {}},
        datasource_registry={
            "PLC": {
                "Motor/Speed": {"kind": "scalar", "base": "Float", "array": False},
                "Motor/Running": {"kind": "scalar", "base": "Boolean", "array": False},
            },
            "Sim": {
                "Motor/Speed": {"kind": "scalar", "base": "Float", "array": False},
            },
        },
        datasource_types={"PLC": "opcua-client", "Sim": "opcua-test-server"},
        translation_keys=frozenset({"app.title"}),
        icon_assets=frozenset({"icons/logo.svg"}),
        image_assets=frozenset({"images/logo.png"}),
    )


def _warn(report: ValidationReport):
    assert report.findings == []
    assert len(report.warnings) >= 1
    return report.warnings[0]


# ── Errors (set but unresolvable) ────────────────────────────────────────────


def test_var_unknown(ctx):
    report = ValidationReport()
    validate_var_ref({"path": "PLC:Missing/Thing"}, ctx, "/p", report, {"type": "string"})
    w = _warn(report)
    assert (w.code, w.severity) == ("var-unknown", "error")


def test_var_unknown_datasource(ctx):
    report = ValidationReport()
    validate_var_ref({"path": "Nope:Motor/Speed"}, ctx, "/p", report, {"type": "string"})
    w = _warn(report)
    assert (w.code, w.severity) == ("var-unknown", "error")


def test_var_test_server(ctx):
    report = ValidationReport()
    validate_var_ref({"path": "Sim:Motor/Speed"}, ctx, "/p", report, {"type": "float"})
    w = _warn(report)
    assert (w.code, w.severity) == ("var-test-server", "error")


def test_write_target_test_server(ctx):
    report = ValidationReport()
    _validate_action(
        {"type": "writeDataVariable", "datasource": "Sim", "path": "Motor/Speed", "value": 1},
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("var-test-server", "error")
    assert w.path == "/a/datasource"


def test_write_target_unknown_variable(ctx):
    report = ValidationReport()
    _validate_action(
        {"type": "writeDataVariable", "datasource": "PLC", "path": "Motor/Ghost", "value": 1},
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("var-unknown", "error")
    assert w.path == "/a/datasource"


def test_write_target_incomplete(ctx):
    report = ValidationReport()
    _validate_action({"type": "writeDataVariable", "value": 1}, ctx, "/a", report)
    w = _warn(report)
    assert (w.code, w.severity) == ("var-empty", "warning")


def test_write_target_resolvable_is_silent(ctx):
    report = ValidationReport()
    _validate_action(
        {"type": "writeDataVariable", "datasource": "PLC", "path": "Motor/Speed", "value": 1},
        ctx, "/a", report,
    )
    assert report.warnings == []
    assert report.findings == []


def test_write_target_in_result_handler(ctx):
    report = ValidationReport()
    _validate_action(
        {
            "type": "writeDataVariable",
            "datasource": "PLC",
            "path": "Motor/Speed",
            "value": 1,
            "onSuccess": [
                {"type": "writeDataVariable", "datasource": "Sim", "path": "Motor/Speed", "value": 2}
            ],
        },
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.path) == ("var-test-server", "/a/onSuccess/0/datasource")


def test_write_target_in_alert_handler(ctx):
    report = ValidationReport()
    _validate_action(
        {
            "type": "showAlert",
            "title": "Confirm",
            "onOk": [
                {"type": "writeDataVariable", "datasource": "Sim", "path": "Motor/Speed", "value": 2}
            ],
        },
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.path) == ("var-test-server", "/a/onOk/0/datasource")


def test_var_type(ctx):
    report = ValidationReport()
    validate_var_ref({"path": "PLC:Motor/Running"}, ctx, "/p", report, {"type": "float"})
    w = _warn(report)
    assert (w.code, w.severity) == ("var-type", "error")


def test_var_type_compatible_does_not_warn(ctx):
    report = ValidationReport()
    validate_var_ref({"path": "PLC:Motor/Speed"}, ctx, "/p", report, {"type": "float"})
    assert report.warnings == []
    assert report.findings == []


def test_user_groups_is_a_boolean_expression(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$userGroups": {"groups": ["admin"]}},
        {"type": "boolean"},
        ctx,
        "/p",
        report,
    )
    assert report.findings == []
    assert report.warnings == []


def test_loc_unknown(ctx):
    report = ValidationReport()
    _validate_property_value({"$loc": "missing.key"}, None, ctx, "/p", report)
    w = _warn(report)
    assert (w.code, w.severity) == ("loc-unknown", "error")


def test_icon_unknown_builtin(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$static": {"type": "builtin", "name": "not-a-real-icon"}},
        {"type": "icon"}, ctx, "/p", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("icon-unknown", "error")


def test_icon_unknown_custom(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$static": {"type": "custom", "path": "icons/missing.svg"}},
        {"type": "icon"}, ctx, "/p", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("icon-unknown", "error")


def test_icon_known_custom_does_not_warn(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$static": {"type": "custom", "path": "icons/logo.svg"}},
        {"type": "icon"}, ctx, "/p", report,
    )
    assert report.warnings == []


def test_icon_known_builtin_does_not_warn(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$static": {"type": "builtin", "name": "gauge"}},
        {"type": "icon"}, ctx, "/p", report,
    )
    assert report.warnings == []


def test_image_unknown(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$static": {"path": "images/missing.png"}},
        {"type": "image"}, ctx, "/p", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("image-unknown", "error")


def test_image_known_does_not_warn(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$static": {"path": "images/logo.png"}},
        {"type": "image"}, ctx, "/p", report,
    )
    assert report.warnings == []


# ── Warnings (required sub-field empty/unset) ────────────────────────────────


def test_var_empty(ctx):
    report = ValidationReport()
    validate_var_ref({"path": ""}, ctx, "/p", report, {"type": "string"})
    w = _warn(report)
    assert (w.code, w.severity) == ("var-empty", "warning")


def test_loc_empty(ctx):
    report = ValidationReport()
    _validate_property_value({"$loc": ""}, None, ctx, "/p", report)
    w = _warn(report)
    assert (w.code, w.severity) == ("loc-empty", "warning")


def test_if_condition_empty(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$if": {"condition": None, "true": 1, "false": 2}}, None, ctx, "/p", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("if-condition-empty", "warning")


def test_if_optional_slots_stay_silent(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$if": {"condition": {"$static": True}, "true": None, "false": None}},
        None, ctx, "/p", report,
    )
    assert report.warnings == []


def test_compare_operand_empty(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$compare": {"left": None, "operator": ">", "right": {"$static": 5}}},
        None, ctx, "/p", report,
    )
    codes = {w.code for w in report.warnings}
    assert "compare-operand-empty" in codes
    assert all(w.severity == "warning" for w in report.warnings if w.code == "compare-operand-empty")


def test_switch_value_empty(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$switch": {"value": None, "cases": [{"when": {"$static": 1}, "then": {"$static": "a"}}], "default": None}},
        None, ctx, "/p", report,
    )
    codes = {w.code for w in report.warnings}
    assert "switch-value-empty" in codes


def test_switch_no_cases(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$switch": {"value": {"$static": 1}, "cases": [], "default": None}},
        None, ctx, "/p", report,
    )
    codes = {w.code for w in report.warnings}
    assert "switch-no-cases" in codes


def test_switch_case_empty(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$switch": {"value": {"$static": 1}, "cases": [{"when": None, "then": None}], "default": None}},
        None, ctx, "/p", report,
    )
    codes = {w.code for w in report.warnings}
    assert "switch-case-empty" in codes


def test_switch_case_with_when_only_stays_silent_for_case(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$switch": {"value": {"$static": 1}, "cases": [{"when": {"$static": 1}, "then": None}], "default": None}},
        None, ctx, "/p", report,
    )
    assert "switch-case-empty" not in {w.code for w in report.warnings}


def test_stringexpr_empty(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$stringExpr": {"template": "", "wildcards": {}}}, None, ctx, "/p", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("stringexpr-empty", "warning")


def test_stringexpr_wildcard_empty(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$stringExpr": {"template": "{ToLower(1)} - {2}", "wildcards": {"1": {"$static": "x"}}}},
        None, ctx, "/p", report,
    )
    codes = {w.code for w in report.warnings}
    assert codes == {"stringexpr-wildcard-empty"}
    assert report.warnings[0].path.endswith("/wildcards/2")


def test_stringexpr_all_wildcards_bound_does_not_warn(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$stringExpr": {"template": "{1} - {2}", "wildcards": {"1": {"$static": "a"}, "2": {"$static": "b"}}}},
        None, ctx, "/p", report,
    )
    assert report.warnings == []


def test_urlparam_empty(ctx):
    report = ValidationReport()
    _validate_property_value({"$urlParam": {"name": ""}}, None, ctx, "/p", report)
    w = _warn(report)
    assert (w.code, w.severity) == ("urlparam-empty", "warning")


def test_widgetprop_empty(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$widgetProp": {"componentId": "", "property": ""}}, None, ctx, "/p", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("widgetprop-empty", "warning")


def test_componentprop_empty(ctx):
    report = ValidationReport()
    _validate_property_value({"$componentProp": ""}, None, ctx, "/p", report)
    w = _warn(report)
    assert (w.code, w.severity) == ("componentprop-empty", "warning")


def test_recipe_type_empty(ctx):
    report = ValidationReport()
    _validate_property_value({"$recipe": {"type": ""}}, None, ctx, "/p", report)
    w = _warn(report)
    assert (w.code, w.severity) == ("recipe-type-empty", "warning")


# ── prop-unknown (set on an interface that doesn't declare it) ───────────────


def _prop_ctx(**overrides) -> ValidationContext:
    manifest = {
        "version": 2,
        "builtin": {"Button": {"name": "Button", "schema": {"label": {"type": "String"}}}},
        "custom": {
            "Inputs/Dropdown": {"name": "Dropdown", "schema": {"options": {"type": "Array"}}}
        },
    }
    return ValidationContext(widget_schemas=manifest, **overrides)


def _node(wtype: str, properties: dict) -> dict:
    return {"id": "w1", "type": wtype, "properties": properties}


def test_prop_unknown_widget():
    report = validate_widget_node(_node("Button", {"label": "Go", "bogus": 1}), _prop_ctx())
    w = _warn(report)
    assert (w.code, w.severity) == ("prop-unknown", "warning")
    assert w.path == "/properties/bogus"
    assert "widget 'Button'" in w.message


def test_prop_unknown_allows_visibility_keys_on_custom_widget():
    # Dropdown's extracted schema has no visible/interactable — the frontend
    # injects them at load and WidgetRenderer reads them off every node.
    node = _node("Dropdown", {"options": [], "visible": True, "interactable": False})
    report = validate_widget_node(node, _prop_ctx())
    assert report.warnings == []
    assert report.findings == []


def test_prop_unknown_component_instance():
    ctx = _prop_ctx(
        component_ids={"card"}, component_property_keys={"card": frozenset({"title"})}
    )
    report = validate_widget_node(_node("$component:card", {"subtitle": "x"}), ctx)
    w = _warn(report)
    assert (w.code, w.severity) == ("prop-unknown", "warning")
    assert "component 'card'" in w.message


def test_prop_unknown_allows_visibility_keys_on_component_instance():
    ctx = _prop_ctx(
        component_ids={"card"}, component_property_keys={"card": frozenset({"title"})}
    )
    report = validate_widget_node(_node("$component:card", {"visible": True}), ctx)
    assert report.warnings == []


def test_prop_unknown_skipped_when_component_interface_uncollected():
    # Fresh checkout / deploy runtime: nothing collected, so nothing is claimed.
    report = validate_widget_node(_node("$component:card", {"anything": 1}), _prop_ctx())
    assert report.warnings == []
    assert report.findings == []


def test_prop_unknown_component_declaring_nothing_warns():
    # An empty componentProperties map is a real interface that declares nothing —
    # unlike an empty widget schema, which means "interface unknown".
    ctx = _prop_ctx(component_ids={"empty"}, component_property_keys={"empty": frozenset()})
    report = validate_widget_node(_node("$component:empty", {"x": 1}), ctx)
    w = _warn(report)
    assert w.code == "prop-unknown"


def test_prop_unknown_skipped_for_schemaless_widget():
    # An empty schema means "interface unknown" (fresh checkout / deploy runtime
    # where extraction produced nothing), so property names can't be judged.
    ctx = _prop_ctx()
    ctx.widget_schemas["builtin"]["Mystery"] = {"name": "Mystery", "schema": {}}
    report = validate_widget_node(_node("Mystery", {"whatever": 1}), ctx)
    assert report.warnings == []
    assert report.findings == []


def test_prop_unknown_dialog_arg():
    ctx = _prop_ctx(
        dialog_ids={"popup1"}, dialog_property_keys={"popup1": frozenset({"title"})}
    )
    report = ValidationReport()
    _validate_action(
        {"type": "openDialog", "dialogId": "popup1", "componentProperties": {"ghost": 1}},
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("prop-unknown", "warning")
    assert w.path == "/a/componentProperties/ghost"
    assert "dialog 'popup1'" in w.message


def test_prop_unknown_dialog_arg_declared_is_silent():
    ctx = _prop_ctx(
        dialog_ids={"popup1"}, dialog_property_keys={"popup1": frozenset({"title"})}
    )
    report = ValidationReport()
    _validate_action(
        {"type": "openDialog", "dialogId": "popup1", "componentProperties": {"title": "x"}},
        ctx, "/a", report,
    )
    assert report.warnings == []


def test_prop_unknown_dialog_arg_skipped_when_dialogs_uncollected():
    ctx = _prop_ctx(dialog_ids={"popup1"})
    report = ValidationReport()
    _validate_action(
        {"type": "openDialog", "dialogId": "popup1", "componentProperties": {"ghost": 1}},
        ctx, "/a", report,
    )
    assert report.warnings == []
    assert report.findings == []


# ── Not diagnosed (valid empties) ────────────────────────────────────────────


def test_pageisactive_empty_page_not_diagnosed(ctx):
    report = ValidationReport()
    _validate_property_value({"$pageIsActive": {"pageId": ""}}, None, ctx, "/p", report)
    assert report.warnings == []
    assert report.findings == []


def test_random_not_diagnosed(ctx):
    report = ValidationReport()
    _validate_property_value({"$random": {"min": 0, "max": 1}}, None, ctx, "/p", report)
    assert report.warnings == []
