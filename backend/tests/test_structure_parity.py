import json
from pathlib import Path

from core.validation import structure

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
    assert frozenset(_load("editorKinds.json")) == structure._EDITOR_KINDS
