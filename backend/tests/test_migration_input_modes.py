"""Tests for the 11 → 12 step that gives every input a mode, Value or Binding."""

import json
import shutil
from pathlib import Path

import core.project_migrations as pm
import pytest
from core.manifest import ProjectMetadata, read_project_metadata, write_project_metadata
from core.migration_input_modes import migrate_input_modes


def _read(path: Path) -> dict:
    return json.loads(path.read_text())


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc))


def _staged(root: Path) -> dict[str, Path]:
    return {k: root / ("config.json" if k == "config" else k) for k in ("config", "pages", "dialogs", "components")}


def _open(page_id: str, **args) -> dict:
    return {
        "id": "b",
        "type": "Button",
        "properties": {
            "actions": {"onPress": [{"type": "openDialog", "pageId": page_id, "componentProperties": args}]}
        },
    }


VAR = {"$var": {"path": "PLC:M1/Run"}}
FORMULA = {"$formula": {"expression": "{1} * 0.5", "wildcards": {"1": {"$var": {"path": "PLC:M1/Speed"}}}}}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    _write(
        root / "config.json",
        {
            "project": {"id": "proj"},
            "pages": [
                {"id": "home", "type": "page"},
                {
                    "id": "area",
                    "type": "page-group",
                    "componentProperties": {"filter": {"type": "string", "label": "Filter"}},
                    "children": [],
                },
            ],
            "dialogs": [
                {
                    "id": "devices",
                    "type": "page-group",
                    "componentProperties": {"zone": {"type": "string", "label": "Zone"}},
                    "children": [{"id": "manual-device", "type": "page"}],
                }
            ],
        },
    )
    _write(
        root / "pages" / "home.json",
        {
            "id": "home",
            "componentProperties": {"recipeFilter": {"type": "string", "label": "Filter"}},
            "sections": {
                "content": [
                    _open("manual-device", enabled=VAR, title={"$loc": "motor"}, jogSpeed=FORMULA),
                    _open("devices", enabled={"$componentProp": "run"}, zone="A"),
                    {"id": "c1", "type": "$component:tile", "properties": {"running": VAR, "label": "M1"}},
                    {"id": "c2", "type": "$component:tile", "properties": {"running": VAR, "label": VAR}},
                ]
            },
        },
    )
    _write(
        root / "dialogs" / "manual-device.json",
        {
            "id": "manual-device",
            "componentProperties": {
                "enabled": {"type": "boolean", "label": "Enabled"},
                "title": {"type": "string", "label": "Title"},
                "jogSpeed": {"type": "float", "label": "Jog speed", "defaultValue": 10},
                "setpoint": {"type": "float", "label": "Setpoint", "write": True},
                "device": {"type": "struct", "label": "Device"},
                "onDone": {"type": "actions", "label": "Done"},
                "kept": {"type": "float", "label": "Kept", "mode": "binding"},
            },
        },
    )
    _write(
        root / "components" / "tile.json",
        {
            "name": "Tile",
            "componentProperties": {
                "running": {"type": "boolean", "label": "Running"},
                "label": {"type": "string", "label": "Label"},
                "unused": {"type": "integer", "label": "Unused"},
            },
            "children": [],
        },
    )
    return root


def _modes(declared: dict) -> dict:
    return {key: decl.get("mode") for key, decl in declared.items()}


def test_derives_each_mode_from_what_reaches_the_input(project: Path) -> None:
    result = migrate_input_modes(_staged(project), project)

    dialog = _read(project / "dialogs" / "manual-device.json")["componentProperties"]
    assert _modes(dialog) == {
        "enabled": "binding",  # both openers (the page and its group) pass a variable
        "title": "value",
        "jogSpeed": "value",
        "setpoint": "binding",  # write access only a Binding has
        "device": None,  # a struct always binds; nothing written
        "onDone": None,
        "kept": "binding",
    }
    tile = _read(project / "components" / "tile.json")["componentProperties"]
    assert _modes(tile) == {"running": "binding", "label": "value", "unused": "value"}
    config = _read(project / "config.json")
    assert config["dialogs"][0]["componentProperties"]["zone"]["mode"] == "value"
    # Nothing opens a page of the Pages section: its inputs are page variables.
    assert config["pages"][1]["componentProperties"]["filter"]["mode"] == "value"
    assert _read(project / "pages" / "home.json")["componentProperties"]["recipeFilter"]["mode"] == "value"
    assert sorted(result.files_changed) == [
        "components/tile.json",
        "config.json",
        "dialogs/manual-device.json",
        "pages/home.json",
    ]


def test_notes_every_live_value_that_is_now_read_once(project: Path) -> None:
    """The formula and the one variable among literals become read-once; a
    translation was never live, so it gets no note."""
    result = migrate_input_modes(_staged(project), project)

    assert sorted(note.split(":")[0] for note in result.diagnostics) == [
        "component 'tile', input 'label'",
        "dialog 'manual-device', input 'jogSpeed'",
    ]
    jog = next(n for n in result.diagnostics if "jogSpeed" in n)
    assert "pages/home.json passes it a live value, which is now read once when the dialog opens" in jog


def test_is_re_runnable(project: Path) -> None:
    migrate_input_modes(_staged(project), project)
    again = migrate_input_modes(_staged(project), project)
    assert (again.files_changed, again.diagnostics) == ([], [])


def _instance(component: str, **props) -> dict:
    return {"id": f"i-{component}", "type": f"$component:{component}", "properties": props}


def _component(root: Path, component_id: str, children: list) -> None:
    _write(
        root / "components" / f"{component_id}.json",
        {
            "name": component_id,
            "componentProperties": {"x": {"type": "float", "label": "X"}},
            "children": children,
        },
    )


@pytest.mark.parametrize(("given", "mode"), [(5, "value"), (VAR, "binding")])
def test_a_forward_is_a_variable_only_when_the_forwarded_input_binds(
    given: object, mode: str, tmp_path: Path
) -> None:
    """Page → outer.x → inner.x, and outer opens a dialog with x: each forward
    takes the mode the input it forwards ends up with, over the whole chain."""
    forward = {"$componentProp": "x"}
    _write(tmp_path / "config.json", {"pages": [{"id": "home", "type": "page"}], "dialogs": [{"id": "d", "type": "page"}]})
    _write(
        tmp_path / "pages" / "home.json",
        {"id": "home", "sections": {"content": [_instance("outer", x=given)]}},
    )
    _component(tmp_path, "outer", [_instance("middle", x=forward), _open("d", x=forward)])
    _component(tmp_path, "middle", [_instance("inner", x=forward)])
    _component(tmp_path, "inner", [])
    _write(
        tmp_path / "dialogs" / "d.json",
        {"id": "d", "componentProperties": {"x": {"type": "float", "label": "X"}}},
    )

    migrate_input_modes(_staged(tmp_path), tmp_path)

    for component_id in ("outer", "middle", "inner"):
        declared = _read(tmp_path / "components" / f"{component_id}.json")["componentProperties"]
        assert declared["x"]["mode"] == mode, component_id
    assert _read(tmp_path / "dialogs" / "d.json")["componentProperties"]["x"]["mode"] == mode


def test_the_coordinator_carries_a_format_11_project_to_12(project: Path) -> None:
    write_project_metadata(
        project, ProjectMetadata(id="proj", formatVersion=11, minAppVersion="1.1.0")
    )
    result = pm.run_baseline_migration(project)
    assert (result.from_version, result.to_version) == (11, 12)
    assert read_project_metadata(project).formatVersion == 12
    assert "components/tile.json" in result.files_changed


@pytest.mark.parametrize("template", ["project-seed", "project-example"])
def test_bundled_templates_need_no_input_mode(template: str, tmp_path: Path) -> None:
    """A new project is stamped current straight from its template, never
    migrated, so a template this step would still change would ship without
    modes."""
    source = Path(__file__).resolve().parents[2] / template
    for name in ("config.json", "pages", "dialogs", "components"):
        if (source / name).is_dir():
            shutil.copytree(source / name, tmp_path / name)
        elif (source / name).exists():
            shutil.copy2(source / name, tmp_path / name)

    assert migrate_input_modes(_staged(tmp_path), tmp_path).files_changed == []
