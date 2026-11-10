"""The runtime's public routes and their table in rest-api.md must agree, so a
route cannot become public without its row saying so (and why)."""

import re
from pathlib import Path

_DOC = Path(__file__).resolve().parents[2] / "docs" / "dev" / "reference" / "rest-api.md"
_PREFIX = "/runtime/{slug}/"


def _documented_public_routes() -> set[tuple[str, tuple[str, ...]]]:
    section = _DOC.read_text(encoding="utf-8").split("### Route access", 1)[1]
    section = re.split(r"^#{2,3} ", section, maxsplit=1, flags=re.M)[0]
    routes = set()
    for line in section.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 4 or cells[2] != "public":
            continue
        assert cells[3], f"public row {cells[1]} says nothing about why it is public"
        method, path = cells[0].strip("`"), cells[1].strip("`")
        if not path.startswith(_PREFIX + "api/"):
            continue
        segments = tuple(
            "*" if seg.startswith("{") and seg.endswith("}") else seg
            for seg in path[len(_PREFIX):].split("/")
        )
        routes.add((method, segments))
    return routes


def test_public_runtime_routes_match_the_rest_api_table() -> None:
    import manager

    # A segment the gate matches by pattern (a theme id) is one wildcard here.
    in_code = {
        (method, tuple("*" if isinstance(seg, re.Pattern) else seg for seg in pattern))
        for method, patterns in manager._RUNTIME_PUBLIC_ROUTES.items()
        for pattern in patterns
    }
    documented = _documented_public_routes()
    assert in_code - documented == set(), "public in manager.py but not in rest-api.md"
    assert documented - in_code == set(), "public in rest-api.md but not in manager.py"
