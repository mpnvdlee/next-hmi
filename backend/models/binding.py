"""Shared parsing for ``$var`` variable bindings.

A binding is the canonical ``{"$var": {"path": "datasource:location", "index": N}}``
property source. These helpers extract the datasource/location and optional array
index so the recipe and alarm models (and anything else reading a bound variable)
share one interpretation of the source shape.
"""

from __future__ import annotations

from typing import Any


def resolve_var_binding(value: Any) -> tuple[str, str]:
    """Extract (datasource, location) from a ``$var`` binding, or ('', '')."""
    if isinstance(value, dict):
        var = value.get("$var")
        if isinstance(var, dict):
            composite = var.get("path", "")
            if isinstance(composite, str) and ":" in composite:
                ds, _, loc = composite.partition(":")
                return ds, loc
    return "", ""


def resolve_var_index(value: Any) -> int | None:
    """Return the array element index from a ``$var`` binding, or None."""
    if isinstance(value, dict):
        var = value.get("$var")
        if isinstance(var, dict):
            idx = var.get("index")
            if isinstance(idx, int):
                return idx
    return None
