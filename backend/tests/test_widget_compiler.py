"""Smoke tests for the backend widget compiler.

These tests shell out to the real esbuild binary (the one
``frontend/node_modules/.bin/esbuild`` provides) since we want to exercise
the same toolchain end-users will get. If esbuild isn't installed, the tests
skip — local dev should `npm install` once in frontend/ to satisfy this.
"""
import json
import shutil
from pathlib import Path, PurePosixPath, PureWindowsPath

import core.storage as storage
import pytest
from services import widget_compiler


# Locate the esbuild binary the same way widget_compiler does, so we can skip
# the suite cleanly if it isn't available.
def _esbuild_present() -> bool:
    if shutil.which("esbuild"):
        return True
    repo_root = Path(__file__).resolve().parent.parent.parent
    return (repo_root / "frontend" / "node_modules" / ".bin" / "esbuild").is_file()


pytestmark = pytest.mark.skipif(
    not _esbuild_present(), reason="esbuild binary required for widget compiler"
)


GOOD_WIDGET = """\
export const schema = {
  label: { type: 'string', label: 'Label' },
};

export default function Foo({ properties }: HmiWidgetProps) {
  const label = usePropString(properties, 'label', '');
  return React.createElement('div', null, label);
}
"""

BAD_WIDGET = """\
export const schema = { label: { type: 'string' } };
export default function Foo({ properties }: { properties: unknown } {
  // unbalanced parens above → esbuild parse error
  return null;
}
"""

REACT_IMPORT_WIDGET = """\
import React from 'react';
export const schema = { label: { type: 'string' } };
export default function Foo() {
  return React.createElement('div', null, 'hi');
}
"""

APP_IMPORT_WIDGET = """\
import { something } from '@shared/utils/valueTypes';
export const schema = { label: { type: 'string' } };
export default function Foo() {
  return React.createElement('div', null, something);
}
"""

EXTERNAL_IMPORT_WIDGET = """\
import { formatLabel } from 'example-lib';
export const schema = { label: { type: 'string' } };
export default function Foo() {
  return React.createElement('div', null, formatLabel('hi'));
}
"""

SDK_COLLISION_WIDGET = """\
export const schema = { label: { type: 'string' } };
function parseVarKey(x: string) { return x; }
export default function Foo({ properties }: HmiWidgetProps) {
  const label = usePropString(properties, 'label', '');
  return React.createElement('div', null, label + parseVarKey('x'));
}
"""

SIBLING_IMPORT_WIDGET = """\
import { greet } from './helper';
export const schema = { label: { type: 'string' } };
export default function Foo() {
  return React.createElement('div', null, greet());
}
"""

SIBLING_HELPER = """\
export function greet() { return 'hello from helper'; }
"""


@pytest.fixture
def widget_workspace(monkeypatch, tmp_path: Path):
    """Redirect CUSTOM_WIDGETS_DIR + WIDGET_BUILD_DIR + BUILD_STATUS_PATH +
    the cached schema-manifest helper into a tmp workspace so each test is
    hermetic.
    """
    src = tmp_path / "custom-widgets"
    build = tmp_path / "widget-build"
    src.mkdir()
    build.mkdir()

    monkeypatch.setattr(storage, "WIDGET_BUILD_DIR", build)
    monkeypatch.setattr(storage, "BUILD_STATUS_PATH", build / ".build-status.json")
    # widget_compiler resolves the custom-widgets src dir through the
    # ``active_custom_widgets_dir`` accessor — patch it directly so the
    # build_dir / build_status overrides above stay anchored at ``build``.
    monkeypatch.setattr(widget_compiler, "active_custom_widgets_dir", lambda: src)
    monkeypatch.setattr(widget_compiler, "WIDGET_BUILD_DIR", build)
    monkeypatch.setattr(widget_compiler, "BUILD_STATUS_PATH", build / ".build-status.json")

    return {"src": src, "build": build}


def _write_widget(root: Path, key: str, source: str) -> Path:
    parts = key.split("/")
    widget_dir = root
    for part in parts:
        widget_dir = widget_dir / part
    widget_dir.mkdir(parents=True, exist_ok=True)
    entry = widget_dir / "index.tsx"
    entry.write_text(source, encoding="utf-8")
    return entry


@pytest.mark.asyncio
async def test_compile_entry_success_writes_js_with_sdk_banner(widget_workspace):
    src, build = widget_workspace["src"], widget_workspace["build"]
    entry = _write_widget(src, "Inputs/Foo", GOOD_WIDGET)

    ok = await widget_compiler.compile_entry(entry)

    assert ok is True
    out_js = build / "Inputs" / "Foo" / "index.js"
    assert out_js.is_file()
    body = out_js.read_text(encoding="utf-8")
    # First line is the SDK destructuring banner; only names referenced by
    # the source are included.
    first_line = body.splitlines()[0]
    assert first_line.startswith("const { ")
    assert first_line.endswith(" } = window.__nextHMI__;")
    assert "React" in first_line
    assert "usePropString" in first_line
    # Sanity check that the compiled body still includes the function.
    assert "function Foo" in body


@pytest.mark.asyncio
async def test_compile_entry_failure_records_status_without_raising(widget_workspace):
    src, build = widget_workspace["src"], widget_workspace["build"]
    entry = _write_widget(src, "Other/Broken", BAD_WIDGET)

    ok = await widget_compiler.compile_entry(entry)

    assert ok is False
    out_js = build / "Other" / "Broken" / "index.js"
    assert not out_js.exists(), "no JS should be written on parse failure"

    status_path = build / ".build-status.json"
    status = json.loads(status_path.read_text(encoding="utf-8"))
    assert status["version"] == 2
    assert status["widgets"]["Other/Broken"]["ok"] is False
    assert "error" in status["widgets"]["Other/Broken"]


@pytest.mark.asyncio
async def test_compile_entry_rejects_bare_react_import(widget_workspace):
    """§4.1: a bare `import React from 'react'` must fail the compile with a
    descriptive error instead of producing a module that duplicate-declares
    `React` via the SDK banner and throws at load time."""
    src, build = widget_workspace["src"], widget_workspace["build"]
    entry = _write_widget(src, "Inputs/Foo", REACT_IMPORT_WIDGET)

    ok = await widget_compiler.compile_entry(entry)

    assert ok is False
    assert not (build / "Inputs" / "Foo" / "index.js").exists()
    status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    assert status["widgets"]["Inputs/Foo"]["ok"] is False
    assert "react" in status["widgets"]["Inputs/Foo"]["error"].lower()


@pytest.mark.asyncio
async def test_compile_entry_rejects_app_internal_import(widget_workspace):
    """§4.1: unregistered app/package imports are rejected."""
    src, build = widget_workspace["src"], widget_workspace["build"]
    entry = _write_widget(src, "Inputs/Foo", APP_IMPORT_WIDGET)

    ok = await widget_compiler.compile_entry(entry)

    assert ok is False
    status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    assert "@shared/utils/valueTypes" in status["widgets"]["Inputs/Foo"]["error"]


@pytest.mark.asyncio
async def test_compile_entry_preserves_registered_external_import(widget_workspace):
    src, build = widget_workspace["src"], widget_workspace["build"]
    library_dir = src.parent / "external-libraries" / "example-lib"
    library_dir.mkdir(parents=True)
    (library_dir / "example-lib.js").write_text(
        "export const formatLabel = (value) => value;", encoding="utf-8"
    )
    entry = _write_widget(src, "Inputs/Foo", EXTERNAL_IMPORT_WIDGET)

    ok = await widget_compiler.compile_entry(entry)

    assert ok is True
    body = (build / "Inputs" / "Foo" / "index.js").read_text(encoding="utf-8")
    assert 'from "example-lib"' in body


@pytest.mark.asyncio
async def test_compile_entry_rejects_local_sdk_name_collision(widget_workspace):
    """§4.1: a local declaration named after a reserved SDK global (e.g. a
    helper called `parseVarKey`) must fail the compile instead of producing a
    module where the SDK banner's `const { parseVarKey } = ...` collides with
    it and throws `Identifier already declared` at load time."""
    src, build = widget_workspace["src"], widget_workspace["build"]
    entry = _write_widget(src, "Inputs/Foo", SDK_COLLISION_WIDGET)

    ok = await widget_compiler.compile_entry(entry)

    assert ok is False
    status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    assert "parseVarKey" in status["widgets"]["Inputs/Foo"]["error"]


@pytest.mark.asyncio
async def test_compile_entry_bundles_sibling_relative_import(widget_workspace):
    """§4.2: a sibling helper file imported via a relative path must be
    bundled into the single compiled entry, not left as an unresolved
    import that 404s in the browser."""
    src, build = widget_workspace["src"], widget_workspace["build"]
    entry = _write_widget(src, "Inputs/Foo", SIBLING_IMPORT_WIDGET)
    (entry.parent / "helper.ts").write_text(SIBLING_HELPER, encoding="utf-8")

    ok = await widget_compiler.compile_entry(entry)

    assert ok is True
    out_js = build / "Inputs" / "Foo" / "index.js"
    body = out_js.read_text(encoding="utf-8")
    assert "hello from helper" in body
    assert "from './helper'" not in body
    assert "from \"./helper\"" not in body


@pytest.mark.asyncio
async def test_compile_all_isolates_failures(widget_workspace):
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Inputs/Good", GOOD_WIDGET)
    _write_widget(src, "Other/Broken", BAD_WIDGET)

    ok = await widget_compiler.compile_all()

    # One succeeds, one fails — both are recorded; the good one writes JS.
    assert ok is False
    assert (build / "Inputs" / "Good" / "index.js").is_file()
    assert not (build / "Other" / "Broken" / "index.js").exists()
    status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    assert status["widgets"]["Inputs/Good"]["ok"] is True
    assert status["widgets"]["Other/Broken"]["ok"] is False


@pytest.mark.asyncio
async def test_duplicate_leaf_names_have_independent_status(widget_workspace):
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Inputs/Display", GOOD_WIDGET)
    _write_widget(src, "Other/Display", BAD_WIDGET)
    storage.write_json(
        build / ".build-status.json",
        {"version": 2, "widgets": {"Inputs/Display": {"ok": True, "ts": "stale"}}},
    )

    events: list[dict] = []

    async def record(event: dict) -> None:
        events.append(event)

    schema_ok = await widget_compiler.recompile(record)

    assert schema_ok is True
    status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    assert status["version"] == 2
    assert status["widgets"]["Inputs/Display"]["ok"] is True
    assert status["widgets"]["Other/Display"]["ok"] is False
    assert status["widgets"]["Inputs/Display"]["ts"] != "stale"
    assert {event["key"] for event in events} == {"Inputs/Display", "Other/Display"}
    assert {
        event["key"]: event["ts"] for event in events
    } == {
        key: value["ts"] for key, value in status["widgets"].items()
    }


@pytest.mark.asyncio
async def test_leaf_keyed_status_is_discarded_not_migrated(widget_workspace):
    """A pre-v2 leaf-keyed file buys a rebuild, not a migration."""
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Inputs/Display", GOOD_WIDGET)
    leaf_keyed = {"Display": {"ok": False, "error": "stale error", "ts": "old"}}
    storage.write_json(build / ".build-status.json", leaf_keyed)

    await widget_compiler._prepare_status(widget_compiler.compile_target(src))

    rewritten = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    assert rewritten == {"version": 2, "widgets": {}}
    assert widget_compiler.decode_build_status(leaf_keyed) == {}


@pytest.mark.asyncio
async def test_compile_all_prunes_deleted_widget_status_and_output(widget_workspace):
    src, build = widget_workspace["src"], widget_workspace["build"]
    entry = _write_widget(src, "Inputs/Display", GOOD_WIDGET)
    await widget_compiler.compile_all()
    output = build / "Inputs" / "Display" / "index.js"
    assert output.is_file()

    entry.unlink()
    await widget_compiler.compile_all()

    status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    assert status == {"version": 2, "widgets": {}}
    assert not output.exists()


@pytest.mark.asyncio
async def test_compile_entry_handles_flat_layout(widget_workspace):
    """The ``<Name>/index.tsx`` layout (no group dir) is also supported."""
    src, build = widget_workspace["src"], widget_workspace["build"]
    entry = _write_widget(src, "FlatWidget", GOOD_WIDGET)

    ok = await widget_compiler.compile_entry(entry)

    assert ok is True
    assert (build / "FlatWidget" / "index.js").is_file()


def test_find_entries_skips_dotfiles_and_underscored_dirs(widget_workspace):
    src = widget_workspace["src"]
    _write_widget(src, "Inputs/Foo", GOOD_WIDGET)
    _write_widget(src, "_template/Skipped", GOOD_WIDGET)
    _write_widget(src, ".hidden/Skipped", GOOD_WIDGET)

    entries = widget_compiler.find_entries()

    rel = sorted(str(e.relative_to(src)) for e in entries)
    assert rel == ["Inputs/Foo/index.tsx"]


def test_widget_key_normalizes_posix_and_windows_parts_to_forward_slashes():
    posix = PurePosixPath("Inputs/Display/index.tsx")
    windows = PureWindowsPath(r"Inputs\Display\index.tsx")

    assert widget_compiler._widget_key_from_parts(posix.parts) == "Inputs/Display"
    assert widget_compiler._widget_key_from_parts(windows.parts) == "Inputs/Display"


@pytest.mark.parametrize(
    "key",
    [
        "",
        "/Display",
        "Inputs/",
        "Inputs//Display",
        "Inputs/../Display",
        r"Inputs\Display",
        r"C:\Display",
        "Inputs%2FDisplay",
        "Inputs%5CDisplay",
        "Inputs?mode/Display",
        "Inputs#fragment/Display",
        "Inputs/Display.js",
        "Inputs/NUL",
        "COM1/Display",
        "Inputs／Display",  # noqa: RUF001 -- fullwidth-slash confusable, deliberately testing rejection of the lookalike as a path separator
        "Inputs＼Display",  # noqa: RUF001 -- fullwidth-backslash confusable, deliberately testing rejection of the lookalike as a path separator
        "Inputs⁄Display",  # noqa: RUF001 -- fraction-slash confusable, deliberately testing rejection of the lookalike as a path separator
        "Inputs∕Display",  # noqa: RUF001 -- division-slash confusable, deliberately testing rejection of the lookalike as a path separator
        "Inputs⧸Display",  # noqa: RUF001 -- big-solidus confusable, deliberately testing rejection of the lookalike as a path separator
        "Inputs⧵Display",  # noqa: RUF001 -- reverse-solidus-operator confusable, deliberately testing rejection of the lookalike as a path separator
        "Inputs/Display/Extra",
    ],
)
def test_canonical_widget_key_rejects_path_and_url_aliases(widget_workspace, key):
    raw = {"version": 2, "widgets": {key: {"ok": True}}}

    assert widget_compiler.is_canonical_widget_key(key) is False
    assert widget_compiler.decode_build_status(raw) == {}
    assert widget_compiler.entry_for_key(key) is None


def test_discovery_skips_unsafe_or_ambiguous_widget_segments(widget_workspace):
    src = widget_workspace["src"]
    _write_widget(src, "Inputs/Good_Name-2", GOOD_WIDGET)
    _write_widget(src, r"Inputs\Backslash", GOOD_WIDGET)
    _write_widget(src, "Inputs/Encoded%2FName", GOOD_WIDGET)
    _write_widget(src, "Inputs/Query?Name", GOOD_WIDGET)
    _write_widget(src, "Inputs/Fullwidth／Name", GOOD_WIDGET)  # noqa: RUF001 -- fullwidth-slash confusable, deliberately testing rejection of the lookalike as a path separator
    _write_widget(src, "Space Group/Name", GOOD_WIDGET)

    keys = [widget_compiler.widget_key(entry, src) for entry in widget_compiler.find_entries(src)]

    assert keys == ["Inputs/Good_Name-2"]


def test_entry_lookup_requires_exact_case_from_discovery(widget_workspace):
    src = widget_workspace["src"]
    entry = _write_widget(src, "Inputs/Display", GOOD_WIDGET)

    assert widget_compiler.entry_for_key("Inputs/Display") == entry
    assert widget_compiler.entry_for_key("inputs/display") is None
    assert widget_compiler.entry_for_key("Inputs/display") is None


def test_casefold_colliding_source_keys_are_both_rejected(widget_workspace):
    src = widget_workspace["src"]
    upper = src / "Inputs" / "Display" / "index.tsx"
    lower = src / "inputs" / "display" / "index.tsx"

    assert widget_compiler._exclude_casefold_collisions([upper, lower], src) == []


def test_discovery_rejects_file_and_parent_directory_symlinks(widget_workspace):
    src = widget_workspace["src"]
    target_file = src.parent / "target.tsx"
    target_file.write_text(GOOD_WIDGET, encoding="utf-8")
    file_link = src / "Inputs" / "FileLink" / "index.tsx"
    file_link.parent.mkdir(parents=True)
    try:
        file_link.symlink_to(target_file)
    except OSError as err:
        pytest.skip(f"symlinks unavailable: {err}")

    target_group = src.parent / "target-group"
    _write_widget(target_group, "DirectoryLink", GOOD_WIDGET)
    parent_link = src / "LinkedGroup"
    parent_link.symlink_to(target_group, target_is_directory=True)

    assert widget_compiler.find_entries(src) == []
    assert widget_compiler.entry_for_key("Inputs/FileLink", src) is None
    assert widget_compiler.entry_for_key("LinkedGroup/DirectoryLink", src) is None
    with pytest.raises(ValueError, match="symlinked widget path"):
        widget_compiler.widget_key(file_link, src)
    with pytest.raises(ValueError, match="symlinked widget path"):
        widget_compiler.widget_key(parent_link / "DirectoryLink" / "index.tsx", src)


@pytest.mark.asyncio
async def test_compile_entry_refuses_symlink_omitted_by_discovery(widget_workspace):
    src, build = widget_workspace["src"], widget_workspace["build"]
    target = src.parent / "target.tsx"
    target.write_text(GOOD_WIDGET, encoding="utf-8")
    linked_entry = src / "Inputs" / "Linked" / "index.tsx"
    linked_entry.parent.mkdir(parents=True)
    try:
        linked_entry.symlink_to(target)
    except OSError as err:
        pytest.skip(f"symlinks unavailable: {err}")

    assert await widget_compiler.compile_entry(linked_entry, src) is False
    assert not (build / "Inputs" / "Linked" / "index.js").exists()
    assert not (build / ".build-status.json").exists()


def test_widget_key_matches_jsextractor_for_flat_and_grouped(widget_workspace):
    src = widget_workspace["src"]
    flat = _write_widget(src, "Flat", GOOD_WIDGET)
    grouped = _write_widget(src, "Group/Nested", GOOD_WIDGET)

    assert widget_compiler.widget_key(flat) == "Flat"
    assert widget_compiler.widget_key(grouped) == "Group/Nested"


def test_build_status_and_entry_lookup_reject_noncanonical_keys(widget_workspace):
    src = widget_workspace["src"]
    _write_widget(src, "Inputs/Foo", GOOD_WIDGET)
    raw = {
        "version": 2,
        "widgets": {
            "Inputs/Foo": {"ok": True},
            "../outside": {"ok": True},
            "Too/Deep/Widget": {"ok": True},
        },
    }

    assert widget_compiler.decode_build_status(raw) == {"Inputs/Foo": {"ok": True}}
    assert widget_compiler.entry_for_key("../outside") is None


@pytest.mark.asyncio
async def test_prune_discovers_deleted_duplicate_artifact_without_status_entry(
    widget_workspace,
):
    """Stale artifacts are found by scanning the build dir, not the status map."""
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Inputs/Display", GOOD_WIDGET)
    current_output = build / "Inputs" / "Display" / "index.js"
    deleted_output = build / "Other" / "Display" / "index.js"
    current_output.parent.mkdir(parents=True)
    deleted_output.parent.mkdir(parents=True)
    current_output.write_text("current", encoding="utf-8")
    deleted_output.write_text("deleted", encoding="utf-8")
    storage.write_json(
        build / ".build-status.json",
        {"Display": {"ok": True, "ts": "old"}},
    )

    await widget_compiler._prune_status(
        widget_compiler.compile_target(src), widget_compiler.find_entries(src)
    )

    status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    assert status["widgets"] == {}
    assert current_output.is_file()
    assert not deleted_output.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("status_text", ["{", '{"version": 2, "widgets": {}}'])
async def test_prune_removes_stale_artifact_with_corrupt_or_empty_status(
    widget_workspace, status_text,
):
    src, build = widget_workspace["src"], widget_workspace["build"]
    stale_output = build / "Other" / "Deleted" / "index.js"
    stale_output.parent.mkdir(parents=True)
    stale_output.write_text("stale", encoding="utf-8")
    metadata = build / "widget-schemas.json"
    metadata.write_text("{}", encoding="utf-8")
    (build / ".build-status.json").write_text(status_text, encoding="utf-8")

    await widget_compiler.compile_all(src)

    assert not stale_output.exists()
    assert metadata.is_file()
    assert json.loads((build / ".build-status.json").read_text(encoding="utf-8")) == {
        "version": 2,
        "widgets": {},
    }


def test_build_sdk_banner_empty_when_no_sdk_names_referenced():
    assert widget_compiler.build_sdk_banner("const x = 1;") == ""


def test_build_sdk_banner_lists_only_referenced_names():
    js = "const a = React.createElement; const b = usePropString();"
    banner = widget_compiler.build_sdk_banner(js)
    assert banner.startswith("const { ")
    assert "React" in banner
    assert "usePropString" in banner
    # An SDK name that isn't referenced shouldn't appear.
    assert "VirtualKeyboard" not in banner


def test_build_sdk_banner_avoids_partial_word_matches():
    """``React`` substring inside ``ReactNative`` must not pull React into
    the banner — the banner regex is word-bounded."""
    js = "const x = ReactNative.thing;"
    banner = widget_compiler.build_sdk_banner(js)
    assert "React" not in banner


def test_regenerate_widget_schemas_writes_manifest(widget_workspace):
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(
        src,
        "Inputs/Foo",
        "export const schema = { label: { type: 'string' as const } };",
    )

    ok = widget_compiler.regenerate_widget_schemas()

    assert ok is True
    manifest_path = build / "widget-schemas.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["version"] == 2
    assert manifest["custom"]["Inputs/Foo"]["name"] == "Foo"
    assert manifest["custom"]["Inputs/Foo"]["category"] == "Inputs"
    assert manifest["custom"]["Inputs/Foo"]["schema"]["label"]["type"] == "string"


CHART_WIDGET = """\
export const schema = {};
export default function Chart() {
  return React.createElement(Recharts.LineChart, null);
}
"""


@pytest.mark.asyncio
async def test_redirected_out_dir_leaves_the_default_build_root_untouched(
    widget_workspace, tmp_path
):
    """The stdlib build compiles a different source tree into its own build root.

    Nothing it writes may land in the runtime-home cache — that is the whole
    reason ``out_dir`` exists, and the reason each target owns its status map.
    """
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Inputs/Project", GOOD_WIDGET)
    await widget_compiler.compile_all()

    stdlib_src = tmp_path / "widgets"
    stdlib_out = tmp_path / "stdlib-build"
    stdlib_src.mkdir()
    _write_widget(stdlib_src, "Layout/Stdlib", GOOD_WIDGET)

    assert await widget_compiler.compile_all(stdlib_src, stdlib_out) is True

    assert (stdlib_out / "Layout" / "Stdlib" / "index.js").is_file()
    assert not (build / "Layout").exists()
    assert not (stdlib_out / "Inputs").exists()

    default_status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    stdlib_status = json.loads(
        (stdlib_out / ".build-status.json").read_text(encoding="utf-8")
    )
    assert set(default_status["widgets"]) == {"Inputs/Project"}
    assert set(stdlib_status["widgets"]) == {"Layout/Stdlib"}


@pytest.mark.asyncio
async def test_targets_on_one_build_root_do_not_regress_each_others_status(
    widget_workspace,
):
    """Every caller writing one ``.build-status.json`` must share one map.

    The watcher holds a target for the process lifetime while ``recompile()``
    and ``compile_entry()`` build their own. With per-target maps the watcher's
    view goes stale the moment an admin "Recompile" writes a newer entry, and
    its next save rewrites the file from that stale copy — walking the ``?t=``
    cache-buster backwards so browsers keep serving the module they cached.
    """
    src, build = widget_workspace["src"], widget_workspace["build"]
    foo = _write_widget(src, "Inputs/Foo", GOOD_WIDGET)
    bar = _write_widget(src, "Inputs/Bar", GOOD_WIDGET)

    watcher = widget_compiler.compile_target()
    await widget_compiler._prepare_status(watcher)

    # An admin recompile of Foo, through its own target.
    assert await widget_compiler.compile_entry(foo) is True
    recompiled_foo = json.loads(
        (build / ".build-status.json").read_text(encoding="utf-8")
    )["widgets"]["Inputs/Foo"]

    # A save of Bar arrives at the long-lived watcher target.
    assert (
        await widget_compiler._compile_discovered_entry(watcher, bar, "Inputs/Bar")
        is True
    )

    widgets = json.loads(
        (build / ".build-status.json").read_text(encoding="utf-8")
    )["widgets"]
    assert widgets["Inputs/Bar"]["ok"] is True
    assert widgets["Inputs/Foo"] == recompiled_foo


@pytest.mark.asyncio
async def test_compile_records_whether_a_module_references_recharts(
    widget_workspace, tmp_path
):
    """``usesRecharts`` is recorded by the compile, not re-derived later — it is
    what keeps the chart library out of first paint for chartless pages."""
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Content/Chart", CHART_WIDGET)
    _write_widget(src, "Content/Plain", GOOD_WIDGET)

    await widget_compiler.compile_all()

    status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    assert status["widgets"]["Content/Chart"]["usesRecharts"] is True
    assert status["widgets"]["Content/Plain"]["usesRecharts"] is False


@pytest.mark.asyncio
async def test_generate_stdlib_manifest_emits_rows_the_frontend_registers(
    widget_workspace, tmp_path
):
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Content/Chart", CHART_WIDGET)
    _write_widget(
        src,
        "Layout/Box",
        "export const hostsChildren = true;\n"
        "export const displayName = 'A Box';\n"
        "export const schema = { label: { type: 'string' as const } };\n"
        "export default function Box() { return null; }\n",
    )
    (src / "Layout" / "Box" / "style.css").write_text(".box {}", encoding="utf-8")

    manifest_path = tmp_path / "stdlibManifest.json"
    assert await widget_compiler.compile_all() is True
    assert widget_compiler.regenerate_widget_schemas() is True
    assert widget_compiler.generate_stdlib_manifest(manifest_path) is True

    rows = {row["key"]: row for row in json.loads(manifest_path.read_text(encoding="utf-8"))}
    assert list(rows) == sorted(rows), "rows must be key-sorted for a stable artifact"

    box = rows["Layout/Box"]
    assert box["name"] == "Box"
    assert box["group"] == "Layout"
    assert box["origin"] == "stdlib"
    assert box["displayName"] == "A Box"
    assert box["hostsChildren"] is True
    assert box["hasStyle"] is True
    assert box["usesRecharts"] is False
    assert box["buildOk"] is True
    assert box["schema"]["label"]["type"] == "string"

    assert rows["Content/Chart"]["usesRecharts"] is True
    assert rows["Content/Chart"]["hasStyle"] is False
    # The build root's own intermediates are not widgets.
    assert (build / "widget-schemas.json").is_file()
    assert "widget-schemas" not in rows


@pytest.mark.asyncio
async def test_generate_stdlib_manifest_splits_the_editor_half_out(
    widget_workspace, tmp_path
):
    """The runtime half rides in every route's entry chunk, so it must carry
    only what a rendering page reads: the registration fields, plus the `type`
    and `requiredFields` `useBindingStatus` validates a binding against. The
    editor half holds the rest and is imported only from ``src/config/``."""
    src = widget_workspace["src"]
    _write_widget(
        src,
        "Layout/Box",
        "export const description = 'A box.';\n"
        "export const icon = { type: 'builtin', name: 'square' };\n"
        "export const schema = {\n"
        "  label: { type: 'string' as const, label: 'Label', defaultValue: 'hi' },\n"
        "  motor: { type: 'struct' as const, label: 'Motor', requiredFields: ['run'] },\n"
        "};\n"
        "export default function Box() { return null; }\n",
    )

    manifest_path = tmp_path / "stdlibManifest.json"
    assert await widget_compiler.compile_all() is True
    assert widget_compiler.regenerate_widget_schemas() is True
    assert widget_compiler.generate_stdlib_manifest(manifest_path) is True

    row = json.loads(manifest_path.read_text(encoding="utf-8"))[0]
    assert "description" not in row
    assert "icon" not in row
    assert "exportedProperties" not in row
    assert row["schema"] == {
        "label": {"type": "string"},
        "motor": {"type": "struct", "requiredFields": ["run"]},
    }

    editor_path = tmp_path / "stdlibManifest.editor.json"
    half = json.loads(editor_path.read_text(encoding="utf-8"))["Layout/Box"]
    assert half["description"] == "A box."
    assert half["icon"] == {"type": "builtin", "name": "square"}
    # A field whose only attributes are runtime ones is absent, not empty:
    # nothing is stored twice.
    assert half["schema"] == {
        "label": {"label": "Label", "defaultValue": "hi"},
        "motor": {"label": "Motor"},
    }


@pytest.mark.asyncio
async def test_stdlib_manifest_is_byte_identical_across_a_no_op_rebuild(
    widget_workspace, tmp_path
):
    """The manifest is tracked in git and regenerated by every ``npm run dev``,
    so a rebuild of unchanged sources must leave the working tree clean — and
    the stamp must still turn over when the bytes a browser caches change."""
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Layout/Box", GOOD_WIDGET)
    stylesheet = src / "Layout" / "Box" / "style.css"
    stylesheet.write_text(".box {}", encoding="utf-8")
    manifest_path = tmp_path / "stdlibManifest.json"

    editor_path = tmp_path / "stdlibManifest.editor.json"

    async def rebuild() -> bytes:
        assert await widget_compiler.compile_all() is True
        assert widget_compiler.regenerate_widget_schemas() is True
        assert widget_compiler.generate_stdlib_manifest(manifest_path) is True
        # Both halves are tracked, so both have to be stable.
        return manifest_path.read_bytes() + editor_path.read_bytes()

    first = await rebuild()
    assert await rebuild() == first

    stylesheet.write_text(".box { color: red }", encoding="utf-8")
    assert await rebuild() != first

    _write_widget(src, "Layout/Box", GOOD_WIDGET.replace("'div'", "'span'"))
    assert await rebuild() != first

    # The status file keeps a real timestamp for /api/widgets and the admin
    # panel's clock column; only the tracked manifest carries the digest.
    status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    entry = status["widgets"]["Layout/Box"]
    assert "T" in entry["ts"]
    row = json.loads(manifest_path.read_text(encoding="utf-8"))[0]
    assert row["buildTs"] == entry["hash"] != entry["ts"]


@pytest.mark.asyncio
async def test_publish_stdlib_assets_copies_only_what_a_browser_fetches(
    widget_workspace, tmp_path
):
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Layout/Box", GOOD_WIDGET)
    (src / "Layout" / "Box" / "style.css").write_text(".box {}", encoding="utf-8")
    (src / "Layout" / "Box" / "fonts").mkdir()
    (src / "Layout" / "Box" / "fonts" / "face.woff2").write_bytes(b"font")
    _write_widget(src, "Content/Plain", GOOD_WIDGET)

    manifest_path = tmp_path / "stdlibManifest.json"
    publish_dir = tmp_path / "public" / "stdlib-js"
    await widget_compiler.compile_all()
    widget_compiler.regenerate_widget_schemas()
    widget_compiler.generate_stdlib_manifest(manifest_path)

    assert widget_compiler.publish_stdlib_assets(publish_dir, manifest_path=manifest_path)

    assert (publish_dir / "Layout" / "Box" / "index.js").is_file()
    assert (publish_dir / "Layout" / "Box" / "style.css").is_file()
    # @font-face rules resolve relative to the published stylesheet, so the
    # faces must travel with it or the widget 404s its own fonts.
    assert (publish_dir / "Layout" / "Box" / "fonts" / "face.woff2").is_file()
    assert (publish_dir / "Content" / "Plain" / "index.js").is_file()
    assert not (publish_dir / "Content" / "Plain" / "style.css").exists()
    assert (publish_dir / "manifest.json").is_file()
    # A packaged runtime has no src/, and config validation there still needs
    # whole schemas — so both halves travel.
    assert (publish_dir / "manifest.editor.json").is_file()
    # Build intermediates must never ship.
    assert not (publish_dir / "widget-schemas.json").exists()
    assert not (publish_dir / ".build-status.json").exists()

    # A stale publish dir is replaced, not merged into.
    (publish_dir / "Gone").mkdir()
    (publish_dir / "Gone" / "index.js").write_text("stale", encoding="utf-8")
    assert widget_compiler.publish_stdlib_assets(publish_dir, manifest_path=manifest_path)
    assert not (publish_dir / "Gone").exists()

    assert build.is_dir()


@pytest.mark.asyncio
async def test_publish_stdlib_assets_fails_loudly_on_a_missing_artifact(
    widget_workspace, tmp_path
):
    """A stdlib widget that didn't compile is a product defect — publishing a
    catalog with a hole in it must fail the build rather than ship it."""
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Layout/Box", GOOD_WIDGET)
    await widget_compiler.compile_all()
    (build / "Layout" / "Box" / "index.js").unlink()

    assert widget_compiler.publish_stdlib_assets(tmp_path / "stdlib-js") is False


@pytest.mark.asyncio
async def test_publish_stdlib_assets_skips_a_widget_that_failed_to_compile(
    widget_workspace, tmp_path
):
    """An incremental build over an existing build root still holds the previous
    run's ``index.js`` for a widget that now fails to compile. Publishing it
    would serve a module that no longer matches its source — and with no
    ``buildTs`` for a failed widget, under an unchanged cache-buster."""
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Layout/Box", GOOD_WIDGET)
    _write_widget(src, "Content/Plain", GOOD_WIDGET)
    assert await widget_compiler.compile_all() is True

    _write_widget(src, "Layout/Box", BAD_WIDGET)
    assert await widget_compiler.compile_all() is False
    assert (build / "Layout" / "Box" / "index.js").is_file()

    publish_dir = tmp_path / "public" / "stdlib-js"
    assert widget_compiler.publish_stdlib_assets(publish_dir) is False
    assert not (publish_dir / "Layout" / "Box").exists()
    # One broken widget must not block the rest of the tree.
    assert (publish_dir / "Content" / "Plain" / "index.js").is_file()


def test_publish_stdlib_assets_refuses_a_directory_it_does_not_own(
    widget_workspace, tmp_path,
):
    """The publish root is emptied before it is refilled, and it arrives from a
    CLI flag. ``--publish-dir frontend/public`` — one segment short of
    ``frontend/public/stdlib-js`` — must not delete the public asset tree."""
    src = widget_workspace["src"]
    _write_widget(src, "Layout/Box", GOOD_WIDGET)
    public = tmp_path / "public"
    (public / "fonts").mkdir(parents=True)
    bystander = public / "fonts" / "inter.woff2"
    bystander.write_bytes(b"font")

    assert widget_compiler.publish_stdlib_assets(public) is False
    assert bystander.is_file(), "a mistyped publish root must not be deleted"


def test_run_once_does_not_publish_when_the_manifest_failed(
    widget_workspace, tmp_path, monkeypatch,
):
    """A failed manifest generation leaves the *previous* run's manifest.json on
    disk, which would copy cleanly into the served tree and let a packaged
    runtime validate pages against schemas from a build that no longer exists."""
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Layout/Box", GOOD_WIDGET)
    publish_dir = tmp_path / "public" / "stdlib-js"
    publish_dir.mkdir(parents=True)
    previously_published = publish_dir / "manifest.json"
    previously_published.write_text("[]", encoding="utf-8")

    monkeypatch.setattr(
        widget_compiler, "generate_stdlib_manifest", lambda *args, **kwargs: False
    )
    code = widget_compiler._run_once(
        src, build, tmp_path / "stdlibManifest.json", publish_dir
    )

    assert code == 1
    assert previously_published.read_text(encoding="utf-8") == "[]"
    assert not (publish_dir / "Layout").exists()


@pytest.mark.asyncio
async def test_recompile_all_compiles_every_entry_and_broadcasts(widget_workspace):
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Inputs/Foo", GOOD_WIDGET)
    _write_widget(src, "FlatWidget", GOOD_WIDGET)

    events: list[dict] = []

    schema_ok = await widget_compiler.recompile(events.append)

    assert schema_ok is True
    assert (build / "Inputs" / "Foo" / "index.js").is_file()
    assert (build / "FlatWidget" / "index.js").is_file()
    # The schema manifest is regenerated alongside the compile.
    assert (build / "widget-schemas.json").is_file()
    # One widget_updated event per entry, carrying the registry key.
    assert {e["key"] for e in events} == {"Inputs/Foo", "FlatWidget"}
    assert all(e["type"] == "widget_updated" and e["schema_ok"] for e in events)


@pytest.mark.asyncio
async def test_recompile_single_entry_only_touches_that_widget(widget_workspace):
    src, build = widget_workspace["src"], widget_workspace["build"]
    target = _write_widget(src, "Inputs/Foo", GOOD_WIDGET)
    _write_widget(src, "Inputs/Bar", GOOD_WIDGET)

    events: list[dict] = []

    await widget_compiler.recompile(events.append, entry=target)

    assert (build / "Inputs" / "Foo" / "index.js").is_file()
    # The untouched widget was never compiled.
    assert not (build / "Inputs" / "Bar" / "index.js").exists()
    assert [e["key"] for e in events] == ["Inputs/Foo"]


@pytest.mark.asyncio
async def test_recompile_records_failure_status_without_raising(widget_workspace):
    src, build = widget_workspace["src"], widget_workspace["build"]
    _write_widget(src, "Other/Broken", BAD_WIDGET)

    events: list[dict] = []

    await widget_compiler.recompile(events.append)

    assert not (build / "Other" / "Broken" / "index.js").exists()
    status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    assert status["widgets"]["Other/Broken"]["ok"] is False
    # A broadcast still fires so browsers can re-read the failed build status.
    assert [e["key"] for e in events] == ["Other/Broken"]


def test_collect_touched_entries_groups_changes_to_their_index_tsx(widget_workspace):
    src = widget_workspace["src"]
    flat = _write_widget(src, "Flat", GOOD_WIDGET)
    grouped = _write_widget(src, "Group/Nested", GOOD_WIDGET)
    # A sibling file inside a widget dir should still point at index.tsx.
    sibling = grouped.parent / "helper.ts"
    sibling.write_text("export const x = 1;")

    changes = [
        (None, str(flat)),
        (None, str(sibling)),
        (None, str(flat)),  # duplicate, should dedupe
    ]
    touched = widget_compiler._collect_touched_entries(changes, src)

    assert sorted(p.name for p in touched) == ["index.tsx", "index.tsx"]
    assert flat in touched
    assert grouped in touched


@pytest.mark.asyncio
async def test_watcher_does_not_re_admit_symlinked_entry(widget_workspace, monkeypatch):
    import watchfiles

    src, build = widget_workspace["src"], widget_workspace["build"]
    target = src.parent / "target.tsx"
    target.write_text(GOOD_WIDGET, encoding="utf-8")
    linked_entry = src / "Inputs" / "Linked" / "index.tsx"
    linked_entry.parent.mkdir(parents=True)
    try:
        linked_entry.symlink_to(target)
    except OSError as err:
        pytest.skip(f"symlinks unavailable: {err}")

    async def fake_awatch(_root, recursive=True):
        yield {(1, str(linked_entry))}

    monkeypatch.setattr(watchfiles, "awatch", fake_awatch)
    events: list[dict] = []

    async def record(event: dict) -> None:
        events.append(event)

    await widget_compiler.start_watcher(record, src_dir=src)

    assert events == []
    status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    assert status["widgets"] == {}


@pytest.mark.asyncio
async def test_start_watcher_survives_unexpected_exception_in_one_iteration(
    widget_workspace, monkeypatch,
):
    """§8.1: an unexpected failure in one watcher iteration (e.g. a bad schema
    literal) must not permanently kill hot-reload for subsequent changes."""
    import watchfiles

    src = widget_workspace["src"]
    entry = _write_widget(src, "Foo", GOOD_WIDGET)

    async def fake_awatch(_root, recursive=True):
        yield {(1, str(entry))}
        yield {(1, str(entry))}

    monkeypatch.setattr(watchfiles, "awatch", fake_awatch)

    real_regenerate = widget_compiler.regenerate_widget_schemas
    call_count = 0

    def flaky_regenerate(root=None):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("simulated unexpected failure")
        return real_regenerate(root)

    monkeypatch.setattr(widget_compiler, "regenerate_widget_schemas", flaky_regenerate)

    events: list[dict] = []
    await widget_compiler.start_watcher(events.append, src_dir=src)

    # Both iterations ran — the first's failure didn't kill the loop.
    assert call_count == 2
    # Only the second (successful) iteration reached the broadcast.
    assert len(events) == 1


@pytest.mark.asyncio
async def test_start_watcher_removes_deleted_widget_status_and_broadcasts(
    widget_workspace, monkeypatch,
):
    import watchfiles

    src, build = widget_workspace["src"], widget_workspace["build"]
    entry = _write_widget(src, "Inputs/Display", GOOD_WIDGET)
    await widget_compiler.compile_entry(entry)

    async def fake_awatch(_root, recursive=True):
        entry.unlink()
        yield {(3, str(entry))}

    monkeypatch.setattr(watchfiles, "awatch", fake_awatch)
    events: list[dict] = []

    async def record(event: dict) -> None:
        events.append(event)

    await widget_compiler.start_watcher(record, src_dir=src)

    status = json.loads((build / ".build-status.json").read_text(encoding="utf-8"))
    assert status == {"version": 2, "widgets": {}}
    assert not (build / "Inputs" / "Display" / "index.js").exists()
    assert [event["key"] for event in events] == ["Inputs/Display"]
