import asyncio
import json
from pathlib import Path

import core.storage as storage_module
import pytest
import services.websocket_manager as websocket_manager_module
from conftest import FakeDatasourceManager, FakeEngine, FakePool, FakeWebSocket
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
        for _ in range(10):
            if len(ws.messages) >= 3:
                break
            await asyncio.sleep(0.01)

    asyncio.run(_run())

    assert ws.messages == [
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

    asyncio.run(
        manager._handle_set_context("client-1", {"currentPageIds": ["main"]})
    )

    assert ws.messages == [
        {"type": "var_update", "values": {"DS:Cached": 1}},
        {"type": "context_ready", "currentPageIds": ["main"]},
    ]


def test_priority_batch_delay_uses_datasource_setting() -> None:
    manager = WebSocketManager()
    manager.set_datasource_manager(FakeDatasourceManager())

    assert manager._priority_batch_delay_ms_for_key("DS:Cached") == 7


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


def test_extract_variable_keys_stops_at_depth_limit() -> None:
    keys: set[str] = set()
    nested: dict[str, object] = {"$var": {"path": "DS:Deep"}}

    for _ in range(MAX_EXTRACT_BINDING_DEPTH + 10):
        nested = {"$if": {"condition": nested, "true": None, "false": None}}

    _extract_variable_keys_from_value(nested, keys)

    assert "DS:Deep" not in keys


def test_broadcast_var_metadata_sends_authoritative_empty_snapshot() -> None:
    class _Manager:
        @staticmethod
        def variable_metadata() -> dict:
            return {}

    manager = WebSocketManager()
    manager.set_datasource_manager(_Manager())
    ws = FakeWebSocket()
    manager._connections["client-1"] = ws  # type: ignore[attr-defined]

    asyncio.run(manager.broadcast_var_metadata())

    assert ws.messages == [{"type": "var_metadata", "meta": {}}]


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
