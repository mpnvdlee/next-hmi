"""The public artifact must contain no enterprise code.

This is the load-bearing rule of the two-edition split: an AGPL build published
to everyone must not carry proprietary code, because recipients acquire AGPL
rights over whatever they received. Under the private-repository layout the
public tree is clean by construction, so these are a cheap regression net
against the day someone vendors enterprise code into core by accident.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND = REPO_ROOT / "backend"

ENTERPRISE_MODULES = ("nexthmi_enterprise", "manager_enterprise", "main_enterprise")


def _python_sources() -> list[Path]:
    # launcher.py is scanned too: it builds the ee module name with an f-string,
    # which the AST scan cannot see anyway, so excluding it would buy nothing
    # and blind the scan on the file most likely to grow a real import.
    return [p for p in BACKEND.rglob("*.py") if "__pycache__" not in p.parts]


def _imported_names(path: Path) -> set[str]:
    """Every module name this file imports, however it spells the import."""
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
    return names


def test_no_backend_module_imports_enterprise_code():
    offenders: list[str] = []
    for path in _python_sources():
        for name in _imported_names(path):
            root = name.split(".")[0]
            if root in ENTERPRISE_MODULES:
                offenders.append(f"{path.relative_to(REPO_ROOT)} imports {name}")
    assert not offenders, "public backend imports enterprise code:\n" + "\n".join(offenders)


def test_launcher_is_the_only_place_referencing_an_ee_entrypoint():
    """The seam is deliberately one function, so it stays auditable.

    ``launcher`` builds the module name (``f"{base}_enterprise"``) rather than
    spelling it out, so match the suffix rather than a specific module.
    """
    naming = [
        p.relative_to(REPO_ROOT)
        for p in BACKEND.rglob("*.py")
        if "__pycache__" not in p.parts
        and p.name != "test_edition_separation.py"
        and "_enterprise" in p.read_text(encoding="utf-8-sig")
    ]
    assert naming == [Path("backend/launcher.py")], (
        f"expected only backend/launcher.py to reference an ee entrypoint, got {naming}"
    )


class TestEditionDispatch:
    """``launcher._load_edition_app()`` must fail closed on an oss install.

    Imports are stubbed rather than performed: really importing the ee
    entrypoint grafts the enterprise routers onto the *module-level*
    ``manager.app`` singleton, which would leak into every later test in the
    session. It would also make these fail in an enterprise dev checkout, where
    the entrypoint is genuinely importable.
    """

    @pytest.fixture
    def stub_import(self, monkeypatch):
        import launcher

        def _install(available: dict[str, object]):
            def fake_import(name: str):
                if name not in available:
                    raise ImportError(f"No module named {name!r}", name=name)
                return available[name]

            monkeypatch.setattr(launcher.importlib, "import_module", fake_import)

        return _install

    def test_defaults_to_the_open_source_app(self, monkeypatch, stub_import):
        import launcher

        sentinel = type("M", (), {"app": "core-app"})
        stub_import({"manager": sentinel})
        monkeypatch.delenv("NEXTHMI_EDITION", raising=False)

        assert launcher._load_edition_app("manager") == "core-app"

    def test_rejects_an_unknown_edition(self, monkeypatch):
        import launcher

        monkeypatch.setenv("NEXTHMI_EDITION", "bogus")
        with pytest.raises(SystemExit, match="Unknown NEXTHMI_EDITION"):
            launcher._load_edition_app("manager")

    def test_ee_on_an_open_source_build_exits_legibly(self, monkeypatch, stub_import):
        """Not a traceback and not a half-started app — a plain message."""
        import launcher

        stub_import({"manager": object()})  # entrypoint absent
        monkeypatch.setenv("NEXTHMI_EDITION", "ee")

        with pytest.raises(SystemExit, match="open-source build"):
            launcher._load_edition_app("manager")

    def test_a_broken_enterprise_install_surfaces_its_own_error(
        self, monkeypatch, stub_import
    ):
        """An ImportError from *inside* the entrypoint is not 'this is oss'."""
        import launcher

        def fake_import(name: str):
            raise ImportError("No module named 'nexthmi_enterprise'", name="nexthmi_enterprise")

        monkeypatch.setattr(launcher.importlib, "import_module", fake_import)
        monkeypatch.setenv("NEXTHMI_EDITION", "ee")

        with pytest.raises(ImportError, match="nexthmi_enterprise"):
            launcher._load_edition_app("manager")

    def test_both_entrypoints_go_through_the_same_dispatch(self, monkeypatch, stub_import):
        import launcher

        ee = type("M", (), {"app": "ee-instance-app"})
        stub_import({"main_enterprise": ee})
        monkeypatch.setenv("NEXTHMI_EDITION", "ee")

        assert launcher._load_edition_app("main") == "ee-instance-app"
