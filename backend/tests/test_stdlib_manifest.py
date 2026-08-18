"""Tests for ``core.stdlib_manifest`` — the read side of the baked stdlib catalog.

The manifest ships as two files so the frontend can leave the editor-only half
out of an HMI route's bundle (see ``generate_stdlib_manifest``). Config
validation and the MCP tools need the whole picture, so this reader merges the
pair back; these tests pin that seam.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from core import stdlib_manifest

RUNTIME_ROWS = [
    {
        "key": "Layout/Box",
        "name": "Box",
        "displayName": "A Box",
        "category": "Layout & structure",
        "hostsChildren": True,
        "schema": {
            "label": {"type": "string"},
            "motor": {"type": "struct", "requiredFields": ["run"]},
        },
    }
]

EDITOR_ROWS = {
    "Layout/Box": {
        "description": "A box.",
        "icon": {"type": "builtin", "name": "square"},
        "schema": {
            "label": {"label": "Label", "defaultValue": "hi"},
            "motor": {"label": "Motor"},
        },
    }
}


@pytest.fixture
def published(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A packaged runtime's ``dist/stdlib-js`` holding both manifest halves."""
    stdlib_dir = tmp_path / "dist" / "stdlib-js"
    stdlib_dir.mkdir(parents=True)
    (stdlib_dir / "manifest.json").write_text(json.dumps(RUNTIME_ROWS), encoding="utf-8")
    (stdlib_dir / "manifest.editor.json").write_text(
        json.dumps(EDITOR_ROWS), encoding="utf-8"
    )
    monkeypatch.setenv("NEXTHMI_FRONTEND_DIST", str(tmp_path / "dist"))
    monkeypatch.setattr(stdlib_manifest, "_catalog_cache", None)
    return stdlib_dir


def test_editor_manifest_path_is_a_sibling_of_the_runtime_half():
    """One derivation rule, so writer and reader cannot drift apart."""
    assert stdlib_manifest.editor_manifest_path(Path("/x/manifest.json")) == Path(
        "/x/manifest.editor.json"
    )
    assert stdlib_manifest.editor_manifest_path(Path("/x/stdlibManifest.json")) == Path(
        "/x/stdlibManifest.editor.json"
    )


def test_catalog_entries_merge_both_halves(published):
    """Validation type-checks property writes against these schemas, so a field
    has to come back whole — the runtime half's `type` and the editor half's
    label/default on the same field."""
    entries = stdlib_manifest.stdlib_catalog_entries()

    assert entries["Box"] == {
        "name": "A Box",
        "category": "Layout & structure",
        "schema": {
            "label": {"type": "string", "label": "Label", "defaultValue": "hi"},
            "motor": {"type": "struct", "requiredFields": ["run"], "label": "Motor"},
        },
        "description": "A box.",
        "icon": {"type": "builtin", "name": "square"},
        "hostsChildren": True,
    }


def test_catalog_entries_survive_a_missing_editor_half(published, monkeypatch):
    """The editor half is the optional one: a catalog stripped of labels still
    validates property *types*, which is what a page save depends on. Losing the
    runtime half instead would lose the fields themselves."""
    stdlib_manifest.editor_manifest_path(published / "manifest.json").unlink()
    monkeypatch.setattr(stdlib_manifest, "_catalog_cache", None)

    entry = stdlib_manifest.stdlib_catalog_entries()["Box"]
    assert entry["schema"]["label"] == {"type": "string"}
    assert "description" not in entry


def test_catalog_version_turns_over_when_either_half_changes(published):
    """Both halves are written by one build but land as two files. A cache keyed
    on the runtime half alone would serve stale labels after an editor-half
    rewrite."""
    before = stdlib_manifest.stdlib_catalog_version()

    editor = stdlib_manifest.editor_manifest_path(published / "manifest.json")
    os.utime(editor, ns=(0, 12345))
    assert stdlib_manifest.stdlib_catalog_version() != before


def test_catalog_version_separates_the_two_halves_mtimes(published):
    """A checkout, a stash or an rsync sets mtimes to arbitrary values, so one
    half can move back exactly as far as the other moves forward. A key that
    folded the pair into one number would collide there and keep serving the
    previous build's schemas until the process restarted."""
    runtime = published / "manifest.json"
    editor = stdlib_manifest.editor_manifest_path(runtime)
    os.utime(runtime, ns=(0, 1_000))
    os.utime(editor, ns=(0, 2_000))
    before = stdlib_manifest.stdlib_catalog_version()

    os.utime(runtime, ns=(0, 1_500))
    os.utime(editor, ns=(0, 1_500))

    assert stdlib_manifest.stdlib_catalog_version() != before
