"""Which property sources a field type offers, and what each source produces.

Port of the offer matrix in ``frontend/src/hmi/utils/propertySourceRules.ts``
and the produced-type rules in ``propertySourceRegistry.ts`` (``producedFits``,
``sourceFieldFits``, ``SOURCE_FIELD_PRODUCES``). Held equal to them by the
shared fixtures ``sourceOffers.json`` and ``sourceProduces.json`` in
``frontend/src/shared/types/__fixtures__/`` (``test_structure_parity.py``).
"""
from __future__ import annotations

from typing import Any

# What each choice of a source's inner `field` selector yields. A choice that
# yields one type on a list field and another elsewhere lists both, and fits a
# field either one fits.
SOURCE_FIELD_PRODUCES: dict[str, dict[str, str | list[str]]] = {
    "$page": {
        "title": "string",
        "breadcrumbLabel": "string",
        "description": "string",
        "icon": "string",
        "id": "string",
        "parentId": "string",
        "pathString": "string",
        "depth": "integer",
        "pathSegments": "string[]",
    },
    "$viewport": {"size": "string", "orientation": "string", "width": "integer", "height": "integer"},
    "$recipe": {"parametersChanged": "boolean", "loaded": "boolean", "activeName": "string"},
    "$user": {
        "username": "string",
        "userList": ["string[]", "string"],
        "groups": ["string", "string[]"],
    },
    "$device": {"hostname": "string", "ipAddress": "string", "macAddress": "string"},
}


def _choice_produces(source: str, field: str) -> list[str]:
    produced = SOURCE_FIELD_PRODUCES.get(source, {}).get(field)
    if produced is None:
        return []
    return [produced] if isinstance(produced, str) else produced


def _field_produces(source: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(
        p for field in SOURCE_FIELD_PRODUCES[source] for p in _choice_produces(source, field)
    ))


# What each source yields, in the registry's order. `any` carries whatever the
# field needs; a source with an inner `field` selector yields the union of its
# choices.
SOURCE_PRODUCES: dict[str, tuple[str, ...]] = {
    "$static": ("any",),
    "$var": ("any",),
    "$loc": ("string",),
    "$urlParam": ("string",),
    "$pageIsActive": ("boolean",),
    "$if": ("any",),
    "$compare": ("boolean",),
    "$not": ("boolean",),
    "$formula": ("float",),
    # Whole numbers unless `integer: false`.
    "$random": ("integer", "float"),
    "$switch": ("any",),
    "$user": _field_produces("$user"),
    "$userGroups": ("boolean",),
    "$device": _field_produces("$device"),
    # The time as text formatted by `format`, which decides whether that text
    # is a DateTime, a Date, a Time or just a string.
    "$time": ("datetime", "string", "date", "time"),
    "$widgetProp": ("any",),
    "$languages": ("string[]",),
    "$stringExpr": ("string",),
    "$http": ("any",),
    "$alarmCount": ("integer",),
    "$recipe": _field_produces("$recipe"),
    "$recipeList": ("record-list",),
    "$componentProp": ("any",),
    "$page": _field_produces("$page"),
    "$viewport": _field_produces("$viewport"),
    "$result": ("any",),
    "$repeatItem": ("any",),
}

# Offered by the surrounding editor scope, never by the field's type.
SCOPE_SOURCES: frozenset[str] = frozenset({"$componentProp", "$result", "$repeatItem"})

SCALAR_FIELD_TYPES: tuple[str, ...] = (
    "string", "datetime", "date", "time", "duration", "integer", "float", "boolean",
)
_STRING_BOUND_KINDS = frozenset({"color", "icon", "image", "video"})
_LIST_KINDS = frozenset({"option-list", "item-list"})

# Editor kinds are not scalars; their sources are listed per kind.
EDITOR_KIND_SOURCES: dict[str, tuple[str, ...]] = {
    "color": ("$static", "$var", "$if", "$switch", "$widgetProp"),
    "icon": ("$static", "$var", "$urlParam", "$if", "$switch", "$page", "$widgetProp"),
    "image": ("$static", "$var", "$urlParam", "$if", "$switch", "$widgetProp"),
    "video": ("$static", "$var", "$urlParam", "$if", "$switch", "$widgetProp"),
    "option-list": ("$static", "$user", "$var", "$languages", "$widgetProp"),
    "record-list": ("$var", "$recipeList", "$widgetProp"),
    "item-list": ("$static", "$var", "$http", "$recipeList", "$user", "$widgetProp"),
}

SOURCE_CAPABLE_TYPES: frozenset[str] = frozenset({*SCALAR_FIELD_TYPES, *EDITOR_KIND_SOURCES})


def produced_fits(produced: str, field_type: str) -> bool:
    """Whether a produced base type fits a scalar field type (`producedFits`):
    the same type only, except that a number also fills a `duration` field."""
    if produced in ("any", field_type):
        return True
    # A duration is a number of seconds.
    return field_type == "duration" and produced in ("integer", "float")


def _produced_fits_field(produced: str, field_type: str) -> bool:
    ft = field_type.lower()
    if ft in SCALAR_FIELD_TYPES:
        return produced_fits(produced, ft)
    if produced == "any":
        return True
    if ft in _STRING_BOUND_KINDS:
        return produced == "string"
    if ft in _LIST_KINDS:
        return produced in ("string[]", "record-list")
    if ft == "record-list":
        return produced == "record-list"
    return True


def _type_tokens(field_type: str | list[str]) -> list[str]:
    return [field_type] if isinstance(field_type, str) else field_type


def source_field_fits(source: str, field: str, field_type: str | list[str]) -> bool:
    """Whether one choice of a source's `field` selector fits the field it sits
    in — any one of a union's types will do (`sourceFieldFits`). A choice the
    table does not know does not."""
    return any(
        _produced_fits_field(p, t)
        for p in _choice_produces(source, field)
        for t in _type_tokens(field_type)
    )


def _scalar_sources(field_type: str) -> tuple[str, ...]:
    return tuple(
        key
        for key, produces in SOURCE_PRODUCES.items()
        if key not in SCOPE_SOURCES and any(produced_fits(p, field_type) for p in produces)
    )


_OFFERS: dict[str, tuple[str, ...]] = {
    **{t: _scalar_sources(t) for t in SCALAR_FIELD_TYPES},
    **EDITOR_KIND_SOURCES,
}


def offered_sources(field_type: str | list[str]) -> tuple[str, ...]:
    """The sources a field of this type offers — for a union, every source any
    of its types offers (`getAllowedPropertySources`)."""
    return tuple(dict.fromkeys(
        key for t in _type_tokens(field_type) for key in _OFFERS.get(t.lower(), ())
    ))


def source_type_mismatch(source_key: str, payload: Any, field_type: Any) -> str | None:
    """Why a fixed-type source cannot fill a field of `field_type`, or None.

    Only the field's source-capable type tokens count; a field with none (a
    struct, `actions`, an array type) is not judged, and neither is a source
    that carries any type or comes from the editor's scope. A source with an
    inner `field` is judged on the stored choice when the table knows it.
    """
    produces = SOURCE_PRODUCES.get(source_key)
    if produces is None or "any" in produces or source_key in SCOPE_SOURCES:
        return None
    listed = field_type if isinstance(field_type, list) else [field_type]
    tokens = [t.lower() for t in listed if isinstance(t, str) and t.lower() in SOURCE_CAPABLE_TYPES]
    if not tokens:
        return None
    if source_key not in offered_sources(tokens):
        return "offered"
    choice = payload.get("field") if isinstance(payload, dict) else None
    if (
        isinstance(choice, str)
        and choice in SOURCE_FIELD_PRODUCES.get(source_key, {})
        and not source_field_fits(source_key, choice, tokens)
    ):
        return "field"
    return None
