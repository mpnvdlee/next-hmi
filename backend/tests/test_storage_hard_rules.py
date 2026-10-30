"""Two storage hard rules from docs/dev/operations/agents.md, enforced.

1. Files are written through the ``core.storage`` atomic helpers, never with a
   raw ``open(..., "w")`` / ``write_text`` / ``write_bytes`` — a crash halfway
   through a raw write leaves a truncated project file behind.
2. Workspace paths come from the ``active_*()`` resolvers, called each time. A
   call at import time pins the path to whichever project was live then, and a
   live-project switch silently keeps writing to the old one.

A new exemption is a deliberate act: add it below with the reason.
"""
from __future__ import annotations

import ast
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND = REPO_ROOT / "backend"

RAW_WRITE_EXEMPT: dict[tuple[str, str], str] = {
    ("backend/api/manager_peers_api.py", "_send_transfer"): "streams an archive; sha256 verified after",
    ("backend/api/manager_peers_api.py", "_run_pull"): "streams a download chunk by chunk",
    ("backend/core/bootstrap.py", "write_bootstrap_config"): "own tmp+replace; importing storage would cycle",
    ("backend/core/manifest.py", "_manifest_guard"): "lock file handle, not data",
    ("backend/core/project_migrations.py", "_write_backup_zip"): "streams to .partial, then os.replace",
    ("backend/core/project_packer.py", "unpack_project"): "streams extracted entries",
    ("backend/core/translations.py", "translation_transaction"): "lock file handle, not data",
    ("backend/services/supervisor.py", "_spawn_locked"): "append-only child-process log",
}

IMPORT_TIME_RESOLVER_EXEMPT: dict[str, str] = {
    "backend/main.py": "the instance process is pinned to one project for its lifetime",
}


def _sources() -> list[Path]:
    return [
        p
        for p in BACKEND.rglob("*.py")
        if "__pycache__" not in p.parts and "tests" not in p.parts and p != BACKEND / "core" / "storage.py"
    ]


def _rel(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def _call_name(call: ast.Call) -> str:
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def _open_mode(call: ast.Call) -> str | None:
    for kw in call.keywords:
        if kw.arg == "mode":
            node = kw.value
            break
    else:
        position = 1 if isinstance(call.func, ast.Name) else 0
        node = call.args[position] if len(call.args) > position else None
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _is_raw_write(call: ast.Call) -> bool:
    name = _call_name(call)
    if name in ("write_text", "write_bytes"):
        return True
    if name == "open":
        mode = _open_mode(call)
        return mode is not None and bool(set(mode) & set("wax+"))
    return False


class _RawWrites(ast.NodeVisitor):
    def __init__(self) -> None:
        self.function = "<module>"
        self.hits: list[tuple[str, int]] = []

    def _enter(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        outer, self.function = self.function, node.name
        self.generic_visit(node)
        self.function = outer

    visit_FunctionDef = _enter
    visit_AsyncFunctionDef = _enter

    def visit_Call(self, node: ast.Call) -> None:
        if _is_raw_write(node):
            self.hits.append((self.function, node.lineno))
        self.generic_visit(node)


def _import_time_calls(tree: ast.Module) -> list[ast.Call]:
    """Calls that run when the module is imported: module and class bodies,
    default argument values and decorators — not function bodies."""
    found: list[ast.Call] = []

    def walk(node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for expr in [*child.args.defaults, *child.args.kw_defaults, *child.decorator_list]:
                    if expr is not None:
                        found.extend(n for n in ast.walk(expr) if isinstance(n, ast.Call))
                continue
            if isinstance(child, ast.Lambda):
                continue
            if isinstance(child, ast.Call):
                found.append(child)
            walk(child)

    walk(tree)
    return found


def test_files_are_written_through_storage_helpers() -> None:
    offenders = []
    for path in _sources():
        visitor = _RawWrites()
        visitor.visit(ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path)))
        for function, line in visitor.hits:
            if (_rel(path), function) not in RAW_WRITE_EXEMPT:
                offenders.append(f"{_rel(path)}:{line} in {function}()")
    assert not offenders, (
        "Raw file writes outside core/storage.py — use write_json / write_text_atomic / "
        "write_bytes_atomic, or add a reasoned exemption:\n" + "\n".join(offenders)
    )


def test_workspace_resolvers_are_not_called_at_import_time() -> None:
    offenders = []
    for path in _sources():
        if _rel(path) in IMPORT_TIME_RESOLVER_EXEMPT:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
        for call in _import_time_calls(tree):
            if _call_name(call).startswith("active_"):
                offenders.append(f"{_rel(path)}:{call.lineno} {_call_name(call)}()")
    assert not offenders, (
        "Workspace resolver called at import time — call it inside the function that "
        "needs the path:\n" + "\n".join(offenders)
    )


def test_exemptions_still_point_at_real_code() -> None:
    live = set()
    for path in _sources():
        visitor = _RawWrites()
        visitor.visit(ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path)))
        live.update((_rel(path), function) for function, _ in visitor.hits)
    stale = sorted(set(RAW_WRITE_EXEMPT) - live)
    assert not stale, f"Exemptions for raw writes that no longer exist — remove them: {stale}"
