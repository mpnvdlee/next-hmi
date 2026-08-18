"""Datasource configuration models.

Variable/struct tree node array encoding: ``is_array`` (bool) marks a node as
an array; ``array_length`` is meaningful only when ``is_array`` is true — a
positive int is a fixed size, absent/null is dynamic (unknown) length.
``array_length`` must never be ``0`` and must never appear on a scalar node.
A folder node representing an array-of-struct carries ``is_array: true`` too,
marking its ``[0]``, ``[1]``, … children as array elements.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DatasourceType = Literal["opcua-client", "static", "opcua-test-server"]


# ── Request models ────────────────────────────────────────────────────────────


class DatasourceUpsertBody(BaseModel):
    """Body for PUT /api/datasources/{name}.

    ``type`` is validated against the allowed set; ``settings`` defaults to
    empty so callers may omit it. Extra fields (e.g. certificate paths,
    test-server ports) are forwarded to storage unchanged via ``model_extra``.

    ``variables`` defaults to ``None`` (also matches an explicit JSON
    ``null``), meaning "leave the existing variable tree untouched" — only an
    explicit ``[]`` clears it. This lets a settings-only PUT (e.g. from the
    properties panel) omit ``variables`` entirely instead of persisting an
    empty tree and silently wiping it (§1.5).
    """

    type: DatasourceType
    settings: dict[str, Any] = Field(default_factory=dict)
    variables: list[Any] | None = None

    model_config = ConfigDict(extra="allow")

    def to_storage_dict(
        self, name: str, *, existing_variables: list[Any] | None = None
    ) -> dict[str, Any]:
        """Merge validated fields + extras into the flat dict stored on disk.

        When ``variables`` was omitted (or explicitly ``null``), *existing_variables*
        (the datasource's current tree, if any) is carried forward instead of
        wiping it to an empty list.
        """
        base = self.model_dump(exclude={"variables"})
        base.update(self.model_extra or {})
        base["name"] = name
        base["variables"] = self.variables if self.variables is not None else (existing_variables or [])
        return base


class DiscoverBody(BaseModel):
    """Body for POST /api/datasources/discover."""

    address: str


class DiscoveredEndpoint(BaseModel):
    endpoint_url: str
    security_mode: str
    security_policy: str
    user_tokens: list[str] = Field(default_factory=list)
    server_name: str = ""
    application_uri: str = ""


class DiscoveryResult(BaseModel):
    ok: bool
    error: str | None = None
    endpoints: list[DiscoveredEndpoint] = Field(default_factory=list)


class TestConnectionBody(BaseModel):
    """Body for POST /api/datasources/test-connection.

    Extra fields (e.g. certificate paths) are forwarded to the probe unchanged.
    """

    server_url: str
    username: str = ""
    password: str = ""
    security_policy: str = "NoSecurity"
    security_mode: str = ""

    model_config = ConfigDict(extra="allow")


class TestConnectionResult(BaseModel):
    ok: bool
    error: str | None = None
    server_name: str | None = None
    namespace_count: int | None = None


class CertUploadResult(BaseModel):
    """Body for POST /api/datasources/certs — the stored file's project-relative path."""

    path: str


# ── Path helpers ──────────────────────────────────────────────────────────────

def build_var_key(datasource: str, path: str) -> str:
    """Build composite variable key: 'datasource:path'."""
    return f"{datasource}:{path}"


def parse_var_key(key: str) -> tuple[str, str]:
    """Parse composite key into (datasource, path)."""
    idx = key.find(":")
    if idx < 0:
        return ("", key)
    return (key[:idx], key[idx + 1:])


# ── Variable predicates ───────────────────────────────────────────────────────


def is_present_on_server(var_entry: dict[str, Any]) -> bool:
    """True when the variable still exists on the OPC-UA server.

    Absent ``present_on_server`` is treated as present; only an explicit
    ``False`` marks the variable stale.
    """
    return var_entry.get("present_on_server") is not False


def is_subscribable(var_entry: dict[str, Any]) -> bool:
    """True when a variable should be subscribed/read.

    A variable is subscribable when it's enabled AND still present on the
    OPC-UA server. Stale variables (kept after a re-browse for reference but
    no longer on the server) are skipped — subscribing them would only
    generate errors.
    """
    if not var_entry.get("enabled", False):
        return False
    return is_present_on_server(var_entry)


# ── Tree walker ───────────────────────────────────────────────────────────────


def flatten_with_paths(
    nodes: list[dict[str, Any]],
    prefix: str = "",
) -> list[tuple[str, dict[str, Any]]]:
    """Flatten a variable tree into (path, entry) pairs."""
    result: list[tuple[str, dict[str, Any]]] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if node.get("kind") == "folder":
            folder_path = f"{prefix}/{node['name']}" if prefix else node["name"]
            result.extend(flatten_with_paths(node.get("children", []), folder_path))
        else:
            dn = node.get("display_name", "")
            path = f"{prefix}/{dn}" if prefix else dn
            result.append((path, node))
    return result
