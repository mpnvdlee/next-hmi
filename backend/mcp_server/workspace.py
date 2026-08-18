"""Workspace-level MCP tools — the read-only discovery layer.

These are the only tools that are *not* project-scoped: they answer "what
projects exist and what is their state" so an AI client can pick a ``project``
id to pass to every other (project-scoped) tool. They run in the manager
process, which is the only component that sees the whole workspace (every
project via the manifest + the running set via the supervisor).

The MCP is content-only: there are deliberately no lifecycle tools here
(``start`` / ``stop`` / ``create``). Bringing projects up or down stays an
operator action in the manager dashboard.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from core.exceptions import ConfigNotFoundError
from core.manifest import ProjectEntry, find_project, load_manifest, project_mcp_enabled

from .pagination import paginated_payload
from .server import expose_workspace_tool


def _status_for(project_id: str) -> str:
    # Late import: the supervisor singleton only exists in the manager process,
    # but this module is importable everywhere (tests, child instances).
    from services.supervisor import supervisor

    snapshot = supervisor.status(project_id)
    if snapshot is None:
        return "stopped"
    return str(snapshot.get("status", "stopped"))


def _project_summary(entry: ProjectEntry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "name": entry.name,
        "status": _status_for(entry.id),
        "mcpEnabled": project_mcp_enabled(Path(entry.path).expanduser()),
    }


def _projects_list_payload(
    cursor: str | None = None, limit: int | None = None
) -> dict[str, Any]:
    manifest = load_manifest()
    items = [(entry.id, entry.id, _project_summary(entry)) for entry in manifest.projects]
    return paginated_payload(items, cursor=cursor, limit=limit)


def _projects_get_payload(project: str) -> dict[str, Any]:
    manifest = load_manifest()
    entry = find_project(manifest, project)
    if entry is None:
        raise ConfigNotFoundError(f"Project '{project}' not found")
    summary = _project_summary(entry)
    summary["path"] = entry.path
    summary["addedAt"] = entry.addedAt
    summary["lastOpenedAt"] = entry.lastOpenedAt
    return summary


def register_workspace_tools() -> None:
    """Register the workspace (un-scoped) discovery tools onto the MCP server.

    Called after the project tools are scoped, so these two are the only tools
    without a required ``project`` argument.
    """
    expose_workspace_tool(
        _projects_list_payload,
        name="projects_list",
        description=(
            "List every project in this workspace. Returns "
            "``{ items, next_cursor? }``; each item has ``id``, ``name``, "
            "``status`` (running/stopped/starting/crashed), and ``mcpEnabled``. "
            "Pass an item's ``id`` as the ``project`` argument of any other "
            "tool to act on it — running or stopped. Writes are refused when "
            "``mcpEnabled`` is false."
        ),
    )
    expose_workspace_tool(
        _projects_get_payload,
        name="projects_get",
        description=(
            "Full detail for one project by ``project`` id: id, name, status, "
            "mcpEnabled, path, and timestamps."
        ),
    )
