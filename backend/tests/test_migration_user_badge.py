"""Tests for the 10 → 11 step that rebuilds a retired UserBadge from built-ins."""

import json
import shutil
from pathlib import Path

import core.project_migrations as pm
import pytest
from core.manifest import ProjectMetadata, read_project_metadata, write_project_metadata
from core.migration_user_badge import migrate_user_badge

_IS_GUEST = {
    "$compare": {"left": {"$user": {"field": "username"}}, "operator": "===", "right": "guest"}
}


def _read(path: Path) -> dict:
    return json.loads(path.read_text())


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc))


def _staged(root: Path) -> dict[str, Path]:
    return {
        "config": root / "config.json",
        "pages": root / "pages",
        "dialogs": root / "dialogs",
        "components": root / "components",
    }


def _types(node: dict) -> list[str]:
    return [node["type"], *(t for child in node.get("children", []) for t in _types(child))]


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    _write(
        root / "config.json",
        {
            "project": {"id": "proj"},
            "header": [
                {
                    "id": "hdr-user",
                    "type": "UserBadge",
                    "name": "User",
                    "properties": {
                        "visible": {"$userGroups": {"groups": []}},
                        "signInLabel": {"$loc": "Sign in"},
                        "actions": {"onPress": [{"type": "navigateToPage", "pageId": "me"}]},
                        "onSignIn": {"onSignIn": [{"type": "openDialog", "pageId": "login"}]},
                        "onSignOut": {"onSignOut": [{"type": "logoutUser"}]},
                    },
                    "layout": {"widthMode": "hug", "heightMode": "hug"},
                }
            ],
        },
    )
    _write(
        root / "pages" / "home.json",
        {
            "id": "home",
            "sections": {
                "content": [
                    {
                        "id": "op",
                        "type": "UserBadge",
                        "name": "Operator",
                        "properties": {
                            "usernameText": {"$var": {"path": "PLC:Operator"}},
                            "showGroups": False,
                        },
                    }
                ]
            },
        },
    )
    return root


def test_a_badge_becomes_a_container_that_keeps_its_identity(project: Path) -> None:
    migrate_user_badge(_staged(project), project)

    node = _read(project / "config.json")["header"][0]
    assert (node["id"], node["type"], node["name"]) == ("hdr-user", "Container", "User")
    assert node["properties"] == {"visible": {"$userGroups": {"groups": []}}}
    assert node["layout"]["widthMode"] == "hug"
    assert node["layout"]["direction"] == "row"
    assert "UserBadge" not in _types(node)


def test_sign_in_and_out_become_buttons_gated_on_the_guest(project: Path) -> None:
    migrate_user_badge(_staged(project), project)

    sign_in, identity, sign_out = _read(project / "config.json")["header"][0]["children"]
    assert sign_in["type"] == "Button"
    assert sign_in["properties"]["visible"] == _IS_GUEST
    assert sign_in["properties"]["label"] == {"$loc": "Sign in"}
    assert sign_in["properties"]["actions"] == {"onPress": [{"type": "openDialog", "pageId": "login"}]}
    assert identity["type"] == "ButtonContainer"
    assert identity["properties"]["visible"] == {"$not": {"value": _IS_GUEST}}
    assert identity["properties"]["actions"] == {
        "onPress": [{"type": "navigateToPage", "pageId": "me"}]
    }
    assert sign_out["properties"]["visible"] == {"$not": {"value": _IS_GUEST}}
    assert sign_out["properties"]["actions"] == {"onPress": [{"type": "logoutUser"}]}


def test_text_overrides_carry_over_and_hidden_groups_stay_hidden(project: Path) -> None:
    migrate_user_badge(_staged(project), project)

    node = _read(project / "pages" / "home.json")["sections"]["content"][0]
    [identity] = node["children"]
    assert "visible" not in identity["properties"]
    _avatar, text = identity["children"]
    [username] = text["children"]
    assert username["properties"]["text"] == {"$var": {"path": "PLC:Operator"}}


def test_rerunning_changes_nothing(project: Path) -> None:
    migrate_user_badge(_staged(project), project)
    before = {p: p.read_bytes() for p in project.rglob("*.json")}

    result = migrate_user_badge(_staged(project), project)

    assert result.files_changed == []
    assert {p: p.read_bytes() for p in project.rglob("*.json")} == before


def test_the_coordinator_carries_a_format_10_project_to_11(project: Path) -> None:
    write_project_metadata(
        project,
        ProjectMetadata(id="proj", formatVersion=10, minAppVersion=pm.PROJECT_FORMAT_MIN_APP),
    )

    result = pm.run_baseline_migration(project)

    assert (result.from_version, result.to_version) == (10, 11)
    assert read_project_metadata(project).formatVersion == 11
    assert sorted(result.files_changed) == ["config.json", "pages/home.json"]


@pytest.mark.parametrize("template", ["project-seed", "project-example"])
def test_bundled_templates_carry_no_user_badge(template: str, tmp_path: Path) -> None:
    """A new project is stamped current straight from its template, never
    migrated, so a template this step would still change would ship broken."""
    source = Path(__file__).resolve().parents[2] / template
    for name in ("config.json", "pages", "dialogs", "components"):
        if (source / name).is_dir():
            shutil.copytree(source / name, tmp_path / name)
        elif (source / name).exists():
            shutil.copy2(source / name, tmp_path / name)

    result = migrate_user_badge(_staged(tmp_path), tmp_path)

    assert result.files_changed == []
