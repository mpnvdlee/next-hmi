"""Subscription-delta helpers shared by the REST API and the MCP write tools.

Both call sites have already persisted the new variable tree and updated the
in-memory ``datasource_manager`` entry. This module then drives the OPC-UA
side-effects: subscribe newly enabled variables, unsubscribe newly disabled
ones, and refresh the live test-server writable flags. Returns the list of
composite keys that should be broadcast as ``var_removed`` to WebSocket
clients so they can drop stale bindings.
"""

from __future__ import annotations

import logging
from typing import Any

from models.datasource import build_var_key, is_subscribable

from services.datasource_manager import DatasourceEntry, datasource_manager

logger = logging.getLogger(__name__)


def enabled_paths(entry: DatasourceEntry | None) -> set[str]:
    if entry is None:
        return set()
    return {
        path for path, var_entry in entry.registry.items()
        if is_subscribable(var_entry)
    }


def metadata_keys(entry: DatasourceEntry | None, name: str | None = None) -> set[str]:
    """Composite keys represented in ``variable_metadata()`` for one entry."""
    if entry is None:
        return set()
    entry_name = name if name is not None else entry.name
    folder_registry = getattr(entry, "folder_registry", {})
    return {
        build_var_key(entry_name, path)
        for path, var_entry in entry.registry.items()
        if is_subscribable(var_entry)
    } | {
        build_var_key(entry_name, path)
        for path in folder_registry
    }


def _root_folder_paths(entry: DatasourceEntry) -> set[str]:
    nested: set[str] = set()
    folder_registry = getattr(entry, "folder_registry", {})
    for folder in folder_registry.values():
        nested.update(folder.get("_nested_fields", {}).values())
        nested.update(folder.get("_element_paths", []))
    return set(folder_registry) - nested


def _folder_type_signature(entry: DatasourceEntry, path: str) -> tuple[Any, ...] | None:
    """Return the part of a folder definition that controls runtime shape."""
    folder = getattr(entry, "folder_registry", {}).get(path)
    if folder is None:
        return None
    source = folder
    if folder.get("_is_array"):
        element_paths = folder.get("_element_paths", [])
        if element_paths:
            source = entry.folder_registry.get(element_paths[0], folder)
    return (
        folder.get("display_name"),
        bool(folder.get("_is_array")),
        tuple(source.get("fields", {}).keys()),
        tuple(source.get("_nested_fields", {}).keys()),
    )


def _reset_keys_for_changed_definitions(
    name: str,
    old_entry: DatasourceEntry | None,
    new_entry: DatasourceEntry,
) -> set[str]:
    """Keys that still exist but whose cached value generation is incompatible."""
    if old_entry is None:
        return set()
    reset: set[str] = set()
    old_registry = getattr(old_entry, "registry", {})
    for path in set(old_registry) & set(new_entry.registry):
        old_var = old_registry[path]
        new_var = new_entry.registry[path]
        old_shape = (
            old_var.get("node_id"),
            old_var.get("data_type"),
            bool(old_var.get("is_array")),
            old_var.get("array_length"),
        )
        new_shape = (
            new_var.get("node_id"),
            new_var.get("data_type"),
            bool(new_var.get("is_array")),
            new_var.get("array_length"),
        )
        if old_shape != new_shape:
            reset.add(build_var_key(name, path))

    old_folders = getattr(old_entry, "folder_registry", {})
    new_folders = getattr(new_entry, "folder_registry", {})
    for path in set(old_folders) & set(new_folders):
        if _folder_type_signature(old_entry, path) != _folder_type_signature(new_entry, path):
            reset.add(build_var_key(name, path))
    return reset


async def apply_subscription_delta(
    name: str,
    old_enabled: set[str],
    new_entry: DatasourceEntry,
    opcua_pool: Any,
    test_server_pool: Any,
    old_entry: DatasourceEntry | None = None,
) -> list[str]:
    """Apply add/remove subscription delta and return removed composite keys.

    Tolerates ``None`` pools (test environments) — the caller is expected to
    have already updated ``datasource_manager`` via ``apply_config()``.
    """
    new_enabled = enabled_paths(new_entry)
    old_metadata = (
        metadata_keys(old_entry)
        if old_entry is not None
        else {build_var_key(name, path) for path in old_enabled}
    )

    if opcua_pool is not None and new_entry.ds_type == "opcua-client":
        engine = opcua_pool.get(name)
        if engine is not None:
            changed_identity: set[str] = set()
            if old_entry is not None:
                for path in old_enabled & new_enabled:
                    old_var = old_entry.registry.get(path, {})
                    new_var = new_entry.registry.get(path, {})
                    if old_var.get("node_id") != new_var.get("node_id"):
                        changed_identity.add(path)

            removed_or_replaced = (old_enabled - new_enabled) | changed_identity
            removed_ok: dict[str, bool] = {}
            for path in removed_or_replaced:
                removed_ok[path] = await engine.remove_subscription_by_path(name, path)
                if path not in new_enabled:
                    datasource_manager.evict(name, path)

            # A failed DeleteMonitoredItems leaves the old monitored item live.
            # Restarting is the only safe way to reconcile it without creating
            # a duplicate for a changed node identity. It also makes disabled
            # paths retryable instead of forgetting the failed handle forever
            # once the new config becomes authoritative.
            removal_failed = any(not ok for ok in removed_ok.values())
            restarted = False
            if removal_failed:
                restart = getattr(opcua_pool, "restart", None)
                if callable(restart):
                    logger.warning(
                        "Restarting %s after subscription removal failed",
                        name,
                    )
                    await restart(name, new_entry.config.get("settings", {}))
                    engine = opcua_pool.get(name)
                    restarted = True
                else:
                    logger.warning(
                        "Could not reconcile failed subscription removal for %s",
                        name,
                    )

            if not restarted:
                for path in (new_enabled - old_enabled) | changed_identity:
                    if path in changed_identity and not removed_ok.get(path, False):
                        continue
                    await engine.add_subscription_by_path(path, new_entry)
            # Backfill the cache for every still-enabled variable (not just the
            # newly-subscribed delta) so a save that touches unrelated settings
            # doesn't leave values empty until the PLC next reports a change.
            # Include aggregate roots so struct and indexed struct[] bindings
            # receive their folder/element keys as part of the same read.
            if new_enabled and engine is not None:
                try:
                    fresh_values = await engine.read_current_values(
                        new_enabled | _root_folder_paths(new_entry)
                    )
                except Exception as exc:
                    logger.warning(
                        "Failed to backfill values for %s after subscription delta: %s",
                        name, exc,
                    )
                    fresh_values = {}
                if fresh_values:
                    datasource_manager.seed_cached_values(fresh_values)

    if test_server_pool is not None and new_entry.ds_type == "opcua-test-server":
        instance = test_server_pool.get(name)
        if instance is not None:
            await instance.update_writable_flags(new_entry.registry)

    return sorted(
        (old_metadata - metadata_keys(new_entry))
        | _reset_keys_for_changed_definitions(name, old_entry, new_entry)
    )


async def apply_datasource_change(
    name: str, after: dict[str, Any], old_enabled: set[str],
) -> list[str]:
    """Apply a persisted datasource config to the live runtime, end to end.

    Refreshes the in-memory ``datasource_manager`` entry from *after*, applies
    the OPC-UA subscription delta against the live pools, and broadcasts the
    removed composite keys to WebSocket clients. Returns those keys.

    The single in-process implementation behind both the REST/MCP write path
    (``mcp_server.tools.variables._sync_runtime``) and the manager→child reload
    hook (``api.internal_api``). Lazy-imports the pools so this module stays
    importable where they aren't wired up (tests); the helpers tolerate ``None``.
    """
    old_entry = datasource_manager.get(name)
    new_entry = datasource_manager.apply_config(name, after)
    try:
        from opcua import opcua_pool, test_server_pool
    except Exception:
        opcua_pool = test_server_pool = None
    removed_keys = await apply_subscription_delta(
        name, old_enabled, new_entry, opcua_pool, test_server_pool, old_entry,
    )
    from services.websocket_manager import websocket_manager
    if removed_keys:
        await websocket_manager.broadcast_var_removed(removed_keys)
    await websocket_manager.broadcast_var_metadata()
    current_values = datasource_manager.get_cached_values(metadata_keys(new_entry))
    await websocket_manager.broadcast_var_values(current_values)
    return removed_keys
