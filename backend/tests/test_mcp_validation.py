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
            },
            "custom": {},
        },
        datasource_registry={
            "PLC": {
                "Motor/Speed": {"kind": "scalar", "base": "String", "array": False},
                "Motor/Running": {"kind": "scalar", "base": "String", "array": False},
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
    assert "expected string" in report.findings[0].message


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


# ── shellOverride bindings ─────────────────────────────────────────────────────


def test_validate_page_checks_shell_override_var_binding(ctx):
    report = validate_page(
        {
            "id": "page-home",
            "shellOverride": {"leftSidebar": {"expanded": {"$var": {"path": "Nope:X/Y"}}}},
        },
        ctx,
    )
    assert report.ok  # unknown datasource is advisory
    assert any("unknown datasource" in w.message for w in report.warnings)


def test_validate_page_rejects_non_boolean_shell_override_literal(ctx):
    report = validate_page(
        {"id": "page-home", "shellOverride": {"header": {"overlay": "yes"}}},
        ctx,
    )
    assert not report.ok
    assert any("expected boolean" in f.message for f in report.findings)


# ── dialog action targets ──────────────────────────────────────────────────────


def test_validate_action_missing_dialog(ctx):
    ctx.dialog_ids = {"login"}
    report = validate_widget_node(
        {
            "type": "Button",
            "properties": {
                "actions": {"onClick": [{"type": "openDialog", "dialogId": "ghost"}]}
            },
        },
        ctx,
    )
    assert not report.ok
    assert "target dialog 'ghost' does not exist" in report.findings[0].message


def test_validate_action_known_dialog_ok(ctx):
    ctx.dialog_ids = {"login"}
    report = validate_widget_node(
        {
            "type": "Button",
            "properties": {
                "actions": {"onClick": [{"type": "openDialog", "dialogId": "login"}]}
            },
        },
        ctx,
    )
    assert report.ok


def test_validate_action_close_dialog_without_id_ok(ctx):
    # closeDialog with no dialogId closes the topmost dialog — not a reference.
    report = validate_widget_node(
        {
            "type": "Button",
            "properties": {"actions": {"onClick": [{"type": "closeDialog"}]}},
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


def test_validate_config_areas_rejects_unknown_dialog_widget(ctx):
    report = validate_config_areas(
        {"dialogs": [{"id": "login", "widgets": [{"id": "x", "type": "Mystery"}]}]},
        ctx,
    )
    assert not report.ok
    assert "unknown widget type" in report.findings[0].message


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
