"""Idempotency cache — LRU + TTL behavior, and what a key is scoped to."""

import asyncio
import json
from pathlib import Path

import pytest
from core import manifest as manifest_mod
from core.manifest import ManifestV1, ProjectEntry, save_manifest
from core.time_utils import iso_now
from mcp.server.mcpserver import Context
from mcp_server import idempotency
from mcp_server.auth import McpIdentity, identity_for_tests


@pytest.fixture(autouse=True)
def _reset_cache():
    idempotency.reset_for_tests()
    yield
    idempotency.reset_for_tests()


def test_get_returns_none_when_missing():
    assert idempotency.get("Claude@1", "key-1") is None


def test_put_then_get_returns_response():
    idempotency.put("Claude@1", "key-1", {"result": "applied"})
    assert idempotency.get("Claude@1", "key-1") == {"result": "applied"}


def test_the_agent_label_does_not_scope_a_key():
    # Anyone can send any X-Mcp-Agent header; it names the caller in the log only.
    idempotency.put("Claude@1", "k", {"by": "Claude"})
    assert idempotency.get("Other@1", "k") == {"by": "Claude"}


def test_empty_idempotency_key_skips_lookup():
    idempotency.put("Claude@1", "", {"r": "1"})
    assert idempotency.get("Claude@1", "") is None


def test_ttl_expires(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(idempotency.time, "monotonic", lambda: now[0])
    idempotency.put("Claude@1", "k", {"v": 1})
    assert idempotency.get("Claude@1", "k") == {"v": 1}
    # Advance past TTL (5 min)
    now[0] = 1000.0 + idempotency.CACHE_TTL_SECONDS + 1
    assert idempotency.get("Claude@1", "k") is None


def test_lru_evicts_oldest():
    capacity = idempotency.CACHE_CAPACITY
    for i in range(capacity + 5):
        idempotency.put("Claude@1", f"k-{i}", {"v": i})
    # First 5 keys should be evicted
    for i in range(5):
        assert idempotency.get("Claude@1", f"k-{i}") is None
    # The most-recently-inserted are present
    assert idempotency.get("Claude@1", f"k-{capacity + 4}") == {"v": capacity + 4}


# ── scope: the project and the credential, from the auth context ─────────────


@pytest.fixture
def tools(monkeypatch, tmp_path: Path):
    """Two MCP-enabled projects, driven through the tool manager as the transport does."""
    monkeypatch.setattr(manifest_mod, "manifest_path", lambda: tmp_path / "projects.json")
    entries = []
    for project_id in ("A", "B"):
        root = tmp_path / project_id
        (root / "pages").mkdir(parents=True)
        (root / "config.json").write_text(
            json.dumps({"mcpEnabled": True, "pages": []}), encoding="utf-8"
        )
        entries.append(
            ProjectEntry(id=project_id, name=project_id, path=str(root), addedAt=iso_now())
        )
    save_manifest(ManifestV1(projects=entries))

    from mcp_server.server import mcp_app, prepare_workspace_tools

    prepare_workspace_tools()
    context = Context(mcp_server=mcp_app)
    return lambda name, arguments: mcp_app._tool_manager.call_tool(name, arguments, context)


def _create_home(call_tool, project: str, identity: McpIdentity) -> dict:
    with identity_for_tests(identity):
        return asyncio.run(
            call_tool(
                "pages_create",
                {"project": project, "title": "Home", "idempotency_key": "same-key"},
            )
        )


def _pages(tmp_path: Path, project: str) -> list[str]:
    return sorted(path.stem for path in (tmp_path / project / "pages").glob("*.json"))


_TOKEN_1 = McpIdentity(kind="token", access="write", token_id="token-1")
_TOKEN_2 = McpIdentity(kind="token", access="write", token_id="token-2")


def test_the_same_key_on_two_projects_writes_both(tools, tmp_path: Path):
    first = _create_home(tools, "A", _TOKEN_1)
    second = _create_home(tools, "B", _TOKEN_1)

    assert first["result"] == second["result"] == "applied"
    assert _pages(tmp_path, "A") == [first["page_id"]]
    assert _pages(tmp_path, "B") == [second["page_id"]]


def test_the_same_key_from_two_tokens_writes_twice(tools, tmp_path: Path):
    first = _create_home(tools, "A", _TOKEN_1)
    second = _create_home(tools, "A", _TOKEN_2)

    assert first["page_id"] != second["page_id"]
    assert _pages(tmp_path, "A") == sorted([first["page_id"], second["page_id"]])


def test_a_retry_with_the_same_key_project_and_token_is_replayed(tools, tmp_path: Path):
    first = _create_home(tools, "A", _TOKEN_1)
    again = _create_home(tools, "A", _TOKEN_1)

    assert again == first
    assert _pages(tmp_path, "A") == [first["page_id"]]
