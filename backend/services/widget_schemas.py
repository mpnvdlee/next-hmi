"""Widget-schema manifest extractor for the backend widget compiler.

Parses TSX source via tree-sitter and folds the canonical catalog metadata and
schema of built-in and custom widgets into a single manifest.

Strict mode: any non-literal expression at an allow-listed field aborts with
``ExtractionError`` naming the file and (when available) the line. A
silently-incomplete manifest would cause validators to reject valid widget
data.

The single TSX grammar (``language_tsx``) handles both the built-in
``widgetRegistry.tsx`` and custom-widget ``index.tsx`` files.
"""
from __future__ import annotations

import contextlib
from typing import Any

import tree_sitter
import tree_sitter_typescript as tsts

_TSX = tree_sitter.Language(tsts.language_tsx())
_PARSER = tree_sitter.Parser(_TSX)

SCHEMA_VERSION = 2
_REGISTRY_FIELDS = ("name", "category", "description", "icon", "schema")
_CUSTOM_EXPORTS = (
    "displayName",
    "hostsChildren",
    "category",
    "description",
    "icon",
    "schema",
    "exportedProperties",
)


class ExtractionError(Exception):
    def __init__(self, message: str, file: str, line: int | None = None) -> None:
        if line is not None:
            super().__init__(f"{file}:{line} — {message}")
        else:
            super().__init__(f"{file} — {message}")
        self.message = message
        self.file = file
        self.line = line


def _node_line(node: tree_sitter.Node) -> int:
    return node.start_point[0] + 1


def _text(node: tree_sitter.Node) -> str:
    return node.text.decode("utf-8")


def _decode_string(node: tree_sitter.Node) -> str:
    """Decode a ``string`` or ``template_string`` node (no substitutions)."""
    parts: list[str] = []
    for child in node.children:
        if child.type == "string_fragment" or child.type == "escape_sequence":
            parts.append(_decode_escapes(_text(child)))
    return "".join(parts)


_ESCAPES = {
    "\\n": "\n",
    "\\t": "\t",
    "\\r": "\r",
    "\\\\": "\\",
    "\\'": "'",
    '\\"': '"',
    "\\`": "`",
    "\\0": "\0",
    "\\b": "\b",
    "\\f": "\f",
    "\\v": "\v",
}


def _decode_escapes(s: str) -> str:
    if "\\" not in s:
        return s
    out: list[str] = []
    i = 0
    while i < len(s):
        if s[i] == "\\" and i + 1 < len(s):
            pair = s[i : i + 2]
            if pair in _ESCAPES:
                out.append(_ESCAPES[pair])
                i += 2
                continue
            # Unknown escape — emit the next char literally (TS behaviour).
            out.append(s[i + 1])
            i += 2
            continue
        out.append(s[i])
        i += 1
    return "".join(out)


def _parse_number(text: str, file: str, line: int) -> int | float:
    text = text.replace("_", "")
    if text and text[-1] in ("n", "N"):
        # BigInt literal (e.g. `10n`) — no BigInt concept in the schema
        # system; the numeric value itself is still meaningful, so strip the
        # suffix instead of aborting the whole extraction over it.
        text = text[:-1]
    try:
        if text.startswith(("0x", "0X")):
            return int(text, 16)
        if text.startswith(("0o", "0O")):
            return int(text, 8)
        if text.startswith(("0b", "0B")):
            return int(text, 2)
        if any(c in text for c in ".eE"):
            return float(text)
        return int(text)
    except ValueError as exc:
        raise ExtractionError(f"invalid numeric literal: {text!r}", file, line) from exc


def _named(node: tree_sitter.Node) -> list[tree_sitter.Node]:
    return [c for c in node.children if c.is_named]


def _literal_value(node: tree_sitter.Node, file: str, consts: dict[str, Any]) -> Any:
    t = node.type
    if t == "string":
        return _decode_string(node)
    if t == "template_string":
        for child in node.children:
            if child.type == "template_substitution":
                raise ExtractionError(
                    "template substitutions not supported — use a plain string",
                    file,
                    _node_line(node),
                )
        return _decode_string(node)
    if t == "number":
        return _parse_number(_text(node), file, _node_line(node))
    if t == "true":
        return True
    if t == "false":
        return False
    if t == "null":
        return None
    if t == "undefined":
        # Treat as missing — but JSON has no undefined, so reject explicitly.
        raise ExtractionError(
            "undefined not supported in literal values", file, _node_line(node)
        )
    if t == "unary_expression":
        op = node.child_by_field_name("operator")
        arg = node.child_by_field_name("argument")
        if op is None or arg is None:
            raise ExtractionError(
                "malformed unary expression", file, _node_line(node)
            )
        inner = _literal_value(arg, file, consts)
        op_text = _text(op)
        if op_text == "-" and isinstance(inner, (int, float)) and not isinstance(inner, bool):
            return -inner
        if op_text == "+" and isinstance(inner, (int, float)) and not isinstance(inner, bool):
            return +inner
        raise ExtractionError(
            "unsupported unary operator (only -/+ on numbers)",
            file,
            _node_line(node),
        )
    if t == "as_expression":
        # `<expr> as const` / `<expr> as T` — first named child is the expression.
        return _literal_value(_named(node)[0], file, consts)
    if t == "satisfies_expression":
        return _literal_value(_named(node)[0], file, consts)
    if t == "parenthesized_expression":
        return _literal_value(_named(node)[0], file, consts)
    if t == "array":
        return [
            _literal_value(el, file, consts)
            for el in _named(node)
            if el.type != "comment"
        ]
    if t == "object":
        return _object_value(node, file, consts)
    if t == "identifier":
        name = _text(node)
        if name not in consts:
            raise ExtractionError(
                f"unresolved identifier '{name}' — only module-level const literals are inlined",
                file,
                _node_line(node),
            )
        return consts[name]
    if t == "call_expression":
        raise ExtractionError(
            "function call not allowed — only literal object/identifier values",
            file,
            _node_line(node),
        )
    if t == "spread_element":
        raise ExtractionError("spread (...) not supported", file, _node_line(node))
    raise ExtractionError(
        f"unsupported expression kind '{t}'", file, _node_line(node)
    )


def _object_value(node: tree_sitter.Node, file: str, consts: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for prop in _named(node):
        if prop.type == "comment":
            continue
        if prop.type == "pair":
            key_node = prop.child_by_field_name("key")
            val_node = prop.child_by_field_name("value")
            if key_node is None or val_node is None:
                raise ExtractionError(
                    "malformed object entry", file, _node_line(prop)
                )
            key = _property_key(key_node, file)
            out[key] = _literal_value(val_node, file, consts)
        elif prop.type == "shorthand_property_identifier":
            name = _text(prop)
            if name not in consts:
                raise ExtractionError(
                    f"unresolved shorthand identifier '{name}'",
                    file,
                    _node_line(prop),
                )
            out[name] = consts[name]
        elif prop.type == "spread_element":
            argument = prop.child_by_field_name("argument")
            if argument is None:
                named = _named(prop)
                argument = named[0] if named else None
            if argument is None:
                raise ExtractionError(
                    "malformed spread expression", file, _node_line(prop)
                )
            spread = _literal_value(argument, file, consts)
            if not isinstance(spread, dict):
                raise ExtractionError(
                    "object spread must resolve to a literal object",
                    file,
                    _node_line(prop),
                )
            out.update(spread)
        elif prop.type == "computed_property_name":
            raise ExtractionError(
                "computed property names not supported", file, _node_line(prop)
            )
        elif prop.type == "method_definition":
            raise ExtractionError(
                "method definitions not supported", file, _node_line(prop)
            )
        else:
            raise ExtractionError(
                f"unsupported property kind '{prop.type}'",
                file,
                _node_line(prop),
            )
    return out


def _property_key(node: tree_sitter.Node, file: str) -> str:
    t = node.type
    if t == "property_identifier":
        return _text(node)
    if t == "string":
        return _decode_string(node)
    if t == "number":
        return _text(node)
    if t == "computed_property_name":
        raise ExtractionError(
            "computed property names not supported", file, _node_line(node)
        )
    raise ExtractionError(
        f"unsupported property key kind '{t}'", file, _node_line(node)
    )


def _collect_consts(root: tree_sitter.Node, file: str) -> dict[str, Any]:
    """Collect module-level ``const NAME = <literal>`` declarations whose
    initializer evaluates as a literal. Non-literal initializers are silently
    skipped — they can't be referenced from schema fragments anyway.
    """
    consts: dict[str, Any] = {}

    def walk(node: tree_sitter.Node, top_level: bool) -> None:
        if node.type == "lexical_declaration" or node.type == "variable_declaration":
            if not top_level:
                return
            for child in node.children:
                if child.type != "variable_declarator":
                    continue
                name_node = child.child_by_field_name("name")
                value_node = child.child_by_field_name("value")
                if name_node is None or value_node is None:
                    continue
                if name_node.type != "identifier":
                    continue
                with contextlib.suppress(ExtractionError):
                    consts[_text(name_node)] = _literal_value(value_node, file, consts)
            return
        if node.type == "export_statement":
            for child in node.children:
                if child.type in ("lexical_declaration", "variable_declaration"):
                    walk(child, top_level)
            return
        if not top_level:
            return
        for child in node.children:
            walk(child, top_level=False)

    for child in root.children:
        walk(child, top_level=True)
    return consts


def _find_top_level_export(
    root: tree_sitter.Node, name: str
) -> tree_sitter.Node | None:
    """Return the declarator for a direct ``export const <name> = …``.

    Private module constants with catalog-like names are deliberately ignored;
    metadata is public only when the widget module explicitly exports it.
    """
    for statement in root.children:
        if statement.type != "export_statement":
            continue
        for declaration in statement.children:
            if declaration.type not in ("lexical_declaration", "variable_declaration"):
                continue
            for declarator in declaration.children:
                if declarator.type != "variable_declarator":
                    continue
                name_node = declarator.child_by_field_name("name")
                if (
                    name_node is not None
                    and name_node.type == "identifier"
                    and _text(name_node) == name
                ):
                    return declarator
    return None


def _extract_registry(source: str, file: str) -> dict[str, dict[str, Any]]:
    tree = _PARSER.parse(source.encode("utf-8"))
    root = tree.root_node
    consts = _collect_consts(root, file)

    decl = _find_top_level_export(root, "widgetRegistry")
    if decl is None:
        raise ExtractionError("could not find 'widgetRegistry' declaration", file)

    init = decl.child_by_field_name("value")
    if init is None:
        raise ExtractionError(
            "'widgetRegistry' has no initializer", file, _node_line(decl)
        )

    if init.type == "as_expression" or init.type == "satisfies_expression":
        init = _named(init)[0]

    if init.type != "object":
        raise ExtractionError(
            "'widgetRegistry' must be an object literal", file, _node_line(decl)
        )

    builtin: dict[str, dict[str, Any]] = {}
    for prop in _named(init):
        if prop.type == "comment":
            continue
        if prop.type != "pair":
            raise ExtractionError(
                "unexpected non-assignment in widgetRegistry", file, _node_line(prop)
            )
        key_node = prop.child_by_field_name("key")
        val_node = prop.child_by_field_name("value")
        if key_node is None or val_node is None:
            continue
        widget_type = _property_key(key_node, file)
        entry_init = val_node
        if entry_init.type == "as_expression" or entry_init.type == "satisfies_expression":
            entry_init = _named(entry_init)[0]
        if entry_init.type != "object":
            raise ExtractionError(
                f"entry for '{widget_type}' must be an object literal",
                file,
                _node_line(prop),
            )
        entry: dict[str, Any] = {}
        for inner in _named(entry_init):
            if inner.type == "comment":
                continue
            if inner.type != "pair":
                continue
            inner_key = inner.child_by_field_name("key")
            inner_val = inner.child_by_field_name("value")
            if inner_key is None or inner_val is None:
                continue
            try:
                field_name = _property_key(inner_key, file)
            except ExtractionError:
                continue
            if field_name not in _REGISTRY_FIELDS:
                continue
            try:
                entry[field_name] = _literal_value(inner_val, file, consts)
            except ExtractionError as err:
                # Re-raise with context about which field tripped it.
                raise ExtractionError(
                    f"{err.message} (in '{widget_type}.{field_name}')",
                    file,
                    err.line if err.line is not None else _node_line(inner),
                ) from err
        builtin[widget_type] = entry
    return builtin


def _extract_custom_widget(source: str, file: str) -> dict[str, Any]:
    tree = _PARSER.parse(source.encode("utf-8"))
    root = tree.root_node
    consts = _collect_consts(root, file)
    metadata: dict[str, Any] = {}
    for export_name in _CUSTOM_EXPORTS:
        decl = _find_top_level_export(root, export_name)
        if decl is None:
            continue
        init = decl.child_by_field_name("value")
        if init is None:
            raise ExtractionError(
                f"'{export_name}' has no initializer", file, _node_line(decl)
            )
        try:
            metadata[export_name] = _literal_value(init, file, consts)
        except ExtractionError as err:
            raise ExtractionError(
                f"{err.message} (in export '{export_name}')",
                file,
                err.line if err.line is not None else _node_line(decl),
            ) from err
    return metadata


def _validate_catalog_entry(entry: dict[str, Any], file: str, key: str) -> None:
    """Reject malformed v2 catalog metadata before it reaches MCP clients."""
    for field in ("name", "category"):
        if not isinstance(entry.get(field), str) or not entry[field].strip():
            raise ExtractionError(
                f"'{key}.{field}' must be a non-empty string", file
            )
    description = entry.get("description")
    if description is not None and not isinstance(description, str):
        raise ExtractionError(f"'{key}.description' must be a string", file)
    hosts_children = entry.get("hostsChildren")
    if hosts_children is not None and not isinstance(hosts_children, bool):
        raise ExtractionError(f"'{key}.hostsChildren' must be a boolean", file)
    display_name = entry.get("displayName")
    if display_name is not None and (
        not isinstance(display_name, str) or not display_name.strip()
    ):
        raise ExtractionError(f"'{key}.displayName' must be a non-empty string", file)
    schema = entry.get("schema")
    if not isinstance(schema, dict):
        raise ExtractionError(f"'{key}.schema' must be an object", file)
    exported = entry.get("exportedProperties")
    if exported is not None:
        if not isinstance(exported, list):
            raise ExtractionError(
                f"'{key}.exportedProperties' must be an array", file
            )
        for index, item in enumerate(exported):
            if not isinstance(item, dict):
                raise ExtractionError(
                    f"'{key}.exportedProperties[{index}]' must be an object", file
                )
            if not isinstance(item.get("key"), str) or not item["key"].strip():
                raise ExtractionError(
                    f"'{key}.exportedProperties[{index}].key' must be a non-empty string",
                    file,
                )
    icon = entry.get("icon")
    if icon is None:
        return
    if not isinstance(icon, dict) or icon.get("type") not in ("builtin", "custom"):
        raise ExtractionError(
            f"'{key}.icon' must be a structured builtin or custom icon", file
        )
    value_field = "name" if icon["type"] == "builtin" else "path"
    if not isinstance(icon.get(value_field), str) or not icon[value_field].strip():
        raise ExtractionError(
            f"'{key}.icon.{value_field}' must be a non-empty string", file
        )
    allowed_icon_fields = {"type", value_field}
    if set(icon) != allowed_icon_fields:
        raise ExtractionError(
            f"'{key}.icon' contains fields outside {sorted(allowed_icon_fields)}",
            file,
        )


def extract_schemas(
    *,
    registry_source: str,
    registry_file: str = "widgetRegistry.tsx",
    custom_widget_sources: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Build the widget-schema manifest from a registry source string and a
    list of ``{"key", "file", "source"}`` dicts for custom widgets.

    Manifest v2 uses the same metadata contract as the frontend registry:
    ``name``, ``category``, optional ``description``/``icon``, and ``schema``.
    """
    builtin = _extract_registry(registry_source, registry_file)
    for key, entry in builtin.items():
        _validate_catalog_entry(entry, registry_file, key)
    custom: dict[str, dict[str, Any]] = {}
    for source_entry in custom_widget_sources or []:
        key = source_entry["key"]
        path_parts = key.split("/")
        default_category = path_parts[-2] if len(path_parts) > 1 else "Other"
        try:
            metadata = _extract_custom_widget(
                source_entry["source"], source_entry["file"]
            )
            catalog_entry = {
                "name": path_parts[-1],
                "category": metadata.pop("category", default_category),
                "schema": metadata.pop("schema", {}),
                **metadata,
            }
            _validate_catalog_entry(catalog_entry, source_entry["file"], key)
        except ExtractionError as err:
            # One unreadable widget must not cost every other widget its schema:
            # the manifest is all-or-nothing on disk, and a stale one registers
            # widgets with no property fields and no `$widgetProp` exports while
            # they still render — a failure with no visible symptom. Record the
            # error against the widget that caused it and keep going; the
            # widgets API hands it to the admin page.
            catalog_entry = {
                "name": path_parts[-1],
                "category": default_category,
                "schema": {},
                "schemaError": str(err),
            }
        custom[key] = catalog_entry
    return {"version": SCHEMA_VERSION, "builtin": builtin, "custom": custom}
