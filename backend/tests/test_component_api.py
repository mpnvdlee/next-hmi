"""Tests for widget CRUD API and component_manager validation rules."""
from pathlib import Path

import api.component_api as component_api_module
import core.component_storage as component_storage_module
import core.storage as storage
import pytest
import services.component_manager as component_manager_module
from core.exceptions import register_exception_handlers
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def widget_client(monkeypatch, live_project_root: Path):
    storage.ensure_active_project_dirs()

    # Reset the singleton's internal state by using a fresh ComponentManager instance
    monkeypatch.setattr(
        component_manager_module,
        "component_manager",
        component_manager_module.ComponentManager(),
    )

    test_app = FastAPI()
    register_exception_handlers(test_app)
    test_app.include_router(component_api_module.router)
    with TestClient(test_app) as client:
        yield client


MINIMAL_WIDGET = {
    "name": "TestWidget",
    "componentProperties": {},
    "children": [],
}


# ── GET /api/components ──────────────────────────────────────────────────────────


def test_list_widgets_empty(widget_client):
    resp = widget_client.get("/api/components")
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_widgets_returns_created(widget_client):
    widget_client.post("/api/components", json=MINIMAL_WIDGET)
    resp = widget_client.get("/api/components")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["name"] == "TestWidget"


# ── POST /api/components ─────────────────────────────────────────────────────────


def test_create_widget_returns_definition(widget_client):
    resp = widget_client.post("/api/components", json=MINIMAL_WIDGET)
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "TestWidget"
    assert "id" in data
    assert data["children"] == []
    persisted = storage.read_json(storage.active_components_dir() / f"{data['id']}.json")
    assert "id" not in persisted
    assert "group" not in persisted
    assert "description" not in persisted
    assert "category" not in persisted
    assert "icon" not in persisted


def test_create_widget_generates_id_when_not_provided(widget_client):
    resp = widget_client.post("/api/components", json=MINIMAL_WIDGET)
    assert resp.status_code == 200
    assert len(resp.json()["id"]) > 0


def test_create_widget_persists_preview_dimensions(widget_client):
    resp = widget_client.post(
        "/api/components",
        json={**MINIMAL_WIDGET, "width": 640, "height": 480},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["width"] == 640
    assert data["height"] == 480

    fetched = widget_client.get(f"/api/components/{data['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["width"] == 640
    assert fetched.json()["height"] == 480


def test_create_widget_persists_drawer_metadata(widget_client):
    metadata = {
        "description": "Shows the current line throughput.",
        "category": "Process overview",
        "icon": {"type": "builtin", "name": "gauge"},
    }
    resp = widget_client.post(
        "/api/components",
        json={**MINIMAL_WIDGET, **metadata},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert {key: data[key] for key in metadata} == metadata

    fetched = widget_client.get(f"/api/components/{data['id']}")
    assert fetched.status_code == 200
    assert {key: fetched.json()[key] for key in metadata} == metadata


def test_component_manager_migrates_path_derived_identity_fields(widget_client):
    path = storage.active_components_dir() / "legacy.json"
    storage.write_json(
        path,
        {
            **MINIMAL_WIDGET,
            "id": "legacy",
            "group": "stale",
            "icon": {"type": "builtin", "name": "gauge"},
        },
    )

    component_manager_module.component_manager.load()

    persisted = storage.read_json(path)
    assert persisted["icon"] == {"type": "builtin", "name": "gauge"}
    assert "id" not in persisted
    assert "group" not in persisted
    fetched = widget_client.get("/api/components/legacy")
    assert fetched.status_code == 200
    assert fetched.json()["icon"] == {"type": "builtin", "name": "gauge"}


def test_component_manager_scans_invalid_binding_before_metadata_migration(
    widget_client, caplog,
):
    path = storage.active_components_dir() / "legacy-invalid.json"
    original = (
        b'{"id":"legacy-invalid","group":"stale","icon":"gauge",'
        b'"name":"Legacy invalid","componentProperties":{},"children":['
        b'{"type":"Label","properties":{"text":{"nested":'
        b'{"$var":{"path":"PLC:Value"}}}}}]}'
    )
    path.write_bytes(original)

    component_manager_module.component_manager.load()

    assert path.read_bytes() == original
    assert (
        "components/legacy-invalid.json#/children/0/properties/text/nested/$var"
        in caplog.text
    )


def test_component_manager_rejects_symlinked_components_root_without_external_read(
    widget_client, tmp_path: Path, caplog,
):
    components = storage.active_components_dir()
    components.rmdir()
    outside = tmp_path / "outside-components"
    outside.mkdir()
    external = outside / "legacy.json"
    original = b'{"id":"outside","name":"Outside","icon":"gauge","children":[]}'
    external.write_bytes(original)
    try:
        components.symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"directory symlinks unavailable: {exc}")

    component_manager_module.component_manager.load()

    assert external.read_bytes() == original
    assert (
        "components#/: component storage is a symlink or reparse point"
        in caplog.text
    )


def test_component_manager_rejects_symlinked_component_file_without_external_read(
    widget_client, tmp_path: Path, caplog,
):
    external = tmp_path / "outside-component.json"
    original = b'{"id":"outside","name":"Outside","icon":"gauge","children":[]}'
    external.write_bytes(original)
    linked = storage.active_components_dir() / "linked.json"
    try:
        linked.symlink_to(external)
    except OSError as exc:
        pytest.skip(f"file symlinks unavailable: {exc}")

    component_manager_module.component_manager.load()

    assert external.read_bytes() == original
    assert (
        "components/linked.json#/: component file is a symlink or reparse point"
        in caplog.text
    )


def test_component_metadata_migration_rejects_file_swapped_to_symlink_after_scan(
    widget_client, tmp_path: Path, caplog, monkeypatch,
):
    component = storage.active_components_dir() / "legacy.json"
    component.write_bytes(
        b'{"id":"legacy","name":"Legacy","icon":"gauge",'
        b'"componentProperties":{},"children":[]}'
    )
    external = tmp_path / "outside-component.json"
    original_external = (
        b'{"id":"outside","name":"Outside","icon":"external",'
        b'"componentProperties":{},"children":[]}'
    )
    external.write_bytes(original_external)
    swapped = False

    def swap_before_mutation(operation: str):
        nonlocal swapped
        if operation == "migrate" and not swapped:
            component.unlink()
            try:
                component.symlink_to(external)
            except OSError as exc:
                pytest.skip(f"file symlinks unavailable: {exc}")
            swapped = True

    monkeypatch.setattr(
        component_storage_module,
        "BOUND_MUTATION_HOOK",
        swap_before_mutation,
    )

    component_manager_module.component_manager.load()

    assert swapped
    assert component.is_symlink()
    assert external.read_bytes() == original_external
    assert "components/legacy.json#/: component file changed after scan" in caplog.text


@pytest.mark.parametrize(
    "operation_family",
    ["create", "update", "delete", "create_folder", "delete_folder", "migrate"],
)
def test_component_mutations_stay_bound_when_root_is_swapped_after_validation(
    widget_client,
    tmp_path: Path,
    monkeypatch,
    operation_family: str,
):
    components = storage.active_components_dir()
    component_id: str | None = None
    if operation_family in {"update", "delete"}:
        component_id = widget_client.post("/api/components", json=MINIMAL_WIDGET).json()["id"]
    elif operation_family == "delete_folder":
        widget_client.post("/api/components/folders", json={"name": "Victim"})
    elif operation_family == "migrate":
        (components / "legacy.json").write_text(
            '{"id":"legacy","name":"Legacy","icon":{"type":"builtin","name":"gauge"},'
            '"componentProperties":{},"children":[]}'
        )

    outside = tmp_path / f"outside-{operation_family}"
    outside.mkdir()
    marker = outside / "marker.json"
    marker_bytes = b'{"external":true}'
    marker.write_bytes(marker_bytes)
    bound = components.with_name(f"components-bound-{operation_family}")
    swapped = False

    def swap_root(operation: str) -> None:
        nonlocal swapped
        if operation != operation_family or swapped:
            return
        components.rename(bound)
        try:
            components.symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            pytest.skip(f"directory symlinks unavailable: {exc}")
        swapped = True

    monkeypatch.setattr(component_storage_module, "BOUND_MUTATION_HOOK", swap_root)

    if operation_family == "create":
        response = widget_client.post("/api/components", json=MINIMAL_WIDGET)
        assert response.status_code == 200
        assert (bound / f"{response.json()['id']}.json").is_file()
    elif operation_family == "update":
        response = widget_client.put(
            f"/api/components/{component_id}",
            json={**MINIMAL_WIDGET, "name": "Updated"},
        )
        assert response.status_code == 200
        assert storage.read_json(bound / f"{component_id}.json")["name"] == "Updated"
    elif operation_family == "delete":
        response = widget_client.delete(f"/api/components/{component_id}")
        assert response.status_code == 200
        assert not (bound / f"{component_id}.json").exists()
    elif operation_family == "create_folder":
        response = widget_client.post("/api/components/folders", json={"name": "Created"})
        assert response.status_code == 200
        assert (bound / "Created").is_dir()
    elif operation_family == "delete_folder":
        response = widget_client.delete("/api/components/folders/Victim")
        assert response.status_code == 200
        assert not (bound / "Victim").exists()
    else:
        component_manager_module.component_manager.load()
        migrated = storage.read_json(bound / "legacy.json")
        assert "id" not in migrated
        assert migrated["icon"] == {"type": "builtin", "name": "gauge"}

    assert swapped
    assert marker.read_bytes() == marker_bytes
    assert set(outside.iterdir()) == {marker}


def test_component_create_stays_bound_when_group_is_swapped_after_validation(
    widget_client, tmp_path: Path, monkeypatch,
):
    widget_client.post("/api/components/folders", json={"name": "Group"})
    group = storage.active_components_dir() / "Group"
    bound = storage.active_components_dir() / "Group-bound"
    outside = tmp_path / "outside-group"
    outside.mkdir()
    marker = outside / "marker.json"
    marker.write_bytes(b'{"external":true}')

    def swap_group(operation: str) -> None:
        if operation != "create" or group.is_symlink():
            return
        group.rename(bound)
        try:
            group.symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            pytest.skip(f"directory symlinks unavailable: {exc}")

    monkeypatch.setattr(component_storage_module, "BOUND_MUTATION_HOOK", swap_group)

    response = widget_client.post(
        "/api/components", json={**MINIMAL_WIDGET, "group": "Group"}
    )

    assert response.status_code == 200
    assert (bound / f"{response.json()['id']}.json").is_file()
    assert marker.read_bytes() == b'{"external":true}'
    assert set(outside.iterdir()) == {marker}


def test_windows_directory_open_omits_file_share_delete(tmp_path: Path):
    api = object.__new__(component_storage_module._WindowsApi)
    calls: list[tuple] = []
    api._invalid = -1
    api._create = lambda *args: calls.append(args) or 123

    assert api.open_directory(tmp_path) == 123
    share_mode = calls[0][2]
    flags = calls[0][5]
    assert share_mode == api.FILE_SHARE_READ | api.FILE_SHARE_WRITE
    assert share_mode & 0x00000004 == 0
    assert flags & api.FILE_FLAG_OPEN_REPARSE_POINT
    assert flags & api.FILE_FLAG_BACKUP_SEMANTICS


def test_windows_directory_pin_retains_and_closes_handle(tmp_path: Path):
    directory = tmp_path / "pinned"
    directory.mkdir()
    identity = component_storage_module._directory_identity(directory.lstat())

    class FakeWindowsApi:
        def __init__(self):
            self.closed: list[int] = []

        def open_directory(self, path: Path) -> int:
            assert path == directory
            return 77

        def directory_info(self, handle: int):
            assert handle == 77
            return False, (9, 11)

        def close(self, handle: int) -> None:
            self.closed.append(handle)

    api = FakeWindowsApi()
    pin = component_storage_module._WindowsDirectoryPin(directory, identity, api)

    pin.open()
    pin.verify()
    assert pin.handle == 77
    pin.close()

    assert api.closed == [77]
    assert pin.handle is None


def test_windows_handle_delete_uses_extended_disposition_flags():
    api = object.__new__(component_storage_module._WindowsApi)
    calls: list[tuple[int, object]] = []

    class Extended:
        Flags = 0

    class Fallback:
        DeleteFile = False

    class FakeCtypes:
        @staticmethod
        def byref(value):
            return value

        @staticmethod
        def sizeof(value):
            return 4

        @staticmethod
        def get_last_error():
            return 0

    api._ctypes = FakeCtypes()
    api._disposition_ex_type = Extended
    api._disposition_type = Fallback
    api._set_info = lambda handle, info_class, value, size: (
        calls.append((info_class, value)) or True
    )

    api.mark_delete(42)

    assert calls[0][0] == api.FILE_DISPOSITION_INFO_EX
    assert calls[0][1].Flags == (
        api.FILE_DISPOSITION_DELETE
        | api.FILE_DISPOSITION_POSIX_SEMANTICS
        | api.FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE
    )


def test_windows_handle_delete_falls_back_when_extended_disposition_is_unavailable():
    api = object.__new__(component_storage_module._WindowsApi)
    calls: list[tuple[int, object]] = []
    results = iter([False, True])

    class Extended:
        Flags = 0

    class Fallback:
        DeleteFile = False

    class FakeCtypes:
        @staticmethod
        def byref(value):
            return value

        @staticmethod
        def sizeof(value):
            return 4

        @staticmethod
        def get_last_error():
            return 87

    api._ctypes = FakeCtypes()
    api._disposition_ex_type = Extended
    api._disposition_type = Fallback
    api._set_info = lambda handle, info_class, value, size: (
        calls.append((info_class, value)) or next(results)
    )

    api.mark_delete(42)

    assert [info_class for info_class, _value in calls] == [
        api.FILE_DISPOSITION_INFO_EX,
        api.FILE_DISPOSITION_INFO,
    ]
    assert calls[1][1].DeleteFile is True


def test_windows_handle_delete_closes_on_failure(tmp_path: Path):
    target = tmp_path / "target.json"
    target.write_text("{}")

    class FakeDeleteApi:
        def __init__(self):
            self.closed: list[int] = []

        def open_for_delete(self, path: Path, *, directory: bool) -> int:
            assert path == target
            assert directory is False
            return 91

        def directory_info(self, handle: int):
            assert handle == 91
            return False, (3, 4)

        def mark_delete(self, handle: int) -> None:
            raise OSError("unsupported")

        def close(self, handle: int) -> None:
            self.closed.append(handle)

    storage_bound = object.__new__(component_storage_module._WindowsBoundStorage)
    storage_bound.project_root = tmp_path
    storage_bound.scan = component_storage_module.ProjectComponentScan(None, (), (), ())
    storage_bound.identities = {}
    storage_bound.root_pin = None
    api = FakeDeleteApi()
    storage_bound.api = api

    with pytest.raises(
        component_storage_module.ComponentScanError,
        match="secure handle-based component deletion is unsupported",
    ):
        storage_bound._delete_tree_by_handle(target, "components/target.json")

    assert api.closed == [91]
    assert target.read_text() == "{}"


def test_create_widget_rejects_legacy_string_icon(widget_client):
    resp = widget_client.post(
        "/api/components",
        json={**MINIMAL_WIDGET, "icon": "gauge"},
    )
    assert resp.status_code == 422


def test_create_widget_rejects_non_positive_preview_dimensions(widget_client):
    resp = widget_client.post("/api/components", json={**MINIMAL_WIDGET, "width": 0})
    assert resp.status_code == 422


def test_create_widget_rejects_duplicate_name(widget_client):
    widget_client.post("/api/components", json=MINIMAL_WIDGET)
    resp = widget_client.post("/api/components", json=MINIMAL_WIDGET)
    assert resp.status_code == 409
    assert "already used" in resp.json()["detail"]


def test_create_widget_rejects_var_binding_in_children(widget_client):
    body = {
        "name": "BadWidget",
        "componentProperties": {},
        "children": [
            {
                "id": "comp1",
                "type": "Label",
                "properties": {"text": {"$var": {"path": "DS:val"}}},
                "children": [],
            }
        ],
    }
    resp = widget_client.post("/api/components", json=body)
    assert resp.status_code == 422
    assert "/children/0/properties/text/$var" in resp.json()["detail"]


@pytest.mark.parametrize(
    ("value", "expected_path"),
    [
        (
            {"style": {"foreground": {"$var": {"path": "DS:colour"}}}},
            "/children/0/properties/value/style/foreground/$var",
        ),
        (
            {"items": [{"label": "fixed"}, {"$var": {"path": "DS:item"}}]},
            "/children/0/properties/value/items/1/$var",
        ),
        (
            {
                "$if": {
                    "condition": {"$componentProp": "enabled"},
                    "true": {"$static": "ready"},
                    "false": {
                        "$switch": {
                            "value": {"$componentProp": "mode"},
                            "cases": [
                                {
                                    "when": "fault",
                                    "value": {"$var": {"path": "DS:fault"}},
                                }
                            ],
                        }
                    },
                }
            },
            "/children/0/properties/value/$if/false/$switch/cases/0/value/$var",
        ),
    ],
    ids=["nested-object", "nested-list", "mixed-wrappers"],
)
def test_create_widget_rejects_recursive_var_sources(widget_client, value, expected_path):
    body = {
        "name": "BadRecursiveWidget",
        "componentProperties": {},
        "children": [{"type": "Label", "properties": {"value": value}}],
    }

    resp = widget_client.post("/api/components", json=body)

    assert resp.status_code == 422
    assert expected_path in resp.json()["detail"]


def test_create_widget_rejects_recursive_var_in_component_property_default(widget_client):
    body = {
        "name": "BadDefaultWidget",
        "componentProperties": {
            "limits/main": {
                "type": "struct",
                "label": "Limits",
                "defaultValue": {"entries": [{"value": {"$var": {"path": "DS:limit"}}}]},
            }
        },
        "children": [],
    }

    resp = widget_client.post("/api/components", json=body)

    assert resp.status_code == 422
    assert (
        "/componentProperties/limits~1main/defaultValue/entries/0/value/$var"
        in resp.json()["detail"]
    )


def test_create_widget_reports_nested_var_binding_path(widget_client):
    body = {
        "name": "BadNestedWidget",
        "componentProperties": {},
        "children": [
            {
                "type": "Container",
                "properties": {},
                "children": [
                    {
                        "type": "Label",
                        "properties": {"text": {"$var": {"path": "DS:val"}}},
                        "children": [],
                    }
                ],
            }
        ],
    }

    resp = widget_client.post("/api/components", json=body)

    assert resp.status_code == 422
    assert "/children/0/children/0/properties/text/$var" in resp.json()["detail"]


def test_get_widget_rejects_persisted_recursive_var_without_mutating_file(widget_client):
    path = storage.active_components_dir() / "invalid.json"
    persisted = {
        **MINIMAL_WIDGET,
        "children": [
            {
                "type": "Label",
                "properties": {"text": {"parts": [{"$var": {"path": "DS:value"}}]}},
            }
        ],
    }
    storage.write_json(path, persisted)

    resp = widget_client.get("/api/components/invalid")

    assert resp.status_code == 422
    assert "/children/0/properties/text/parts/0/$var" in resp.json()["detail"]
    assert storage.read_json(path) == persisted


def test_create_widget_rejects_nested_widget_children(widget_client):
    # First create a valid widget to reference
    widget_client.post("/api/components", json=MINIMAL_WIDGET)
    body = {
        "name": "NestedWidget",
        "componentProperties": {},
        "children": [
            {
                "id": "inner",
                "type": "$component:some-id",
                "properties": {},
                "children": [],
            }
        ],
    }
    resp = widget_client.post("/api/components", json=body)
    assert resp.status_code == 422
    assert "cannot be nested" in resp.json()["detail"]


# ── GET /api/components/{id} ─────────────────────────────────────────────────────


def test_get_widget_returns_definition(widget_client):
    created = widget_client.post("/api/components", json=MINIMAL_WIDGET).json()
    resp = widget_client.get(f"/api/components/{created['id']}")
    assert resp.status_code == 200
    assert resp.json()["id"] == created["id"]


def test_get_widget_not_found(widget_client):
    resp = widget_client.get("/api/components/does-not-exist")
    assert resp.status_code == 404


# ── PUT /api/components/{id} ─────────────────────────────────────────────────────


def test_update_widget_replaces_definition(widget_client):
    created = widget_client.post("/api/components", json=MINIMAL_WIDGET).json()
    updated_body = {**MINIMAL_WIDGET, "id": created["id"], "name": "RenamedWidget"}
    resp = widget_client.put(f"/api/components/{created['id']}", json=updated_body)
    assert resp.status_code == 200
    assert resp.json()["name"] == "RenamedWidget"
    assert resp.json()["id"] == created["id"]


def test_update_widget_not_found(widget_client):
    body = {**MINIMAL_WIDGET, "id": "ghost-id"}
    resp = widget_client.put("/api/components/ghost-id", json=body)
    assert resp.status_code == 404


def test_update_widget_rejects_name_conflict_with_other(widget_client):
    widget_client.post("/api/components", json=MINIMAL_WIDGET)
    w2 = widget_client.post("/api/components", json={**MINIMAL_WIDGET, "name": "Second"}).json()
    # Try to rename w2 to w1's name
    resp = widget_client.put(f"/api/components/{w2['id']}", json={**MINIMAL_WIDGET, "name": "TestWidget"})
    assert resp.status_code == 409


def test_update_widget_allows_same_name_for_self(widget_client):
    created = widget_client.post("/api/components", json=MINIMAL_WIDGET).json()
    resp = widget_client.put(f"/api/components/{created['id']}", json={**MINIMAL_WIDGET, "name": "TestWidget"})
    assert resp.status_code == 200


# ── DELETE /api/components/{id} ──────────────────────────────────────────────────


def test_delete_widget_removes_it(widget_client):
    created = widget_client.post("/api/components", json=MINIMAL_WIDGET).json()
    resp = widget_client.delete(f"/api/components/{created['id']}")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    assert widget_client.get(f"/api/components/{created['id']}").status_code == 404


def test_delete_widget_not_found(widget_client):
    resp = widget_client.delete("/api/components/does-not-exist")
    assert resp.status_code == 404


# ── Folders ──────────────────────────────────────────────────────────────────


def test_folders_empty(widget_client):
    resp = widget_client.get("/api/components/folders")
    assert resp.status_code == 200
    assert resp.json() == []


def test_create_folder_appears_in_list(widget_client):
    resp = widget_client.post("/api/components/folders", json={"name": "Widgets"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Widgets"
    assert widget_client.get("/api/components/folders").json() == ["Widgets"]


def test_create_folder_rejects_duplicate(widget_client):
    widget_client.post("/api/components/folders", json={"name": "Widgets"})
    resp = widget_client.post("/api/components/folders", json={"name": "Widgets"})
    assert resp.status_code == 409


def test_create_folder_rejects_invalid_name(widget_client):
    resp = widget_client.post("/api/components/folders", json={"name": "bad*name"})
    assert resp.status_code == 422


def test_create_folder_rejects_path_traversal(widget_client):
    resp = widget_client.post("/api/components/folders", json={"name": "A/../B"})
    assert resp.status_code == 422


def test_create_folder_rejects_empty_segment(widget_client):
    resp = widget_client.post("/api/components/folders", json={"name": "A//B"})
    assert resp.status_code == 422


def test_create_folder_rejects_whitespace_only_name(widget_client):
    resp = widget_client.post("/api/components/folders", json={"name": "   "})
    assert resp.status_code == 422


def test_create_folder_trims_surrounding_whitespace(widget_client):
    resp = widget_client.post("/api/components/folders", json={"name": "  Widgets  "})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Widgets"
    assert widget_client.get("/api/components/folders").json() == ["Widgets"]


def test_create_component_in_group_reports_group(widget_client):
    widget_client.post("/api/components/folders", json={"name": "Gauges"})
    created = widget_client.post(
        "/api/components", json={**MINIMAL_WIDGET, "group": "Gauges"}
    ).json()
    assert created["group"] == "Gauges"
    fetched = widget_client.get(f"/api/components/{created['id']}").json()
    assert fetched["group"] == "Gauges"
    listed = widget_client.get("/api/components").json()
    assert listed[0]["group"] == "Gauges"
    stored = storage.read_json(storage.active_components_dir() / "Gauges" / f"{created['id']}.json")
    assert "id" not in stored
    assert "group" not in stored


def test_create_nested_folder_appears_in_list(widget_client):
    resp = widget_client.post("/api/components/folders", json={"name": "A/B"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "A/B"
    # Intermediate folder "A" is created on disk and shows up too.
    assert widget_client.get("/api/components/folders").json() == ["A", "A/B"]


def test_create_deeply_nested_folder(widget_client):
    resp = widget_client.post("/api/components/folders", json={"name": "A/B/C/D"})
    assert resp.status_code == 200
    assert widget_client.get("/api/components/folders").json() == ["A", "A/B", "A/B/C", "A/B/C/D"]


def test_create_component_in_nested_group_reports_group(widget_client):
    widget_client.post("/api/components/folders", json={"name": "A/B"})
    created = widget_client.post(
        "/api/components", json={**MINIMAL_WIDGET, "group": "A/B"}
    ).json()
    assert created["group"] == "A/B"
    fetched = widget_client.get(f"/api/components/{created['id']}").json()
    assert fetched["group"] == "A/B"
    listed = widget_client.get("/api/components").json()
    assert listed[0]["group"] == "A/B"


def test_delete_empty_folder(widget_client):
    widget_client.post("/api/components/folders", json={"name": "Widgets"})
    resp = widget_client.delete("/api/components/folders/Widgets")
    assert resp.status_code == 200
    assert widget_client.get("/api/components/folders").json() == []


def test_delete_folder_not_found(widget_client):
    resp = widget_client.delete("/api/components/folders/DoesNotExist")
    assert resp.status_code == 404


def test_delete_folder_removes_its_components(widget_client):
    widget_client.post("/api/components/folders", json={"name": "Gauges"})
    created = widget_client.post(
        "/api/components", json={**MINIMAL_WIDGET, "group": "Gauges"}
    ).json()
    resp = widget_client.delete("/api/components/folders/Gauges")
    assert resp.status_code == 200
    assert widget_client.get(f"/api/components/{created['id']}").status_code == 404
    assert widget_client.get("/api/components").json() == []


def test_delete_nested_folder_removes_subfolders_and_components(widget_client):
    widget_client.post("/api/components/folders", json={"name": "A/B"})
    created = widget_client.post(
        "/api/components", json={**MINIMAL_WIDGET, "group": "A/B"}
    ).json()
    resp = widget_client.delete("/api/components/folders/A")
    assert resp.status_code == 200
    assert widget_client.get("/api/components/folders").json() == []
    assert widget_client.get(f"/api/components/{created['id']}").status_code == 404


def test_delete_subfolder_leaves_parent_and_siblings_intact(widget_client):
    widget_client.post("/api/components/folders", json={"name": "A/B"})
    widget_client.post("/api/components/folders", json={"name": "A/C"})
    resp = widget_client.delete("/api/components/folders/A/B")
    assert resp.status_code == 200
    assert widget_client.get("/api/components/folders").json() == ["A", "A/C"]


def test_update_component_moves_between_groups(widget_client):
    created = widget_client.post("/api/components", json=MINIMAL_WIDGET).json()
    assert created["group"] is None
    moved = widget_client.put(
        f"/api/components/{created['id']}",
        json={**MINIMAL_WIDGET, "id": created["id"], "group": "Gauges"},
    ).json()
    assert moved["group"] == "Gauges"
    # No stale copy left behind at the old (flat) location.
    listed = widget_client.get("/api/components").json()
    assert len(listed) == 1
    assert listed[0]["group"] == "Gauges"


def test_component_property_accepts_a_description(tmp_path):
    """The frontend's SchemaField has always allowed `description`; the model
    rejecting it took the whole definition down rather than one field."""
    from models.component import ComponentDefinition

    definition = ComponentDefinition(
        name="Card",
        componentProperties={
            "title": {"type": "string", "label": "Title", "description": "Shown in the header."},
        },
        children=[],
    )
    assert definition.componentProperties["title"].description == "Shown in the header."


def test_component_property_description_defaults_to_none():
    from models.component import ComponentDefinition

    definition = ComponentDefinition(
        name="Card",
        componentProperties={"title": {"type": "string", "label": "Title"}},
        children=[],
    )
    assert definition.componentProperties["title"].description is None
