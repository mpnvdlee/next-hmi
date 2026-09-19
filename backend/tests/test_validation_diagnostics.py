"""Build Diagnostics catalog — one case per code in structure.py.

Every catalog code is non-blocking: it must land in `report.warnings`
(severity 'error' or 'warning'), never in `report.findings` (which would
reject the write with a 422).
"""

from dataclasses import replace

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
        video_assets=frozenset({"videos/intro.mp4"}),
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


def test_toast_severity_invalid(ctx):
    report = ValidationReport()
    _validate_action(
        {"type": "showToast", "message": "hi", "severity": "success"}, ctx, "/a", report
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("toast-severity-invalid", "error")
    assert w.path == "/a/severity"


def test_toast_severity_valid_is_silent(ctx):
    report = ValidationReport()
    for sev in ("info", "warning", "error"):
        _validate_action(
            {"type": "showToast", "message": "hi", "severity": sev}, ctx, "/a", report
        )
    assert report.warnings == []


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


def test_video_unknown(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$static": {"path": "videos/missing.mp4"}},
        {"type": "video"}, ctx, "/p", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("video-unknown", "error")


def test_video_known_does_not_warn(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$static": {"path": "videos/intro.mp4"}},
        {"type": "video"}, ctx, "/p", report,
    )
    assert report.warnings == []


def test_video_known_in_subfolder_does_not_warn(live_project_root):
    """`/api/assets` and the picker both offer nested videos (rglob) — the
    validator must key its asset context the same way or it rejects content
    the picker just offered."""
    import core.storage as storage
    from core.validation.structure import _collect_asset_names

    storage.ensure_active_project_dirs()
    nested = storage.active_videos_dir() / "lines"
    nested.mkdir(parents=True)
    (nested / "clip.mp4").write_bytes(b"\x00\x00\x00 ftypmp42")

    ctx = ValidationContext(
        widget_schemas={"version": 2, "builtin": {}, "custom": {}},
        video_assets=_collect_asset_names(storage.active_videos_dir()),
    )
    report = ValidationReport()
    _validate_property_value(
        {"$static": {"path": "videos/lines/clip.mp4"}},
        {"type": "video"}, ctx, "/p", report,
    )
    assert report.warnings == []


@pytest.mark.parametrize("field_type,url", [
    ("video", "https://cdn.example.com/clip.mp4"),
    ("video", "blob:http://localhost/9f2c"),
    ("image", "https://cdn.example.com/logo.png"),
    ("image", "data:image/png;base64,iVBORw0KGgo="),
])
def test_absolute_asset_url_is_not_an_unknown_asset(ctx, field_type, url):
    report = ValidationReport()
    _validate_property_value(
        {"$static": {"path": url}},
        {"type": field_type}, ctx, "/p", report,
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


def test_prop_unknown_page_overlay_arg():
    ctx = _prop_ctx(page_ids={"detail"}, page_property_keys={"detail": frozenset({"motorId"})})
    report = ValidationReport()
    _validate_action(
        {"type": "openDialog", "pageId": "detail", "componentProperties": {"ghost": 1}},
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("prop-unknown", "warning")
    assert w.path == "/a/componentProperties/ghost"
    assert "page 'detail'" in w.message


def test_prop_unknown_page_overlay_arg_declared_is_silent():
    ctx = _prop_ctx(page_ids={"detail"}, page_property_keys={"detail": frozenset({"motorId"})})
    report = ValidationReport()
    _validate_action(
        {"type": "openDialog", "pageId": "detail", "componentProperties": {"motorId": "M1"}},
        ctx, "/a", report,
    )
    assert report.warnings == []


def test_prop_unknown_page_overlay_arg_skipped_when_pages_uncollected():
    ctx = _prop_ctx(page_ids={"detail"})
    report = ValidationReport()
    _validate_action(
        {"type": "openDialog", "pageId": "detail", "componentProperties": {"ghost": 1}},
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


# ── Navigation targets that cannot be reached ────────────────────────────────


@pytest.fixture()
def nav_ctx(ctx) -> ValidationContext:
    """A project whose `motor-detail` page sits in the Dialogs folder."""
    return replace(ctx, dialogs_page_ids=frozenset({"motor-detail"}))


def _root_ctx() -> ValidationContext:
    """`motor-detail` in the Dialogs folder, `home` in the navigable tree."""
    return _prop_ctx(
        page_ids={"motor-detail", "home"},
        dialogs_page_ids=frozenset({"motor-detail"}),
        navigable_page_ids=frozenset({"home"}),
    )


def test_open_dialog_naming_a_navigable_page():
    report = ValidationReport()
    _validate_action({"type": "openDialog", "pageId": "home"}, _root_ctx(), "/a", report)
    w = _warn(report)
    assert (w.code, w.severity, w.path) == ("overlay-wrong-root", "error", "/a/pageId")
    assert "Open Page As Overlay" in w.message


def test_open_page_overlay_naming_the_dialogs_folder():
    report = ValidationReport()
    _validate_action(
        {"type": "openPageOverlay", "pageId": "motor-detail"}, _root_ctx(), "/a", report
    )
    w = _warn(report)
    assert (w.code, w.path) == ("overlay-wrong-root", "/a/pageId")
    assert "Open Dialog" in w.message


def test_each_overlay_action_naming_its_own_root_is_silent():
    ctx = _root_ctx()
    report = ValidationReport()
    _validate_action({"type": "openDialog", "pageId": "motor-detail"}, ctx, "/a", report)
    _validate_action({"type": "openPageOverlay", "pageId": "home"}, ctx, "/b", report)
    # Close spans both roots, so neither target is wrong for it.
    _validate_action({"type": "closePageOverlay", "pageId": "motor-detail"}, ctx, "/c", report)
    _validate_action({"type": "closePageOverlay", "pageId": "home"}, ctx, "/d", report)
    assert report.warnings == []


def test_overlay_root_check_is_skipped_when_the_index_was_not_read():
    # Both membership tests are positive, so empty roots flag nothing rather
    # than flagging every overlay action in the project.
    report = ValidationReport()
    _validate_action(
        {"type": "openDialog", "pageId": "motor-detail"},
        _prop_ctx(page_ids={"motor-detail"}),
        "/a",
        report,
    )
    assert report.warnings == []


def test_page_field_naming_the_dialogs_folder(nav_ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$static": "motor-detail"},
        {"type": "String", "format": "page"}, nav_ctx, "/p", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("page-not-navigable", "error")


def test_page_field_naming_a_bare_id_is_checked_too(nav_ctx):
    report = ValidationReport()
    _validate_property_value(
        "motor-detail",
        {"type": "String", "format": "page"}, nav_ctx, "/p", report,
    )
    assert _warn(report).code == "page-not-navigable"


def test_page_field_naming_a_navigable_page_is_silent(nav_ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$static": "home"},
        {"type": "String", "format": "page"}, nav_ctx, "/p", report,
    )
    assert report.warnings == []


def test_menu_item_linking_to_the_dialogs_folder(nav_ctx):
    report = ValidationReport()
    _validate_property_value(
        [{"type": "page-link", "pageId": "motor-detail", "label": "Motor"}],
        {"type": "menu-items"}, nav_ctx, "/p", report,
    )
    w = _warn(report)
    assert (w.code, w.path) == ("page-not-navigable", "/p/0/pageId")


def test_menu_item_inside_a_submenu_is_checked_too(nav_ctx):
    report = ValidationReport()
    _validate_property_value(
        [
            {"type": "divider"},
            {
                "type": "submenu",
                "label": "Machine",
                "items": [{"type": "page-link", "pageId": "motor-detail"}],
            },
        ],
        {"type": "menu-items"}, nav_ctx, "/p", report,
    )
    assert _warn(report).path == "/p/1/items/0/pageId"


def test_menu_item_linking_to_a_navigable_page_is_silent(nav_ctx):
    report = ValidationReport()
    _validate_property_value(
        [{"type": "page-link", "pageId": "home"}],
        {"type": "menu-items"}, nav_ctx, "/p", report,
    )
    assert report.warnings == []
