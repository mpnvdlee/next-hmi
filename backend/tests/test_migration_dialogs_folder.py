"""Tests for the 7 → 8 step that turns every dialog into a Dialogs-folder page.

Each old inline dialog becomes an index node under ``dialogs`` plus a page file
carrying its title, declarations, both close flags written explicitly, and its
widgets as the ``content`` section — wrapped in one row-wrapping Container when
there is more than one, so they keep the dialog body's layout. Every
``openDialog`` / ``closeDialog`` action, wherever it is stored, is rewritten to
name the same id as a page: ``openDialog`` keeps its type and renames
``dialogId`` to ``pageId``, ``closeDialog`` becomes ``closePageOverlay``.
"""

import json
import shutil
from pathlib import Path

import core.project_migrations as pm
import pytest
from core.manifest import ProjectMetadata, read_project_metadata, write_project_metadata
from core.migration_dialogs_folder import migrate_dialogs_folder


def _button(widget_id: str, actions: list) -> dict:
    return {
        "id": widget_id,
        "type": "Button",
        "name": widget_id,
        "properties": {"actions": {"onPress": actions}},
    }


def _open(dialog_id: str, **extra) -> dict:
    return {"type": "openDialog", "dialogId": dialog_id, **extra}


def _read(path: Path) -> dict:
    return json.loads(path.read_text())


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "pages").mkdir()
    (tmp_path / "components").mkdir()
    config = {
        "version": 2,
        "project": {"id": "proj"},
        "pages": [
            {"id": "home", "type": "page"},
            {
                "id": "machines",
                "title": "Machines",
                "type": "page-group",
                "events": {"onClose": [{"type": "closeDialog"}]},
                "header": [_button("group-btn", [_open("confirm")])],
                "children": [{"id": "line-a", "type": "page"}],
            },
        ],
        "header": [
            {
                "id": "menu",
                "type": "NavigationMenu",
                "name": "menu",
                "properties": {
                    "items": [
                        {"type": "action", "label": "Help", "actions": [_open("help")]},
                    ]
                },
            }
        ],
        "footer": [],
        "globalEvents": {"onHmiLoaded": [_open("confirm", size="small")]},
        "dialogs": [
            {
                "id": "confirm",
                "title": "Confirm",
                "showCloseButton": True,
                "widgets": [_button("ok", [{"type": "closeDialog", "dialogId": "confirm"}])],
            },
            {
                "id": "motor-detail",
                "title": "Motor detail",
                "closeOnBackgroundPress": True,
                "componentProperties": {"motorId": {"type": "String", "label": "Motor"}},
                "widgets": [
                    {"id": "speed", "type": "Label", "name": "speed", "properties": {}},
                    {"id": "temp", "type": "Label", "name": "temp", "properties": {}},
                ],
            },
            {"id": "help", "title": "Help"},
        ],
    }
    (tmp_path / "config.json").write_text(json.dumps(config))
    (tmp_path / "pages" / "home.json").write_text(json.dumps({
        "id": "home",
        "title": "Home",
        "events": {"onOpen": [_open("help")]},
        "sections": {
            "content": [
                {
                    "id": "box",
                    "type": "Container",
                    "name": "box",
                    "children": [
                        _button(
                            "write",
                            [
                                {
                                    "type": "writeDataVariable",
                                    "datasource": "DS",
                                    "path": "Tag",
                                    "value": 1,
                                    "onSuccess": [
                                        _open(
                                            "motor-detail",
                                            componentProperties={"motorId": "M1"},
                                            placement="trigger-below",
                                            backdrop="none",
                                        )
                                    ],
                                    "onFailed": [{"type": "closeDialog"}],
                                }
                            ],
                        )
                    ],
                }
            ]
        },
    }))
    (tmp_path / "pages" / "line-a.json").write_text(json.dumps({
        "id": "line-a",
        "sections": {
            "content": [
                _button("plain", [{"type": "showToast", "message": "hi"}]),
                # Predates the step and already names a navigable page, which is
                # the root Open Page As Overlay still offers — left alone.
                _button("overlay", [{"type": "openPageOverlay", "pageId": "home"}]),
            ]
        },
    }))
    (tmp_path / "components" / "Cards").mkdir()
    (tmp_path / "components" / "Cards" / "card.json").write_text(json.dumps({
        "id": "card",
        "children": [_button("inner", [_open("motor-detail", size="fixed", width=400, height=300)])],
    }))
    return tmp_path


def _paths(root: Path) -> dict[str, Path]:
    return {
        "config": root / "config.json",
        "pages": root / "pages",
        "dialogs": root / "dialogs",
        "components": root / "components",
    }


def test_dialogs_become_index_nodes_of_the_dialogs_folder(project: Path) -> None:
    migrate_dialogs_folder(_paths(project), project)

    config = _read(project / "config.json")
    assert config["dialogs"] == [
        {"id": "confirm", "type": "page"},
        {"id": "motor-detail", "type": "page"},
        {"id": "help", "type": "page"},
    ]
    assert [node["id"] for node in config["pages"]] == ["home", "machines"]


def test_each_dialog_gets_a_page_file_with_explicit_close_flags(project: Path) -> None:
    migrate_dialogs_folder(_paths(project), project)

    confirm = _read(project / "dialogs" / "confirm.json")
    assert confirm["title"] == "Confirm"
    assert confirm["showCloseButton"] is True
    assert confirm["closeOnBackgroundPress"] is False
    assert "componentProperties" not in confirm

    help_page = _read(project / "dialogs" / "help.json")
    assert help_page == {
        "id": "help",
        "title": "Help",
        "showCloseButton": False,
        "closeOnBackgroundPress": False,
        "sections": {"content": []},
    }

    detail = _read(project / "dialogs" / "motor-detail.json")
    assert detail["showCloseButton"] is False
    assert detail["closeOnBackgroundPress"] is True
    assert detail["componentProperties"] == {"motorId": {"type": "String", "label": "Motor"}}


def test_a_dialog_with_no_title_falls_back_to_its_id(project: Path) -> None:
    """A page whose title is falsy is dropped by the frontend's node guard, and
    the next save would unlink its file — so the migration never writes one."""
    config = _read(project / "config.json")
    config["dialogs"].append({"id": "untitled", "title": "", "widgets": []})
    config["dialogs"].append({"id": "no-title-key", "widgets": []})
    (project / "config.json").write_text(json.dumps(config))

    migrate_dialogs_folder(_paths(project), project)

    assert _read(project / "dialogs" / "untitled.json")["title"] == "untitled"
    assert _read(project / "dialogs" / "no-title-key.json")["title"] == "no-title-key"


def test_a_single_widget_moves_as_is(project: Path) -> None:
    migrate_dialogs_folder(_paths(project), project)

    content = _read(project / "dialogs" / "confirm.json")["sections"]["content"]
    assert [widget["id"] for widget in content] == ["ok"]


def test_several_widgets_are_wrapped_to_keep_the_wrapping_row(project: Path) -> None:
    result = migrate_dialogs_folder(_paths(project), project)

    content = _read(project / "dialogs" / "motor-detail.json")["sections"]["content"]
    assert len(content) == 1
    wrapper = content[0]
    assert wrapper["type"] == "Container"
    assert wrapper["layout"] == {
        "direction": "row",
        "wrap": True,
        "widthMode": "fill",
        "heightMode": "fill",
        "paddingTop": "0",
        "paddingRight": "0",
        "paddingBottom": "0",
        "paddingLeft": "0",
    }
    assert "gap" not in wrapper["layout"]
    assert [child["id"] for child in wrapper["children"]] == ["speed", "temp"]
    assert any("motor-detail" in note for note in result.diagnostics)


def test_actions_are_rewritten_everywhere(project: Path) -> None:
    migrate_dialogs_folder(_paths(project), project)

    config = _read(project / "config.json")
    assert config["globalEvents"]["onHmiLoaded"] == [
        {"type": "openDialog", "pageId": "confirm", "size": "small"}
    ]
    assert config["header"][0]["properties"]["items"][0]["actions"] == [
        {"type": "openDialog", "pageId": "help", "size": "auto"}
    ]
    group = config["pages"][1]
    assert group["events"]["onClose"] == [{"type": "closePageOverlay"}]
    assert group["header"][0]["properties"]["actions"]["onPress"] == [
        {"type": "openDialog", "pageId": "confirm", "size": "auto"}
    ]

    home = _read(project / "pages" / "home.json")
    assert home["events"]["onOpen"] == [{"type": "openDialog", "pageId": "help", "size": "auto"}]
    write = home["sections"]["content"][0]["children"][0]["properties"]["actions"]["onPress"][0]
    assert write["onSuccess"] == [
        {
            "type": "openDialog",
            "pageId": "motor-detail",
            "componentProperties": {"motorId": "M1"},
            "placement": "trigger-below",
            "backdrop": "none",
            "size": "auto",
        }
    ]
    assert write["onFailed"] == [{"type": "closePageOverlay"}]

    confirm = _read(project / "dialogs" / "confirm.json")
    assert confirm["sections"]["content"][0]["properties"]["actions"]["onPress"] == [
        {"type": "closePageOverlay", "pageId": "confirm"}
    ]

    card = _read(project / "components" / "Cards" / "card.json")
    assert card["children"][0]["properties"]["actions"]["onPress"] == [
        {"type": "openDialog", "pageId": "motor-detail", "size": "fixed", "width": 400, "height": 300}
    ]


def test_untouched_files_are_not_reported_or_rewritten(project: Path) -> None:
    line_a = project / "pages" / "line-a.json"
    before = line_a.read_bytes()

    result = migrate_dialogs_folder(_paths(project), project)

    assert line_a.read_bytes() == before
    assert "pages/line-a.json" not in result.files_changed
    assert {
        "config.json",
        "pages/home.json",
        "dialogs/confirm.json",
        "components/Cards/card.json",
    } <= set(result.files_changed)


def test_an_existing_page_overlay_action_is_left_alone(project: Path) -> None:
    migrate_dialogs_folder(_paths(project), project)

    line_a = _read(project / "pages" / "line-a.json")
    assert line_a["sections"]["content"][1]["properties"]["actions"]["onPress"] == [
        {"type": "openPageOverlay", "pageId": "home"}
    ]


def test_rerunning_changes_nothing(project: Path) -> None:
    migrate_dialogs_folder(_paths(project), project)
    snapshot = {path: path.read_bytes() for path in project.rglob("*.json")}

    result = migrate_dialogs_folder(_paths(project), project)

    assert result.files_changed == []
    assert {path: path.read_bytes() for path in project.rglob("*.json")} == snapshot


def test_a_dialog_id_that_collides_with_a_page_fails(project: Path) -> None:
    config = _read(project / "config.json")
    config["dialogs"].append({"id": "machines", "title": "Clash", "widgets": []})
    (project / "config.json").write_text(json.dumps(config))

    with pytest.raises(pm.MigrationFailedError, match="machines"):
        migrate_dialogs_folder(_paths(project), project)


def test_a_dialog_id_that_is_not_a_valid_page_id_fails(project: Path) -> None:
    config = _read(project / "config.json")
    config["dialogs"].append({"id": "../escape", "title": "Bad", "widgets": []})
    (project / "config.json").write_text(json.dumps(config))

    with pytest.raises(pm.MigrationFailedError, match="not a valid page id"):
        migrate_dialogs_folder(_paths(project), project)


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

    result = migrate_dialogs_folder(_paths(tmp_path), tmp_path)

    assert result.files_changed == []


def test_an_old_project_lands_with_its_documents_in_the_dialogs_directory(project: Path) -> None:
    """The end state: every dialog document is in ``dialogs/``, the navigable
    pages are untouched in ``pages/``, and nothing of the dialogs is left there."""
    write_project_metadata(
        project,
        ProjectMetadata(id="proj", formatVersion=7, minAppVersion=pm.PROJECT_FORMAT_MIN_APP),
    )

    pm.run_baseline_migration(project)

    assert sorted(p.name for p in (project / "dialogs").glob("*.json")) == [
        "confirm.json",
        "help.json",
        "motor-detail.json",
    ]
    assert sorted(p.name for p in (project / "pages").glob("*.json")) == [
        "home.json",
        "line-a.json",
    ]


def test_the_coordinator_carries_a_format_7_project_to_8(project: Path) -> None:
    write_project_metadata(
        project,
        ProjectMetadata(id="proj", formatVersion=7, minAppVersion=pm.PROJECT_FORMAT_MIN_APP),
    )

    result = pm.run_baseline_migration(project)

    assert result.from_version == 7
    assert result.to_version == 8
    assert read_project_metadata(project).formatVersion == 8
    assert (project / "dialogs" / "motor-detail.json").exists()
    assert not (project / "pages" / "motor-detail.json").exists()
    assert _read(project / "config.json")["dialogs"][0] == {"id": "confirm", "type": "page"}


def test_a_failed_step_leaves_the_project_as_it_was(project: Path) -> None:
    config = _read(project / "config.json")
    config["dialogs"].append({"id": "home", "title": "Clash", "widgets": []})
    (project / "config.json").write_text(json.dumps(config))
    write_project_metadata(
        project,
        ProjectMetadata(id="proj", formatVersion=7, minAppVersion=pm.PROJECT_FORMAT_MIN_APP),
    )
    before = (project / "config.json").read_bytes()

    with pytest.raises(pm.MigrationFailedError):
        pm.run_baseline_migration(project)

    assert (project / "config.json").read_bytes() == before
    assert not (project / "dialogs").exists()
    assert read_project_metadata(project).formatVersion == 7
