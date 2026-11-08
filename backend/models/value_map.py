"""Value maps: project-wide lookup tables kept in ``config.json`` under
``valueMaps`` and read by the ``$map`` property source.

A map turns an input value into an output of its ``type``: the first case whose
``when`` equals the input gives ``then``, else ``default``. Mirrors ``ValueMap``
in ``frontend/src/shared/types/config.ts``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

ValueMapType = Literal["Color", "String", "Boolean", "Integer", "Float"]


class ValueMapCase(BaseModel):
    when: str | int | float | bool
    # A literal of the map's type, or `{"$loc": ...}` on a String map.
    then: Any = None


class ValueMap(BaseModel):
    id: str = Field(min_length=1)
    type: ValueMapType
    cases: list[ValueMapCase] = Field(default_factory=list)
    default: Any = None
