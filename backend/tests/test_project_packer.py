"""Phase 5 — zip pack/unpack for projects.

Covers the standalone packer functions; endpoint coverage lives in
``test_projects_api.py``.
"""
from __future__ import annotations

import io
import os
import stat
import sys
import zipfile
from pathlib import Path

import core.component_validation as component_validation_module
import pytest
from core import manifest as manifest_mod
from core.component_validation import (
    ComponentScanError,
    scan_project_component_bindings,
)
from core.project_packer import (
    UnsafeArchiveError,
    max_zip_bytes,
    pack_project,
    unpack_project,
)


def _make_project(root: Path, *, name: str = "Test") -> str:
    """Create a project folder skeleton with metadata; return the project id."""
    root.mkdir(parents=True, exist_ok=True)
    root.mkdir(exist_ok=True)
    (root / "datasources").mkdir(exist_ok=True)
    (root / "datasources" / "PLC1.json").write_text('{"name":"PLC1"}')
    (root / "pages.json").write_text('{"pages":[]}')
    (root / "assets").mkdir(exist_ok=True)
    (root / "users.json").write_text('{"users":[]}')
    metadata = manifest_mod.ensure_project_metadata(root, name=name)
    return metadata.id


def test_pack_then_unpack_round_trips(tmp_path: Path) -> None:
    src = tmp_path / "src"
    pid = _make_project(src, name="Plant A")

    buf = io.BytesIO()
    pack_project(src, buf)
    buf.seek(0)

    dest = tmp_path / "dest"
    metadata = unpack_project(buf, dest)

    assert metadata.id == pid
    assert (dest / "users.json").read_text() == '{"users":[]}'
    assert (dest / "datasources" / "PLC1.json").read_text() == '{"name":"PLC1"}'
    assert manifest_mod.read_project_metadata(dest).id == pid


def test_unpack_rejects_recursive_component_var_binding_with_exact_source(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _make_project(src)
    component_dir = src / "components" / "Process"
    component_dir.mkdir(parents=True)
    (component_dir / "invalid.json").write_text(
        '{"name":"Invalid","componentProperties":{},"children":['
        '{"type":"Label","properties":{"text":{"items":['
        '{"$componentProp":"label"},{"$var":{"path":"PLC:Value"}}]}}}]}'
    )
    buf = io.BytesIO()
    pack_project(src, buf)
    buf.seek(0)

    with pytest.raises(UnsafeArchiveError) as exc_info:
        unpack_project(buf, tmp_path / "dest")

    assert (
        "components/Process/invalid.json#/children/0/properties/text/items/1/$var"
        in str(exc_info.value)
    )


@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        (b'{"name":', "component file contains malformed JSON"),
        (b'\xff\xfe', "component file is not valid UTF-8"),
        (b'[]', "component definition must be an object"),
    ],
    ids=["malformed-json", "invalid-unicode", "non-object"],
)
def test_unpack_rejects_unreadable_component_content(
    tmp_path: Path, payload: bytes, reason: str,
) -> None:
    src = tmp_path / "src"
    _make_project(src)
    components = src / "components"
    components.mkdir()
    (components / "invalid.json").write_bytes(payload)
    buf = io.BytesIO()
    pack_project(src, buf)
    buf.seek(0)

    with pytest.raises(UnsafeArchiveError) as exc_info:
        unpack_project(buf, tmp_path / "dest")

    assert f"components/invalid.json#/: {reason}" in str(exc_info.value)


def test_component_scan_reports_unreadable_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = tmp_path / "project"
    components = project / "components"
    components.mkdir(parents=True)
    path = components / "unreadable.json"
    path.write_text("{}")
    original_open = component_validation_module.os.open

    def fail_component_read(candidate, *args, **kwargs):
        if Path(candidate) == path:
            raise OSError("platform-specific detail")
        return original_open(candidate, *args, **kwargs)

    monkeypatch.setattr(component_validation_module.os, "open", fail_component_read)

    with pytest.raises(ComponentScanError) as exc_info:
        scan_project_component_bindings(project)

    assert str(exc_info.value) == (
        "components/unreadable.json#/: component file is unreadable"
    )


def test_unpack_distinguishes_absent_components_dir_from_non_directory(tmp_path: Path) -> None:
    valid_source = tmp_path / "valid-source"
    _make_project(valid_source)
    valid_archive = io.BytesIO()
    pack_project(valid_source, valid_archive)
    valid_archive.seek(0)
    unpack_project(valid_archive, tmp_path / "valid-destination")

    invalid_source = tmp_path / "invalid-source"
    _make_project(invalid_source)
    (invalid_source / "components").write_text("not a directory")
    invalid_archive = io.BytesIO()
    pack_project(invalid_source, invalid_archive)
    invalid_archive.seek(0)

    with pytest.raises(UnsafeArchiveError) as exc_info:
        unpack_project(invalid_archive, tmp_path / "invalid-destination")

    assert "components#/: component storage is not a directory" in str(exc_info.value)


def test_pack_excludes_widget_build(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _make_project(src)
    (src / "widget-build").mkdir()
    (src / "widget-build" / "Compiled.js").write_text("// generated")
    (src / "widget-build" / "nested").mkdir()
    (src / "widget-build" / "nested" / "deep.js").write_text("// deeper")

    buf = io.BytesIO()
    pack_project(src, buf)
    buf.seek(0)
    with zipfile.ZipFile(buf, "r") as zf:
        names = set(zf.namelist())

    assert not any(n.startswith("widget-build/") for n in names), names


def test_pack_writes_metadata_if_missing(tmp_path: Path) -> None:
    """A folder with no metadata block should still pack — packer creates one in config.json."""
    src = tmp_path / "src"
    src.mkdir()
    src.mkdir(exist_ok=True)
    (src / "pages.json").write_text("{}")
    # No ensure_project_metadata call; packer must do it for us.

    buf = io.BytesIO()
    pack_project(src, buf)
    buf.seek(0)
    with zipfile.ZipFile(buf, "r") as zf:
        names = set(zf.namelist())

    assert manifest_mod.PROJECT_CONFIG_FILENAME in names
    # And it was written to disk too.
    assert manifest_mod.read_project_metadata(src) is not None


def test_pack_keeps_historian_config_but_strips_db(tmp_path: Path) -> None:
    """historian/config.json travels with the project; runtime DB files don't."""
    src = tmp_path / "src"
    _make_project(src)
    hist_dir = src / "historian"
    hist_dir.mkdir(parents=True)
    (hist_dir / "config.json").write_text('{"variables":{}}')
    (hist_dir / "history.db").write_bytes(b"sqlite payload")
    (hist_dir / "history.db-wal").write_bytes(b"wal")
    (hist_dir / "history.db-shm").write_bytes(b"shm")

    buf = io.BytesIO()
    pack_project(src, buf)
    buf.seek(0)
    with zipfile.ZipFile(buf, "r") as zf:
        names = set(zf.namelist())

    assert "historian/config.json" in names
    assert "historian/history.db" not in names
    assert "historian/history.db-wal" not in names
    assert "historian/history.db-shm" not in names


def test_pack_skips_symlinks(tmp_path: Path) -> None:
    if sys.platform == "win32":
        pytest.skip("Symlink creation requires admin privileges on Windows")
    src = tmp_path / "src"
    _make_project(src)
    target = tmp_path / "outside.txt"
    target.write_text("not in project")
    (src / "link.txt").symlink_to(target)

    buf = io.BytesIO()
    pack_project(src, buf)
    buf.seek(0)
    with zipfile.ZipFile(buf, "r") as zf:
        names = set(zf.namelist())
    assert "link.txt" not in names


def test_unpack_rejects_path_traversal(tmp_path: Path) -> None:
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("../escape.txt", "pwned")

    dest = tmp_path / "dest"
    with bad.open("rb") as fp, pytest.raises(UnsafeArchiveError):
        unpack_project(fp, dest)
    assert not (tmp_path / "escape.txt").exists()


def test_unpack_rejects_absolute_path(tmp_path: Path) -> None:
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("/etc/passwd", "x")

    dest = tmp_path / "dest"
    with bad.open("rb") as fp, pytest.raises(UnsafeArchiveError):
        unpack_project(fp, dest)


def test_unpack_rejects_symlink_member(tmp_path: Path) -> None:
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as zf:
        info = zipfile.ZipInfo("link.txt")
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        zf.writestr(info, "/etc/passwd")

    dest = tmp_path / "dest"
    with bad.open("rb") as fp, pytest.raises(UnsafeArchiveError):
        unpack_project(fp, dest)


def test_unpack_rejects_symlinked_component_member_with_stable_error(tmp_path: Path) -> None:
    bad = tmp_path / "component-link.zip"
    with zipfile.ZipFile(bad, "w") as zf:
        info = zipfile.ZipInfo("components/linked.json")
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        zf.writestr(info, "/outside/component.json")

    with bad.open("rb") as fp, pytest.raises(UnsafeArchiveError) as exc_info:
        unpack_project(fp, tmp_path / "dest")

    assert (
        "Archive contains a symlink member ('components/linked.json')"
        in str(exc_info.value)
    )


def test_unpack_enforces_size_cap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NEXTHMI_MAX_PROJECT_ZIP_MB", "1")
    bad = tmp_path / "bad.zip"
    payload = b"x" * (2 * 1024 * 1024)  # 2 MB > 1 MB cap
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("huge.bin", payload)

    dest = tmp_path / "dest"
    with bad.open("rb") as fp, pytest.raises(UnsafeArchiveError):
        unpack_project(fp, dest)


def test_unpack_requires_metadata_block(tmp_path: Path) -> None:
    """A zip whose config.json has no `project` block is rejected."""
    bad = tmp_path / "no-meta.zip"
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("pages.json", "{}")

    dest = tmp_path / "dest"
    with bad.open("rb") as fp, pytest.raises(UnsafeArchiveError):
        unpack_project(fp, dest)


def test_progress_callback_reports_total_and_done(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _make_project(src)

    events: list[tuple[int, int]] = []
    buf = io.BytesIO()
    pack_project(src, buf, progress=lambda d, t: events.append((d, t)))
    assert events, "pack should emit at least one progress event"
    final_done, final_total = events[-1]
    assert final_done == final_total
    assert final_total > 0


def test_max_zip_bytes_defaults_to_500_mb(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NEXTHMI_MAX_PROJECT_ZIP_MB", raising=False)
    assert max_zip_bytes() == 500 * 1024 * 1024


def test_max_zip_bytes_falls_back_on_invalid_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NEXTHMI_MAX_PROJECT_ZIP_MB", "not-a-number")
    assert max_zip_bytes() == 500 * 1024 * 1024


def test_pack_preserves_executable_mode(tmp_path: Path) -> None:
    if sys.platform == "win32":
        pytest.skip("POSIX mode bits not preserved on Windows")
    src = tmp_path / "src"
    _make_project(src)
    script = src / "tool.sh"
    script.write_text("#!/bin/sh\necho hi\n")
    os.chmod(script, 0o755)

    buf = io.BytesIO()
    pack_project(src, buf)
    buf.seek(0)
    dest = tmp_path / "dest"
    unpack_project(buf, dest)

    extracted_mode = (dest / "tool.sh").stat().st_mode & 0o777
    assert extracted_mode == 0o755
