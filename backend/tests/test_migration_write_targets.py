"""Tests for the 8 → 9 step that turns a write action's datasource/path pair
into one sourced ``target``."""

import json
import shutil
from pathlib import Path

import core.project_migrations as pm
import pytest
from core.manifest import ProjectMetadata, read_project_metadata, write_project_metadata
from core.migration_write_targets import migrate_write_targets


def _read(path: Path) -> dict:
    return json.loads(path.read_text())


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc))


def _button(actions: list) -> dict:
    return {"id": "b", "type": "Button", "properties": {"actions": {"onPress": actions}}}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    _write(
        root / "config.json",
        {
            "project": {"id": "proj"},
            "globalEvents": {
                "onStart": [{"type": "toggleDataVariable", "datasource": "PLC", "path": "Run"}]
            },
        },
    )
    _write(
        root / "pages" / "home.json",
        {
            "id": "home",
            "sections": {
                "content": [
                    _button(
                        [
                            {
                                "type": "writeDataVariable",
                                "datasource": "PLC",
                                "path": "Speeds[2]",
                                "value": 5,
                                "onSuccess": [
                                    {"type": "writeDataVariable", "datasource": "", "path": "", "value": 1}
                                ],
                            },
                            {"type": "showToast", "message": "hi"},
                        ]
                    )
                ]
            },
        },
    )
    _write(
        root / "components" / "row.json",
        {
            "id": "row",
            "children": [
                _button(
                    [
                        {
                            "type": "writeDataVariable",
                            "datasource": "",
                            "path": "",
                            "repeatItem": {"member": "Speed"},
                            "value": 0,
                        }
                    ]
                )
            ],
        },
    )
    (root / "dialogs").mkdir()
    return root


def _staged(root: Path) -> dict[str, Path]:
    return {
        "config": root / "config.json",
        "pages": root / "pages",
        "dialogs": root / "dialogs",
        "components": root / "components",
    }


def test_a_pair_becomes_a_var_target_in_its_place(project: Path) -> None:
    migrate_write_targets(_staged(project), project)

    action = _read(project / "pages" / "home.json")["sections"]["content"][0]["properties"][
        "actions"
    ]["onPress"][0]
    assert list(action) == ["type", "target", "value", "onSuccess"]
    assert action["target"] == {"$var": {"path": "PLC:Speeds[2]"}}


def test_an_unpicked_pair_becomes_no_target(project: Path) -> None:
    migrate_write_targets(_staged(project), project)

    nested = _read(project / "pages" / "home.json")["sections"]["content"][0]["properties"][
        "actions"
    ]["onPress"][0]["onSuccess"][0]
    assert nested == {"type": "writeDataVariable", "value": 1}


def test_config_events_and_components_are_rewritten(project: Path) -> None:
    result = migrate_write_targets(_staged(project), project)

    assert _read(project / "config.json")["globalEvents"]["onStart"][0] == {
        "type": "toggleDataVariable",
        "target": {"$var": {"path": "PLC:Run"}},
    }
    action = _read(project / "components" / "row.json")["children"][0]["properties"]["actions"][
        "onPress"
    ][0]
    assert action == {
        "type": "writeDataVariable",
        "target": {"$repeatItem": {"member": "Speed"}},
        "value": 0,
    }
    assert sorted(result.files_changed) == ["components/row.json", "config.json", "pages/home.json"]


def test_rerunning_changes_nothing(project: Path) -> None:
    migrate_write_targets(_staged(project), project)
    before = {p: p.read_bytes() for p in project.rglob("*.json")}

    result = migrate_write_targets(_staged(project), project)

    assert result.files_changed == []
    assert {p: p.read_bytes() for p in project.rglob("*.json")} == before


def test_the_coordinator_carries_a_format_8_project_to_9(project: Path) -> None:
    write_project_metadata(
        project,
        ProjectMetadata(id="proj", formatVersion=8, minAppVersion=pm.PROJECT_FORMAT_MIN_APP),
    )

    result = pm.run_baseline_migration(project)

    assert (result.from_version, result.to_version) == (8, 9)
    assert read_project_metadata(project).formatVersion == 9
    assert _read(project / "config.json")["globalEvents"]["onStart"][0]["target"] == {
        "$var": {"path": "PLC:Run"}
    }


@pytest.mark.parametrize("template", ["project-seed", "project-example"])
def test_bundled_templates_are_already_in_the_current_format(template: str, tmp_path: Path) -> None:
    """A new project is stamped current straight from its template, never
    migrated, so a template this step would still change would ship broken."""
    source = Path(__file__).resolve().parents[2] / template
    for name in ("config.json", "pages", "dialogs", "components"):
        if (source / name).is_dir():
            shutil.copytree(source / name, tmp_path / name)
        elif (source / name).exists():
            shutil.copy2(source / name, tmp_path / name)

    result = migrate_write_targets(_staged(tmp_path), tmp_path)

    assert result.files_changed == []
