"""Tests for the 10 → 11 half that moves press actions onto Button Container."""

import json
import shutil
from pathlib import Path

import pytest
from core.migration_button_container import migrate_button_container


def _read(path: Path) -> dict:
    return json.loads(path.read_text())


def _staged(root: Path) -> dict[str, Path]:
    return {
        "config": root / "config.json",
        "pages": root / "pages",
        "dialogs": root / "dialogs",
        "components": root / "components",
    }


def _container(node_id: str, props: dict) -> dict:
    return {"id": node_id, "type": "Container", "properties": props, "children": []}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    (root / "pages").mkdir(parents=True)
    tile = _container("tile", {"actions": {"onPress": [{"type": "navigateToPage", "pageId": "x"}]}})
    hold = _container("hold", {"onRelease": {"onRelease": [{"type": "logoutUser"}]}})
    empty = _container("empty", {"title": "T", "actions": {"onPress": []}})
    plain = _container("plain", {"title": "P"})
    bound = _container("bound", {"actions": {"$componentProp": "actions"}})
    tile["children"] = [hold]
    (root / "pages" / "home.json").write_text(
        json.dumps({"id": "home", "sections": {"content": [tile, empty, plain, bound]}})
    )
    return root


def test_containers_with_actions_become_button_containers(project: Path) -> None:
    migrate_button_container(_staged(project), project)

    tile, empty, plain, bound = _read(project / "pages" / "home.json")["sections"]["content"]
    assert tile["type"] == "ButtonContainer"
    assert tile["properties"]["actions"]["onPress"] == [{"type": "navigateToPage", "pageId": "x"}]
    assert tile["children"][0]["type"] == "ButtonContainer"
    assert empty == _container("empty", {"title": "T"})
    assert plain == _container("plain", {"title": "P"})
    assert bound["type"] == "ButtonContainer"
    assert bound["properties"]["actions"] == {
        "onPress": [{"type": "runComponentActions", "property": "actions"}]
    }


def test_rerunning_changes_nothing(project: Path) -> None:
    migrate_button_container(_staged(project), project)
    before = (project / "pages" / "home.json").read_bytes()

    result = migrate_button_container(_staged(project), project)

    assert result.files_changed == []
    assert (project / "pages" / "home.json").read_bytes() == before


@pytest.mark.parametrize("template", ["project-seed", "project-example"])
def test_bundled_templates_carry_no_pressable_container(template: str, tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[2] / template
    for name in ("config.json", "pages", "dialogs", "components"):
        if (source / name).is_dir():
            shutil.copytree(source / name, tmp_path / name)
        elif (source / name).exists():
            shutil.copy2(source / name, tmp_path / name)

    result = migrate_button_container(_staged(tmp_path), tmp_path)

    assert result.files_changed == []
