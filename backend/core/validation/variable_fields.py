"""Shared writable-field policy for datasource variable-tree leaf nodes.

Resolves maintenance-backlog item 11: MCP's variable patch tools
(``variables_add``'s ``settings`` and ``variables_set_property``'s merge
patch) previously rejected only three structural keys and accepted anything
else without an allowlist, so a typo'd field name was silently accepted and
persisted as dead weight instead of surfacing as an error.

Fields fall into three independently-documented classes:

* ``STRUCTURAL_FIELDS`` — set once at variable creation (``variables_add``
  assigns these itself); never patchable afterward through
  ``variables_set_property``, and not settable via ``variables_add``'s
  ``settings`` either (it would silently override what the call just
  computed, e.g. reusing ``settings`` to smuggle in a mismatched
  ``display_name``).
* ``DERIVED_FIELDS`` — computed only by the OPC-UA browse/reconnect pipeline
  (the REST/UI editor's browse-diff merges these in before saving); never
  MCP-writable, since an agent has no legitimate way to know live server
  presence.
* ``CORE_WRITABLE_FIELDS`` — the remaining fields a client may set directly.

Anything outside ``CORE_WRITABLE_FIELDS`` must live under the namespaced
``EXTENSIONS_FIELD`` object, which merge-patch already preserves verbatim
(including forward-compatible round trips and per-key deletion via
``{"extensions": {"key": None}}``) the same way it treats any other nested
object — no special-casing needed beyond allowing the key through.

This policy is enforced only at the MCP merge-patch boundary. The REST/UI
datasource editor deliberately stays schemaless (``list[Any]`` in
``models.datasource.DatasourceUpsertBody``) because it legitimately writes
``STRUCTURAL_FIELDS`` (renaming/retyping a variable) and ``DERIVED_FIELDS``
(``present_on_server``, computed by its own browse-diff) as part of ordinary
saves — those are exactly the writes MCP has no tool for and this policy
exists to keep MCP from doing by accident via the patch tools. Storage and
datasource sync (``services/datasource_manager.py``,
``services/datasource_sync.py``) never reconstruct variable dicts, so any
field accepted here (including everything under ``extensions``) round-trips
through disk and the live OPC-UA pipeline unchanged — the same "unrecognised
keys survive untouched" behavior REST already has.
"""

from __future__ import annotations

from typing import Any

from core.exceptions import ConfigValidationError

STRUCTURAL_FIELDS = frozenset({"kind", "display_name", "data_type"})
DERIVED_FIELDS = frozenset({"present_on_server"})
CORE_WRITABLE_FIELDS = frozenset(
    {"node_id", "is_array", "array_length", "enabled", "writable", "value", "min", "max", "fields"}
)
EXTENSIONS_FIELD = "extensions"

_LOCKED_FIELDS = STRUCTURAL_FIELDS | DERIVED_FIELDS
_ALLOWED_TOP_LEVEL = CORE_WRITABLE_FIELDS | {EXTENSIONS_FIELD}


def validate_variable_write_fields(fields: dict[str, Any], *, context: str) -> None:
    """Raise ``ConfigValidationError`` unless *fields* only touches the core
    writable allowlist plus an ``extensions`` object.

    *fields* is a merge-patch body or a ``variables_add`` ``settings`` dict.
    *context* names the caller for the error message (e.g. the tool name).
    """
    if not isinstance(fields, dict):
        return
    locked = set(fields) & _LOCKED_FIELDS
    if locked:
        raise ConfigValidationError(
            f"{context} cannot set structural or server-managed field(s) {sorted(locked)}"
        )
    unknown = set(fields) - _ALLOWED_TOP_LEVEL
    if unknown:
        raise ConfigValidationError(
            f"{context} does not recognise field(s) {sorted(unknown)}; put "
            f"custom/forward-compatible data under '{EXTENSIONS_FIELD}' instead"
        )
    extensions = fields.get(EXTENSIONS_FIELD)
    if extensions is not None and not isinstance(extensions, dict):
        raise ConfigValidationError(f"{context}.{EXTENSIONS_FIELD} must be an object")
