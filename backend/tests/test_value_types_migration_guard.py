"""Guard: shipped HMI config + widget schemas must speak only value types.

Datasource files keep real OPC-UA types (they feed the sim server / write path),
so they are excluded. This catches a regression where an OPC literal or a stale
``dataType`` key sneaks back into config.json / components / custom-widgets.

The value-type vocabulary is capitalised (``Boolean``, ``Float``, ``DateTime``,
…), so those names overlap real OPC-UA type names and are *not* flagged. The
guard therefore only forbids OPC types that have no value-type equivalent
(``Int16``, ``Double``, ``Byte``, …).
"""

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PROJECT_TESTBENCH = REPO_ROOT / "project-testbench"
PROJECT_SEED = REPO_ROOT / "project-seed"
PROJECT_ROOTS = (PROJECT_TESTBENCH, PROJECT_SEED)

# Raw OPC-UA type literals with no value-type name — these must never appear in
# HMI config / widget schemas (a value type is the only datatype a schema speaks).
_OPC_LITERAL_RE = re.compile(
    r"\b(Bool|SByte|Byte|Int8|Int16|Int32|Int64|UInt8|UInt16|UInt32|UInt64"
    r"|Single|Double|Decimal)\b"
)


def _json_files() -> list[Path]:
    """HMI config JSON where a datatype only appears as a schema value."""
    files: list[Path] = []
    for project_root in PROJECT_ROOTS:
        cfg = project_root / "config.json"
        if cfg.exists():
            files.append(cfg)
        components = project_root / "components"
        if components.exists():
            files.extend(sorted(components.glob("*.json")))
    return files


def _all_schema_files() -> list[Path]:
    files = _json_files()
    for project_root in PROJECT_ROOTS:
        widgets = project_root / "custom-widgets"
        if widgets.exists():
            files.extend(sorted(widgets.rglob("index.tsx")))
    return files


@pytest.mark.skipif(not PROJECT_TESTBENCH.exists(), reason="project-testbench not present")
def test_no_datatype_key_survives_in_widget_schemas():
    offenders = [str(f) for f in _all_schema_files() if "dataType" in f.read_text(encoding="utf-8")]
    assert not offenders, f"stale dataType key in: {offenders}"


@pytest.mark.skipif(not PROJECT_TESTBENCH.exists(), reason="project-testbench not present")
def test_no_opc_literal_survives_in_config_json():
    # Scoped to JSON: in .tsx widget code OPC-shaped words (Boolean(), "Decimal
    # places", "Single") appear legitimately. In config/component JSON the only
    # place a type literal can appear is a schema value.
    offenders: list[str] = []
    for f in _json_files():
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), start=1):
            if _OPC_LITERAL_RE.search(line):
                offenders.append(f"{f}:{i}: {line.strip()}")
    assert not offenders, "OPC literal in HMI config JSON:\n" + "\n".join(offenders)
