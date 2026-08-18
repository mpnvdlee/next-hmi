"""REST API for datasource management (CRUD + browse)."""

from typing import Any, Literal, TypedDict

from core.exceptions import DatasourceNotFoundError, DatasourceValidationError
from core.project_packer import safe_filename
from core.storage import active_certs_dir, write_bytes_atomic
from core.value_types import simplify_variable_tree
from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from models.datasource import (
    CertUploadResult,
    DatasourceUpsertBody,
    DiscoverBody,
    DiscoveryResult,
    TestConnectionBody,
    TestConnectionResult,
)
from opcua.client_pool import discover_endpoints, probe_connection
from services import users_manager, write_service
from services.datasource_manager import (
    DatasourceEntry,
    datasource_manager,
    validate_static_data_types,
)
from services.datasource_sync import (
    apply_subscription_delta,
    enabled_paths,
    metadata_keys,
)

router = APIRouter(prefix="/api/datasources", tags=["datasources"])
_write_credentials = HTTPBasic(auto_error=False)
DatasourceAction = Literal["start", "restart"]

_RESERVED_FILENAMES = {"", ".", ".."}


def _sanitize_cert_filename(raw_name: str | None) -> str:
    """ASCII-safe, single-component filename for a cert/key upload.

    Reuses ``safe_filename`` (already used for zip download names) to collapse
    path separators and unsafe characters, then rejects the residual traversal
    case it doesn't cover: a name that sanitizes down to ``.`` or ``..``, which
    would otherwise resolve to the certs directory itself or its parent.
    """
    cleaned = safe_filename(raw_name or "")
    if cleaned in _RESERVED_FILENAMES:
        raise DatasourceValidationError(f"Invalid certificate filename: {raw_name!r}")
    return cleaned


class DatasourceSummary(TypedDict):
    name: str
    type: str
    connected: bool
    variable_count: int
    enabled_count: int
    error: str | None


def _require_opcua_pool() -> Any:
    pool = _opcua_pool
    if not pool:
        raise HTTPException(status_code=503, detail="OPC-UA pool not available")
    return pool


def _require_test_server_pool() -> Any:
    pool = _test_server_pool
    if not pool:
        raise HTTPException(status_code=503, detail="Test server pool not available")
    return pool


def _require_datasource(name: str) -> DatasourceEntry:
    entry = datasource_manager.get(name)
    if entry is None:
        raise DatasourceNotFoundError(f"Datasource '{name}' not found")
    return entry


async def _sync_datasource_runtime(
    name: str,
    payload: dict[str, Any],
    old_entry: Any,
    *,
    runtime_stopped: bool = False,
) -> None:
    pool = _opcua_pool
    ds_type = payload["type"]
    old_type = old_entry.ds_type if old_entry is not None else None

    # A datasource can change type through the API. Stop the old runtime first
    # so a client/test-server engine is not left alive behind a static config.
    if not runtime_stopped and old_type is not None and old_type != ds_type:
        if old_type == "opcua-test-server" and _test_server_pool:
            await _test_server_pool.stop(name)
        elif old_type == "opcua-client" and pool:
            await pool.stop(name)

    if ds_type == "opcua-client":
        if not pool:
            return
        if runtime_stopped or old_entry is None or old_type != ds_type:
            await pool.start(name, payload["settings"])
        else:
            await pool.restart(name, payload["settings"])
        return

    if ds_type == "opcua-test-server":
        ts_pool = _test_server_pool
        if not ts_pool:
            return
        if runtime_stopped or old_entry is None or old_type != ds_type:
            await ts_pool.start(name, payload)
        else:
            await ts_pool.restart(name, payload)


async def _broadcast_removed_keys(removed_keys: list[str]) -> None:
    if not removed_keys:
        return
    from services.websocket_manager import websocket_manager

    await websocket_manager.broadcast_var_removed(removed_keys)


async def _broadcast_var_metadata() -> None:
    from services.websocket_manager import websocket_manager

    await websocket_manager.broadcast_var_metadata()


async def _broadcast_current_values(entry: DatasourceEntry | None) -> None:
    if entry is None:
        return
    from services.websocket_manager import websocket_manager

    values = datasource_manager.get_cached_values(metadata_keys(entry))
    await websocket_manager.broadcast_var_values(values)


async def _stop_datasource_runtime(name: str, ds_type: str | None = None) -> None:
    if ds_type in (None, "opcua-client") and _opcua_pool:
        await _opcua_pool.stop(name)
    # TestServerPool.stop also stops its paired OPC-UA client.
    if ds_type in (None, "opcua-test-server") and _test_server_pool:
        await _test_server_pool.stop(name)


def _apply_connection_status(items: list[DatasourceSummary]) -> list[DatasourceSummary]:
    pool = _opcua_pool
    ts_pool = _test_server_pool
    for item in items:
        if item.get("type") == "opcua-test-server" and ts_pool:
            instance = ts_pool.get(item["name"])
            item["connected"] = instance.running if instance else False
            item["error"] = instance.error if instance else None
        elif pool:
            engine = pool.get(item["name"])
            if engine is not None:
                item["connected"] = engine.connected
    return items


async def _run_datasource_action(name: str, entry: Any, action: DatasourceAction) -> dict[str, str]:
    if entry.ds_type == "opcua-test-server":
        ts_pool = _require_test_server_pool()
        if action == "start":
            await ts_pool.start(name, entry.config)
            return {"status": "started"}
        await ts_pool.restart(name, entry.config)
        return {"status": "restarted"}

    if entry.ds_type == "opcua-client":
        pool = _require_opcua_pool()
        await pool.restart(name, entry.config.get("settings", {}))
        return {"status": "reconnecting"}

    raise DatasourceValidationError(f"Only OPC-UA datasources support {action}")


@router.get("")
async def list_datasources() -> list[DatasourceSummary]:
    """List all datasources with summary info."""
    return _apply_connection_status(datasource_manager.list_all())


@router.post("/discover")
async def discover_datasource_endpoints(body: DiscoverBody) -> DiscoveryResult:
    """Enumerate an OPC-UA server's endpoints without persisting anything.

    Used by the connection wizard so the engineer can pick an endpoint instead
    of typing the URL/security/auth by hand. Never touches the live pool.
    """
    return DiscoveryResult(**await discover_endpoints(body.address))


@router.post("/test-connection")
async def test_datasource_connection(body: TestConnectionBody) -> TestConnectionResult:
    """Open a throwaway session to verify a candidate connection pre-save."""
    return TestConnectionResult(**await probe_connection(body.model_dump()))


@router.post("/certs")
async def upload_datasource_certificate(file: UploadFile = File(...)) -> CertUploadResult:
    """Upload a client certificate, private key, or server certificate.

    Used by the connection wizard's secure-connection step: called once per
    file (client cert, private key, server cert), never for the key password
    itself — that stays a plain settings field, never a file. Stores the
    upload under the live project's ``certs/`` folder with a sanitized
    filename and returns the project-relative path
    (``"certs/<filename>"``) the caller stores in ``client_certificate`` /
    ``client_private_key`` / ``server_certificate``.
    """
    filename = _sanitize_cert_filename(file.filename)
    certs_dir = active_certs_dir()
    target = (certs_dir / filename).resolve()
    certs_root = certs_dir.resolve()
    if target != certs_root and not target.is_relative_to(certs_root):
        raise DatasourceValidationError(f"Invalid certificate filename: {file.filename!r}")

    data = await file.read()
    write_bytes_atomic(target, data)
    return CertUploadResult(path=f"certs/{filename}")


@router.post("/write")
async def write_datasource_variable(
    body: Any = Body(...),
    credentials: HTTPBasicCredentials | None = Depends(_write_credentials),
) -> dict[str, Any]:
    """Authenticated project-user write using the WebSocket request contract."""
    authenticated = (
        await users_manager.authenticate(credentials.username, credentials.password)
        if credentials is not None
        else None
    )
    if authenticated is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_credentials",
            headers={"WWW-Authenticate": "Basic"},
        )
    parsed = write_service.parse_write_request(body)
    if parsed is None:
        return {"ok": False, "reason": "bad_request"}
    datasource, path, field, value = parsed
    registry_path = write_service.array_registry_path(path)
    entry_data = datasource_manager.get_entry(datasource, registry_path)
    if entry_data is None:
        return {"ok": False, "reason": write_service.REASON_BAD_PATH}
    identity, _document = authenticated
    if not write_service.write_permitted(identity, entry_data):
        return {"ok": False, "reason": "permission_denied"}
    outcome = await write_service.write_value(
        datasource_manager, _opcua_pool, datasource, path, value, field=field,
    )
    return {"ok": outcome.ok, "reason": outcome.reason}


@router.get("/{name}")
async def get_datasource(name: str, include_variables: bool = True) -> dict[str, Any]:
    """Get full config for a single datasource.

    Pass ``include_variables=false`` to omit the variable tree and get only
    settings — useful when the caller fetches variables separately.
    """
    entry = _require_datasource(name)
    if not include_variables:
        config = {k: v for k, v in entry.config.items() if k != "variables"}
        return config
    return entry.config


@router.get("/{name}/variables")
async def get_datasource_variables(name: str, simple: bool = True) -> dict[str, Any]:
    """Return only the variable tree for a datasource (no settings/certs).

    With ``simple=true`` (default, the HMI boundary used by the binding picker)
    variable ``data_type`` values are converted to simple types and
    ``is_array``/``array_length`` are preserved so the picker derives
    array-ness. With
    ``simple=false`` the raw OPC-UA types are returned unchanged — used by the
    config editor so it can show real types and round-trip them on save.
    """
    entry = _require_datasource(name)
    variables = entry.config.get("variables", [])
    if simple:
        variables = simplify_variable_tree(variables)
    return {"variables": variables}


@router.put("/{name}")
async def put_datasource(name: str, body: DatasourceUpsertBody) -> dict[str, Any]:
    """Create or update a datasource (settings + variables).

    Omitting ``variables`` from the body (e.g. a settings-only save from the
    properties panel) preserves the existing tree — see
    ``DatasourceUpsertBody.to_storage_dict`` (§1.5).
    """
    old_entry = datasource_manager.get(name)
    existing_variables = old_entry.config.get("variables") if old_entry is not None else None
    payload = body.to_storage_dict(name, existing_variables=existing_variables)
    if payload.get("type") == "static":
        validate_static_data_types(payload.get("variables") or [])

    # A full datasource PUT starts a new runtime generation. Clear every old
    # runtime before replacing its manager entry so an in-flight callback from
    # the old endpoint cannot seed the new cache. Then clear every old browser
    # key so same-path values cannot survive until a future datachange.
    if old_entry is not None:
        await _stop_datasource_runtime(name, old_entry.ds_type)
    await _broadcast_removed_keys(sorted(metadata_keys(old_entry)))
    datasource_manager.save(name, payload)
    await _sync_datasource_runtime(
        name,
        payload,
        old_entry,
        runtime_stopped=old_entry is not None,
    )
    new_entry = datasource_manager.get(name)
    await _broadcast_var_metadata()
    await _broadcast_current_values(new_entry)
    return payload


@router.delete("/{name}")
async def delete_datasource(name: str) -> dict[str, str]:
    """Delete a datasource and stop its connections."""
    entry = _require_datasource(name)
    await _stop_datasource_runtime(name, entry.ds_type)
    datasource_manager.delete(name)
    await _broadcast_removed_keys(sorted(metadata_keys(entry, name)))
    await _broadcast_var_metadata()
    return {"status": "deleted"}


@router.put("/{name}/variables")
async def put_variables(name: str, body: list[Any]) -> list[Any]:
    """Update only the variable tree for a datasource."""
    entry = _require_datasource(name)
    old_enabled = enabled_paths(entry)
    if entry.ds_type == "static":
        validate_static_data_types(body)

    config = {**entry.config, "variables": body}
    datasource_manager.save(name, config)

    new_entry = datasource_manager.get(name)
    if new_entry is None:
        return body

    removed_keys = await apply_subscription_delta(
        name, old_enabled, new_entry, _opcua_pool, _test_server_pool, entry,
    )
    await _broadcast_removed_keys(removed_keys)
    await _broadcast_var_metadata()
    await _broadcast_current_values(new_entry)
    return body


@router.get("/{name}/browse")
async def browse_datasource(name: str) -> Any:
    """Browse the OPC-UA server for a datasource."""
    entry = _require_datasource(name)
    if entry.ds_type not in ("opcua-client", "opcua-test-server"):
        raise DatasourceValidationError("Only OPC-UA datasources support browse")

    pool = _opcua_pool
    if not pool:
        raise HTTPException(status_code=503, detail="OPC-UA pool not available")
    engine = pool.get(name)
    if engine is None:
        raise HTTPException(status_code=503, detail=f"No active connection for '{name}'")
    if not engine.connected:
        raise HTTPException(status_code=503, detail=f"Datasource '{name}' is not connected")

    return await engine.browse()


# ── Test server lifecycle ─────────────────────────────────────────────────────

@router.post("/{name}/start")
async def start_datasource(name: str) -> dict[str, str]:
    """Start a test server or reconnect an OPC-UA client."""
    entry = _require_datasource(name)
    return await _run_datasource_action(name, entry, "start")


@router.post("/{name}/stop")
async def stop_datasource(name: str) -> dict[str, str]:
    """Stop a test server (and its paired client)."""
    entry = _require_datasource(name)
    if entry.ds_type != "opcua-test-server":
        raise DatasourceValidationError("Only test servers can be stopped")
    ts_pool = _require_test_server_pool()
    await ts_pool.stop(name)
    return {"status": "stopped"}


@router.post("/{name}/restart")
async def restart_datasource(name: str) -> dict[str, str]:
    """Restart a test server or reconnect an OPC-UA client."""
    entry = _require_datasource(name)
    return await _run_datasource_action(name, entry, "restart")


# ── Pool accessors (set during wiring in main.py) ────────────────────────────

_opcua_pool = None
_test_server_pool = None


def set_opcua_pool(pool: Any) -> None:
    global _opcua_pool
    _opcua_pool = pool


def set_test_server_pool(pool: Any) -> None:
    global _test_server_pool
    _test_server_pool = pool
