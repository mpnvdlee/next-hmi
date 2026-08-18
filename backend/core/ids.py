"""Human-readable slug IDs for persisted entities.

Mirrors the frontend `shared/utils/id.ts` so both sides produce identical slugs.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_EDGE_DASH = re.compile(r"^-+|-+$")


def slugify(base: str) -> str:
    """Lowercase kebab slug derived from an arbitrary label."""
    normalized = unicodedata.normalize("NFKD", base)
    stripped = "".join(c for c in normalized if not unicodedata.combining(c))
    slug = _NON_ALNUM.sub("-", stripped.lower())
    return _EDGE_DASH.sub("", slug)


def slug_id(base: str, taken: Iterable[str]) -> str:
    """Unique, human-readable ID derived from ``base``.

    Returns the bare slug when free, otherwise the smallest ``-N`` suffix not in ``taken``.
    """
    used = set(taken)
    root = slugify(base) or "item"
    if root not in used:
        return root
    n = 1
    while f"{root}-{n}" in used:
        n += 1
    return f"{root}-{n}"
