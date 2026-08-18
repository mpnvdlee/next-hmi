"""Reusable component models — persisted in components/<id>.json."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ComponentPropertySchema(BaseModel):
    """Schema definition for a property declared by a reusable component or dialog."""

    model_config = ConfigDict(extra="forbid")

    type: str  # boolean | integer | float | string | datetime | <arrays> | struct | color | select | icon | image | actions | widgets
    label: str
    # One line explaining the property, mirroring SchemaField.description on the
    # frontend — which has always allowed it, while this model rejected it and
    # took the whole component definition down with it.
    description: str | None = None
    defaultValue: Any = None
    # Rich tree for struct-typed properties; SchemaField.requiredFields is derived
    # from this on the frontend. No flat `requiredFields` is persisted.
    structSchema: list[Any] = Field(default_factory=list)
    write: bool = False
    # For select type
    options: list[dict[str, Any]] = Field(default_factory=list)
    display: str | None = None
    # For string / number / url
    placeholder: str | None = None
    min: float | None = None
    max: float | None = None
    step: float | None = None


class BuiltinIconValue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["builtin"]
    name: NonEmptyText


class CustomIconValue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["custom"]
    path: NonEmptyText


IconValue = Annotated[
    BuiltinIconValue | CustomIconValue,
    Field(discriminator="type"),
]


class ComponentDefinition(BaseModel):
    """A named, reusable widget composition with a component-property interface."""

    model_config = ConfigDict(extra="forbid")

    # API-only slug derived from the filename; omitted from persisted JSON.
    id: str = ""
    name: NonEmptyText
    # Optional folder the component lives in. This API-only field is derived from
    # ``components/<group>/<id>.json`` and is not duplicated inside the JSON file.
    group: str | None = None
    # One-line summary shown on the app-drawer card.
    description: NonEmptyText | None = None
    # Drawer category. Independent from ``group``, which only controls file organisation.
    category: NonEmptyText | None = None
    # Icon-picker value shown in the app drawer and page tree.
    icon: IconValue | None = None
    # Optional fixed canvas dimensions in the components editor. When absent,
    # the editor grows the preview to the component's rendered content.
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    componentProperties: dict[str, ComponentPropertySchema] = Field(default_factory=dict)
    # WidgetConfig-shaped dicts — validated structurally at the service layer
    children: list[Any] = Field(default_factory=list)
