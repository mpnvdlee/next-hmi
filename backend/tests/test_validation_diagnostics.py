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
    validate_action_targets,
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
        datasource_writable={
            "PLC": {"Motor/Speed": True, "Motor/Running": True},
            "Sim": {"Motor/Speed": True},
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


def test_var_disabled_is_a_warning_not_an_unknown_variable(ctx):
    disabled = {("PLC", "Motor/Off"), ("PLC", "Counts")}
    ctx = replace(ctx, datasource_disabled=lambda ds, path: (ds, path) in disabled)
    for var_path in ("PLC:Motor/Off", "PLC:Counts[2]"):
        report = ValidationReport()
        validate_var_ref({"path": var_path}, ctx, "/p", report, {"type": "float"})
        w = _warn(report)
        assert (w.code, w.severity) == ("var-disabled", "warning")
        assert "disabled" in w.message
    report = ValidationReport()
    validate_var_ref({"path": "PLC:Missing/Thing"}, ctx, "/p", report, {"type": "string"})
    assert _warn(report).code == "var-unknown"


def test_var_disabled_in_a_datasource_with_nothing_enabled(ctx):
    ctx.datasource_registry["Line"] = {}
    ctx = replace(ctx, datasource_disabled=lambda ds, path: (ds, path) == ("Line", "Speed"))
    report = ValidationReport()
    validate_var_ref({"path": "Line:Speed"}, ctx, "/p", report, {"type": "float"})
    assert _warn(report).code == "var-disabled"


def test_write_target_disabled_variable(ctx):
    ctx = replace(ctx, datasource_disabled=lambda ds, path: (ds, path) == ("PLC", "Motor/Off"))
    report = ValidationReport()
    _validate_action(
        {"type": "writeDataVariable", "target": {"$var": {"path": "PLC:Motor/Off"}}, "value": 1},
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.severity, w.path) == ("var-disabled", "warning", "/a/target")


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
        {"type": "writeDataVariable", "target": {"$var": {"path": "Sim:Motor/Speed"}}, "value": 1},
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("var-test-server", "error")
    assert w.path == "/a/target"


def test_write_target_unknown_variable(ctx):
    report = ValidationReport()
    _validate_action(
        {"type": "writeDataVariable", "target": {"$var": {"path": "PLC:Motor/Ghost"}}, "value": 1},
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("var-unknown", "error")
    assert w.path == "/a/target"


def test_write_target_incomplete(ctx):
    report = ValidationReport()
    _validate_action({"type": "writeDataVariable", "value": 1}, ctx, "/a", report)
    w = _warn(report)
    assert (w.code, w.severity) == ("var-empty", "warning")


def test_toggle_target_unknown_variable(ctx):
    report = ValidationReport()
    _validate_action(
        {"type": "toggleDataVariable", "target": {"$var": {"path": "PLC:Motor/Ghost"}}},
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.path) == ("var-unknown", "/a/target")


def test_toast_severity_invalid(ctx):
    report = ValidationReport()
    _validate_action(
        {"type": "showToast", "message": "hi", "severity": "fatal"}, ctx, "/a", report
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("toast-severity-invalid", "error")
    assert w.path == "/a/severity"


def test_toast_severity_success_is_valid(ctx):
    report = ValidationReport()
    _validate_action(
        {"type": "showToast", "message": "hi", "severity": "success"}, ctx, "/a", report
    )
    assert report.to_dict()["warnings"] == []


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
        {"type": "writeDataVariable", "target": {"$var": {"path": "PLC:Motor/Speed"}}, "value": 1},
        ctx, "/a", report,
    )
    assert report.warnings == []
    assert report.findings == []


def test_write_target_in_result_handler(ctx):
    report = ValidationReport()
    _validate_action(
        {
            "type": "writeDataVariable",
            "target": {"$var": {"path": "PLC:Motor/Speed"}},
            "value": 1,
            "onSuccess": [
                {"type": "writeDataVariable", "target": {"$var": {"path": "Sim:Motor/Speed"}}, "value": 2}
            ],
        },
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.path) == ("var-test-server", "/a/onSuccess/0/target")


def test_write_target_in_if_branch(ctx):
    report = ValidationReport()
    _validate_action(
        {
            "type": "if",
            "condition": {"$var": {"path": "PLC:Motor/Running"}},
            "then": [],
            "else": [{"type": "toggleDataVariable", "target": {"$var": {"path": "PLC:Motor/Ghost"}}}],
        },
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.path) == ("var-unknown", "/a/else/0/target")


def test_write_target_in_alert_handler(ctx):
    report = ValidationReport()
    _validate_action(
        {
            "type": "showAlert",
            "title": "Confirm",
            "onOk": [
                {"type": "writeDataVariable", "target": {"$var": {"path": "Sim:Motor/Speed"}}, "value": 2}
            ],
        },
        ctx, "/a", report,
    )
    w = _warn(report)
    assert (w.code, w.path) == ("var-test-server", "/a/onOk/0/target")


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


_INTEGER = {"kind": "scalar", "base": "Integer", "array": False}
_FLOAT = {"kind": "scalar", "base": "Float", "array": False}
_STRING = {"kind": "scalar", "base": "String", "array": False}


def _var_type_codes(ctx, var_path: str, field: dict, **ref) -> list[str]:
    report = ValidationReport()
    validate_var_ref({"path": var_path, **ref}, ctx, "/p", report, field)
    assert report.findings == []
    return [w.code for w in report.warnings]


def test_float_and_integer_slots_take_only_their_own_base(ctx):
    ctx.datasource_registry["PLC"]["Count"] = _INTEGER
    assert _var_type_codes(ctx, "PLC:Count", {"type": "float"}) == ["var-type"]
    assert _var_type_codes(ctx, "PLC:Count", {"type": ["float", "integer"]}) == []
    ctx.datasource_registry["PLC"]["Speed"] = _FLOAT
    assert _var_type_codes(ctx, "PLC:Speed", {"type": "integer"}) == ["var-type"]


@pytest.mark.parametrize("kind", ["color", "Color", "icon", "image", "video"])
def test_string_bound_editor_kinds_take_a_string_variable(ctx, kind):
    ctx.datasource_registry["PLC"]["Label"] = _STRING
    assert _var_type_codes(ctx, "PLC:Label", {"type": kind}) == []
    assert _var_type_codes(ctx, "PLC:Motor/Speed", {"type": kind}) == ["var-type"]


@pytest.fixture()
def struct_ctx(ctx):
    ctx.datasource_registry["PLC"].update({
        "Motor": {"kind": "struct", "name": "Motor", "array": False, "fields": ["Speed", "Name", "Tint", "Limits"]},
        "Motor/Speed": _FLOAT,
        "Motor/Name": _STRING,
        "Motor/Tint": _INTEGER,
        "Motor/Limits": {"kind": "struct", "name": "Limits", "array": False, "fields": ["Max"]},
        "Motor/Limits/Max": _INTEGER,
        "Motors": {"kind": "struct", "name": "Motors", "array": True, "fields": ["Speed"]},
        "Motors/Line[1]": {"kind": "struct", "name": "Line[1]", "array": False, "fields": ["Speed"]},
        "Motors/Line[1]/Speed": _FLOAT,
        "Motors/Line[0]": {"kind": "struct", "name": "Line[0]", "array": False, "fields": ["Speed"]},
        "Motors/Line[0]/Speed": _FLOAT,
    })
    ctx.datasource_writable = {
        "PLC": {
            "Motor/Speed": True,
            "Motor/Name": False,
            "Motor/Limits/Max": False,
            "Motors/Line[0]/Speed": False,
            "Motors/Line[1]/Speed": True,
        }
    }
    return ctx


@pytest.mark.parametrize(
    ("required", "code"),
    [
        (["Speed", "Name"], None),
        ([{"name": "Name", "type": "Float"}], "var-type"),
        ([{"name": "Tint", "type": "color"}], "var-type"),
        ([{"name": "Name", "type": "color"}], None),
        ([{"name": "Speed", "write": True}], None),
        ([{"name": "Name", "write": True}], "var-readonly"),
        ([{"name": "Limits", "requiredFields": [{"name": "Max", "type": "Float"}]}], "var-type"),
        ([{"name": "Limits", "requiredFields": [{"name": "Max", "type": "Integer"}]}], None),
        ([{"name": "Limits", "requiredFields": [{"name": "Max", "write": True}]}], "var-readonly"),
        ([{"name": "Limits", "requiredFields": ["Min"]}], "var-type"),
        ([{"name": "Speed", "requiredFields": ["Max"]}], "var-type"),
    ],
)
def test_struct_members_are_checked_for_type_and_access(struct_ctx, required, code):
    field = {"type": "Motor", "requiredFields": required}
    assert _var_type_codes(struct_ctx, "PLC:Motor", field) == ([code] if code else [])


def test_struct_member_failures_name_the_member(struct_ctx):
    report = ValidationReport()
    field = {"type": "Motor", "requiredFields": [{"name": "Name", "write": True}]}
    validate_var_ref({"path": "PLC:Motor"}, struct_ctx, "/p", report, field)
    assert report.warnings[0].message == (
        "member 'Name' of variable 'PLC:Motor' is read-only, and this field writes to it"
    )
    report = ValidationReport()
    field = {"type": "Motor", "requiredFields": [{"name": "Limits", "requiredFields": ["Min"]}]}
    validate_var_ref({"path": "PLC:Motor"}, struct_ctx, "/p", report, field)
    assert "member 'Limits/Min' is missing" in report.warnings[0].message


def test_struct_array_members_are_read_off_the_bound_element(struct_ctx):
    written = [{"name": "Speed", "write": True}]
    whole = {"type": "Motor[]", "requiredFields": written}
    one = {"type": "Motor", "requiredFields": written}
    # Unindexed, the lowest-index element counts whatever order the registry
    # lists them in: Line[0], whose Speed is read-only.
    assert _var_type_codes(struct_ctx, "PLC:Motors", whole) == ["var-readonly"]
    assert _var_type_codes(struct_ctx, "PLC:Motors", one, repeatIndex=True) == ["var-readonly"]
    # A bound index is judged on that element; one that does not exist falls
    # back to the lowest.
    assert _var_type_codes(struct_ctx, "PLC:Motors", one, index=1) == []
    assert _var_type_codes(struct_ctx, "PLC:Motors", one, index=0) == ["var-readonly"]
    assert _var_type_codes(struct_ctx, "PLC:Motors", one, index=7) == ["var-readonly"]
    struct_ctx.datasource_writable["PLC"]["Motors/Line[0]/Speed"] = True
    assert _var_type_codes(struct_ctx, "PLC:Motors", whole) == []


def test_one_based_struct_array_is_still_judged(struct_ctx):
    registry = struct_ctx.datasource_registry["PLC"]
    for key in [k for k in registry if k.startswith("Motors/Line[0]")]:
        registry[key.replace("Line[0]", "Line[2]")] = registry.pop(key)
    struct_ctx.datasource_writable["PLC"]["Motors/Line[1]/Speed"] = False
    field = {"type": "Motor[]", "requiredFields": [{"name": "Speed", "write": True}]}
    assert _var_type_codes(struct_ctx, "PLC:Motors", field) == ["var-readonly"]


def test_read_only_variable_bound_to_a_writing_field(struct_ctx):
    struct_ctx.datasource_registry["PLC"]["Setpoints"] = {"kind": "scalar", "base": "Float", "array": True}
    struct_ctx.datasource_writable["PLC"].update({"Setpoints": False, "Motor/Speed": False})
    written = {"type": "float", "write": True}
    assert _var_type_codes(struct_ctx, "PLC:Motor/Speed", written) == ["var-readonly"]
    assert _var_type_codes(struct_ctx, "PLC:Motor/Speed", {"type": "float"}) == []
    assert _var_type_codes(struct_ctx, "PLC:Setpoints", written, index=1) == ["var-readonly"]
    # Access that is not known is read-only, as the picker reads it.
    del struct_ctx.datasource_writable["PLC"]["Motor/Speed"]
    assert _var_type_codes(struct_ctx, "PLC:Motor/Speed", written) == ["var-readonly"]
    struct_ctx.datasource_writable = {}
    assert _var_type_codes(struct_ctx, "PLC:Setpoints", written, index=1) == ["var-readonly"]
    # A datasource whose variables are not collected yet is not judged at all.
    struct_ctx.datasource_registry["Fresh"] = {}
    assert _var_type_codes(struct_ctx, "Fresh:Motor/Speed", written) == []


def test_struct_member_access_is_read_only_without_access_information(struct_ctx):
    struct_ctx.datasource_writable = {}
    field = {"type": "Motor", "requiredFields": [{"name": "Speed", "write": True}]}
    assert _var_type_codes(struct_ctx, "PLC:Motor", field) == ["var-readonly"]
    # A struct has no access of its own: without write members it is not judged.
    assert _var_type_codes(struct_ctx, "PLC:Motor", {"write": True}) == []


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


def _condition_codes(ctx, where: str, condition) -> list[str]:
    report = ValidationReport()
    if where == "action":
        _validate_action({"type": "if", "condition": condition}, ctx, "/a", report)
    elif where == "$if":
        _validate_property_value(
            {"$if": {"condition": condition, "true": 1, "false": 2}}, None, ctx, "/p", report,
        )
    elif where in ("$and", "$or"):
        _validate_property_value({where: [{"$static": True}, condition]}, None, ctx, "/p", report)
    else:
        _validate_property_value({"$not": {"value": condition}}, None, ctx, "/p", report)
    return [w.code for w in report.warnings]


@pytest.mark.parametrize("where", ["action", "$if", "$not", "$and", "$or"])
def test_condition_takes_a_boolean_not_any_value_truthiness(ctx, where):
    assert _condition_codes(ctx, where, {"$var": {"path": "PLC:Motor/Running"}}) == []
    assert _condition_codes(ctx, where, {"$var": {"path": "PLC:Motor/Speed"}}) == ["var-type"]


@pytest.mark.parametrize("where", ["action", "$if", "$not", "$and", "$or"])
def test_condition_compares_a_number_through_compare(ctx, where):
    compare = {"$compare": {
        "left": {"$var": {"path": "PLC:Motor/Speed"}}, "operator": ">", "right": 80,
    }}
    assert _condition_codes(ctx, where, compare) == []


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


def test_not_value_empty(ctx):
    report = ValidationReport()
    _validate_property_value({"$not": {"value": None}}, None, ctx, "/p", report)
    w = _warn(report)
    assert (w.code, w.severity) == ("not-value-empty", "warning")


def test_not_validates_nested_value(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$not": {"value": {"$compare": {"left": None, "operator": ">", "right": 1}}}},
        None, ctx, "/p", report,
    )
    assert "compare-operand-empty" in {w.code for w in report.warnings}


@pytest.mark.parametrize("key", ["$and", "$or"])
def test_and_or_reports(ctx, key):
    name = key[1:]
    report = ValidationReport()
    _validate_property_value({key: []}, None, ctx, "/p", report)
    assert (_warn(report).code, _warn(report).severity) == (f"{name}-empty", "error")

    report = ValidationReport()
    _validate_property_value({key: [{"$static": True}, None]}, None, ctx, "/p", report)
    w = _warn(report)
    assert (w.path, w.code, w.severity) == (f"/p/{key}/1", f"{name}-item-empty", "warning")

    report = ValidationReport()
    _validate_property_value({key: {"value": True}}, None, ctx, "/p", report)
    assert [f.message for f in report.findings] == [f"{key} payload must be a list of conditions"]


@pytest.mark.parametrize("key", ["$and", "$or"])
def test_and_or_fill_a_boolean_field_and_nest(ctx, key):
    report = ValidationReport()
    value = {key: [{"$not": {"value": {"$static": False}}}, {"$and": [{"$static": True}]}]}
    _validate_property_value(value, {"type": "Boolean"}, ctx, "/p", report)
    assert report.warnings == [] and report.findings == []

    report = ValidationReport()
    _validate_property_value({key: [{"$static": True}]}, {"type": "Integer"}, ctx, "/p", report)
    assert _warn(report).code == "source-type"


def test_formula_empty(ctx):
    report = ValidationReport()
    _validate_property_value({"$formula": {"expression": " ", "wildcards": {}}}, None, ctx, "/p", report)
    w = _warn(report)
    assert (w.code, w.severity) == ("formula-empty", "warning")


@pytest.mark.parametrize("expression", ["1 +", "(1 + 2", "1 2", "1 ^ 2", "{a} + 1", "2 * * 3", "()"])
def test_formula_invalid(ctx, expression):
    report = ValidationReport()
    _validate_property_value(
        {"$formula": {"expression": expression, "wildcards": {}}}, None, ctx, "/p", report,
    )
    w = _warn(report)
    assert (w.code, w.severity) == ("formula-invalid", "error")


@pytest.mark.parametrize("expression", ["1 + 2 * 3", "(1 + 2) * 3", "-2 * -(3 + 1)", ".5 * 4", "{ 1 } / 2.5"])
def test_formula_valid(ctx, expression):
    report = ValidationReport()
    _validate_property_value(
        {"$formula": {"expression": expression, "wildcards": {"1": {"$static": 3}}}},
        None, ctx, "/p", report,
    )
    assert report.warnings == []
    assert report.findings == []


def test_formula_wildcard_empty(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$formula": {"expression": "{1} * {2}", "wildcards": {"1": {"$static": 3}}}},
        None, ctx, "/p", report,
    )
    w = _warn(report)
    assert (w.code, w.path) == ("formula-wildcard-empty", "/p/$formula/wildcards/2")


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


def test_stringexpr_wildcard_row_the_editor_added_is_unbound_but_a_cleared_static_is_not(ctx):
    # The editor seeds a typed placeholder's row as an empty $var; a Static the
    # author cleared is stored as "" and is a value (an optional query part, say).
    report = ValidationReport()
    _validate_property_value(
        {"$stringExpr": {"template": "{1} {2}", "wildcards": {"1": "", "2": {"$var": {"path": ""}}}}},
        None, ctx, "/p", report,
    )
    assert [(w.code, w.path) for w in report.warnings] == [
        ("stringexpr-wildcard-empty", "/p/$stringExpr/wildcards/2"),
    ]


@pytest.mark.parametrize(
    "template",
    ["{Round2(1)}", "{Trim(Round1(1))} g", "{ Signed( Round2(1) ) }", "{Thousands(Round4(1))}"],
)
def test_stringexpr_digits_in_function_names_are_not_wildcards(ctx, template):
    report = ValidationReport()
    _validate_property_value(
        {"$stringExpr": {"template": template, "wildcards": {"1": {"$static": 3}}}},
        None, ctx, "/p", report,
    )
    assert report.warnings == []


@pytest.mark.parametrize("template", ["{Round2}", "{abc}", "{1.5}", "{Round2()}"])
def test_stringexpr_non_wildcard_braces_are_not_wildcards(ctx, template):
    report = ValidationReport()
    _validate_property_value(
        {"$stringExpr": {"template": template, "wildcards": {}}},
        None, ctx, "/p", report,
    )
    assert report.warnings == []


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


def _array_ctx(ctx: ValidationContext) -> ValidationContext:
    registry = dict(ctx.datasource_registry)
    registry["PLC"] = {
        **registry["PLC"],
        "Safety/Open": {"kind": "scalar", "base": "Boolean", "array": True, "length": 27},
    }
    return replace(
        ctx,
        datasource_registry=registry,
        datasource_writable={"PLC": {**ctx.datasource_writable["PLC"], "Safety/Open": True}},
        input_schema={"device": {"type": "Integer"}, "label": {"type": "String"}},
    )


def test_bound_index_reading_an_integer_input_is_clean(ctx):
    report = ValidationReport()
    value = {"$var": {"path": "PLC:Safety/Open", "index": {"$componentProp": "device"}}}
    _validate_property_value(value, {"type": "Boolean"}, _array_ctx(ctx), "/p", report)
    assert report.warnings == [] and report.findings == []


@pytest.mark.parametrize(
    "index, code",
    [
        ({"$loc": "app.title"}, "source-type"),
        ({"$componentProp": "label"}, "componentprop-type"),
    ],
)
def test_bound_index_must_give_an_integer(ctx, index, code):
    report = ValidationReport()
    value = {"$var": {"path": "PLC:Safety/Open", "index": index}}
    _validate_property_value(value, {"type": "Boolean"}, _array_ctx(ctx), "/p", report)
    w = _warn(report)
    assert w.code == code
    assert w.path == "/p/$var/index"


@pytest.mark.parametrize(
    "index, codes",
    [({"$componentProp": "device"}, []), ({"$componentProp": "label"}, ["componentprop-type"])],
)
def test_bound_index_on_a_write_target(ctx, index, codes):
    report = ValidationReport()
    action = {"type": "toggleDataVariable", "target": {"$var": {"path": "PLC:Safety/Open", "index": index}}}
    validate_action_targets([action], _array_ctx(ctx), "/a", report)
    assert [w.code for w in report.warnings] == codes


def test_whole_array_on_a_one_value_field_anchors_on_its_index(ctx):
    report = ValidationReport()
    value = {"$var": {"path": "PLC:Safety/Open"}}
    _validate_property_value(value, {"type": "Boolean"}, _array_ctx(ctx), "/p", report)
    w = _warn(report)
    assert (w.code, w.path) == ("var-type", "/p/$var/index")
    assert "choose an element" in w.message


@pytest.mark.parametrize("kind", ["toggleDataVariable", "writeDataVariable"])
def test_whole_array_toggle_target_anchors_on_its_index(ctx, kind):
    report = ValidationReport()
    action = {"type": kind, "target": {"$var": {"path": "PLC:Safety/Open"}}}
    validate_action_targets([action], _array_ctx(ctx), "/a", report)
    # A write may write the whole array; a toggle needs one element.
    expected = [("/a/0/target/$var/index", "toggle-target-type")] if kind == "toggleDataVariable" else []
    assert [(w.path, w.code) for w in report.warnings] == expected


def test_read_only_whole_array_toggle_target_asks_for_its_element_and_says_read_only(ctx):
    array_ctx = _array_ctx(ctx)
    array_ctx.datasource_writable["PLC"]["Safety/Open"] = False
    report = ValidationReport()
    action = {"type": "toggleDataVariable", "target": {"$var": {"path": "PLC:Safety/Open"}}}
    validate_action_targets([action], array_ctx, "/a", report)
    assert [(w.path, w.code) for w in report.warnings] == [
        ("/a/0/target/$var/index", "toggle-target-type"),
        ("/a/0/target", "write-target-type"),
    ]
    assert "read-only" in report.warnings[1].message


def _overlay_ctx(ctx: ValidationContext) -> ValidationContext:
    return replace(
        ctx,
        dialogs_page_ids=frozenset({"device"}),
        page_property_keys={"device": frozenset({"device"})},
    )


@pytest.mark.parametrize(
    "payload, code, severity",
    [
        ({"page": "", "param": ""}, "overlay-empty", "warning"),
        ({"page": "device", "param": ""}, "overlay-empty", "warning"),
        ({"page": "dashboard", "param": "device"}, "overlay-page", "error"),
        ({"page": "device", "param": "motor"}, "overlay-param-unknown", "error"),
    ],
)
def test_overlay_reports(ctx, payload, code, severity):
    report = ValidationReport()
    _validate_property_value({"$overlay": payload}, None, _overlay_ctx(ctx), "/p", report)
    w = _warn(report)
    assert (w.code, w.severity) == (code, severity)


def test_overlay_reading_a_declared_input_is_clean(ctx):
    report = ValidationReport()
    _validate_property_value(
        {"$overlay": {"page": "device", "param": "device"}}, None, _overlay_ctx(ctx), "/p", report,
    )
    assert report.warnings == [] and report.findings == []


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


def _station_link_instance(target: str) -> ValidationReport:
    decl = {"target": {"type": "string", "label": "Target", "format": "page"}}
    ctx = replace(
        _root_ctx(),
        component_ids={"station-link"},
        component_property_keys={"station-link": frozenset(decl)},
        component_properties={"station-link": decl},
    )
    return validate_widget_node(_node("$component:station-link", {"target": target}), ctx)


def test_a_component_page_input_takes_a_navigable_page():
    report = _station_link_instance("home")
    assert (report.findings, report.warnings) == ([], [])


@pytest.mark.parametrize(
    "target, code", [("motor-detail", "page-not-navigable"), ("gone", "page-unknown")]
)
def test_a_component_page_input_flags_a_page_navigation_cannot_reach(target, code):
    w = _warn(_station_link_instance(target))
    assert (w.code, w.path) == (code, "/properties/target")


def test_navigate_inside_a_component_to_its_page_input():
    ctx = _dialog_scope(target={"type": "string", "label": "Target", "format": "page"})
    assert _navigate({"$componentProp": "target"}, ctx).warnings == []


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


def test_page_field_naming_no_page():
    report = ValidationReport()
    _validate_property_value("gone", {"type": "String", "format": "page"}, _root_ctx(), "/p", report)
    assert (_warn(report).code, _warn(report).severity) == ("page-unknown", "error")


def _navigate(page_id, ctx: ValidationContext) -> ValidationReport:
    report = ValidationReport()
    _validate_action({"type": "navigateToPage", "pageId": page_id}, ctx, "/a", report)
    return report


def _dialog_scope(**inputs) -> ValidationContext:
    return replace(_root_ctx(), input_schema=inputs)


def test_navigate_to_a_navigable_page_is_silent():
    report = _navigate("home", _root_ctx())
    assert (report.findings, report.warnings) == ([], [])


def test_navigate_to_an_unknown_page():
    report = _navigate("gone", _root_ctx())
    assert [f.message for f in report.findings] == ["action target page 'gone' does not exist"]
    assert report.warnings == []


def test_navigate_to_a_page_file_no_root_lists():
    # The file exists, so the page-field finding stays quiet, but nothing routes there.
    ctx = replace(_root_ctx(), page_ids={"motor-detail", "home", "orphan"})
    report = _navigate("orphan", ctx)
    assert report.findings == []
    assert [(w.code, w.path) for w in report.warnings] == [("page-unknown", "/a/pageId")]


def test_navigate_to_the_dialogs_folder():
    w = _warn(_navigate("motor-detail", _root_ctx()))
    assert (w.code, w.severity, w.path) == ("page-not-navigable", "error", "/a/pageId")
    assert "Open Dialog" in w.message


def test_navigate_to_a_page_input():
    ctx = _dialog_scope(stationPage={"type": "String", "format": "page"})
    assert _navigate({"$componentProp": "stationPage"}, ctx).warnings == []


@pytest.mark.parametrize(
    "inputs",
    [{"stationPage": {"type": "String"}}, {}],
    ids=["not-format-page", "undeclared"],
)
def test_navigate_to_an_input_that_is_not_a_page(inputs):
    w = _warn(_navigate({"$componentProp": "stationPage"}, _dialog_scope(**inputs)))
    assert (w.code, w.severity) == ("navigate-input-not-page", "error")


def test_navigate_to_an_input_outside_a_dialog():
    ctx = replace(_root_ctx(), input_scope=False)
    assert _warn(_navigate({"$componentProp": "stationPage"}, ctx)).code == "navigate-input-not-page"


_REPEATED_ICON = {"$static": {"type": "custom", "path": {"$repeatItem": {"member": "icon"}}}}


@pytest.mark.parametrize(
    "value, field_type",
    [
        (_REPEATED_ICON, "icon"),
        ({"$static": {"type": "builtin", "name": {"$repeatItem": {"member": "icon"}}}}, "icon"),
        ({"$static": {"path": {"$repeatItem": {"member": "photo"}}}}, "image"),
    ],
)
def test_a_repeat_item_naming_the_asset_over_a_list_is_not_an_unknown_asset(ctx, value, field_type):
    # Each copy gets its item's text as the path (substituteRepeatRefs).
    rctx = replace(ctx, repeat_scope=True, repeat_items=[{"icon": "icons/door.svg"}])
    report = ValidationReport()
    _validate_property_value(value, {"type": field_type}, rctx, "/p", report)
    assert (report.findings, report.warnings) == ([], [])


def test_a_repeat_item_naming_the_asset_over_a_variable_says_to_bind_the_field(ctx):
    rctx = replace(ctx, repeat_scope=True, repeat_items={"$var": {"path": "PLC:Doors"}})
    report = ValidationReport()
    _validate_property_value(_REPEATED_ICON, {"type": "icon"}, rctx, "/p", report)
    assert _warn(report).code == "repeatitem-in-static"


def test_a_repeat_item_naming_the_asset_outside_a_repeater(ctx):
    report = ValidationReport()
    _validate_property_value(_REPEATED_ICON, {"type": "icon"}, ctx, "/p", report)
    assert _warn(report).code == "repeatitem-no-scope"


def _write_formula(target_base: str) -> ValidationReport:
    ctx = ValidationContext(
        widget_schemas={"version": 2, "builtin": {}, "custom": {}},
        datasource_registry={
            "PLC": {"Count": {"kind": "scalar", "base": target_base, "array": False}}
        },
        datasource_writable={"PLC": {"Count": True}},
        datasource_types={"PLC": "opcua-client"},
    )
    report = ValidationReport()
    formula = {"$formula": {"expression": "{1} + 1", "wildcards": {"1": {"$var": {"path": "PLC:Count"}}}}}
    _validate_action(
        {"type": "writeDataVariable", "target": {"$var": {"path": "PLC:Count"}}, "value": formula},
        ctx, "/a", report,
    )
    return report


@pytest.mark.parametrize("base", ["Integer", "Float"])
def test_a_formula_value_can_be_written_to_a_number_tag(base):
    # Into an integer tag the write path takes a whole result and refuses a
    # fraction as lossy (test_write_service), so validation does not refuse it.
    assert _write_formula(base).warnings == []


def test_a_formula_value_still_does_not_fit_a_boolean_tag():
    assert _warn(_write_formula("Boolean")).code == "source-type"


def _write_to_input(kind: str, ctx: ValidationContext, name: str = "value") -> ValidationReport:
    report = ValidationReport()
    action = {"type": kind, "target": {"$componentProp": name}}
    if kind == "writeDataVariable":
        action["value"] = 1
    _validate_action(action, ctx, "/a", report)
    return report


@pytest.mark.parametrize("kind", ["writeDataVariable", "editValue"])
def test_write_target_naming_a_writable_input_is_clean(kind):
    # The compressor parameter row: the instance passes the variable as `value`.
    ctx = _dialog_scope(value={"type": "float", "label": "Value", "write": True})
    report = _write_to_input(kind, ctx)
    assert (report.findings, report.warnings) == ([], [])


def test_toggle_target_naming_a_writable_boolean_input_is_clean():
    ctx = _dialog_scope(run={"type": "boolean", "write": True})
    assert _write_to_input("toggleDataVariable", ctx, "run").warnings == []


@pytest.mark.parametrize(
    "inputs, code",
    [
        ({"value": {"type": "float"}}, "componentprop-type"),
        ({"value": {"type": "string", "write": True}}, "componentprop-type"),
        ({}, "componentprop-unknown"),
    ],
    ids=["not-writable", "wrong-type", "undeclared"],
)
def test_edit_value_target_naming_an_input_that_cannot_take_it(inputs, code):
    w = _warn(_write_to_input("editValue", _dialog_scope(**inputs)))
    assert (w.code, w.path) == (code, "/a/target")


def test_write_target_naming_an_input_outside_any_input_scope():
    ctx = replace(_root_ctx(), input_scope=False)
    assert _warn(_write_to_input("editValue", ctx)).code == "componentprop-no-scope"


@pytest.mark.parametrize("page_id", [{"$static": "home"}, {"$var": {"path": "PLC:Page"}}])
def test_navigate_takes_nothing_else(page_id):
    assert _warn(_navigate(page_id, _root_ctx())).code == "navigate-target-invalid"


def test_open_dialog_passing_a_page_input_checks_the_page():
    ctx = replace(
        _root_ctx(),
        page_properties={"motor-detail": {"stationPage": {"type": "String", "format": "page"}}},
    )
    for value, code in [("gone", "page-unknown"), ("motor-detail", "page-not-navigable")]:
        report = ValidationReport()
        _validate_action(
            {"type": "openDialog", "pageId": "motor-detail", "componentProperties": {"stationPage": value}},
            ctx, "/a", report,
        )
        assert [w.code for w in report.warnings] == [code]
    report = ValidationReport()
    _validate_action(
        {"type": "openDialog", "pageId": "motor-detail", "componentProperties": {"stationPage": "home"}},
        ctx, "/a", report,
    )
    assert report.warnings == []
