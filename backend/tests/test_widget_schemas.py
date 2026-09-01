"""Canonical v2 widget-schema manifest extraction cases."""
import json

import pytest
from services.widget_schemas import extract_schemas


@pytest.fixture
def manifest_loader(monkeypatch, tmp_path):
    """``load_widget_manifest`` reading a tmp manifest, with a stub built-in
    widgets catalog.

    Both caches are module-level and both inputs are real files in a checkout,
    so a test that doesn't pin them reads whatever the last built-in-widgets
    build wrote.
    """
    import core.validation.structure as structure

    manifest_path = tmp_path / "widget-schemas.json"
    monkeypatch.setattr(structure, "WIDGET_SCHEMAS_PATH", manifest_path)
    monkeypatch.setattr(structure, "_manifest_cache", None)

    state: dict = {"builtin_widgets": {}, "version": (1, 1)}
    monkeypatch.setattr(
        structure, "builtin_widgets_catalog", lambda: (state["version"], state["builtin_widgets"])
    )

    def write(manifest) -> None:
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def set_builtin_widgets(entries) -> None:
        state["builtin_widgets"] = entries
        state["version"] = (state["version"][0] + 1, state["version"][1])

    return type(
        "ManifestLoader",
        (),
        {
            "load": staticmethod(structure.load_widget_manifest),
            "write": staticmethod(write),
            "set_builtin_widgets": staticmethod(set_builtin_widgets),
            "path": manifest_path,
        },
    )


def test_manifest_loader_rejects_v1_instead_of_supporting_legacy(manifest_loader) -> None:
    manifest_loader.write({"version": 1, "builtin": {}, "custom": {}})

    assert manifest_loader.load() == {"version": 2, "builtin": {}, "custom": {}}


def test_manifest_loader_overlays_builtin_widgets_without_a_compiled_manifest(
    manifest_loader,
) -> None:
    """A runtime home that has never compiled still knows the shipped widgets."""
    manifest_loader.set_builtin_widgets({"Container": {"name": "Container", "hostsChildren": True}})

    assert not manifest_loader.path.exists()
    manifest = manifest_loader.load()
    assert manifest["builtin"]["Container"]["hostsChildren"] is True
    assert manifest["custom"] == {}


def test_manifest_loader_lets_builtin_widgets_win_a_stale_registry_row(manifest_loader) -> None:
    """``widget-schemas.json`` survives upgrades, so it can still carry a registry
    row for a widget that has since moved to the built-in catalog."""
    manifest_loader.write(
        {
            "version": 2,
            "builtin": {"Container": {"name": "Container (stale)"}},
            "custom": {},
        }
    )
    manifest_loader.set_builtin_widgets({"Container": {"name": "Container", "hostsChildren": True}})

    builtin = manifest_loader.load()["builtin"]
    assert builtin["Container"] == {"name": "Container", "hostsChildren": True}


def test_manifest_loader_reloads_when_only_the_builtin_widgets_change(manifest_loader) -> None:
    manifest_loader.write({"version": 2, "builtin": {}, "custom": {}})
    assert manifest_loader.load()["builtin"] == {}

    manifest_loader.set_builtin_widgets({"Label": {"name": "Label"}})

    assert manifest_loader.load()["builtin"] == {"Label": {"name": "Label"}}


def test_builtin_is_always_empty_and_needs_no_source_to_read() -> None:
    """Every product widget is a built-in widget with a baked manifest, which
    ``load_widget_manifest`` overlays. So a compile has no built-in source to
    parse, and the half it writes stays empty — which is why no build has to
    ship a frontend source file for the extractor to read."""
    out = extract_schemas(
        custom_widget_sources=[
            {"key": "Inputs/Foo", "file": "foo.tsx", "source": "export const schema = {};"}
        ]
    )

    assert out["builtin"] == {}
    assert set(out["custom"]) == {"Inputs/Foo"}


def _custom(source: str, key: str = "Inputs/Foo") -> dict:
    """Extract one custom widget and return its manifest entry.

    Every literal the extractor understands reaches it through a widget source
    now, so the literal-machinery cases below go through this rather than
    through a registry object that no longer exists. An unreadable widget lands
    a ``schemaError`` on its own entry instead of failing the run, which is why
    these assert on that field rather than expecting a raise.
    """
    out = extract_schemas(
        custom_widget_sources=[{"key": key, "file": "widget.tsx", "source": source}]
    )
    return out["custom"][key]


def test_rejects_function_calls_on_allowlisted_fields() -> None:
    out = _custom("export const schema = mergeSchemas({ a: 1 });")
    assert "function call not allowed" in out["schemaError"]


def test_inlines_module_level_const_fragments_and_spreads() -> None:
    out = _custom(
        "const COMMON = { x: 1 };\n"
        "const LABEL = { type: 'string', label: 'Label' };\n"
        "export const schema = { ...COMMON, y: 2, label: LABEL };"
    )
    assert out["schema"] == {
        "x": 1,
        "y": 2,
        "label": {"type": "string", "label": "Label"},
    }


def test_rejects_unresolved_object_spreads() -> None:
    assert _custom("export const schema = { ...UNKNOWN };")["schemaError"]


def test_rejects_unresolved_identifier_references() -> None:
    assert _custom("export const schema = UNDEFINED_FRAGMENT;")["schemaError"]


def test_extracts_custom_widget_schema_named_export() -> None:
    widget = """
      /* @jsxRuntime classic */
      export const schema = {
        label: { type: 'string', label: 'Label' },
        count: { type: 'integer', defaultValue: 0 },
      };
    """
    out = extract_schemas(
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
        custom_widget_sources=[{"key": "X/Y", "file": "x.tsx", "source": widget}],
    )
    assert out["custom"]["X/Y"]["schema"]["label"]["type"] == "string"


def test_custom_widgets_without_schema_are_still_discoverable() -> None:
    widget = "export default function Foo() { return null; }"
    out = extract_schemas(
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
        custom_widget_sources=[
            {"key": "Layout/Container", "file": "c.tsx", "source": widget}
        ],
    )
    assert out["custom"]["Layout/Container"]["hostsChildren"] is True


def test_rejects_non_boolean_hosts_children() -> None:
    widget = "export const hostsChildren = 'yes';"
    out = extract_schemas(
        custom_widget_sources=[{"key": "X/Y", "file": "x.tsx", "source": widget}],
    )
    assert "hostsChildren" in out["custom"]["X/Y"]["schemaError"]


def test_rejects_blank_display_name() -> None:
    widget = "export const displayName = '   ';"
    out = extract_schemas(
        custom_widget_sources=[{"key": "X/Y", "file": "x.tsx", "source": widget}],
    )
    assert "displayName" in out["custom"]["X/Y"]["schemaError"]


def test_rejects_legacy_string_icon_metadata() -> None:
    widget = "export const icon = 'gauge';"
    out = extract_schemas(
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
    out = _custom(
        "export const schema = {\n"
        "  // leading comment\n"
        "  a: 1, // trailing comment\n"
        "  /* block */\n"
        "  b: 2,\n"
        "};"
    )
    assert out["schema"] == {"a": 1, "b": 2}


def test_decodes_string_escape_sequences() -> None:
    out = _custom(r"export const schema = { msg: 'line1\nline2\tend' };")
    assert out["schema"]["msg"] == "line1\nline2\tend"


def test_handles_negative_numbers_and_unary_plus() -> None:
    out = _custom("export const schema = { min: -5, max: +10, ratio: -1.5 };")
    assert out["schema"] == {"min": -5, "max": 10, "ratio": -1.5}


def test_bigint_literal_suffix_is_stripped_not_a_crash() -> None:
    """§8.1: a trailing BigInt `n` suffix must not raise a raw ValueError."""
    out = _custom("export const schema = { min: 10n, max: 0x1An };")
    assert out["schema"] == {"min": 10, "max": 26}


def test_invalid_numeric_literal_is_reported_not_a_raw_value_error() -> None:
    assert _custom("export const schema = { min: 0x };")["schemaError"]


def test_resolves_shorthand_property_to_const() -> None:
    out = _custom("const VERSION = 2;\nexport const schema = { VERSION };")
    assert out["schema"] == {"VERSION": 2}
