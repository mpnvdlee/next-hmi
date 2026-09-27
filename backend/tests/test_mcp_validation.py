"""Structural validators — strict mode, $var ref resolution, action targets."""


import pytest
from core.validation import (
    ValidationContext,
    validate_config_areas,
    validate_page,
    validate_var_ref,
    validate_widget_node,
)
from core.validation.report import ValidationReport


@pytest.fixture()
def ctx() -> ValidationContext:
    return ValidationContext(
        widget_schemas={
            "version": 2,
            "builtin": {
                "Container": {
                    "name": "Container",
                    "category": "Layout",
                    "schema": {"title": {"type": "string"}},
                },
                "Button": {
                    "name": "Button",
                    "category": "Controls",
                    "schema": {
                        "label": {"type": "string"},
                        "actions": {"type": "actions"},
                    }
                },
                "Repeater": {
                    "name": "Repeater",
                    "category": "Layout",
                    "repeatsChildren": "items",
                    "schema": {"items": {"type": "item-list"}},
                },
            },
            "custom": {},
        },
        datasource_registry={
            "PLC": {
                "Motor/Speed": {"kind": "scalar", "base": "String", "array": False},
                "Motor/Running": {"kind": "scalar", "base": "String", "array": False},
                "Names": {"kind": "scalar", "base": "String", "array": True},
                "Motors": {"kind": "struct", "name": "Motor", "array": True, "fields": ["Name", "Speed"]},
                "Motors/Line[0]/Name": {"kind": "scalar", "base": "String", "array": False},
                "Motors/Line[0]/Speed": {"kind": "scalar", "base": "Float", "array": False},
            },
        },
        page_ids={"page-home", "page-detail"},
        component_ids=set(),
    )


def test_validate_widget_node_unknown_type_reports(ctx):
    report = validate_widget_node({"type": "Mystery"}, ctx)
    assert not report.ok
    assert "unknown widget type" in report.findings[0].message


def test_validate_widget_node_accepts_known_type(ctx):
    report = validate_widget_node(
        {"type": "Container", "properties": {"title": "Home"}},
        ctx,
    )
    assert report.ok


def test_validate_widget_node_type_mismatch(ctx):
    report = validate_widget_node(
        {"type": "Container", "properties": {"title": 123}},
        ctx,
    )
    assert not report.ok
    assert "expected String, got Integer" in report.findings[0].message


def test_validate_widget_node_accepts_recipe_binding(ctx):
    report = validate_widget_node(
        {
            "type": "Container",
            "properties": {"title": {"$recipe": {"type": "batch", "field": "activeName"}}},
        },
        ctx,
    )
    assert report.ok


def test_validate_var_ref_unknown_datasource(ctx):
    report = ValidationReport()
    validate_var_ref({"path": "Nope:X/Y"}, ctx, "", report)
    assert report.ok  # warnings don't fail validation
    assert any("unknown datasource" in w.message for w in report.warnings)


def test_validate_var_ref_unknown_path(ctx):
    report = ValidationReport()
    validate_var_ref({"path": "PLC:Motor/Bogus"}, ctx, "", report)
    assert report.ok  # warnings don't fail validation
    assert any("unknown variable" in w.message for w in report.warnings)


def test_validate_var_ref_empty_datasource_warns(ctx):
    report = ValidationReport()
    validate_var_ref({"path": ":X/Y"}, ctx, "", report)
    assert report.ok  # editor produces empty bindings during editing; must not block save
    assert any("datasource is empty" in w.message for w in report.warnings)


def test_validate_var_ref_empty_path_warns(ctx):
    report = ValidationReport()
    validate_var_ref({"path": "PLC:"}, ctx, "", report)
    assert report.ok
    assert any("path is empty" in w.message for w in report.warnings)


def test_validate_widget_node_accepts_var_binding(ctx):
    report = validate_widget_node(
        {
            "type": "Container",
            "properties": {"title": {"$var": {"path": "PLC:Motor/Speed"}}},
        },
        ctx,
    )
    assert report.ok


def test_validate_action_target_missing_page(ctx):
    report = validate_widget_node(
        {
            "type": "Button",
            "properties": {
                "label": "Go",
                "actions": {
                    "onClick": [{"type": "openPage", "target": "page-missing"}]
                },
            },
        },
        ctx,
    )
    assert not report.ok
    assert "does not exist" in report.findings[0].message


def test_validate_widget_node_accepts_loc_string(ctx):
    report = validate_widget_node(
        {"type": "Container", "properties": {"title": {"$loc": "page.title"}}},
        ctx,
    )
    assert report.ok


def test_validate_widget_node_rejects_loc_object_payload(ctx):
    # Common agent mistake: `{ "$loc": { "key": "..." } }` silently resolves to
    # null at render time. The validator must catch this on write.
    report = validate_widget_node(
        {"type": "Container", "properties": {"title": {"$loc": {"key": "page.title"}}}},
        ctx,
    )
    assert not report.ok
    assert any("$loc payload must be a string" in f.message for f in report.findings)


# ── Repeater scope ──────────────────────────────────────────────────────────────


def _warning_codes(report: ValidationReport) -> list[str]:
    return [w.code for w in report.warnings]


def _in_repeater(child: dict) -> dict:
    return {
        "type": "Repeater",
        "properties": {"items": {"$var": {"path": "PLC:Names"}}},
        "children": [child],
    }


def test_repeat_item_inside_a_repeater_is_clean(ctx):
    child = {
        "type": "Container",
        "properties": {"title": {"$repeatItem": {"field": "value", "member": "Name"}}},
    }
    report = validate_widget_node(_in_repeater(child), ctx)
    assert report.ok
    assert "repeatitem-no-scope" not in _warning_codes(report)


def test_repeat_item_outside_a_repeater_warns(ctx):
    report = validate_widget_node(
        {"type": "Container", "properties": {"title": {"$repeatItem": {}}}},
        ctx,
    )
    assert report.ok
    assert "repeatitem-no-scope" in _warning_codes(report)


def test_repeat_index_outside_a_repeater_warns(ctx):
    report = validate_widget_node(
        {"type": "Container", "properties": {"title": {"$var": {"path": "PLC:Names", "repeatIndex": True}}}},
        ctx,
    )
    assert "repeatitem-no-scope" in _warning_codes(report)


def test_repeat_item_rejects_an_unknown_field(ctx):
    report = validate_widget_node(
        _in_repeater({"type": "Container", "properties": {"title": {"$repeatItem": {"field": "row"}}}}),
        ctx,
    )
    assert not report.ok


def test_repeat_index_binding_is_type_checked_as_one_element(ctx):
    indexed = {"type": "Container", "properties": {"title": {"$var": {"path": "PLC:Names", "repeatIndex": True}}}}
    whole = {"type": "Container", "properties": {"title": {"$var": {"path": "PLC:Names"}}}}
    assert "var-type" not in _warning_codes(validate_widget_node(_in_repeater(indexed), ctx))
    assert "var-type" in _warning_codes(validate_widget_node(_in_repeater(whole), ctx))


def _titled(source: dict, items: str = "PLC:Names") -> dict:
    return {
        "type": "Repeater",
        "properties": {"items": {"$var": {"path": items}}},
        "children": [{"type": "Container", "properties": {"title": source}}],
    }


@pytest.mark.parametrize(
    ("payload", "items", "mismatch"),
    [
        ({"field": "value"}, "PLC:Names", False),
        ({"field": "index"}, "PLC:Names", True),
        ({"field": "value", "member": "Name"}, "PLC:Motors", False),
        ({"field": "value", "member": "Speed"}, "PLC:Motors", True),
        ({"field": "value"}, "PLC:Motors", True),
        ({"field": "value", "member": "Unknown"}, "PLC:Motors", False),
    ],
)
def test_repeat_item_is_type_checked_against_its_field(ctx, payload, items, mismatch):
    codes = _warning_codes(validate_widget_node(_titled({"$repeatItem": payload}, items), ctx))
    assert ("repeatitem-type" in codes) is mismatch


def _in_motors(prop: str, source: dict) -> dict:
    return {
        "type": "Repeater",
        "properties": {"items": {"$var": {"path": "PLC:Motors"}}},
        "children": [{"type": "Meter", "properties": {prop: source}}],
    }


@pytest.fixture()
def meter_ctx(ctx):
    ctx.widget_schemas["builtin"]["Meter"] = {
        "name": "Meter",
        "category": "Display",
        "schema": {
            "reading": {"type": "float"},
            "setpoint": {"type": "float", "write": True},
            "motor": {"type": "Motor", "requiredFields": [{"name": "Speed", "write": True}]},
            "io": {"type": "Motor", "requiredFields": [{"name": "Io", "requiredFields": ["On"]}]},
        },
    }
    ctx.datasource_registry["PLC"].update({
        "Motors": {"kind": "struct", "name": "Motor", "array": True, "fields": ["Name", "Speed", "Count", "Io"]},
        "Motors/Line[0]": {"kind": "struct", "name": "Line[0]", "array": False, "fields": ["Name", "Speed", "Count", "Io"]},
        "Motors/Line[0]/Count": {"kind": "scalar", "base": "Integer", "array": False},
        "Motors/Line[0]/Io": {"kind": "struct", "name": "Io", "array": False, "fields": ["On"]},
        "Motors/Line[0]/Io/On": {"kind": "scalar", "base": "Boolean", "array": False},
    })
    ctx.datasource_writable = {"PLC": {"Motors/Line[0]/Speed": False, "Motors/Line[0]/Count": True}}
    return ctx


@pytest.mark.parametrize(
    ("prop", "payload", "code"),
    [
        ("reading", {"field": "value", "member": "Speed"}, None),
        ("reading", {"field": "value", "member": "Count"}, "repeatitem-type"),
        ("setpoint", {"field": "value", "member": "Speed"}, "var-readonly"),
        ("motor", {"field": "value"}, "var-readonly"),
        ("io", {"field": "value"}, None),
        ("io", {"field": "value", "member": "Io"}, "repeatitem-type"),
    ],
)
def test_repeat_item_type_and_members_follow_the_field(meter_ctx, prop, payload, code):
    codes = _warning_codes(validate_widget_node(_in_motors(prop, {"$repeatItem": payload}), meter_ctx))
    assert codes == ([code] if code else [])


def test_repeat_item_struct_with_writable_members_fits(meter_ctx):
    meter_ctx.datasource_writable["PLC"]["Motors/Line[0]/Speed"] = True
    node = _in_motors("motor", {"$repeatItem": {"field": "value"}})
    assert _warning_codes(validate_widget_node(node, meter_ctx)) == []


def _in_list(items, prop: str, source: dict) -> dict:
    return {
        "type": "Repeater",
        "properties": {"items": items},
        "children": [{"type": "Meter", "properties": {prop: source}}],
    }


_RECORDS = [
    {"label": "Low", "value": 1, "speed": 1.5, "unit": "rpm"},
    {"label": "High", "value": 2, "speed": 3, "unit": {"$loc": "rpm"}},
]


@pytest.mark.parametrize("items", [_RECORDS, {"$static": _RECORDS}])
@pytest.mark.parametrize(
    ("prop", "payload", "code"),
    [
        ("reading", {"field": "value", "member": "speed"}, None),
        ("reading", {"field": "value", "member": "value"}, "repeatitem-type"),
        ("reading", {"field": "value", "member": "label"}, "repeatitem-type"),
        ("reading", {"field": "value"}, "repeatitem-type"),
        # Mixed or absent values say nothing: trusted.
        ("reading", {"field": "value", "member": "unit"}, None),
        ("reading", {"field": "value", "member": "missing"}, None),
        ("io", {"field": "value"}, "repeatitem-type"),
        # A list element has no variable behind it to write back to.
        ("setpoint", {"field": "value", "member": "speed"}, "var-readonly"),
    ],
)
def test_repeat_item_over_a_literal_list_is_typed_by_its_values(meter_ctx, items, prop, payload, code):
    codes = _warning_codes(validate_widget_node(_in_list(items, prop, {"$repeatItem": payload}), meter_ctx))
    assert codes == ([code] if code else [])


@pytest.mark.parametrize(
    ("items", "code"),
    [
        ([1.5, 2.5], None),
        ([1, 2.5], None),
        ([1, 2], "repeatitem-type"),
        (["a", "b"], "repeatitem-type"),
        # Mixed values: nothing to type the element by.
        ([1, "a"], None),
    ],
)
def test_repeat_item_over_a_list_of_scalars(meter_ctx, items, code):
    node = _in_list(items, "reading", {"$repeatItem": {"field": "value"}})
    codes = _warning_codes(validate_widget_node(node, meter_ctx))
    assert codes == ([code] if code else [])


def test_repeat_item_over_an_empty_list_is_a_label_value_record(ctx):
    node = {
        "type": "Repeater",
        "properties": {"items": []},
        "children": [{"type": "Container", "properties": {"title": {"$repeatItem": {}}}}],
    }
    assert "repeatitem-type" in _warning_codes(validate_widget_node(node, ctx))


@pytest.mark.parametrize("items", [[{}], {"$static": [{}, {}]}])
def test_repeat_item_over_records_with_no_keys_is_trusted(ctx, items):
    node = {
        "type": "Repeater",
        "properties": {"items": items},
        "children": [{"type": "Container", "properties": {"title": {"$repeatItem": {}}}}],
    }
    assert "repeatitem-type" not in _warning_codes(validate_widget_node(node, ctx))


def test_repeat_item_over_a_user_list_reads_label_value_strings(meter_ctx):
    users = {"$user": {"field": "userList"}}
    node = _in_list(users, "reading", {"$repeatItem": {"field": "value", "member": "value"}})
    assert _warning_codes(validate_widget_node(node, meter_ctx)) == ["repeatitem-type"]
    node["children"][0] = {"type": "Container", "properties": {"title": {"$repeatItem": {"member": "label"}}}}
    assert _warning_codes(validate_widget_node(node, meter_ctx)) == []


@pytest.mark.parametrize(
    "items",
    [
        {"$http": {"url": "https://example.test/rows", "pick": "rows"}},
        {"$recipeList": {"type": "Batch"}},
        {"$widgetProp": {"componentId": "grid", "property": "rows"}},
    ],
)
def test_repeat_item_over_a_runtime_list_is_trusted_for_type_not_access(meter_ctx, items):
    read = _in_list(items, "reading", {"$repeatItem": {"field": "value", "member": "speed"}})
    assert "repeatitem-type" not in _warning_codes(validate_widget_node(read, meter_ctx))
    written = _in_list(items, "setpoint", {"$repeatItem": {"field": "value", "member": "speed"}})
    assert "var-readonly" in _warning_codes(validate_widget_node(written, meter_ctx))


def test_repeat_index_never_fills_a_writing_field(meter_ctx):
    meter_ctx.widget_schemas["builtin"]["Meter"]["schema"]["count"] = {"type": "integer", "write": True}
    node = _in_motors("count", {"$repeatItem": {"field": "index"}})
    assert _warning_codes(validate_widget_node(node, meter_ctx)) == ["var-readonly"]


def test_repeat_item_write_target_over_a_list_cannot_be_written(ctx):
    button = {
        "type": "Button",
        "properties": {
            "actions": {"onPress": [{"type": "toggleDataVariable", "target": {"$repeatItem": {}}}]}
        },
    }
    node = {"type": "Repeater", "properties": {"items": [True, False]}, "children": [button]}
    assert _warning_codes(validate_widget_node(node, ctx)) == ["write-target-type"]


def test_repeat_item_write_target_skips_the_variable_check_inside_a_repeater(ctx):
    button = {
        "type": "Button",
        "properties": {
            "actions": {
                "onPress": [
                    {"type": "toggleDataVariable", "target": {"$repeatItem": {}}}
                ]
            }
        },
    }
    inside = _warning_codes(validate_widget_node(_in_repeater(button), ctx))
    outside = _warning_codes(validate_widget_node(button, ctx))
    assert "var-empty" not in inside
    assert "repeatitem-no-scope" not in inside
    assert "repeatitem-no-scope" in outside


# ── page overlay action targets ────────────────────────────────────────────────


@pytest.mark.parametrize("kind", ["openDialog", "openPageOverlay", "closePageOverlay"])
def test_validate_page_overlay_action_missing_page(ctx, kind):
    ctx.page_ids = {"login"}
    report = validate_widget_node(
        {
            "type": "Button",
            "properties": {"actions": {"onClick": [{"type": kind, "pageId": "ghost"}]}},
        },
        ctx,
    )
    assert not report.ok
    assert "target page 'ghost' does not exist" in report.findings[0].message


@pytest.mark.parametrize("kind", ["openDialog", "openPageOverlay", "closePageOverlay"])
def test_validate_page_overlay_action_known_page_ok(ctx, kind):
    ctx.page_ids = {"login"}
    report = validate_widget_node(
        {
            "type": "Button",
            "properties": {"actions": {"onClick": [{"type": kind, "pageId": "login"}]}},
        },
        ctx,
    )
    assert report.ok


def test_validate_action_close_page_overlay_without_id_ok(ctx):
    # closePageOverlay with no pageId closes the topmost overlay — not a reference.
    report = validate_widget_node(
        {
            "type": "Button",
            "properties": {"actions": {"onClick": [{"type": "closePageOverlay", "pageId": ""}]}},
        },
        ctx,
    )
    assert report.ok


# ── $component references ───────────────────────────────────────────────────────


def test_component_ref_unknown_when_registry_known(ctx):
    ctx.component_ids = {"gauge-card"}
    report = validate_widget_node({"type": "$component:deleted"}, ctx)
    assert not report.ok
    assert "unknown widget type" in report.findings[0].message


def test_component_ref_known_when_registry_known(ctx):
    ctx.component_ids = {"gauge-card"}
    report = validate_widget_node({"type": "$component:gauge-card"}, ctx)
    assert report.ok


def test_component_ref_trusted_when_registry_empty(ctx):
    # Fresh checkout / deploy runtime: registry wasn't collected — trust the type
    # rather than block the save.
    assert ctx.component_ids == set()
    report = validate_widget_node({"type": "$component:anything"}, ctx)
    assert report.ok


# ── custom-widget precedence ────────────────────────────────────────────────────


def test_custom_widget_overrides_builtin_schema():
    ctx = ValidationContext(
        widget_schemas={
            "builtin": {"Gauge": {"schema": {"value": {"type": "integer"}}}},
            "custom": {"Widgets/Gauge": {"schema": {"value": {"type": "string"}}}},
        },
    )
    # The custom Gauge (string) shadows the builtin (integer) — a string literal
    # must validate, mirroring the frontend loader overwriting the builtin.
    report = validate_widget_node(
        {"type": "Gauge", "properties": {"value": "ok"}}, ctx
    )
    assert report.ok


def test_custom_widget_group_collision_last_group_wins():
    ctx = ValidationContext(
        widget_schemas={
            "builtin": {},
            # Manifest order mirrors find_entries (sorted by group): "Beta" wins
            # on the frontend because it overwrites "Alpha" last.
            "custom": {
                "Alpha/Card": {"schema": {"n": {"type": "integer"}}},
                "Beta/Card": {"schema": {"n": {"type": "string"}}},
            },
        },
    )
    report = validate_widget_node({"type": "Card", "properties": {"n": "x"}}, ctx)
    assert report.ok


# ── config-area validation ──────────────────────────────────────────────────────


def test_validate_config_areas_warns_on_shell_widget_var(ctx):
    report = validate_config_areas(
        {
            "header": [
                {
                    "id": "h1",
                    "type": "Button",
                    "properties": {"label": {"$var": {"path": "Nope:X/Y"}}},
                }
            ]
        },
        ctx,
    )
    assert report.ok
    assert any("unknown datasource" in w.message for w in report.warnings)


def test_validate_config_areas_checks_dialogs_folder_group_events(ctx):
    report = validate_config_areas(
        {
            "dialogs": [
                {
                    "id": "settings",
                    "type": "page-group",
                    "events": {"onOpen": [{"type": "openPageOverlay", "pageId": "ghost"}]},
                    "children": [],
                }
            ]
        },
        ctx,
    )
    assert not report.ok
    assert report.findings[0].path == "/dialogs/settings/events/onOpen/0"


def test_validate_config_areas_checks_global_event_action_targets(ctx):
    report = validate_config_areas(
        {"globalEvents": {"onHmiLoaded": [{"type": "openPage", "target": "ghost"}]}},
        ctx,
    )
    assert not report.ok
    assert "does not exist" in report.findings[0].message


def test_validate_page_walks_sections(ctx):
    report = validate_page(
        {
            "id": "page-home",
            "sections": {
                "content": [
                    {"type": "Container", "properties": {"title": "Home"}, "children": [
                        {"type": "Mystery"},
                    ]},
                ],
            },
        },
        ctx,
    )
    assert not report.ok
    assert any("Mystery" in f.message for f in report.findings)


def test_collect_component_interfaces_is_recursive(live_project_root, monkeypatch):
    """Components live in nested group folders, so a flat glob misses most of
    them — which used to leave component_ids empty and the reference check dead."""
    import core.storage as storage
    from core.validation import structure

    monkeypatch.setattr(structure, "_component_interface_cache", None)
    nested = live_project_root / "components" / "group1" / "group2"
    nested.mkdir(parents=True)
    storage.write_json(
        nested / "gauge.json",
        {"name": "Gauge", "componentProperties": {"scale": {"type": "Float"}}},
    )
    storage.write_json(
        live_project_root / "components" / "flat.json",
        {"name": "Flat", "componentProperties": {}},
    )

    keys, _slots = structure._collect_component_interfaces()

    assert keys == {"gauge": frozenset({"scale"}), "flat": frozenset()}


def test_collect_component_interfaces_reads_slot_names(live_project_root, monkeypatch):
    """A definition's slots are structural — the ComponentSlot widgets in its
    tree, at any depth — not entries in its component-property interface."""
    import core.storage as storage
    from core.validation import structure

    monkeypatch.setattr(structure, "_component_interface_cache", None)
    storage.write_json(
        live_project_root / "components" / "card.json",
        {
            "name": "Card",
            "children": [
                {"id": "s1", "type": "ComponentSlot", "properties": {"slot": "header"}},
                {
                    "id": "box",
                    "type": "Container",
                    "children": [
                        {"id": "s2", "type": "ComponentSlot", "properties": {"slot": "body"}},
                        # Blank name falls back to the default slot key.
                        {"id": "s3", "type": "ComponentSlot"},
                    ],
                },
            ],
        },
    )

    _keys, slots = structure._collect_component_interfaces()

    assert slots == {"card": frozenset({"header", "body", "content"})}


@pytest.mark.parametrize(
    ("field_type", "value", "message"),
    [
        ("integer", True, "expected Integer, got Boolean"),
        ("boolean", 1, "expected Boolean, got Integer"),
        ("datetime", 5, "expected DateTime, got Integer"),
        ("color", [1], "expected Color, got Array"),
    ],
)
def test_literal_type_messages_name_types_capitalised(ctx, field_type, value, message):
    ctx.widget_schemas["builtin"]["Container"]["schema"]["value"] = {"type": field_type}
    report = validate_widget_node({"type": "Container", "properties": {"value": value}}, ctx)
    assert any(f.message == message for f in report.findings)



def test_repeat_scope_follows_the_declaration_not_the_type_name(ctx):
    """A custom widget that declares `repeatsChildren` scopes `$repeatItem` the
    way the built-in Repeater does."""
    ctx.widget_schemas["custom"]["Project/Carousel"] = {
        "name": "Carousel",
        "repeatsChildren": "slides",
        "schema": {"slides": {"type": "item-list"}},
    }
    child = {
        "type": "Container",
        "properties": {"title": {"$repeatItem": {"field": "value"}}},
    }
    report = validate_widget_node(
        {
            "type": "Carousel",
            "properties": {"slides": {"$var": {"path": "PLC:Names"}}},
            "children": [child],
        },
        ctx,
    )
    assert report.ok
    assert "repeatitem-no-scope" not in _warning_codes(report)
