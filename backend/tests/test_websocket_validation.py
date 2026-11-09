import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import core.storage as storage_module
import pytest
import services.websocket_manager as websocket_manager_module
from conftest import (
    FakeDatasourceEntry,
    FakeDatasourceManager,
    FakeEngine,
    FakePool,
    FakeWebSocket,
)
from services.datasource_manager import DatasourceManager
from services.websocket_manager import (
    MAX_EXTRACT_BINDING_DEPTH,
    WebSocketManager,
    _collect_context_composite_keys,
    _extract_variable_keys_from_value,
    _parse_write_field_request,
    _resolve_current_page_ids,
)


def test_resolve_current_page_ids_returns_unified_payload() -> None:
    msg = {"currentPageIds": ["main", "overlay-a"]}
    assert _resolve_current_page_ids(msg) == ["main", "overlay-a"]


def test_parse_write_field_request_returns_none_for_missing_values() -> None:
    assert _parse_write_field_request({"datasource": "A", "path": "B"}) is None


@pytest.mark.parametrize(
    "message",
    [
        {"datasource": "", "path": "B", "value": 1},
        {"datasource": " A", "path": "B", "value": 1},
        {"datasource": 1, "path": "B", "value": 1},
        {"datasource": "A", "path": [], "value": 1},
        {"datasource": "A", "path": " ", "value": 1},
        {"datasource": "A", "path": "B", "field": 3, "value": 1},
    ],
)
def test_parse_write_field_request_rejects_malformed_envelope(message) -> None:
    assert _parse_write_field_request(message) is None


def test_parse_write_field_request_preserves_present_null() -> None:
    assert _parse_write_field_request({"datasource": "A", "path": "B", "value": None}) == (
        "A",
        "B",
        None,
        None,
    )


def test_parse_write_field_request_extracts_expected_tuple() -> None:
    msg = {"datasource": "DS", "path": "Motor/Speed", "field": "fValue", "value": 12}
    assert _parse_write_field_request(msg) == ("DS", "Motor/Speed", "fValue", 12)


def test_handle_set_context_prefetches_uncached_values(monkeypatch) -> None:
    manager = WebSocketManager()
    datasource_manager = FakeDatasourceManager()
    engine = FakeEngine()
    manager.set_datasource_manager(datasource_manager)
    manager.set_opcua_pool(FakePool(engine))

    ws = FakeWebSocket()
    manager._connections["client-1"] = ws  # type: ignore[attr-defined]

    monkeypatch.setattr(
        websocket_manager_module,
        "_resolve_context_composite_keys",
        lambda **_kwargs: {"DS:Cached", "DS:Fresh"},
    )

    async def _run() -> None:
        await manager._handle_set_context("client-1", {"currentPageIds": ["main"]})
        await manager._priority_recompute_task
        for _ in range(10):
            if len(ws.messages) >= 3:
                break
            await asyncio.sleep(0.01)

    asyncio.run(_run())

    assert ws.messages == [
        {"type": "var_metadata", "meta": {}},
        {"type": "var_update", "values": {"DS:Cached": 1}},
        {"type": "var_update", "values": {"DS:Fresh": 2}},
        {"type": "context_ready", "currentPageIds": ["main"]},
    ]
    assert datasource_manager.seeded == {"DS:Fresh": 2}
    assert engine.priority_paths == [{"Cached", "Fresh"}]


def test_handle_set_context_sends_ready_immediately_when_fully_cached(monkeypatch) -> None:
    manager = WebSocketManager()
    datasource_manager = FakeDatasourceManager()
    manager.set_datasource_manager(datasource_manager)
    manager.set_opcua_pool(FakePool(FakeEngine()))

    ws = FakeWebSocket()
    manager._connections["client-1"] = ws  # type: ignore[attr-defined]

    monkeypatch.setattr(
        websocket_manager_module,
        "_resolve_context_composite_keys",
        lambda **_kwargs: {"DS:Cached"},
    )

    async def _run() -> None:
        await manager._handle_set_context("client-1", {"currentPageIds": ["main"]})
        await manager._priority_recompute_task

    asyncio.run(_run())

    assert ws.messages == [
        {"type": "var_metadata", "meta": {}},
        {"type": "var_update", "values": {"DS:Cached": 1}},
        {"type": "context_ready", "currentPageIds": ["main"]},
    ]


def test_set_context_never_hands_out_a_disabled_variable() -> None:
    # Any client may name any key in priorityKeys, a browsed tag nobody enabled
    # included; even a cached value of one must not come back.
    datasource_manager = DatasourceManager()
    datasource_manager.apply_config("PLC", {
        "name": "PLC",
        "type": "opcua-client",
        "variables": [{"kind": "folder", "name": "Line", "children": [
            {"kind": "variable", "display_name": "Speed", "data_type": "Float",
             "node_id": "ns=2;s=Speed", "enabled": True},
            {"kind": "variable", "display_name": "SafetyLimit", "data_type": "Float",
             "node_id": "ns=2;s=Limit", "enabled": False},
        ]}],
    })
    datasource_manager.seed_cached_values({"PLC:Line/Speed": 5.0, "PLC:Line/SafetyLimit": 999.0})
    manager = WebSocketManager()
    manager.set_datasource_manager(datasource_manager)
    manager.set_opcua_pool(FakePool(FakeEngine()))
    ws = FakeWebSocket()
    manager._connections["c1"] = ws  # type: ignore[attr-defined]

    async def _run() -> None:
        await manager.handle_message("c1", json.dumps({
            "type": "set_context",
            "currentPageIds": [],
            "priorityKeys": ["PLC:Line/Speed", "PLC:Line/SafetyLimit"],
        }))
        for _ in range(10):
            if any(m["type"] == "context_ready" for m in ws.messages):
                break
            await asyncio.sleep(0.01)

    asyncio.run(_run())

    metadata, *rest = ws.messages
    assert metadata["type"] == "var_metadata"
    assert "PLC:Line/SafetyLimit" not in metadata["meta"]
    assert rest == [
        {"type": "var_update", "values": {"PLC:Line/Speed": 5.0}},
        {"type": "context_ready", "currentPageIds": []},
    ]


def test_priority_batch_delay_uses_datasource_setting() -> None:
    manager = WebSocketManager()
    manager.set_datasource_manager(FakeDatasourceManager())

    assert manager._priority_batch_delay_ms_for_key("DS:Cached") == 7


def test_priority_batch_delay_follows_an_edited_datasource() -> None:
    datasource_manager = FakeDatasourceManager()
    manager = WebSocketManager()
    manager.set_datasource_manager(datasource_manager)
    assert manager._priority_batch_delay_ms_for_key("DS:Cached") == 7

    datasource_manager.datasources["DS"] = FakeDatasourceEntry(
        config={"settings": {"priority_ws_batch_ms": 25}}
    )

    assert manager._priority_batch_delay_ms_for_key("DS:Cached") == 25


def test_extract_variable_keys_handles_nested_if() -> None:
    keys: set[str] = set()
    payload = {
        "$if": {
            "condition": {"$var": {"path": "DS:Cond"}},
            "true": {"$var": {"path": "DS:TrueBranch"}},
            "false": {"$var": {"path": "DS:FalseBranch"}},
        }
    }

    _extract_variable_keys_from_value(payload, keys)

    assert keys == {"DS:Cond", "DS:TrueBranch", "DS:FalseBranch"}


def test_extract_variable_keys_handles_string_wildcards_switch_when_and_plain_records() -> None:
    keys: set[str] = set()
    payload = {
        "$stringExpr": {
            "template": "{1}",
            "wildcards": {"1": {"$var": {"path": "DS:Wildcard"}}},
        },
        "nested": {
            "$switch": {
                "value": {"$var": {"path": "DS:Mode"}},
                "cases": [{
                    "when": {"$var": {"path": "DS:ExpectedMode"}},
                    "then": {"action": {"$var": {"path": "DS:ActionPayload"}}},
                }],
                "default": None,
            },
        },
    }

    _extract_variable_keys_from_value(payload, keys)

    assert keys == {"DS:Wildcard", "DS:Mode", "DS:ExpectedMode", "DS:ActionPayload"}


def test_extract_variable_keys_walks_and_or_items() -> None:
    keys: set[str] = set()
    payload = {"$and": [
        {"$var": {"path": "DS:Ready"}},
        {"$or": [{"$not": {"value": {"$var": {"path": "DS:Fault"}}}}, True]},
    ]}

    _extract_variable_keys_from_value(payload, keys)

    assert keys == {"DS:Ready", "DS:Fault"}


def test_extract_variable_keys_follows_a_bound_index() -> None:
    keys: set[str] = set()
    payload = {"$var": {"path": "DS:Open", "index": {"$var": {"path": "DS:Selected"}}}}

    _extract_variable_keys_from_value(payload, keys)

    assert keys == {"DS:Open", "DS:Selected"}


def test_context_keys_record_how_an_array_is_addressed() -> None:
    keys = websocket_manager_module.ContextKeys()
    _extract_variable_keys_from_value({"$var": {"path": "DS:Motors", "index": 3}}, keys)
    _extract_variable_keys_from_value({"$var": {"path": "DS:Motors", "index": 7}}, keys)
    _extract_variable_keys_from_value({"$var": {"path": "DS:Pumps", "repeatIndex": True}}, keys)
    _extract_variable_keys_from_value({"$var": {"path": "DS:Valves", "index": {"$var": {"path": "DS:Sel"}}}}, keys)

    assert keys == {"DS:Motors", "DS:Pumps", "DS:Valves", "DS:Sel"}
    assert keys.index_refs == {"DS:Motors": {3, 7}, "DS:Pumps": {None}, "DS:Valves": {None}, "DS:Sel": {None}}


def test_promotion_keys_promote_only_the_literally_indexed_elements() -> None:
    from services.datasource_manager import DatasourceEntry, DatasourceManager

    def element(i: int) -> dict:
        return {"kind": "folder", "name": f"Motors[{i}]", "children": [
            {"kind": "variable", "display_name": "Speed", "node_id": f"ns=2;s=M{i}", "data_type": "Float", "enabled": True},
        ]}

    dm = DatasourceManager()
    dm.datasources["DS"] = DatasourceEntry({"name": "DS", "type": "opcua-client", "variables": [
        {"kind": "folder", "name": "Motors", "is_array": True, "children": [element(i) for i in range(5)]},
        {"kind": "folder", "name": "Pumps", "is_array": True, "children": [element(i) for i in range(2)]},
    ]})
    keys = websocket_manager_module.ContextKeys({"DS:Motors", "DS:Pumps", "DS:Plain"})
    keys.index_refs = {"DS:Motors": {1, 3, 99}, "DS:Pumps": {0, None}}

    promoted = websocket_manager_module._promotion_keys(keys, dm)

    # Motors: two bound elements instead of the whole array (99 is out of range);
    # Pumps: also bound whole somewhere, so it stays whole; Plain is untouched.
    assert promoted == {"DS:Motors/Motors[1]", "DS:Motors/Motors[3]", "DS:Pumps", "DS:Plain"}
    # A plain set (an explicit priorityKeys context) is promoted as is.
    assert websocket_manager_module._promotion_keys({"DS:Motors"}, dm) == {"DS:Motors"}


def test_extract_variable_keys_stops_at_depth_limit() -> None:
    keys: set[str] = set()
    nested: dict[str, object] = {"$var": {"path": "DS:Deep"}}

    for _ in range(MAX_EXTRACT_BINDING_DEPTH + 10):
        nested = {"$if": {"condition": nested, "true": None, "false": None}}

    _extract_variable_keys_from_value(nested, keys)

    assert "DS:Deep" not in keys


def test_broadcast_var_metadata_sends_each_client_its_own_context() -> None:
    manager = WebSocketManager()
    manager.set_datasource_manager(
        FakeDatasourceManager(metadata={"DS:A": {"type": "a"}, "DS:B": {"type": "b"}})
    )
    on_a, idle = FakeWebSocket(), FakeWebSocket()
    manager._connections = {"a": on_a, "idle": idle}  # type: ignore[assignment]
    manager._client_keys = {"a": {"DS:A"}}

    asyncio.run(manager.broadcast_var_metadata())

    assert on_a.messages == [{"type": "var_metadata", "meta": {"DS:A": {"type": "a"}}}]
    # A client with no context gets the (authoritative) empty map.
    assert idle.messages == [{"type": "var_metadata", "meta": {}}]


# ── v2 split-page storage tests ───────────────────────────────────────────────


def test_collect_context_keys_v2_page_loads_from_file(monkeypatch, tmp_path) -> None:
    """v2 format: page component tree lives in a per-page file; fast subscription must
    still resolve variable keys for the active page."""
    pages_dir = tmp_path / "pages"
    pages_dir.mkdir()
    page_id = "page-abc"

    (pages_dir / f"{page_id}.json").write_text(json.dumps({
        "id": page_id,
        "sections": {
            "header": [{
                "id": "title",
                "type": "Label",
                "properties": {"value": {"$var": {"path": "DS:Motor/Name"}}},
            }],
            "content": [{
                "id": "btn-1",
                "type": "Button",
                "properties": {
                    "variable": {"$var": {"path": "DS:Motor/Speed"}},
                },
            }],
        },
    }))

    monkeypatch.setattr(storage_module, "active_pages_dir", lambda: pages_dir)

    # v2 index: page node has no 'children' key
    config = {
        "version": 2,
        "pages": [{"id": page_id, "title": "Main", "type": "page"}],
        "header": [], "footer": [], "dialogs": [],
    }

    keys = _collect_context_composite_keys(config, current_page_ids=[page_id])
    assert {"DS:Motor/Speed", "DS:Motor/Name"} <= keys


def _runtime_dirs(monkeypatch, tmp_path: Path) -> tuple[Path, Path]:
    """Point the runtime's two document directories at a scratch project."""
    pages_dir = tmp_path / "pages"
    dialogs_dir = tmp_path / "dialogs"
    pages_dir.mkdir()
    dialogs_dir.mkdir()
    monkeypatch.setattr(storage_module, "active_pages_dir", lambda: pages_dir)
    monkeypatch.setattr(storage_module, "active_dialogs_dir", lambda: dialogs_dir)
    return pages_dir, dialogs_dir


def _document(widget_id: str) -> str:
    return json.dumps({"sections": {"content": [{"id": widget_id, "type": "Label"}]}})


def test_runtime_config_loads_each_document_from_its_own_root(monkeypatch, tmp_path) -> None:
    """The directory comes from the index root the node was found under. A
    leftover document of the same id in the other directory is not what the
    operator sees."""
    pages_dir, dialogs_dir = _runtime_dirs(monkeypatch, tmp_path)
    (pages_dir / "shared-id.json").write_text(_document("stale-widget"))
    (dialogs_dir / "shared-id.json").write_text(_document("real-widget"))

    runtime = websocket_manager_module._to_runtime_pages_config({
        "pages": [{"id": "home", "type": "page"}],
        "dialogs": [{"id": "shared-id", "type": "page"}],
    })

    assert [w["id"] for w in runtime["dialogs"][0]["children"]] == ["real-widget"]


def test_runtime_config_reads_a_group_child_from_the_group_s_own_root(
    monkeypatch, tmp_path
) -> None:
    _pages_dir, dialogs_dir = _runtime_dirs(monkeypatch, tmp_path)
    (dialogs_dir / "tab-1.json").write_text(_document("tab-widget"))

    runtime = websocket_manager_module._to_runtime_pages_config({
        "pages": [],
        "dialogs": [
            {
                "id": "grp",
                "type": "page-group",
                "children": [{"id": "tab-1", "type": "page"}],
            }
        ],
    })

    group = runtime["dialogs"][0]
    assert [w["id"] for w in group["children"][0]["children"]] == ["tab-widget"]


def test_runtime_config_serves_nothing_for_an_unreadable_document(monkeypatch, tmp_path) -> None:
    """A parse error in one root is that page's answer — not a reason to serve
    the other root's document of the same id."""
    pages_dir, dialogs_dir = _runtime_dirs(monkeypatch, tmp_path)
    (dialogs_dir / "broken.json").write_text("{ not json")
    (pages_dir / "broken.json").write_text(_document("stale-widget"))

    runtime = websocket_manager_module._to_runtime_pages_config({
        "pages": [],
        "dialogs": [{"id": "broken", "type": "page"}],
    })

    assert runtime["dialogs"][0]["children"] == []


def test_collect_context_keys_resolves_a_page_in_the_dialogs_folder(monkeypatch, tmp_path) -> None:
    """An open page overlay's page is sent in `currentPageIds` like the routed
    page, and may live in the Dialogs folder root rather than under `pages`."""
    pages_dir = tmp_path / "pages"
    pages_dir.mkdir()
    dialogs_dir = tmp_path / "dialogs"
    dialogs_dir.mkdir()
    # The document lives in the Dialogs folder's own directory, so finding it
    # proves that directory is read — pages/ holds nothing here.
    (dialogs_dir / "motor-detail.json").write_text(json.dumps({
        "id": "motor-detail",
        "sections": {"content": [{"id": "c1", "type": "Label", "properties": {
            "value": {"$var": {"path": "DS:Motor/Temp"}},
        }}]},
    }))
    monkeypatch.setattr(storage_module, "active_pages_dir", lambda: pages_dir)
    monkeypatch.setattr(storage_module, "active_dialogs_dir", lambda: dialogs_dir)

    config = {
        "version": 2,
        "pages": [],
        "dialogs": [{"id": "motor-detail", "type": "page"}],
        "header": [], "footer": [],
    }

    keys = _collect_context_composite_keys(config, current_page_ids=["motor-detail"])
    assert keys == {"DS:Motor/Temp"}


def test_collect_context_keys_v2_group_warms_all_sibling_pages(monkeypatch, tmp_path) -> None:
    """Visiting a page inside a group should warm all sibling pages in that group."""
    pages_dir = tmp_path / "pages"
    pages_dir.mkdir()

    (pages_dir / "page-1.json").write_text(json.dumps({
        "id": "page-1",
        "sections": {"content": [{"id": "c1", "type": "Label", "properties": {
            "value": {"$var": {"path": "DS:Tag/A"}},
        }}]},
    }))
    (pages_dir / "page-2.json").write_text(json.dumps({
        "id": "page-2",
        "sections": {"content": [{"id": "c2", "type": "Label", "properties": {
            "value": {"$var": {"path": "DS:Tag/B"}},
        }}]},
    }))

    monkeypatch.setattr(storage_module, "active_pages_dir", lambda: pages_dir)

    config = {
        "version": 2,
        "pages": [{
            "id": "grp-1", "title": "Group", "type": "page-group",
            "children": [
                {"id": "page-1", "title": "Tab 1", "type": "page"},
                {"id": "page-2", "title": "Tab 2", "type": "page"},
            ],
        }],
        "header": [], "footer": [], "dialogs": [],
    }

    keys = _collect_context_composite_keys(config, current_page_ids=["page-1"])
    assert "DS:Tag/A" in keys
    assert "DS:Tag/B" in keys  # sibling page is also warmed


def test_collect_context_keys_v1_inline_children_still_work(monkeypatch, tmp_path) -> None:
    """v1 inline children in the index node must still be resolved (no page files needed)."""
    pages_dir = tmp_path / "pages"
    pages_dir.mkdir()  # intentionally empty

    monkeypatch.setattr(storage_module, "active_pages_dir", lambda: pages_dir)

    config = {
        "pages": [{
            "id": "page-v1",
            "title": "Old Page",
            "children": [{
                "id": "btn-1",
                "type": "Button",
                "properties": {
                    "variable": {"$var": {"path": "DS:Motor/Speed"}},
                },
            }],
        }],
        "header": [], "footer": [], "dialogs": [],
    }

    keys = _collect_context_composite_keys(config, current_page_ids=["page-v1"])
    assert "DS:Motor/Speed" in keys


def test_collect_context_keys_scans_nested_properties_and_layout(monkeypatch, tmp_path) -> None:
    pages_dir = tmp_path / "pages"
    pages_dir.mkdir()
    monkeypatch.setattr(storage_module, "active_pages_dir", lambda: pages_dir)
    config = {
        "pages": [{
            "id": "page-v1",
            "children": [{
                "id": "widget",
                "properties": {
                    "text": {
                        "$stringExpr": {
                            "template": "{1}",
                            "wildcards": {"1": {"$var": {"path": "DS:Text"}}},
                        },
                    },
                },
                "layout": {"width": {"$var": {"path": "DS:Width"}}},
            }],
        }],
        "header": [], "footer": [], "dialogs": [],
    }

    keys = _collect_context_composite_keys(
        config, current_page_ids=["page-v1"]
    )

    assert keys == {"DS:Text", "DS:Width"}


class _RecordingAlarmManager:
    def __init__(self) -> None:
        self.acks: list[tuple[str, str, str]] = []

    def ack_alarm(self, instance_id: str, username: str, *, actor_source: str) -> bool:
        self.acks.append((instance_id, username, actor_source))
        return instance_id == "a1"

    def ack_all(self, username: str, *, actor_source: str) -> int:
        self.acks.append(("*", username, actor_source))
        return 1


def _ack_manager() -> tuple[WebSocketManager, FakeWebSocket, _RecordingAlarmManager]:
    manager = WebSocketManager()
    alarms = _RecordingAlarmManager()
    manager.set_alarm_manager(alarms)
    ws = FakeWebSocket()
    manager._connections["c1"] = ws  # type: ignore[attr-defined]
    return manager, ws, alarms


def test_alarm_ack_is_attributed_to_the_connection_not_the_message() -> None:
    manager, ws, alarms = _ack_manager()
    manager._client_users["c1"] = {"runtime:t1": {"username": "anna", "groups": ["operator"]}}

    asyncio.run(manager.handle_message("c1", json.dumps(
        {"type": "alarm_ack", "instanceId": "a1", "username": "mallory", "requestId": "r1"}
    )))

    assert alarms.acks == [("a1", "anna", "session")]
    assert ws.messages == [{"type": "alarm_ack_response", "requestId": "r1"}]


def test_alarm_ack_with_nobody_signed_in_is_guest() -> None:
    manager, _ws, alarms = _ack_manager()

    asyncio.run(manager.handle_message("c1", json.dumps({"type": "alarm_ack_all"})))

    assert alarms.acks == [("*", "guest", "session")]


def test_alarm_ack_follows_the_latest_identity_on_the_socket() -> None:
    """A remounted HmiView gets a new scope; the old scope's entry stays behind."""
    manager, _ws, alarms = _ack_manager()

    async def scenario() -> None:
        await manager._apply_and_respond_identity(
            "c1", "runtime:new", {"username": "guest", "groups": ["guest"]}, {},
        )
        await manager._apply_and_respond_identity(
            "c1", "runtime:old", {"username": "guest", "groups": ["guest"]}, {},
        )
        await manager._apply_and_respond_identity(
            "c1", "runtime:new", {"username": "anna", "groups": ["operator"]}, {},
        )
        await manager.handle_message("c1", json.dumps({"type": "alarm_ack", "instanceId": "a1"}))

    asyncio.run(scenario())

    assert alarms.acks == [("a1", "anna", "session")]


@pytest.mark.parametrize(
    ("message", "reason"),
    [
        ({"type": "alarm_ack", "instanceId": "gone", "requestId": "r1"}, "not_found"),
        ({"type": "alarm_ack", "requestId": "r1"}, "bad_request"),
    ],
)
def test_alarm_ack_failures_answer_alarm_ack_error(message, reason) -> None:
    manager, ws, _alarms = _ack_manager()

    asyncio.run(manager.handle_message("c1", json.dumps(message)))

    assert ws.messages == [{"type": "alarm_ack_error", "requestId": "r1", "reason": reason}]


def test_alarm_ack_from_the_editor_is_attributed_to_the_engineer() -> None:
    manager, _ws, alarms = _ack_manager()
    manager._editor_clients.add("c1")  # type: ignore[attr-defined]
    manager._client_users["c1"] = {"runtime:preview": {"username": "anna", "groups": ["operator"]}}

    asyncio.run(manager.handle_message("c1", json.dumps({"type": "alarm_ack", "instanceId": "a1"})))

    assert alarms.acks == [("a1", "engineer", "device_admin")]


class _FakeRecipeManager:
    def __init__(self, written: int) -> None:
        self.written = written

    async def download(self, dataset_id: str, *, verify: bool):
        from models.recipe import DownloadResult

        return DownloadResult(
            result="success" if self.written else "failed", datasetId=dataset_id,
            written=self.written, total=1, verified=verify, failures=[],
        )


@pytest.mark.parametrize(
    ("editor", "written", "expected"),
    [
        (False, 1, [("anna", "session", "recipe.load", "espresso")]),
        (True, 1, [("engineer", "device_admin", "recipe.load", "espresso")]),
        (False, 0, []),
    ],
)
def test_recipe_load_is_audited_with_its_actor(editor, written, expected) -> None:
    from core import audit

    manager = WebSocketManager()
    manager.set_recipe_manager(_FakeRecipeManager(written))
    manager._connections["c1"] = FakeWebSocket()  # type: ignore[attr-defined]
    manager._client_users["c1"] = {"runtime:t1": {"username": "anna", "groups": ["operator"]}}
    if editor:
        manager._editor_clients.add("c1")  # type: ignore[attr-defined]
    seen: list = []
    audit.register_listener(seen.append)
    try:
        asyncio.run(manager.handle_message("c1", json.dumps(
            {"type": "recipe_load", "datasetId": "espresso", "scope": "runtime:t1"}
        )))
    finally:
        audit.unregister_listener(seen.append)

    assert [(e.actor, e.actor_source, e.action, e.subject) for e in seen] == expected


def test_connect_marks_only_an_editor_socket() -> None:
    manager = WebSocketManager()

    async def scenario() -> tuple[str, str]:
        return (
            await manager.connect(FakeWebSocket(), editor=True),  # type: ignore[arg-type]
            await manager.connect(FakeWebSocket()),  # type: ignore[arg-type]
        )

    editor_id, runtime_id = asyncio.run(scenario())

    assert manager._editor_clients == {editor_id}  # type: ignore[attr-defined]
    asyncio.run(manager.disconnect(editor_id))
    assert manager._editor_clients == set()  # type: ignore[attr-defined]
    assert runtime_id not in manager._editor_clients  # type: ignore[attr-defined]


# Runs in a subprocess: importing ``main`` bootstraps a project and grafts its
# singletons onto the module table for every later test.
_EDITOR_HEADER_PROBE = '''
import json
import sys

from fastapi.testclient import TestClient

import main
from services.websocket_manager import websocket_manager

# An instance answers only a loopback Host (core.origin_check).
client = TestClient(main.app)
with client.websocket_connect("ws://127.0.0.1/ws", headers={"x-nexthmi-editor": "1"}) as editor:
    editor.receive_text()
    with client.websocket_connect("ws://127.0.0.1/ws", headers={"x-nexthmi-editor": "yes"}) as other:
        other.receive_text()
        result = {
            "connections": len(websocket_manager._connections),
            "editors": len(websocket_manager._editor_clients),
        }
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(result, fh)
'''


def test_the_instance_marks_only_a_socket_carrying_the_editor_header(tmp_path: Path) -> None:
    backend = Path(__file__).resolve().parents[1]
    home = tmp_path / "runtime-home"
    home.mkdir()
    script = tmp_path / "probe.py"
    script.write_text(_EDITOR_HEADER_PROBE, encoding="utf-8")
    out = tmp_path / "result.json"
    env = {
        **os.environ,
        "NEXTHMI_DATA_DIR": str(home),
        "PYTHONPATH": os.pathsep.join([str(backend), os.environ.get("PYTHONPATH", "")]),
    }
    env.pop("NEXTHMI_FRONTEND_DIST", None)
    proc = subprocess.run(
        [sys.executable, str(script), str(out)],
        env=env, capture_output=True, text=True, cwd=str(backend.parent), timeout=180,
    )
    assert proc.returncode == 0, f"probe failed:\n{proc.stdout}\n{proc.stderr}"
    assert json.loads(out.read_text(encoding="utf-8")) == {"connections": 2, "editors": 1}
