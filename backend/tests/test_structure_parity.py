import json
from pathlib import Path

import pytest
from core.validation import component_property, source_rules, structure, vartype

FIXTURES_DIR = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "shared"
    / "types"
    / "__fixtures__"
)


def _load(name: str) -> list[str]:
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


def test_builtin_icon_ids_match_frontend_allowlist() -> None:
    """Same fixture drives frontend/src/shared/config/iconAllowlist.test.ts —
    a divergence between the hand-maintained Python/TS icon lists fails
    exactly one side."""
    assert frozenset(_load("builtinIconIds.json")) == structure._BUILTIN_ICON_IDS


def test_universal_property_keys_match_frontend_visibility_schema() -> None:
    """Same fixture drives frontend/src/hmi/registry/widgetRegistry.test.ts —
    these keys are read off every node by WidgetRenderer, so the unknown-property
    rule must accept them even on schemas that don't declare them."""
    assert frozenset(_load("universalWidgetPropertyKeys.json")) == structure._UNIVERSAL_PROPERTY_KEYS


def test_editor_kinds_match_frontend_value_types() -> None:
    """Same fixture drives frontend/src/shared/utils/valueTypes.test.ts — a
    divergence between the hand-maintained Python/TS editor-kind lists fails
    exactly one side."""
    assert frozenset(_load("editorKinds.json")) == vartype.EDITOR_KINDS


def test_item_list_accepts_match_frontend_value_types() -> None:
    """Same fixture drives frontend/src/shared/utils/valueTypes.test.ts — what an
    `item-list` field binds to must agree between picker and validator."""
    assert list(vartype.ITEM_LIST_ACCEPTS) == _load("itemListAccepts.json")


def test_editor_kind_accepts_match_frontend_value_types() -> None:
    """Same fixture drives frontend/src/shared/utils/valueTypes.test.ts — what a
    colour, icon, image or video field binds to, and which kinds stay
    unconstrained, must agree between picker and validator."""
    for case in json.loads((FIXTURES_DIR / "editorKindAccepts.json").read_text(encoding="utf-8")):
        assert vartype.accepted_value_types(case["type"]) == case["accepts"], case["name"]


def test_source_offers_match_frontend_rules() -> None:
    """Same fixture drives propertySourceRules.test.ts — which sources a field
    type offers, and what each source produces, decide `source-type`."""
    fixture = _load("sourceOffers.json")
    assert {k: list(v) for k, v in source_rules.SOURCE_PRODUCES.items()} == fixture["produces"]
    assert frozenset(fixture["offers"]) == source_rules.SOURCE_CAPABLE_TYPES
    for field_type, offered in fixture["offers"].items():
        assert list(source_rules.offered_sources(field_type)) == offered, field_type


@pytest.mark.parametrize(
    "case", _load("sourceOffers.json")["unionOffers"], ids=lambda c: "|".join(c["fieldType"])
)
def test_union_field_offers_match_frontend_rules(case: dict) -> None:
    """Same fixture drives propertySourceRules.test.ts (`getAllowedPropertySources`
    on a union): every source any of the field's types offers."""
    assert list(source_rules.offered_sources(case["fieldType"])) == case["offers"]


def test_source_field_produces_match_frontend_registry() -> None:
    """Same fixture drives propertySourceRegistry.test.ts."""
    assert _load("sourceProduces.json") == source_rules.SOURCE_FIELD_PRODUCES


def test_produced_fits_match_frontend_rule() -> None:
    """Same fixture drives propertySourceRules.test.ts — a produced type fits
    the same scalar type only, and a number a duration too."""
    fits = _load("sourceOffers.json")["fits"]
    assert {
        produced: [t for t in source_rules.SCALAR_FIELD_TYPES if source_rules.produced_fits(produced, t)]
        for produced in fits
    } == fits


@pytest.mark.parametrize(
    "case",
    _load("sourceOffers.json")["fieldFits"],
    ids=lambda c: f"{c['source']}-{c['field']}-{c['fieldType']}",
)
def test_source_field_fits_match_frontend_registry(case: dict) -> None:
    """Same fixture drives propertySourceRegistry.test.ts (`sourceFieldFits`)."""
    assert (
        source_rules.source_field_fits(case["source"], case["field"], case["fieldType"])
        is case["fits"]
    )


@pytest.mark.parametrize(
    "case", _load("componentPropertySchemaField.json"), ids=lambda case: case["name"]
)
def test_component_property_schema_field_matches_frontend(case: dict) -> None:
    """Same fixture drives componentProperty.test.ts (`componentPropertyToSchemaField`)."""
    assert component_property.to_schema_field(case["input"]) == case["output"]


@pytest.mark.parametrize("case", _load("componentPropFits.json"), ids=lambda case: case["name"])
def test_component_prop_fits_matches_frontend(case: dict) -> None:
    """Same fixture drives componentProperty.test.ts (`componentPropFits` /
    `structSchemaNodeFits` and their verdicts) — `componentprop-type` and
    `widgetprop-type` judge a declared value as the pickers do. The only
    verdict reason the drawer gives is *Not declared writable*."""
    slot = {("type" if k == "fieldType" else k): v for k, v in case["slot"].items()}
    verdict = case["verdict"]
    why = None if verdict["ok"] else "read-only" if verdict.get("reason") else "type"
    if "prop" in case:
        assert component_property.declaration_fits(case["prop"], slot) is case["fits"]
        assert component_property.declaration_verdict(case["prop"], slot) == why
    else:
        assert component_property.node_fits(case["node"], slot) is case["fits"]
        assert component_property.node_verdict(case["node"], slot) == why


def test_action_fields_table_matches_frontend_union() -> None:
    """Same fixture drives actionFields.test.ts, which holds it to the
    ButtonAction union — so a new action type or field fails here until the
    backend says how to validate it."""
    assert _load("actionFields.json") == structure.ACTION_FIELDS
