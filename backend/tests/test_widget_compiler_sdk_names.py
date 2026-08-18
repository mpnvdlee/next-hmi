"""Parity test: the Python SDK_NAMES list in services.widget_compiler must
match the TS canonical list in frontend/src/shared/utils/nextHmiSdkNames.ts.

The two lists drive the per-widget banner: TS for build-time scanning in dev,
Python for the same job in the packaged runtime. If they drift, a widget can
compile against an SDK name in dev that goes missing at runtime, producing a
silent ReferenceError in production.

If this test fails, sync both files. There's no other automated bridge.
"""
import re
from pathlib import Path

from services.widget_compiler import SDK_NAMES

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_TS_PATH = _REPO_ROOT / "frontend" / "src" / "shared" / "utils" / "nextHmiSdkNames.ts"


def _parse_ts_sdk_names(text: str) -> list[str]:
    """Pull the string entries out of ``export const SDK_NAMES = [ … ] as const;``.

    Deliberately simple — the file is hand-maintained and only ever contains
    a flat list of single-quoted identifiers. If that ever changes, this
    parser breaks loudly, which is exactly the signal we want.
    """
    match = re.search(
        r"export\s+const\s+SDK_NAMES\s*=\s*\[(.*?)\]\s*as\s+const",
        text,
        re.DOTALL,
    )
    assert match is not None, "couldn't find SDK_NAMES array in nextHmiSdkNames.ts"
    body = match.group(1)
    return re.findall(r"'([^']+)'", body)


def test_python_and_ts_sdk_names_match() -> None:
    ts_names = _parse_ts_sdk_names(_TS_PATH.read_text(encoding="utf-8"))
    assert tuple(ts_names) == SDK_NAMES, (
        "SDK_NAMES drift between TS and Python.\n"
        f"  TS-only:     {set(ts_names) - set(SDK_NAMES)}\n"
        f"  Python-only: {set(SDK_NAMES) - set(ts_names)}\n"
        f"  Order diffs: ts={ts_names!r}\n"
        f"               py={list(SDK_NAMES)!r}"
    )
