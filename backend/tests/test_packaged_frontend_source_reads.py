"""Regression guard: every frontend *source* file the backend reads at runtime
must be shipped by both distributions.

The SPA bundle travels as ``frontend/dist``, but a file under ``frontend/src/``
that the backend itself reads is not part of that bundle and needs its own line
in the packaging. A checkout never notices when one stops shipping —
``repo_root()`` finds it there — so the failure only ever appears in a packaged
build, and silently.

Each file has to appear in three places, checked here: ``build/nexthmi.spec``
datas, a ``Dockerfile`` COPY into ``/app/``, and (for the frozen case)
``core.storage.repo_root()`` resolving to ``sys._MEIPASS``.

The last test covers the sibling case: the baked built-in-widgets manifest,
which the backend also cannot do without and which *is* inside
``frontend/dist`` — so it needs no datas line, only a build that actually
produced it.
"""
import os
from pathlib import Path, PurePosixPath

import core.storage as storage
import models.theme as theme
import pytest

_ROOT = Path(__file__).resolve().parents[2]
_SPEC = _ROOT / "build" / "nexthmi.spec"
_DOCKERFILE = _ROOT / "Dockerfile"


def _repo_relative(path: Path) -> PurePosixPath:
    return PurePosixPath(path.resolve().relative_to(storage.repo_root()).as_posix())


# Derived from the resolvers themselves, so moving a file moves the assertion
# with it rather than leaving a stale literal behind.
FRONTEND_SOURCE_READS = [
    _repo_relative(theme._DEFAULTS_PATH),
]


@pytest.fixture(scope="module")
def spec_text() -> str:
    assert _SPEC.is_file(), f"build spec missing at {_SPEC}"
    return _SPEC.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def dockerfile_text() -> str:
    assert _DOCKERFILE.is_file(), f"Dockerfile missing at {_DOCKERFILE}"
    return _DOCKERFILE.read_text(encoding="utf-8")


@pytest.mark.parametrize("relative", FRONTEND_SOURCE_READS, ids=str)
def test_present_in_the_checkout(relative: PurePosixPath) -> None:
    assert (_ROOT / relative).is_file()


@pytest.mark.parametrize("relative", FRONTEND_SOURCE_READS, ids=str)
def test_binary_spec_ships_it(spec_text: str, relative: PurePosixPath) -> None:
    """datas carries the file, destined for its checkout-relative directory —
    which is where ``repo_root()`` looks under ``sys._MEIPASS``."""
    assert f'"{relative.name}"' in spec_text, f"{relative} is not named in the spec"
    assert f'"{relative.parent}"' in spec_text, (
        f"{relative} must ship into '{relative.parent}' so repo_root() finds it when frozen"
    )


@pytest.mark.parametrize("relative", FRONTEND_SOURCE_READS, ids=str)
def test_docker_image_copies_it(dockerfile_text: str, relative: PurePosixPath) -> None:
    """Docker's runtime stage copies ``backend/`` and ``frontend/dist`` only, so
    each of these needs its own COPY — ``repo_root()`` there is ``/app``."""
    assert f"/app/{relative}" in dockerfile_text, (
        f"Dockerfile has no COPY of {relative} into /app/{relative}"
    )


def test_no_frontend_source_read_is_missing_from_the_list() -> None:
    """The list above is hand-maintained, so pin the one thing that would make it
    incomplete without anyone noticing: a backend module resolving a path under
    ``frontend/src/`` that nobody registered here."""
    # Only path *construction* counts: the tree is full of comments naming a
    # frontend file this or that constant mirrors, and those read nothing.
    offenders: list[str] = []
    for module in (_ROOT / "backend").rglob("*.py"):
        if "__pycache__" in module.parts or module.parts[-2] == "tests":
            continue
        if '"frontend" / "src"' in module.read_text(encoding="utf-8"):
            offenders.append(str(module.relative_to(_ROOT).as_posix()))

    known = {
        # Reads themeDefaults.json — the one entry in FRONTEND_SOURCE_READS.
        "backend/models/theme.py",
        # Resolves a *generated* artifact that ships inside frontend/dist in a
        # packaged build (the built-in-widgets manifest, via
        # NEXTHMI_FRONTEND_DIST) and falls back to the checkout path only in dev.
        "backend/core/builtin_widgets_manifest.py",
    }
    assert set(offenders) <= known, (
        "a backend module reads a frontend/src path that is not covered here — "
        f"add it to FRONTEND_SOURCE_READS or to `known`: {sorted(set(offenders) - known)}"
    )


def test_binary_spec_refuses_a_bundle_without_the_baked_builtin_widgets_manifest(spec_text: str) -> None:
    """The ``builtin`` half of ``widget-schemas.json`` is always empty, so the
    baked built-in-widgets manifest is the validator's only source of widget
    types. It ships inside ``frontend/dist``, which the spec bundles wholesale —
    meaning the spec cannot tell a complete bundle from one built by
    ``npm run build:app`` unless it looks. It looks.

    Asserting on the spec's text rather than running it: executing a spec needs
    PyInstaller's injected globals. This pins that the check is still there and
    still names both halves, which is what a well-meaning cleanup would remove.
    """
    dist_relative = PurePosixPath("builtin-widgets-js") / "manifest.json"
    assert f'"{dist_relative.parent}" / "{dist_relative.name}"' in spec_text, (
        "build/nexthmi.spec must verify the baked built-in-widgets manifest is in the bundle — "
        "without it a packaged binary rejects every widget on save"
    )
    assert '"manifest.editor.json"' in spec_text, (
        "the editor half travels with the runtime half; the spec must check for both"
    )


def test_builtin_widgets_manifest_dist_location_matches_what_the_spec_checks() -> None:
    """The spec hardcodes the in-bundle path; the reader derives it from
    ``NEXTHMI_FRONTEND_DIST``. Pin them together so moving one moves the other."""
    import core.builtin_widgets_manifest as builtin_widgets_manifest

    dist = _ROOT / "frontend" / "dist"
    prev = os.environ.get("NEXTHMI_FRONTEND_DIST")
    os.environ["NEXTHMI_FRONTEND_DIST"] = str(dist)
    try:
        expected = dist / "builtin-widgets-js" / "manifest.json"
        if not expected.is_file():
            pytest.skip("no built frontend/dist in this checkout")
        assert builtin_widgets_manifest.builtin_widgets_manifest_path() == expected.resolve()
        assert (
            builtin_widgets_manifest.editor_manifest_path(expected).name == "manifest.editor.json"
        )
    finally:
        if prev is None:
            os.environ.pop("NEXTHMI_FRONTEND_DIST", None)
        else:
            os.environ["NEXTHMI_FRONTEND_DIST"] = prev


def test_repo_root_is_the_bundle_root_when_frozen(monkeypatch, tmp_path) -> None:
    """The spec ships these at checkout-relative paths inside the bundle, and
    PyInstaller seals ``core/storage.py`` where the ``parents[]`` walk lands
    above the extracted tree — so the frozen root has to come from
    ``sys._MEIPASS``."""
    monkeypatch.setattr(storage.sys, "_MEIPASS", str(tmp_path), raising=False)

    assert storage._resolve_repo_root() == tmp_path.resolve()

    monkeypatch.delattr(storage.sys, "_MEIPASS", raising=False)
    assert storage._resolve_repo_root() == _ROOT
