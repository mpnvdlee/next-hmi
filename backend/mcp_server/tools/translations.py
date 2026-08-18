from __future__ import annotations

from typing import Any

from core.exceptions import (
    ConfigConflictError,
    ConfigNotFoundError,
    ConfigValidationError,
)
from core.storage import active_translations_dir, read_csv, write_csv
from core.translations import (
    build_translation_rows,
    parse_translation_rows,
    translation_payload,
    translation_transaction,
)
from core.validation.ids import is_valid_dict_name

from .. import idempotency, locks
from ..confirm import applied_response, dry_run_response
from ..pagination import paginated_payload
from ..server import expose_read_tool, get_agent_label, register_tool
from ..write_helpers import emit_change


def _dict_path(dict_name: str):
    if not is_valid_dict_name(dict_name):
        raise ConfigValidationError("Invalid dictionary name")
    return active_translations_dir() / f"{dict_name}.csv"


def _list_items() -> list[tuple[str, str, dict]]:
    items: list[tuple[str, str, dict]] = []
    if not active_translations_dir().exists():
        return items
    for path in active_translations_dir().glob("*.csv"):
        items.append((path.stem, path.stem, {"name": path.stem, "filename": path.name}))
    return items


def _dictionary_payload(name: str) -> dict[str, Any]:
    if not is_valid_dict_name(name):
        raise ConfigValidationError(f"Invalid dictionary name: {name!r}")
    path = active_translations_dir() / f"{name}.csv"
    with translation_transaction(path):
        if not path.exists():
            raise ConfigNotFoundError(f"Dictionary '{name}' not found")
        return translation_payload(read_csv(path), path)


def _list_payload(cursor: str | None = None, limit: int | None = None) -> dict[str, Any]:
    return paginated_payload(_list_items(), cursor=cursor, limit=limit)


translations_list = expose_read_tool(
    _list_payload,
    name="translations_list",
    description="List translation dictionaries. Each item: ``{ name, filename }``.",
)
translations_get = expose_read_tool(
    _dictionary_payload,
    name="translations_get",
    description="Full dictionary contents — ``{ languages: [...], rows: {key: {code: value}} }``.",
)


@register_tool()
async def translations_add_language(
    dict_name: str,
    language_code: str,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Add an empty secondary-language column to a dictionary."""
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    language_code = language_code.strip()
    if not language_code:
        raise ConfigValidationError("Language code is required")
    path = _dict_path(dict_name)
    async with locks.acquire(("translations", dict_name)):
        with translation_transaction(path):
            if not path.exists():
                raise ConfigNotFoundError(f"Dictionary '{dict_name}' not found")
            rows = read_csv(path)
            before = {"rows": [list(row) for row in rows]}
            document = parse_translation_rows(rows)
            codes = [language["code"] for language in document["languages"]]
            if language_code in codes:
                raise ConfigConflictError(f"Language '{language_code}' already exists")
            rows = build_translation_rows(
                [*codes, language_code], document["rows"], existing_rows=rows
            )
            write_csv(path, rows)
            after = {"rows": [list(row) for row in rows]}
            response = applied_response(
                f"Added language '{language_code}' to '{dict_name}'", before, after
            )
    await emit_change(
        artifact_type="translations",
        artifact_ids=[dict_name],
        summary=response["summary"],
        diff=response["diff"],
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response


@register_tool()
async def translations_delete_language(
    dict_name: str,
    language_code: str,
    confirm: bool = False,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Delete a secondary-language column. Dry-run unless ``confirm=true``."""
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    path = _dict_path(dict_name)
    async with locks.acquire(("translations", dict_name)):
        with translation_transaction(path):
            if not path.exists():
                raise ConfigNotFoundError(f"Dictionary '{dict_name}' not found")
            rows = read_csv(path)
            parse_translation_rows(rows)
            if language_code not in rows[0]:
                raise ConfigNotFoundError(f"Language '{language_code}' not found")
            column = rows[0].index(language_code)
            if column == 0:
                raise ConfigValidationError("Cannot remove the primary language")
            before_rows = [list(row) for row in rows]
            after_rows = [list(row) for row in rows]
            for row in after_rows:
                if column < len(row):
                    row.pop(column)
            if not confirm:
                return dry_run_response(
                    f"Would delete language '{language_code}' from '{dict_name}'",
                    {"rows": before_rows},
                    {"rows": after_rows},
                )
            write_csv(path, after_rows)
            response = applied_response(
                f"Deleted language '{language_code}' from '{dict_name}'",
                {"rows": before_rows},
                {"rows": after_rows},
            )
    await emit_change(
        artifact_type="translations",
        artifact_ids=[dict_name],
        summary=response["summary"],
        diff=response["diff"],
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response


@register_tool()
async def translations_add_key(
    dict_name: str,
    key: str,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Add an empty translation key (with no values yet)."""
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    key = key.strip()
    if not key:
        raise ConfigValidationError("Translation key is required")
    path = _dict_path(dict_name)
    async with locks.acquire(("translations", dict_name)):
        with translation_transaction(path):
            if not path.exists():
                raise ConfigNotFoundError(f"Dictionary '{dict_name}' not found")
            rows = read_csv(path)
            before = {"rows": [list(r) for r in rows]}
            document = parse_translation_rows(rows)
            if key in document["rows"]:
                raise ConfigConflictError(f"Key '{key}' already exists in '{dict_name}'")
            num_langs = len(rows[0])
            new_row = [key] + [""] * (num_langs - 1)
            rows.append(new_row)
            write_csv(path, rows)
            after = {"rows": [list(r) for r in rows]}
            response = applied_response(
                f"Added key '{key}' to '{dict_name}'", before, after
            )
            response["key"] = key
    await emit_change(
        artifact_type="translations",
        artifact_ids=[dict_name],
        summary=response["summary"],
        diff=response["diff"]
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response


@register_tool()
async def translations_delete_key(
    dict_name: str,
    key: str,
    confirm: bool = False,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Delete a translation key. Two-step: dry-run unless ``confirm=true``."""
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    path = _dict_path(dict_name)
    async with locks.acquire(("translations", dict_name)):
        with translation_transaction(path):
            if not path.exists():
                raise ConfigNotFoundError(f"Dictionary '{dict_name}' not found")
            rows = read_csv(path)
            document = parse_translation_rows(rows)
            if key not in document["rows"]:
                raise ConfigNotFoundError(f"Key '{key}' not found in '{dict_name}'")
            before_rows = [list(r) for r in rows]
            after_rows = [before_rows[0]] + [
                r for r in before_rows[1:] if not (r and r[0] == key)
            ]
            if not confirm:
                return dry_run_response(
                    f"Would delete key '{key}' from '{dict_name}'",
                    {"rows": before_rows},
                    {"rows": after_rows},
                )
            write_csv(path, after_rows)
            before = {"rows": before_rows}
            after = {"rows": after_rows}
            response = applied_response(
                f"Deleted key '{key}' from '{dict_name}'", before, after
            )
    await emit_change(
        artifact_type="translations",
        artifact_ids=[dict_name],
        summary=response["summary"],
        diff=response["diff"]
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response


@register_tool()
async def translations_set_cell(
    dict_name: str,
    key: str,
    language_code: str,
    value: str,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Set a single translation cell."""
    label = get_agent_label()
    if idempotency_key:
        cached = idempotency.get(label, idempotency_key)
        if cached is not None:
            return cached
    path = _dict_path(dict_name)
    async with locks.acquire(("translations", dict_name)):
        with translation_transaction(path):
            if not path.exists():
                raise ConfigNotFoundError(f"Dictionary '{dict_name}' not found")
            rows = read_csv(path)
            before = {"rows": [list(r) for r in rows]}
            parse_translation_rows(rows)
            codes = rows[0]
            if language_code not in codes:
                raise ConfigValidationError(f"Unknown language '{language_code}'")
            col = codes.index(language_code)
            if col == 0:
                raise ConfigValidationError(
                    f"translations_set_cell cannot overwrite the immutable key column "
                    f"('{language_code}')"
                )
            found_row = None
            for row in rows[1:]:
                if row and row[0] == key:
                    found_row = row
                    break
            if found_row is None:
                raise ConfigNotFoundError(f"Key '{key}' not found in '{dict_name}'")
            while len(found_row) <= col:
                found_row.append("")
            found_row[col] = value
            write_csv(path, rows)
            after = {"rows": [list(r) for r in rows]}
            response = applied_response(
                f"Set '{dict_name}/{key}[{language_code}]'", before, after
            )
    await emit_change(
        artifact_type="translations",
        artifact_ids=[dict_name],
        summary=response["summary"],
        diff=response["diff"]
    )
    if idempotency_key:
        idempotency.put(label, idempotency_key, response)
    return response
