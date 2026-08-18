"""Conflict broadcast — WS payload shape (artifact_ids array, diff, agent_label).

No MCP-native notification is emitted alongside it: no MCP resources are
exposed, so there is nothing for a client to subscribe to, and an agent that
mutates state re-reads via the matching ``*_list`` / ``*_get`` tool. The WS
broadcast is therefore the whole contract — for other connected tabs and for
agents alike — so that's what we assert here.
"""


import pytest
from mcp_server.diff import make_diff
from services.websocket_manager import ConfigChangedEvent, WebSocketManager


class _RecordingWS:
    def __init__(self) -> None:
        self.messages: list[str] = []

    async def send_text(self, text: str) -> None:
        self.messages.append(text)


@pytest.mark.asyncio
async def test_broadcast_config_changed_mcp_includes_agent_label():
    manager = WebSocketManager()
    ws = _RecordingWS()
    manager._connections["client-1"] = ws  # type: ignore[arg-type]
    diff = make_diff({"x": 1}, {"x": 2})
    await manager.broadcast_config_changed(
        ConfigChangedEvent(
            artifact_type="page",
            artifact_ids=["page-home", "page-detail"],
            source="mcp",
            summary="Bulk update",
            diff=diff,
            agent_label="Claude@1.0",
        )
    )
    import json
    assert ws.messages, "expected a broadcast"
    payload = json.loads(ws.messages[0])
    assert payload["type"] == "config_changed"
    assert payload["artifact_type"] == "page"
    assert payload["artifact_ids"] == ["page-home", "page-detail"]
    assert payload["source"] == "mcp"
    assert payload["agent_label"] == "Claude@1.0"
    assert payload["summary"] == "Bulk update"
    assert payload["diff"] == diff


@pytest.mark.asyncio
async def test_broadcast_config_changed_rest_omits_agent_label():
    manager = WebSocketManager()
    ws = _RecordingWS()
    manager._connections["client-1"] = ws  # type: ignore[arg-type]
    await manager.broadcast_config_changed(
        ConfigChangedEvent(
            artifact_type="page",
            artifact_ids=["page-home"],
            source="rest",
            summary="REST write",
        )
    )
    import json
    payload = json.loads(ws.messages[0])
    assert payload["source"] == "rest"
    assert "agent_label" not in payload


@pytest.mark.asyncio
async def test_diff_truncation_sentinel_when_oversize():
    """A diff that exceeds 32 KiB is replaced by the truncation sentinel."""
    # Build a diff large enough to trigger truncation: two big dicts.
    big_before = {"k": "x" * (40 * 1024)}
    big_after = {"k": "y" * (40 * 1024)}
    diff = make_diff(big_before, big_after)
    assert isinstance(diff, dict)
    assert diff.get("truncated") is True
    assert diff.get("reason") == "patch_too_large"
    assert "op_count" in diff
