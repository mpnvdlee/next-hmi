from __future__ import annotations

from typing import Any

from .diff import make_diff


def dry_run_response(summary: str, before: Any, after: Any) -> dict[str, Any]:
    return {
        "summary": summary,
        "result": "dry_run",
        "diff": make_diff(before, after),
    }


def applied_response(
    summary: str,
    before: Any,
    after: Any,
    warnings: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "summary": summary,
        "result": "applied",
        "diff": make_diff(before, after),
        "warnings": warnings or [],
    }
