"""Tests for the version-2 split-page config API."""
import shutil
from pathlib import Path

import core.storage as storage
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def tmp_dirs(live_project_root: Path, monkeypatch, tmp_path: Path):
    """Redirect all storage paths to a fresh temp directory."""
    import core.validation.structure as structure

    storage.ensure_active_project_dirs()
    manifest_path = tmp_path / "widget-schemas.json"
    storage.write_json(
        manifest_path,
        {
            "version": 2,
            "builtin": {
                "Button": {"name": "Button", "category": "Controls", "schema": {}},
                "Label": {"name": "Label", "category": "Content", "schema": {}},
                # Button/Label carry an empty schema on purpose (the schema-less
                # pass); Gauge is the one entry that declares its interface.
                "Gauge": {
                    "name": "Gauge",
                    "category": "Content",
                    "schema": {"label": {"type": "string"}, "actions": {"type": "actions"}},
                },
                "ComponentSlot": {
                    "name": "Component Slot",
                    "category": "Layout",
                    "schema": {"slot": {"type": "slot"}},
                },
                # The two shapes a navigation target is stored in: a
                # `format: 'page'` field and a menu's own item list.
                "Breadcrumb": {
                    "name": "Breadcrumb",
                    "category": "Navigation",
                    "schema": {"homePageId": {"type": "string", "format": "page"}},
                },
                "NavigationMenu": {
                    "name": "Navigation Menu",
                    "category": "Navigation",
                    "schema": {"items": {"type": "menu-items"}},
                },
            },
            "custom": {},
        },
    )
    monkeypatch.setattr(structure, "WIDGET_SCHEMAS_PATH", manifest_path)
    monkeypatch.setattr(structure, "_manifest_cache", None)
    # The catalog above is the whole point of these tests, and the real built-in
    # catalog is merged over it — a shipped widget sharing a fixture name would
    # silently replace the schema under test.
    monkeypatch.setattr(structure, "builtin_widgets_catalog", lambda: ((0, 0), {}))
    return storage.active_project_root(), storage.active_pages_dir()


@pytest.fixture()
def dialogs_dir(tmp_dirs):
    """The Dialogs folder's own document directory, beside ``pages/``."""
    return storage.active_dialogs_dir()


@pytest.fixture()
def client(tmp_dirs):
    """Minimal FastAPI app that only mounts the config router — no lifespan."""
    from api.config_api import router
    from core.exceptions import register_exception_handlers
    test_app = FastAPI()
    register_exception_handlers(test_app)
    test_app.include_router(router)
    with TestClient(test_app) as c:
        yield c


# ── GET /api/config/config ────────────────────────────────────────────────────


def test_get_config_empty(client):
    resp = client.get("/api/config/config")
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"] == 2
    assert data["pages"] == []
    assert data["header"] == []


def test_get_config_returns_index_only(client, tmp_dirs):
    project_dir, _pages_dir = tmp_dirs
    # Write a v2 config with a page entry (no children key)
    config = {
        "version": 2,
        "pages": [{"id": "p1", "title": "Page 1", "type": "page"}],
        "header": [],
        "footer": [],
        "dialogs": [],
    }
    storage.write_json(project_dir / "config.json", config)

    resp = client.get("/api/config/config")
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"] == 2
    assert len(data["pages"]) == 1
    # Index entries for pages must NOT contain component children
    assert "children" not in data["pages"][0]


def test_get_config_hydrates_from_page_files(client, tmp_dirs):
    """Metadata stored in per-page files should be merged into the index on GET."""
    project_dir, pages_dir = tmp_dirs
    # Structural-only index (no title)
    config = {
        "version": 2,
        "pages": [{"id": "p1", "type": "page"}],
        "header": [],
        "footer": [],
        "dialogs": [],
    }
    storage.write_json(project_dir / "config.json", config)
    # Page file has the metadata
    storage.write_json(
        pages_dir / "p1.json",
        {"id": "p1", "title": "From File", "showHeader": True, "sections": {"content": []}},
    )

    resp = client.get("/api/config/config")
    assert resp.status_code == 200
    page = resp.json()["pages"][0]
    assert page["title"] == "From File"
    assert page["showHeader"] is True
    assert page["sections"] == {"content": []}


def test_put_config_strips_metadata_from_index(client, tmp_dirs):
    """PUT should store only structural data (id, type, hierarchy) in config.json."""
    project_dir, _pages_dir = tmp_dirs
    payload = {
        "pages": [{"id": "p1", "type": "page"}],
        "header": [],
        "footer": [],
        "dialogs": [],
    }
    client.put("/api/config/config", json=payload)
    saved = storage.read_json(project_dir / "config.json")
    node = saved["pages"][0]
    assert node == {"id": "p1", "type": "page"}


# ── PUT /api/config/config ────────────────────────────────────────────────────


def test_put_config_saves_index(client):
    payload = {
        "pages": [{"id": "p1", "title": "Page 1", "type": "page"}],
        "header": [],
        "footer": [],
        "dialogs": [],
    }
    resp = client.put("/api/config/config", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"] == 2
    assert data["pages"][0]["id"] == "p1"
    assert "sections" not in data["pages"][0]


def test_put_config_does_not_include_warnings_in_response(client):
    # Advisory issues (e.g. unknown $var on a header widget) don't block the
    # write, but the build-diagnostics response is served separately from
    # GET /api/config/validate — the PUT response no longer carries them.
    payload = {
        "pages": [],
        "header": [
            {
                "id": "h1",
                "type": "Button",
                "properties": {"label": {"$var": {"path": "DoesNotExist:X/Y"}}},
            }
        ],
        "footer": [],
        "dialogs": [],
    }
    resp = client.put("/api/config/config", json=payload)
    assert resp.status_code == 200
    assert "warnings" not in resp.json()


def test_get_validate_sweep_surfaces_shell_widget_diagnostic(client):
    payload = {
        "pages": [],
        "header": [
            {
                "id": "h1",
                "type": "Button",
                "properties": {"label": {"$var": {"path": "DoesNotExist:X/Y"}}},
            }
        ],
        "footer": [],
        "dialogs": [],
    }
    client.put("/api/config/config", json=payload)
    resp = client.get("/api/config/validate")
    assert resp.status_code == 200
    diagnostics = resp.json()["diagnostics"]
    matches = [d for d in diagnostics if d["code"] == "var-unknown" and d["artifactKind"] == "shell"]
    assert matches
    assert matches[0]["widgetId"] == "h1"
    assert matches[0]["severity"] == "error"
    assert matches[0]["propKey"] == "label"


def test_put_config_rejects_page_content_on_a_dialogs_folder_entry(client):
    """The Dialogs folder is a page-index root like `pages`: its entries are
    structural, and a page's widgets belong in the page's own file."""
    payload = {
        "pages": [],
        "header": [],
        "footer": [],
        "dialogs": [{"id": "login", "title": "Login", "type": "page", "sections": {"content": []}}],
    }
    resp = client.put("/api/config/config", json=payload)
    assert resp.status_code == 422


def test_put_config_rejects_an_id_used_in_both_roots(client):
    payload = {
        "pages": [{"id": "p1", "title": "Page 1", "type": "page"}],
        "header": [],
        "footer": [],
        "dialogs": [{"id": "p1", "title": "Also page 1", "type": "page"}],
    }
    resp = client.put("/api/config/config", json=payload)
    assert resp.status_code == 422


def test_get_config_hydrates_the_dialogs_folder_from_its_own_directory(
    client, tmp_dirs, dialogs_dir
):
    project_dir, pages_dir = tmp_dirs
    storage.write_json(project_dir / "config.json", {
        "version": 2,
        "pages": [],
        "dialogs": [{"id": "motor-detail", "type": "page"}],
    })
    # A same-named document in pages/ is a different page, and must not be read
    # for the Dialogs folder's node.
    storage.write_json(pages_dir / "motor-detail.json", {"id": "motor-detail", "title": "Wrong"})
    storage.write_json(
        dialogs_dir / "motor-detail.json",
        {"id": "motor-detail", "title": "Motor detail", "showCloseButton": False},
    )

    dialogs = client.get("/api/config/config").json()["dialogs"]

    assert dialogs == [
        {"id": "motor-detail", "type": "page", "title": "Motor detail", "showCloseButton": False}
    ]


def test_put_config_rejects_sections_on_page_index_entry(client):
    payload = {
        "pages": [
            {
                "id": "p1",
                "title": "Page 1",
                "type": "page",
                "sections": {"main": [{"id": "c1", "type": "Button", "name": "B"}]},
            }
        ],
        "header": [],
        "footer": [],
        "dialogs": [],
    }
    resp = client.put("/api/config/config", json=payload)
    assert resp.status_code == 422


def test_put_config_accepts_group_with_page_children(client):
    payload = {
        "pages": [
            {
                "id": "g1",
                "title": "Group",
                "type": "page-group",
                "children": [{"id": "p1", "title": "Tab 1", "type": "page"}],
            }
        ],
        "header": [],
        "footer": [],
        "dialogs": [],
    }
    resp = client.put("/api/config/config", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data["pages"][0]["type"] == "page-group"
    assert data["pages"][0]["children"][0]["id"] == "p1"
    # Page entries inside a group index also must not contain content
    assert "sections" not in data["pages"][0]["children"][0]


def test_put_config_preserves_group_header_and_footer(client):
    payload = {
        "pages": [
            {
                "id": "g1",
                "title": "Group",
                "type": "page-group",
                "children": [{"id": "p1", "title": "Tab 1", "type": "page"}],
                "header": [{"id": "h1", "type": "Label", "name": "GroupHdr"}],
                "footer": [{"id": "f1", "type": "Label", "name": "GroupFtr"}],
            }
        ],
        "header": [],
        "footer": [],
        "dialogs": [],
    }
    resp = client.put("/api/config/config", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data["pages"][0]["header"] == [{"id": "h1", "type": "Label", "name": "GroupHdr"}]
    assert data["pages"][0]["footer"] == [{"id": "f1", "type": "Label", "name": "GroupFtr"}]

    fetched = client.get("/api/config/config").json()
    assert fetched["pages"][0]["header"][0]["id"] == "h1"
    assert fetched["pages"][0]["footer"][0]["id"] == "f1"


def test_put_config_round_trips_group_component_properties(client):
    # A page group declares the same input-property interface a page does, and
    # it lives in the index, not in a page file — nothing strips it on save.
    declared = {"motorId": {"type": "String", "label": "Motor", "defaultValue": "M1"}}
    payload = {
        "pages": [
            {
                "id": "g1",
                "title": "Group",
                "type": "page-group",
                "componentProperties": declared,
                "children": [{"id": "p1", "title": "Tab 1", "type": "page"}],
            }
        ],
        "header": [],
        "footer": [],
        "dialogs": [],
    }
    resp = client.put("/api/config/config", json=payload)
    assert resp.status_code == 200
    assert resp.json()["pages"][0]["componentProperties"] == declared

    fetched = client.get("/api/config/config").json()
    assert fetched["pages"][0]["componentProperties"] == declared


def test_group_declarations_are_collected_for_overlay_argument_validation(client):
    # A group declares its parameters in the page index, not in a page file, so
    # the validator has to walk the index to know them. `prop-unknown` is a
    # warning, and neither PUT returns warnings — the debounced validate
    # endpoint is the only place it surfaces, so that is what this asserts.
    payload = {
        "pages": [],
        "dialogs": [
            {
                "id": "g1",
                "title": "Group",
                "type": "page-group",
                "componentProperties": {"motorId": {"type": "String", "label": "Motor"}},
                "children": [{"id": "p1", "title": "Tab 1", "type": "page"}],
            }
        ],
        "header": [
            {
                "id": "h1",
                "type": "Gauge",
                "name": "Opener",
                "properties": {
                    "actions": {
                        "onPress": [
                            {
                                "type": "openDialog",
                                "pageId": "g1",
                                "componentProperties": {"motorId": "M1"},
                            }
                        ]
                    }
                },
            }
        ],
        "footer": [],
    }
    resp = client.put("/api/config/config", json=payload)
    assert resp.status_code == 200

    warnings = client.get("/api/config/validate").json()["diagnostics"]
    assert [d for d in warnings if d["code"] == "prop-unknown"] == []


def test_put_config_validates_moved_page_against_new_root(client, monkeypatch):
    """A save that moves a page between the two page-tree roots must validate
    cross-references (overlay actions, input parameters) against the root the
    body assigns, not the on-disk index this same request is about to replace."""
    import api.config_api as config_api

    seed = {
        "pages": [{"id": "p1", "title": "P1", "type": "page"}],
        "dialogs": [],
        "header": [], "footer": [],
    }
    assert client.put("/api/config/config", json=seed).status_code == 200

    captured: dict = {}
    original = config_api.validate_config_areas

    def spy(payload, ctx):
        report = original(payload, ctx)
        captured["ctx"] = ctx
        captured["report"] = report
        return report

    monkeypatch.setattr(config_api, "validate_config_areas", spy)

    # Same save: move p1 into the Dialogs root and open it with `openDialog`
    # — the action only the Dialogs root supports.
    moved = {
        "pages": [],
        "dialogs": [{"id": "p1", "title": "P1", "type": "page"}],
        "header": [
            {
                "id": "h1", "type": "Gauge", "name": "Opener",
                "properties": {"actions": {"onPress": [
                    {"type": "openDialog", "pageId": "p1", "componentProperties": {}}
                ]}},
            }
        ],
        "footer": [],
    }
    resp = client.put("/api/config/config", json=moved)
    assert resp.status_code == 200

    ctx = captured["ctx"]
    assert "p1" in ctx.dialogs_page_ids
    assert "p1" not in ctx.navigable_page_ids

    codes = {w.code for w in captured["report"].warnings}
    assert "overlay-wrong-root" not in codes


def test_project_sweep_matches_input_scope_per_root(client, monkeypatch):
    """The whole-project sweep must give a navigable-root page-group the same
    'no input scope' treatment `PUT /api/config` already applies on save —
    otherwise the same $componentProp reads a warning on one and not the other."""
    import api.config_api as config_api

    payload = {
        "pages": [{"id": "pg1", "title": "PG1", "type": "page-group", "children": []}],
        "dialogs": [{"id": "dg1", "title": "DG1", "type": "page-group", "children": []}],
        "header": [], "footer": [],
    }
    assert client.put("/api/config/config", json=payload).status_code == 200

    captured: dict = {}
    original = config_api.validate_page_node_events

    def spy(node, ctx):
        captured[node.get("id")] = ctx.input_scope
        return original(node, ctx)

    monkeypatch.setattr(config_api, "validate_page_node_events", spy)

    resp = client.get("/api/config/validate")
    assert resp.status_code == 200
    assert captured["pg1"] is False
    assert captured["dg1"] is True


def test_put_config_rejects_non_array_group_header(client):
    payload = {
        "pages": [
            {
                "id": "g1",
                "title": "Group",
                "type": "page-group",
                "children": [{"id": "p1", "title": "Tab 1", "type": "page"}],
                "header": "not-an-array",
            }
        ],
        "header": [],
        "footer": [],
        "dialogs": [],
    }
    resp = client.put("/api/config/config", json=payload)
    assert resp.status_code == 422


def test_put_config_cleanup_orphaned_page_files(client, tmp_dirs):
    """Saving a new index should delete page files no longer referenced."""
    _project_dir, pages_dir = tmp_dirs
    # Create an orphaned page file
    orphan = pages_dir / "orphan-id.json"
    storage.write_json(orphan, {"id": "orphan-id", "sections": {"main": []}})

    payload = {
        "pages": [{"id": "p1", "title": "Page 1", "type": "page"}],
        "header": [],
        "footer": [],
        "dialogs": [],
    }
    client.put("/api/config/config", json=payload)
    assert not orphan.exists()


def test_put_config_without_a_dialogs_key_keeps_the_stored_folder(client, dialogs_dir):
    """An older client PUTs the surface it knows. Dropping the root it never
    sends would take the Dialogs folder's documents with it."""
    page_file = dialogs_dir / "motor-detail.json"
    storage.write_json(page_file, {"id": "motor-detail", "sections": {"content": []}})
    client.put(
        "/api/config/config",
        json={"pages": [], "dialogs": [{"id": "motor-detail", "type": "page"}]},
    )

    assert client.put("/api/config/config", json={"pages": []}).status_code == 200

    assert page_file.exists()
    assert [node["id"] for node in client.get("/api/config/config").json()["dialogs"]] == [
        "motor-detail"
    ]
    # An explicit empty array still clears it.
    assert client.put("/api/config/config", json={"pages": [], "dialogs": []}).status_code == 200
    assert client.get("/api/config/config").json()["dialogs"] == []
    assert not page_file.exists()


def test_put_config_keeps_the_page_files_of_the_dialogs_folder(client, dialogs_dir):
    """A page in the Dialogs folder is indexed under `dialogs`, not `pages` —
    the sweep runs per directory, so each one has to be counted against its own
    root's ids."""
    in_group = dialogs_dir / "tab-1.json"
    top_level = dialogs_dir / "motor-detail.json"
    storage.write_json(in_group, {"id": "tab-1", "sections": {"content": []}})
    storage.write_json(top_level, {"id": "motor-detail", "sections": {"content": []}})

    payload = {
        "pages": [],
        "header": [],
        "footer": [],
        "dialogs": [
            {"id": "motor-detail", "type": "page"},
            {
                "id": "settings",
                "title": "Settings",
                "type": "page-group",
                "children": [{"id": "tab-1", "type": "page"}],
            },
        ],
    }
    assert client.put("/api/config/config", json=payload).status_code == 200
    assert in_group.exists()
    assert top_level.exists()


def test_put_config_relocates_a_page_that_changed_root(client, tmp_dirs, dialogs_dir):
    """The dangerous edit: dragging a page between the two sections changes only
    the index. Each directory is swept against its own root, so without the move
    the document would be deleted as an orphan of the root it left."""
    _project_dir, pages_dir = tmp_dirs
    storage.write_json(pages_dir / "detail.json", {"id": "detail", "sections": {"content": []}})
    client.put("/api/config/config", json={"pages": [{"id": "detail", "type": "page"}]})

    # Pages -> Dialogs
    assert (
        client.put(
            "/api/config/config",
            json={"pages": [], "dialogs": [{"id": "detail", "type": "page"}]},
        ).status_code
        == 200
    )
    assert (dialogs_dir / "detail.json").exists()
    assert not (pages_dir / "detail.json").exists()

    # ...and back again
    assert (
        client.put(
            "/api/config/config",
            json={"pages": [{"id": "detail", "type": "page"}], "dialogs": []},
        ).status_code
        == 200
    )
    assert (pages_dir / "detail.json").exists()
    assert not (dialogs_dir / "detail.json").exists()


def test_put_config_relocates_into_a_project_with_no_dialogs_directory(client, tmp_dirs):
    """A project that predates the Dialogs folder has no such directory; the
    move has to create it rather than fail."""
    _project_dir, pages_dir = tmp_dirs
    dialogs_dir = storage.active_dialogs_dir()
    storage.write_json(pages_dir / "detail.json", {"id": "detail", "sections": {"content": []}})
    client.put("/api/config/config", json={"pages": [{"id": "detail", "type": "page"}]})
    shutil.rmtree(dialogs_dir, ignore_errors=True)
    assert not dialogs_dir.exists()

    resp = client.put(
        "/api/config/config",
        json={"pages": [], "dialogs": [{"id": "detail", "type": "page"}]},
    )

    assert resp.status_code == 200
    assert (dialogs_dir / "detail.json").exists()
    assert not (pages_dir / "detail.json").exists()


def test_put_config_leaves_a_stale_duplicate_in_the_other_root_alone(
    client, tmp_dirs, dialogs_dir
):
    """One id can have a document in both directories — an import or a hand
    edit does it. The node's own root decides which one is served, and the
    sweep deletes the one whose root no longer lists the id."""
    _project_dir, pages_dir = tmp_dirs
    storage.write_json(pages_dir / "detail.json", {"id": "detail", "title": "Stale"})
    storage.write_json(dialogs_dir / "detail.json", {"id": "detail", "title": "Real"})

    client.put(
        "/api/config/config",
        json={"pages": [], "dialogs": [{"id": "detail", "type": "page"}]},
    )

    # The Dialogs document is the one the index names, and it is untouched;
    # the pages/ copy is an orphan of a root that no longer holds the id.
    assert storage.read_json(dialogs_dir / "detail.json")["title"] == "Real"
    assert not (pages_dir / "detail.json").exists()
    assert client.get("/api/config/config").json()["dialogs"][0]["title"] == "Real"


def test_put_config_relocates_every_page_of_a_group_that_changed_root(
    client, tmp_dirs, dialogs_dir
):
    _project_dir, pages_dir = tmp_dirs
    for page_id in ("tab-1", "tab-2"):
        storage.write_json(pages_dir / f"{page_id}.json", {"id": page_id, "sections": {}})
    group = {
        "id": "settings",
        "title": "Settings",
        "type": "page-group",
        "children": [
            {"id": "tab-1", "type": "page"},
            {
                "id": "nested",
                "title": "Nested",
                "type": "page-group",
                "children": [{"id": "tab-2", "type": "page"}],
            },
        ],
    }
    client.put("/api/config/config", json={"pages": [group]})

    resp = client.put("/api/config/config", json={"pages": [], "dialogs": [group]})

    assert resp.status_code == 200
    assert sorted(f.name for f in dialogs_dir.glob("*.json")) == ["tab-1.json", "tab-2.json"]
    assert list(pages_dir.glob("*.json")) == []


def test_put_config_keeps_the_content_of_a_relocated_page(client, tmp_dirs, dialogs_dir):
    _project_dir, pages_dir = tmp_dirs
    storage.write_json(
        pages_dir / "detail.json",
        {
            "id": "detail",
            "title": "Detail",
            "sections": {"content": [{"id": "b", "type": "Button"}]},
        },
    )
    client.put("/api/config/config", json={"pages": [{"id": "detail", "type": "page"}]})

    client.put(
        "/api/config/config", json={"pages": [], "dialogs": [{"id": "detail", "type": "page"}]}
    )

    moved = storage.read_json(dialogs_dir / "detail.json")
    assert moved["title"] == "Detail"
    assert moved["sections"]["content"][0]["id"] == "b"


# ── The Dialogs folder's own document endpoints ──────────────────────────────


def test_dialogs_document_endpoints_address_that_directory(client, tmp_dirs, dialogs_dir):
    _project_dir, pages_dir = tmp_dirs
    body = {"id": "motor-detail", "title": "Motor detail", "sections": {"content": []}}

    assert client.put("/api/config/dialogs/motor-detail", json=body).status_code == 200

    assert (dialogs_dir / "motor-detail.json").exists()
    assert not (pages_dir / "motor-detail.json").exists()
    assert client.get("/api/config/dialogs/motor-detail").json()["title"] == "Motor detail"
    # The pages route addresses a different document - an empty stub here.
    assert client.get("/api/config/pages/motor-detail").json() == {
        "id": "motor-detail",
        "sections": {"content": []},
    }

    assert client.delete("/api/config/dialogs/motor-detail").status_code == 200
    assert not (dialogs_dir / "motor-detail.json").exists()


# ── GET /api/config/pages/{page_id} ──────────────────────────────────────────


def test_get_page_returns_empty_when_missing(client):
    resp = client.get("/api/config/pages/some-page-id")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == "some-page-id"
    assert data["sections"] == {"content": []}


def test_get_page_returns_stored_content(client, tmp_dirs):
    _project_dir, pages_dir = tmp_dirs
    page_id = "aabbccdd-1234-5678-abcd-000000000001"
    storage.write_json(
        pages_dir / f"{page_id}.json",
        {"id": page_id, "sections": {"main": [{"id": "c1", "type": "Button", "name": "B"}]}},
    )
    resp = client.get(f"/api/config/pages/{page_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == page_id
    assert data["sections"]["main"][0]["id"] == "c1"


def test_get_page_rejects_invalid_id(client):
    resp = client.get("/api/config/pages/../etc/passwd")
    assert resp.status_code in (404, 422)


# ── PUT /api/config/pages/{page_id} ──────────────────────────────────────────


def test_put_page_creates_file(client, tmp_dirs):
    _project_dir, pages_dir = tmp_dirs
    page_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    payload = {"id": page_id, "sections": {"main": [{"id": "c1", "type": "Button", "name": "B"}]}}
    resp = client.put(f"/api/config/pages/{page_id}", json=payload)
    assert resp.status_code == 200
    assert (pages_dir / f"{page_id}.json").exists()


def test_put_page_accepts_metadata_only(client, tmp_dirs):
    """Page groups store metadata without sections."""
    _project_dir, pages_dir = tmp_dirs
    resp = client.put("/api/config/pages/some-group", json={"id": "some-group", "title": "My Group"})
    assert resp.status_code == 200
    assert resp.json()["title"] == "My Group"
    assert (pages_dir / "some-group.json").exists()


def test_put_page_does_not_include_warnings_in_response(client, tmp_dirs):
    # Lenient policy: unknown datasource is advisory — write succeeds, but the
    # PUT response no longer carries it (see GET /api/config/validate).
    page_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    payload = {
        "id": page_id,
        "sections": {
            "main": [
                {
                    "id": "c1",
                    "type": "Button",
                    "properties": {
                        "label": {"$var": {"path": "DoesNotExist:X/Y"}},
                    },
                }
            ]
        },
    }
    resp = client.put(f"/api/config/pages/{page_id}", json=payload)
    assert resp.status_code == 200
    assert "warnings" not in resp.json()


def test_put_page_persists_main_padding_and_background(client, tmp_dirs):
    # Regression: these page fields were dropped by the persisted-fields allowlist.
    page_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    resp = client.put(
        f"/api/config/pages/{page_id}",
        json={
            "id": page_id,
            "mainPadding": "16px",
            "mainBackground": "#123456",
            "sections": {"main": []},
        },
    )
    assert resp.status_code == 200
    fetched = client.get(f"/api/config/pages/{page_id}").json()
    assert fetched["mainPadding"] == "16px"
    assert fetched["mainBackground"] == "#123456"


def test_put_page_persists_lifecycle_events(client, tmp_dirs):
    page_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    events = {"onOpen": [{"type": "closePageOverlay"}], "onClose": [{"type": "closePageOverlay"}]}
    resp = client.put(
        f"/api/config/pages/{page_id}",
        json={"id": page_id, "events": events, "sections": {"main": []}},
    )
    assert resp.status_code == 200
    assert client.get(f"/api/config/pages/{page_id}").json()["events"] == events


def test_post_validate_page_events_owned_by_the_page(client):
    """A page's own onOpen/onClose hang off the page node, not a widget."""
    draft = {
        "id": "page-home",
        "events": {"onOpen": [{"type": "openPageOverlay", "pageId": "does-not-exist"}]},
        "sections": {"content": []},
    }
    resp = client.post("/api/config/validate", json={"kind": "page", "draft": draft})
    assert resp.status_code == 200
    diagnostic = next(d for d in resp.json()["diagnostics"] if d["severity"] == "error")
    assert diagnostic["widgetId"] == "page-home"
    assert diagnostic["propKey"] == "onOpen"
    assert diagnostic["fieldPath"][:2] == ["onOpen", "0"]


def test_put_config_keeps_page_group_events_in_the_index(client, tmp_dirs):
    """A group's events have no page file to live on — the index carries them."""
    project_dir, _pages_dir = tmp_dirs
    events = {"onOpen": [{"type": "closePageOverlay"}]}
    payload = {
        "version": 2,
        "pages": [
            {"id": "grp-1", "title": "Section", "type": "page-group",
             "events": events, "children": []},
        ],
        "header": [], "footer": [], "dialogs": [],
    }
    assert client.put("/api/config/config", json=payload).status_code == 200
    saved = storage.read_json(project_dir / "config.json")
    assert saved["pages"][0]["events"] == events


def test_get_validate_reports_page_group_events(client, tmp_dirs):
    """Group events live in the page index, so only the config sweep sees them."""
    project_dir, _pages_dir = tmp_dirs
    storage.write_json(project_dir / "config.json", {
        "version": 2,
        "pages": [{
            "id": "grp-1",
            "title": "Section",
            "type": "page-group",
            "events": {"onOpen": [{"type": "openPageOverlay", "pageId": "does-not-exist"}]},
            "children": [],
        }],
        "header": [], "footer": [], "dialogs": [],
    })

    diagnostics = client.get("/api/config/validate").json()["diagnostics"]
    diagnostic = next(d for d in diagnostics if d["artifactKind"] == "pageGroup")
    assert diagnostic["artifactId"] == "grp-1"
    assert diagnostic["widgetId"] == "grp-1"
    assert diagnostic["propKey"] == "onOpen"
    assert diagnostic["severity"] == "error"


def test_put_page_round_trips_component_properties(client, tmp_dirs):
    # The page's input-property interface, filled in by the openDialog action.
    page_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    declared = {"motorId": {"type": "String", "label": "Motor", "defaultValue": "M1"}}
    resp = client.put(
        f"/api/config/pages/{page_id}",
        json={"id": page_id, "componentProperties": declared, "sections": {"main": []}},
    )
    assert resp.status_code == 200
    assert client.get(f"/api/config/pages/{page_id}").json()["componentProperties"] == declared


def test_get_validate_scans_every_page(client, tmp_dirs):
    # A page saved earlier (not touched in a later session) still surfaces its
    # advisory diagnostics under the read-only project-wide sweep.
    page_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    client.put(
        f"/api/config/pages/{page_id}",
        json={
            "id": page_id,
            "sections": {
                "main": [
                    {
                        "id": "c1",
                        "type": "Button",
                        "properties": {"label": {"$var": {"path": "DoesNotExist:X/Y"}}},
                    }
                ]
            },
        },
    )
    resp = client.get("/api/config/validate")
    assert resp.status_code == 200
    diagnostics = resp.json()["diagnostics"]
    assert any(
        d["artifactKind"] == "page"
        and d["artifactId"] == page_id
        and d["widgetId"] == "c1"
        and d["code"] == "var-unknown"
        for d in diagnostics
    )


def test_get_validate_empty_when_clean(client):
    resp = client.get("/api/config/validate")
    assert resp.status_code == 200
    assert resp.json()["diagnostics"] == []


def test_get_validate_checks_components_translations_and_widget_builds(
    client, tmp_dirs, monkeypatch, tmp_path
):
    import api.config_api as config_api

    _project_dir, _pages_dir = tmp_dirs
    storage.write_json(
        storage.active_components_dir() / "bad-component.json",
        {
            "name": "Bad component",
            "componentProperties": {},
            "children": [
                {
                    "id": "label-1",
                    "type": "Label",
                    "properties": {"text": {"$var": {"path": "Missing:Value"}}},
                }
            ],
        },
    )
    storage.write_csv(
        storage.active_translations_dir() / "Default.csv",
        [["en-EN", "en-EN"], ["", "orphan"]],
    )
    widget_dir = storage.active_custom_widgets_dir() / "BrokenWidget"
    widget_dir.mkdir(parents=True)
    (widget_dir / "index.tsx").write_text("export default () => null", encoding="utf-8")
    status_path = tmp_path / ".build-status.json"
    storage.write_json(
        status_path,
        {
            "version": 2,
            "widgets": {"BrokenWidget": {"ok": False, "error": "syntax error"}},
        },
    )
    monkeypatch.setattr(config_api, "BUILD_STATUS_PATH", status_path)

    resp = client.get("/api/config/validate")
    assert resp.status_code == 200
    diagnostics = resp.json()["diagnostics"]
    assert any(
        d["artifactKind"] == "component" and d["artifactId"] == "bad-component" for d in diagnostics
    )
    assert any(
        d["artifactKind"] == "translations" and d["artifactId"] == "Default" for d in diagnostics
    )
    assert any(
        d["artifactKind"] == "widget-build" and d["artifactId"] == "BrokenWidget" for d in diagnostics
    )


def test_put_translations_rejects_malformed_dictionary(client):
    resp = client.put(
        "/api/config/translations",
        json={"languages": [{"code": "en-EN"}, {"code": "en-EN"}], "rows": {}},
    )
    assert resp.status_code == 422
    assert "duplicate language code" in resp.json()["detail"]


def test_put_page_rejects_invalid_sections(client):
    resp = client.put("/api/config/pages/some-page", json={"id": "some-page", "sections": "bad"})
    assert resp.status_code == 422


def test_put_page_rejects_non_array_section(client):
    resp = client.put(
        "/api/config/pages/some-page",
        json={"id": "some-page", "sections": {"main": "not-a-list"}},
    )
    assert resp.status_code == 422


# ── DELETE /api/config/pages/{page_id} ───────────────────────────────────────


def test_delete_page_removes_file(client, tmp_dirs):
    _project_dir, pages_dir = tmp_dirs
    page_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    storage.write_json(pages_dir / f"{page_id}.json", {"id": page_id, "sections": {"main": []}})
    resp = client.delete(f"/api/config/pages/{page_id}")
    assert resp.status_code == 200
    assert not (pages_dir / f"{page_id}.json").exists()


def test_delete_page_ok_when_missing(client):
    resp = client.delete("/api/config/pages/nonexistent-page")
    assert resp.status_code == 200


# ── POST /api/config/validate (realtime, one artifact, no persist) ──────────


def test_post_validate_rejects_unknown_kind(client):
    resp = client.post("/api/config/validate", json={"kind": "nonsense", "draft": {}})
    assert resp.status_code == 422


def test_post_validate_rejects_non_object_draft(client):
    resp = client.post("/api/config/validate", json={"kind": "page", "draft": "nope"})
    assert resp.status_code == 422


def test_post_validate_page_does_not_persist(client, tmp_dirs):
    _project_dir, pages_dir = tmp_dirs
    draft = {
        "id": "unsaved-page",
        "sections": {
            "main": [
                {
                    "id": "c1",
                    "type": "Button",
                    "properties": {"label": {"$var": {"path": "DoesNotExist:X/Y"}}},
                }
            ]
        },
    }
    resp = client.post("/api/config/validate", json={"kind": "page", "draft": draft})
    assert resp.status_code == 200
    diagnostics = resp.json()["diagnostics"]
    diagnostic = next(
        d
        for d in diagnostics
        if d["code"] == "var-unknown" and d["widgetId"] == "c1" and d["propKey"] == "label"
    )
    assert diagnostic["fieldPath"] == ["label"]
    assert not (pages_dir / "unsaved-page.json").exists()


def test_post_validate_reports_unknown_property(client):
    draft = {
        "id": "stale-prop",
        "sections": {
            "main": [{"id": "c1", "type": "Gauge", "properties": {"optionsSource": "users"}}]
        },
    }

    resp = client.post("/api/config/validate", json={"kind": "page", "draft": draft})

    assert resp.status_code == 200
    diagnostic = next(d for d in resp.json()["diagnostics"] if d["code"] == "prop-unknown")
    assert diagnostic["severity"] == "warning"
    assert diagnostic["widgetId"] == "c1"
    assert diagnostic["propKey"] == "optionsSource"
    assert diagnostic["fieldPath"] == ["optionsSource"]
    assert diagnostic["nested"] is False


def _overlay_opener_draft(target_id: str, args: dict) -> dict:
    return {
        "id": "overlay-args",
        "sections": {
            "main": [
                {
                    "id": "c1",
                    "type": "Gauge",
                    "properties": {
                        "actions": {
                            "onPress": [
                                {
                                    "type": "openDialog",
                                    "pageId": target_id,
                                    "componentProperties": args,
                                }
                            ]
                        }
                    },
                }
            ]
        },
    }


def test_post_validate_ignores_declarations_outside_the_dialogs_folder(client, tmp_dirs):
    """A page in the navigable tree takes no input parameters, whatever its file
    declares, so every value an action hands it is flagged."""
    project_dir, pages_dir = tmp_dirs
    target_id = "motor-page"
    storage.write_json(project_dir / "config.json", {
        "version": 2,
        "pages": [{"id": target_id, "type": "page"}],
        "dialogs": [],
    })
    storage.write_json(
        pages_dir / f"{target_id}.json",
        {
            "id": target_id,
            "componentProperties": {"motorId": {"type": "String", "label": "Motor"}},
            "sections": {"main": []},
        },
    )

    resp = client.post(
        "/api/config/validate",
        json={"kind": "page", "draft": _overlay_opener_draft(target_id, {"motorId": "M1"})},
    )

    assert resp.status_code == 200
    diagnostic = next(d for d in resp.json()["diagnostics"] if d["code"] == "prop-unknown")
    assert diagnostic["fieldPath"][-1] == "motorId"


def test_post_validate_reports_input_parameter_on_a_navigable_page(client, tmp_dirs):
    project_dir, _pages_dir = tmp_dirs
    storage.write_json(project_dir / "config.json", {
        "version": 2,
        "pages": [{"id": "home", "type": "page"}],
        "dialogs": [{"id": "motor-detail", "type": "page"}],
    })

    def draft(page_id: str) -> dict:
        return {
            "id": page_id,
            "sections": {
                "content": [
                    {"id": "l1", "type": "Label", "properties": {"text": {"$componentProp": "motorId"}}}
                ]
            },
        }

    navigable = client.post("/api/config/validate", json={"kind": "page", "draft": draft("home")})
    overlay = client.post("/api/config/validate", json={"kind": "page", "draft": draft("motor-detail")})

    codes = [d["code"] for d in navigable.json()["diagnostics"]]
    assert "componentprop-no-scope" in codes
    assert "componentprop-no-scope" not in [d["code"] for d in overlay.json()["diagnostics"]]


def test_post_validate_reports_unknown_page_overlay_argument(client, tmp_dirs):
    project_dir, _pages_dir = tmp_dirs
    target_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    storage.write_json(project_dir / "config.json", {
        "version": 2,
        "pages": [],
        "dialogs": [{"id": target_id, "type": "page"}],
    })
    storage.write_json(
        storage.active_dialogs_dir() / f"{target_id}.json",
        {
            "id": target_id,
            "componentProperties": {"motorId": {"type": "String", "label": "Motor"}},
            "sections": {"main": []},
        },
    )
    draft = {
        "id": "overlay-args",
        "sections": {
            "main": [
                {
                    "id": "c1",
                    "type": "Gauge",
                    "properties": {
                        "actions": {
                            "onPress": [
                                {
                                    "type": "openDialog",
                                    "pageId": target_id,
                                    "componentProperties": {"ghost": 1},
                                }
                            ]
                        }
                    },
                }
            ]
        },
    }

    resp = client.post("/api/config/validate", json={"kind": "page", "draft": draft})

    assert resp.status_code == 200
    diagnostic = next(d for d in resp.json()["diagnostics"] if d["code"] == "prop-unknown")
    assert diagnostic["severity"] == "warning"
    assert diagnostic["fieldPath"] == [
        "actions",
        "onPress",
        "0",
        "componentProperties",
        "ghost",
    ]


def test_post_validate_reports_unknown_page_group_overlay_argument(client):
    # Open Page Overlay may target a page group, so its declared interface has
    # to be collected from the index tree the same way a page's is from its file.
    client.put(
        "/api/config/config",
        json={
            "pages": [],
            "dialogs": [
                {
                    "id": "g1",
                    "title": "Group",
                    "type": "page-group",
                    "componentProperties": {"motorId": {"type": "String", "label": "Motor"}},
                    "children": [{"id": "p1", "title": "Tab 1", "type": "page"}],
                }
            ],
            "header": [],
            "footer": [],
        },
    )
    draft = {
        "id": "overlay-group-args",
        "sections": {
            "main": [
                {
                    "id": "c1",
                    "type": "Gauge",
                    "properties": {
                        "actions": {
                            "onPress": [
                                {
                                    "type": "openDialog",
                                    "pageId": "g1",
                                    "componentProperties": {"ghost": 1},
                                }
                            ]
                        }
                    },
                }
            ]
        },
    }

    resp = client.post("/api/config/validate", json={"kind": "page", "draft": draft})

    assert resp.status_code == 200
    diagnostic = next(d for d in resp.json()["diagnostics"] if d["code"] == "prop-unknown")
    assert diagnostic["severity"] == "warning"
    assert diagnostic["fieldPath"] == [
        "actions",
        "onPress",
        "0",
        "componentProperties",
        "ghost",
    ]


def test_post_validate_exposes_nested_expression_field_path(client):
    draft = {
        "id": "nested-expression",
        "sections": {
            "main": [
                {
                    "id": "c1",
                    "type": "Button",
                    "properties": {
                        "label": {
                            "$if": {
                                "condition": {
                                    "$compare": {
                                        "left": {"$var": {"path": "DoesNotExist:X/Y"}},
                                        "operator": ">",
                                        "right": 0,
                                    }
                                },
                                "true": "yes",
                                "false": "no",
                            }
                        }
                    },
                }
            ]
        },
    }

    resp = client.post("/api/config/validate", json={"kind": "page", "draft": draft})

    assert resp.status_code == 200
    diagnostic = next(d for d in resp.json()["diagnostics"] if d["code"] == "var-unknown")
    assert diagnostic["fieldPath"] == [
        "label",
        "$if",
        "condition",
        "$compare",
        "left",
    ]


def test_post_validate_shell(client):
    draft = {
        "header": [
            {"id": "h1", "type": "Button", "properties": {"label": {"$loc": ""}}}
        ],
        "footer": [],
        "leftSidebar": [],
        "rightSidebar": [],
        "shell": {},
    }
    resp = client.post("/api/config/validate", json={"kind": "shell", "draft": draft})
    assert resp.status_code == 200
    diagnostics = resp.json()["diagnostics"]
    assert any(
        d["artifactKind"] == "shell" and d["code"] == "loc-empty" and d["widgetId"] == "h1"
        for d in diagnostics
    )


def test_post_validate_shell_region_field_owned_by_its_area_panel(client):
    """Shell-region settings live on no widget node — they still need an owner
    id and field path, or the property panel can't mark them."""
    draft = {
        "header": [],
        "footer": [],
        "leftSidebar": [],
        "rightSidebar": [],
        "shell": {"header": {"expandedSize": {"$var": {"path": "Missing:Size"}}}},
    }
    resp = client.post("/api/config/validate", json={"kind": "shell", "draft": draft})
    assert resp.status_code == 200
    diagnostic = next(d for d in resp.json()["diagnostics"] if d["code"] == "var-unknown")
    assert diagnostic["widgetId"] == "__header__"
    assert diagnostic["propKey"] == "expandedSize"
    assert diagnostic["fieldPath"] == ["expandedSize"]
    assert diagnostic["nested"] is False
    assert diagnostic["breadcrumb"] == "Header › expandedSize"  # noqa: RUF001


def test_post_validate_shell_region_nested_expression(client):
    draft = {
        "shell": {
            "leftSidebar": {"expanded": {"$if": {"true": True, "false": False}}}
        }
    }
    resp = client.post("/api/config/validate", json={"kind": "shell", "draft": draft})
    assert resp.status_code == 200
    diagnostic = next(
        d for d in resp.json()["diagnostics"] if d["code"] == "if-condition-empty"
    )
    assert diagnostic["widgetId"] == "__leftSidebar__"
    assert diagnostic["fieldPath"] == ["expanded", "$if", "condition"]
    assert diagnostic["nested"] is True


def test_post_validate_shell_default_state_enum(client):
    draft = {"shell": {"header": {"defaultState": "sideways"}}}
    resp = client.post("/api/config/validate", json={"kind": "shell", "draft": draft})
    assert resp.status_code == 200
    diagnostic = next(
        d for d in resp.json()["diagnostics"] if d["code"] == "shell-default-state-unknown"
    )
    assert diagnostic["widgetId"] == "__header__"
    assert diagnostic["propKey"] == "defaultState"
    assert diagnostic["severity"] == "error"


def test_post_validate_shell_full_height_is_bindable(client):
    draft = {"shell": {"leftSidebar": {"fullHeight": {"$var": {"path": "Missing:Wide"}}}}}
    resp = client.post("/api/config/validate", json={"kind": "shell", "draft": draft})
    assert resp.status_code == 200
    diagnostic = next(d for d in resp.json()["diagnostics"] if d["code"] == "var-unknown")
    assert diagnostic["widgetId"] == "__leftSidebar__"
    assert diagnostic["propKey"] == "fullHeight"


def test_post_validate_global_events(client):
    draft = {"onLoad": [{"type": "openPageOverlay", "pageId": "does-not-exist"}]}
    resp = client.post("/api/config/validate", json={"kind": "globalEvents", "draft": draft})
    assert resp.status_code == 200
    diagnostics = resp.json()["diagnostics"]
    assert any(d["artifactKind"] == "globalEvents" and d["severity"] == "error" for d in diagnostics)


def test_post_validate_global_events_owned_by_the_events_panel(client):
    draft = {"onPageLoaded": [{"type": "openPageOverlay", "pageId": "does-not-exist"}]}
    resp = client.post("/api/config/validate", json={"kind": "globalEvents", "draft": draft})
    assert resp.status_code == 200
    diagnostic = next(
        d for d in resp.json()["diagnostics"] if d["artifactKind"] == "globalEvents"
    )
    assert diagnostic["widgetId"] == "__events__"
    assert diagnostic["propKey"] == "onPageLoaded"
    assert diagnostic["fieldPath"][:2] == ["onPageLoaded", "0"]
    assert diagnostic["breadcrumb"].startswith("onPageLoaded")


def test_post_validate_component(client):
    draft = {
        "name": "Bad",
        "componentProperties": {},
        "children": [
            {
                "id": "label-1",
                "type": "Label",
                "properties": {"text": {"$var": {"path": "Missing:Value"}}},
            }
        ],
    }
    resp = client.post("/api/config/validate", json={"kind": "component", "draft": draft})
    assert resp.status_code == 200
    diagnostics = resp.json()["diagnostics"]
    assert any(
        d["artifactKind"] == "component" and d["widgetId"] == "label-1" and d["code"] == "var-unknown"
        for d in diagnostics
    )
    direct = next(d for d in diagnostics if d["code"] == "component-direct-binding")
    assert direct["sourcePath"] == "/children/0/properties/text/$var"
    assert direct["fieldPath"] == ["text", "$var"]


def test_post_validate_component_reports_recursive_direct_binding_sources(client):
    draft = {
        "name": "Bad",
        "componentProperties": {
            "settings": {
                "type": "struct",
                "label": "Settings",
                "defaultValue": {"rows": [{"$var": {"path": "PLC:Default"}}]},
            }
        },
        "children": [
            {
                "id": "label-1",
                "type": "Label",
                "properties": {
                    "text": {
                        "$if": {
                            "condition": {"$componentProp": "enabled"},
                            "true": {
                                "values": ["fixed", {"$var": {"path": "PLC:Nested"}}]
                            },
                            "false": {"$componentProp": "fallback"},
                        }
                    }
                },
            }
        ],
    }

    resp = client.post("/api/config/validate", json={"kind": "component", "draft": draft})

    assert resp.status_code == 200
    direct_paths = {
        d["sourcePath"]
        for d in resp.json()["diagnostics"]
        if d["code"] == "component-direct-binding"
    }
    assert direct_paths == {
        "/children/0/properties/text/$if/true/values/1/$var",
        "/componentProperties/settings/defaultValue/rows/0/$var",
    }


def test_component_diagnostics_unescape_json_pointer_segments_for_field_ownership(client):
    draft = {
        "name": "Escaped keys",
        "componentProperties": {
            "settings/~main": {
                "type": "struct",
                "label": "Settings",
                "defaultValue": {
                    "entries/~list": [{"$var": {"path": "PLC:Default"}}]
                },
            }
        },
        "children": [
            {
                "id": "label-1",
                "type": "Label",
                "properties": {
                    "label/~primary": {
                        "nested/~slot": {"$var": {"path": "PLC:Nested"}}
                    }
                },
            }
        ],
    }

    resp = client.post("/api/config/validate", json={"kind": "component", "draft": draft})

    assert resp.status_code == 200
    diagnostics = {
        diagnostic["sourcePath"]: diagnostic
        for diagnostic in resp.json()["diagnostics"]
        if diagnostic["code"] == "component-direct-binding"
    }
    child = diagnostics[
        "/children/0/properties/label~1~0primary/nested~1~0slot/$var"
    ]
    assert child["propKey"] == "label/~primary"
    assert child["fieldPath"] == ["label/~primary", "nested/~slot", "$var"]
    component_property = diagnostics[
        "/componentProperties/settings~1~0main/defaultValue/entries~1~0list/0/$var"
    ]
    assert component_property["propKey"] == "settings/~main"
    assert component_property["fieldPath"] == [
        "settings/~main",
        "defaultValue",
        "entries/~list",
        "0",
        "$var",
    ]


def test_post_validate_component_flags_component_props_the_runtime_cannot_keep_live(client):
    draft = {
        "name": "Stale",
        "componentProperties": {
            "status": {"type": "string", "label": "Status"},
            "tint": {"type": "color", "label": "Tint"},
            "fallback": {"type": "string", "label": "Fallback", "defaultValue": {"$componentProp": "status"}},
        },
        "children": [
            {
                "id": "card",
                "type": "Container",
                "layout": {"width": {"$componentProp": "status"}},
                "properties": {
                    "background": {
                        "$switch": {
                            "value": {"$componentProp": "status"},
                            "cases": [{"when": "warn", "then": "var(--hmi-warn-soft)"}],
                            "default": "var(--hmi-surface)",
                        }
                    },
                    "border": {"$componentProp": "tint"},
                },
                "children": [
                    {
                        "id": "label-1",
                        "type": "Label",
                        "properties": {"text": {"$componentProp": "status"}},
                    }
                ],
            }
        ],
    }

    resp = client.post("/api/config/validate", json={"kind": "component", "draft": draft})

    assert resp.status_code == 200
    nested = {
        d["sourcePath"]
        for d in resp.json()["diagnostics"]
        if d["code"] == "componentprop-nested"
    }
    # The two bare top-level uses (`border`, the nested Label's `text`) are the
    # shape that stays live and must not be flagged.
    assert nested == {
        "/children/0/properties/background/$switch/value/$componentProp",
        "/children/0/layout/width/$componentProp",
        "/componentProperties/fallback/defaultValue/$componentProp",
    }


def test_post_validate_component_keeps_nested_component_props_a_warning(client):
    draft = {
        "name": "Stale",
        "componentProperties": {"status": {"type": "string", "label": "Status"}},
        "children": [
            {
                "id": "label-1",
                "type": "Label",
                "properties": {
                    "text": {
                        "$if": {
                            "condition": {"$componentProp": "status"},
                            "true": "on",
                            "false": "off",
                        }
                    }
                },
            }
        ],
    }

    resp = client.post("/api/config/validate", json={"kind": "component", "draft": draft})

    diagnostic = next(
        d for d in resp.json()["diagnostics"] if d["code"] == "componentprop-nested"
    )
    assert diagnostic["severity"] == "warning"
    assert diagnostic["propKey"] == "text"


def _slot_property_draft(slot_names):
    """A definition declaring a `body` widgets property and the given slots."""
    return {
        "name": "Card",
        "componentProperties": {"body": {"type": "widgets", "label": "Body"}},
        "children": [
            {"id": f"slot-{s}", "type": "ComponentSlot", "properties": {"slot": s}}
            for s in slot_names
        ],
    }


def test_post_validate_component_flags_a_slot_property_no_slot_names(client):
    resp = client.post(
        "/api/config/validate",
        json={"kind": "component", "draft": _slot_property_draft(["header"])},
    )

    diagnostic = next(
        d for d in resp.json()["diagnostics"] if d["code"] == "slot-property-unmatched"
    )
    assert diagnostic["severity"] == "warning"
    assert diagnostic["sourcePath"] == "/componentProperties/body/type"


def test_post_validate_component_stays_quiet_once_a_slot_names_the_property(client):
    resp = client.post(
        "/api/config/validate",
        json={"kind": "component", "draft": _slot_property_draft(["body"])},
    )

    codes = {d["code"] for d in resp.json()["diagnostics"]}
    assert "slot-property-unmatched" not in codes


def test_post_validate_component_flags_a_slot_naming_no_property(client):
    """A slot is picked from the declared properties; one matching none of them
    is invisible to the caller's properties panel."""
    draft = {
        "name": "Card",
        "componentProperties": {},
        "children": [{"id": "slot-body", "type": "ComponentSlot", "properties": {"slot": "body"}}],
    }

    resp = client.post("/api/config/validate", json={"kind": "component", "draft": draft})

    diagnostic = next(d for d in resp.json()["diagnostics"] if d["code"] == "slot-undeclared")
    assert diagnostic["severity"] == "warning"
    assert diagnostic["sourcePath"] == "/children/0/properties/slot"


def test_post_validate_component_flags_a_slot_that_picked_nothing(client):
    """A blank slot falls back to `content`, which is a name like any other."""
    draft = {
        "name": "Card",
        "componentProperties": {},
        "children": [{"id": "slot-1", "type": "ComponentSlot", "properties": {}}],
    }

    resp = client.post("/api/config/validate", json={"kind": "component", "draft": draft})

    diagnostic = next(d for d in resp.json()["diagnostics"] if d["code"] == "slot-undeclared")
    assert "content" in diagnostic["message"]


def _write_card_component(project_dir, slots):
    """A Card definition declaring one ComponentSlot per name in `slots`."""
    import core.storage as storage
    from core.validation import structure

    components = project_dir / "components"
    components.mkdir(parents=True, exist_ok=True)
    storage.write_json(
        components / "card.json",
        {
            "name": "Card",
            "children": [
                {"id": f"slot-{s}", "type": "ComponentSlot", "properties": {"slot": s}}
                for s in slots
            ],
        },
    )
    structure._component_interface_cache = None


def _page_with_instance_children(children):
    return {
        "id": "p1",
        "title": "Page 1",
        "sections": {
            "content": [{"id": "card-1", "type": "$component:card", "children": children}]
        },
    }


def test_instance_child_naming_a_missing_slot_warns(client, tmp_dirs):
    """Dropping a slot from a definition must not silently strip the pages that
    filled it — the orphaned child still renders, in the first slot."""
    project_dir, _pages_dir = tmp_dirs
    _write_card_component(project_dir, ["header", "body"])
    page = _page_with_instance_children(
        [
            {"id": "a", "type": "Gauge", "slot": "header"},
            {"id": "b", "type": "Gauge", "slot": "sidebar"},
        ]
    )

    resp = client.post("/api/config/validate", json={"kind": "page", "draft": page})

    assert resp.status_code == 200
    unknown = [d for d in resp.json()["diagnostics"] if d["code"] == "slot-unknown"]
    assert len(unknown) == 1
    assert unknown[0]["severity"] == "warning"
    assert "'sidebar'" in unknown[0]["message"]


def test_untagged_instance_children_are_clean(client, tmp_dirs):
    """No tag means the first slot — the shape a single-slot component always has."""
    project_dir, _pages_dir = tmp_dirs
    _write_card_component(project_dir, ["body"])
    page = _page_with_instance_children([{"id": "a", "type": "Gauge"}])

    resp = client.post("/api/config/validate", json={"kind": "page", "draft": page})

    assert resp.status_code == 200
    assert not [d for d in resp.json()["diagnostics"] if d["code"].startswith("slot-")]


def test_children_on_a_slotless_component_warn(client, tmp_dirs):
    project_dir, _pages_dir = tmp_dirs
    _write_card_component(project_dir, [])
    page = _page_with_instance_children([{"id": "a", "type": "Gauge"}])

    resp = client.post("/api/config/validate", json={"kind": "page", "draft": page})

    assert resp.status_code == 200
    unknown = [d for d in resp.json()["diagnostics"] if d["code"] == "slot-unknown"]
    assert len(unknown) == 1
    assert "declares no slots" in unknown[0]["message"]


def test_post_validate_reports_a_page_field_naming_the_dialogs_folder(client, tmp_dirs):
    """Nothing routes to a Dialogs-folder page, so a widget field that navigates
    to one points at a screen the runtime never shows."""
    project_dir, _pages_dir = tmp_dirs
    storage.write_json(project_dir / "config.json", {
        "version": 2,
        "pages": [{"id": "home", "type": "page"}],
        "dialogs": [{"id": "motor-detail", "type": "page"}],
    })

    draft = {
        "id": "home",
        "sections": {
            "content": [
                {
                    "id": "crumbs",
                    "type": "Breadcrumb",
                    "properties": {"homePageId": {"$static": "motor-detail"}},
                }
            ]
        },
    }

    resp = client.post("/api/config/validate", json={"kind": "page", "draft": draft})

    assert resp.status_code == 200
    assert "page-not-navigable" in [d["code"] for d in resp.json()["diagnostics"]]


def test_post_validate_reports_a_menu_item_naming_the_dialogs_folder(client, tmp_dirs):
    project_dir, _pages_dir = tmp_dirs
    storage.write_json(project_dir / "config.json", {
        "version": 2,
        "pages": [{"id": "home", "type": "page"}],
        "dialogs": [{"id": "motor-detail", "type": "page"}],
    })

    draft = {
        "id": "home",
        "sections": {
            "content": [
                {
                    "id": "menu",
                    "type": "NavigationMenu",
                    "properties": {
                        "items": [
                            {"type": "page-link", "pageId": "motor-detail", "label": "Motor"}
                        ]
                    },
                }
            ]
        },
    }

    resp = client.post("/api/config/validate", json={"kind": "page", "draft": draft})

    assert resp.status_code == 200
    assert "page-not-navigable" in [d["code"] for d in resp.json()["diagnostics"]]


def test_post_validate_stays_silent_on_a_menu_item_naming_a_navigable_page(client, tmp_dirs):
    project_dir, _pages_dir = tmp_dirs
    storage.write_json(project_dir / "config.json", {
        "version": 2,
        "pages": [{"id": "home", "type": "page"}, {"id": "machine", "type": "page"}],
        "dialogs": [{"id": "motor-detail", "type": "page"}],
    })

    draft = {
        "id": "home",
        "sections": {
            "content": [
                {
                    "id": "menu",
                    "type": "NavigationMenu",
                    "properties": {
                        "items": [{"type": "page-link", "pageId": "machine", "label": "Machine"}]
                    },
                }
            ]
        },
    }

    resp = client.post("/api/config/validate", json={"kind": "page", "draft": draft})

    assert resp.status_code == 200
    assert "page-not-navigable" not in [d["code"] for d in resp.json()["diagnostics"]]
