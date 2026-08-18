"""Canonical v2 widget-schema manifest extraction cases."""
import json

import pytest
from services.widget_schemas import ExtractionError, extract_schemas


@pytest.fixture
def manifest_loader(monkeypatch, tmp_path):
    """``load_widget_manifest`` reading a tmp manifest, with a stub stdlib catalog.

    Both caches are module-level and both inputs are real files in a checkout,
    so a test that doesn't pin them reads whatever the last stdlib build wrote.
    """
    import core.validation.structure as structure

    manifest_path = tmp_path / "widget-schemas.json"
    monkeypatch.setattr(structure, "WIDGET_SCHEMAS_PATH", manifest_path)
    monkeypatch.setattr(structure, "_manifest_cache", None)

    state: dict = {"stdlib": {}, "version": (1, 1)}
    monkeypatch.setattr(structure, "stdlib_catalog", lambda: (state["version"], state["stdlib"]))

    def write(manifest) -> None:
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def set_stdlib(entries) -> None:
        state["stdlib"] = entries
        state["version"] = (state["version"][0] + 1, state["version"][1])

    return type(
        "ManifestLoader",
        (),
        {
            "load": staticmethod(structure.load_widget_manifest),
            "write": staticmethod(write),
            "set_stdlib": staticmethod(set_stdlib),
            "path": manifest_path,
        },
    )


def test_manifest_loader_rejects_v1_instead_of_supporting_legacy(manifest_loader) -> None:
    manifest_loader.write({"version": 1, "builtin": {}, "custom": {}})

    assert manifest_loader.load() == {"version": 2, "builtin": {}, "custom": {}}


def test_manifest_loader_overlays_stdlib_without_a_compiled_manifest(
    manifest_loader,
) -> None:
    """A runtime home that has never compiled still knows the shipped widgets."""
    manifest_loader.set_stdlib({"Container": {"name": "Container", "hostsChildren": True}})

    assert not manifest_loader.path.exists()
    manifest = manifest_loader.load()
    assert manifest["builtin"]["Container"]["hostsChildren"] is True
    assert manifest["custom"] == {}


def test_manifest_loader_lets_stdlib_win_a_stale_registry_row(manifest_loader) -> None:
    """``widget-schemas.json`` survives upgrades, so it can still carry a registry
    row for a widget that has since moved out to the stdlib."""
    manifest_loader.write(
        {
            "version": 2,
            "builtin": {"Container": {"name": "Container (stale)"}},
            "custom": {},
        }
    )
    manifest_loader.set_stdlib({"Container": {"name": "Container", "hostsChildren": True}})

    builtin = manifest_loader.load()["builtin"]
    assert builtin["Container"] == {"name": "Container", "hostsChildren": True}


def test_manifest_loader_reloads_when_only_the_stdlib_changes(manifest_loader) -> None:
    manifest_loader.write({"version": 2, "builtin": {}, "custom": {}})
    assert manifest_loader.load()["builtin"] == {}

    manifest_loader.set_stdlib({"Label": {"name": "Label"}})

    assert manifest_loader.load()["builtin"] == {"Label": {"name": "Label"}}


REGISTRY_HAPPY = """
const ALARM_FILTER_LEVEL_SCHEMA = {
  type: 'select',
  label: 'Filter Level',
  options: [
    { label: 'All', value: '' },
    { label: 'Error', value: 'error' },
  ],
};

export const widgetRegistry = {
  Container: {
    name: 'Container',
    category: 'Layout',
    description: 'Groups child widgets.',
    icon: { type: 'builtin', name: 'stack' },
    component: SomeReactComponent,
    schema: {
      title: { type: 'string', label: 'Title' },
      visible: { type: 'boolean', defaultValue: true },
    },
  },
  AlarmList: {
    name: 'Alarm List',
    category: 'Alarms',
    component: AlarmListComponent,
    schema: {
      filterLevel: ALARM_FILTER_LEVEL_SCHEMA,
    },
  },
};
"""


def test_extracts_allowlisted_fields_per_entry() -> None:
    out = extract_schemas(registry_source=REGISTRY_HAPPY)
    assert out["version"] == 2
    assert out["builtin"]["Container"] == {
        "name": "Container",
        "category": "Layout",
        "description": "Groups child widgets.",
        "icon": {"type": "builtin", "name": "stack"},
        "schema": {
            "title": {"type": "string", "label": "Title"},
            "visible": {"type": "boolean", "defaultValue": True},
        },
    }
    # The non-allowlisted `component` field is dropped from the manifest.
    assert "component" not in out["builtin"]["Container"]


def test_inlines_module_level_const_fragment_identifiers() -> None:
    out = extract_schemas(registry_source=REGISTRY_HAPPY)
    assert out["builtin"]["AlarmList"]["schema"]["filterLevel"] == {
        "type": "select",
        "label": "Filter Level",
        "options": [
            {"label": "All", "value": ""},
            {"label": "Error", "value": "error"},
        ],
    }


def test_category_is_canonical_and_group_is_not_emitted() -> None:
    out = extract_schemas(registry_source=REGISTRY_HAPPY)
    assert out["builtin"]["AlarmList"]["category"] == "Alarms"
    assert "group" not in out["builtin"]["Container"]


def test_rejects_function_calls_on_allowlisted_fields() -> None:
    src = """
      export const widgetRegistry = {
        Bad: { name: 'Bad', category: 'Test', component: C, schema: mergeSchemas({ a: 1 }) },
      };
    """
    with pytest.raises(ExtractionError):
        extract_schemas(registry_source=src)


def test_inlines_literal_object_spreads_in_schema_object() -> None:
    src = """
      const COMMON = { x: 1 };
      export const widgetRegistry = {
        Bad: { name: 'Bad', category: 'Test', component: C, schema: { ...COMMON, y: 2 } },
      };
    """
    out = extract_schemas(registry_source=src)
    assert out["builtin"]["Bad"]["schema"] == {"x": 1, "y": 2}


def test_rejects_unresolved_object_spreads() -> None:
    src = """
      export const widgetRegistry = {
        Bad: { name: 'Bad', category: 'Test', component: C, schema: { ...UNKNOWN } },
      };
    """
    with pytest.raises(ExtractionError):
        extract_schemas(registry_source=src)


def test_rejects_unresolved_identifier_references() -> None:
    src = """
      export const widgetRegistry = {
        Bad: { name: 'Bad', category: 'Test', component: C, schema: UNDEFINED_FRAGMENT },
      };
    """
    with pytest.raises(ExtractionError):
        extract_schemas(registry_source=src)


def test_extracts_custom_widget_schema_named_export() -> None:
    widget = """
      /* @jsxRuntime classic */
      export const schema = {
        label: { type: 'string', label: 'Label' },
        count: { type: 'integer', defaultValue: 0 },
      };
    """
    out = extract_schemas(
        registry_source="export const widgetRegistry = {};",
        custom_widget_sources=[
            {"key": "Inputs/MyWidget", "file": "MyWidget.tsx", "source": widget}
        ],
    )
    assert out["custom"]["Inputs/MyWidget"] == {
        "name": "MyWidget",
        "category": "Inputs",
        "schema": {
            "label": {"type": "string", "label": "Label"},
            "count": {"type": "integer", "defaultValue": 0},
        }
    }


def test_strips_as_const_type_assertions_in_custom_widgets() -> None:
    widget = """
      export const schema = {
        label: { type: 'string' as const, label: 'Label' },
      };
    """
    out = extract_schemas(
        registry_source="export const widgetRegistry = {};",
        custom_widget_sources=[{"key": "X/Y", "file": "x.tsx", "source": widget}],
    )
    assert out["custom"]["X/Y"]["schema"]["label"]["type"] == "string"


def test_custom_widgets_without_schema_are_still_discoverable() -> None:
    widget = "export default function Foo() { return null; }"
    out = extract_schemas(
        registry_source="export const widgetRegistry = {};",
        custom_widget_sources=[{"key": "No/Schema", "file": "n.tsx", "source": widget}],
    )
    assert out["custom"]["No/Schema"] == {
        "name": "Schema",
        "category": "No",
        "schema": {},
    }


def test_extracts_custom_catalog_metadata() -> None:
    widget = """
      export const category = 'Process';
      export const description = 'Shows the current process value.';
      export const icon = { type: 'builtin', name: 'gauge' } as const;
      export const schema = {};
    """
    out = extract_schemas(
        registry_source="export const widgetRegistry = {};",
        custom_widget_sources=[
            {"key": "Other/Gauge", "file": "gauge.tsx", "source": widget}
        ],
    )
    assert out["custom"]["Other/Gauge"] == {
        "name": "Gauge",
        "category": "Process",
        "description": "Shows the current process value.",
        "icon": {"type": "builtin", "name": "gauge"},
        "schema": {},
    }


def test_extracts_display_name_separate_from_the_widget_type() -> None:
    """The folder name stays the type page files reference; displayName is the
    label, so a widget can read as 'Stretch Spacer' without renaming its type."""
    widget = """
      export const displayName = 'Stretch Spacer';
      export const schema = {};
    """
    out = extract_schemas(
        registry_source="export const widgetRegistry = {};",
        custom_widget_sources=[
            {"key": "Layout/StretchSpacer", "file": "s.tsx", "source": widget}
        ],
    )
    assert out["custom"]["Layout/StretchSpacer"] == {
        "name": "StretchSpacer",
        "displayName": "Stretch Spacer",
        "category": "Layout",
        "schema": {},
    }


def test_extracts_hosts_children_capability() -> None:
    """A widget declares that its nodes carry a `children` array; the editor
    reads it to treat the node as a container (drop target, tree recursion)."""
    widget = """
      export const hostsChildren = true;
      export const schema = {};
    """
    out = extract_schemas(
        registry_source="export const widgetRegistry = {};",
        custom_widget_sources=[
            {"key": "Layout/Container", "file": "c.tsx", "source": widget}
        ],
    )
    assert out["custom"]["Layout/Container"]["hostsChildren"] is True


def test_rejects_non_boolean_hosts_children() -> None:
    widget = "export const hostsChildren = 'yes';"
    out = extract_schemas(
        registry_source="export const widgetRegistry = {};",
        custom_widget_sources=[{"key": "X/Y", "file": "x.tsx", "source": widget}],
    )
    assert "hostsChildren" in out["custom"]["X/Y"]["schemaError"]


def test_rejects_blank_display_name() -> None:
    widget = "export const displayName = '   ';"
    out = extract_schemas(
        registry_source="export const widgetRegistry = {};",
        custom_widget_sources=[{"key": "X/Y", "file": "x.tsx", "source": widget}],
    )
    assert "displayName" in out["custom"]["X/Y"]["schemaError"]


def test_rejects_legacy_string_icon_metadata() -> None:
    widget = "export const icon = 'gauge';"
    out = extract_schemas(
        registry_source="export const widgetRegistry = {};",
        custom_widget_sources=[
            {"key": "Other/Gauge", "file": "gauge.tsx", "source": widget}
        ],
    )
    assert "structured builtin or custom icon" in out["custom"]["Other/Gauge"]["schemaError"]
    assert out["custom"]["Other/Gauge"]["schema"] == {}


def test_one_unreadable_widget_does_not_cost_the_others_their_schema() -> None:
    good = "export const schema = { label: { type: 'string' } };"
    bad = "export const icon = 'gauge';"
    out = extract_schemas(
        registry_source="export const widgetRegistry = {};",
        custom_widget_sources=[
            {"key": "Bad", "file": "bad.tsx", "source": bad},
            {"key": "Good", "file": "good.tsx", "source": good},
        ],
    )
    assert out["custom"]["Good"]["schema"] == {"label": {"type": "string"}}
    assert "schemaError" not in out["custom"]["Good"]
    assert out["custom"]["Bad"]["schemaError"]


# Additional Python-side cases that exercise tree-sitter quirks the JS port
# never had to deal with (comments inside object literals, escape sequences).


def test_allows_comments_inside_object_literals() -> None:
    src = """
      export const widgetRegistry = {
        // top-level comment
        Container: {
          name: 'Container', // trailing comment
          category: 'Layout',
          /* block */
          schema: { a: 1 },
        },
      };
    """
    out = extract_schemas(registry_source=src)
    assert out["builtin"]["Container"]["name"] == "Container"
    assert out["builtin"]["Container"]["schema"] == {"a": 1}


def test_decodes_string_escape_sequences() -> None:
    src = r"""
      export const widgetRegistry = {
        X: { name: 'a\nb\tc', category: 'Test', schema: { msg: 'line1\nline2' } },
      };
    """
    out = extract_schemas(registry_source=src)
    assert out["builtin"]["X"]["name"] == "a\nb\tc"
    assert out["builtin"]["X"]["schema"]["msg"] == "line1\nline2"


def test_handles_negative_numbers_and_unary_plus() -> None:
    src = """
      export const widgetRegistry = {
        X: { name: 'X', category: 'Test', schema: { min: -5, max: +10, ratio: -1.5 } },
      };
    """
    out = extract_schemas(registry_source=src)
    assert out["builtin"]["X"]["schema"] == {"min": -5, "max": 10, "ratio": -1.5}


def test_bigint_literal_suffix_is_stripped_not_a_crash() -> None:
    """§8.1: a trailing BigInt `n` suffix must not raise a raw ValueError."""
    src = """
      export const widgetRegistry = {
        X: { name: 'X', category: 'Test', schema: { min: 10n, max: 0x1An } },
      };
    """
    out = extract_schemas(registry_source=src)
    assert out["builtin"]["X"]["schema"] == {"min": 10, "max": 26}


def test_invalid_numeric_literal_raises_extraction_error_not_value_error() -> None:
    src = """
      export const widgetRegistry = {
        X: { name: 'X', category: 'Test', schema: { min: 0x } },
      };
    """
    with pytest.raises(ExtractionError):
        extract_schemas(registry_source=src)


def test_resolves_shorthand_property_to_const() -> None:
    src = """
      const VERSION = 2;
      export const widgetRegistry = {
        X: { name: 'X', category: 'Test', schema: { VERSION } },
      };
    """
    out = extract_schemas(registry_source=src)
    assert out["builtin"]["X"]["schema"] == {"VERSION": 2}
