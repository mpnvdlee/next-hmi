"""
opcua.client_pool — OPC-UA connection pool.

Manages one OpcuaEngine per opcua-client datasource.
Each engine connects independently to its configured server and routes
datachange notifications through the DatasourceManager using composite keys.
"""

import asyncio
import contextlib
import datetime
import logging
import os
from pathlib import Path
from typing import Any

from asyncua import Client, ua
from asyncua.common.node import Node
from core.number_utils import get_config_float
from core.storage import active_project_root
from models.datasource import build_var_key, is_present_on_server, is_subscribable

from .compat import apply_asyncua_watchdog_log_patch

apply_asyncua_watchdog_log_patch()

logger = logging.getLogger(__name__)


# ── Security-string builder (shared by live connect + probe) ─────────────────

def _resolve_security_path(raw_path: str) -> str:
    """Resolve a datasource-relative cert/key path against the active project.

    Absolute-path settings are not supported — a datasource's cert/key
    settings are project-relative ``certs/...`` paths.
    """
    return str((active_project_root() / raw_path).resolve())


def _ensure_client_certificate(cert_path: str, key_path: str) -> None:
    """Generate a self-signed OPC-UA client certificate pair if it is missing.

    The dev/test project ships datasource configs that request a secured
    policy, so the client certificate pair is generated on first connect
    rather than committed — no private key lives in the repository. A
    deployment pointing a secured datasource at a real server should replace
    the generated pair with a server-trusted certificate of its own.
    """
    cert = Path(cert_path)
    key = Path(key_path)
    if cert.exists() and key.exists():
        return

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "DE"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "WebHMI"),
            x509.NameAttribute(NameOID.COMMON_NAME, "webhmi-opc-client"),
        ]
    )
    now = datetime.datetime.now(datetime.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(private_key, hashes.SHA256())
    )

    key_bytes = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    cert.parent.mkdir(parents=True, exist_ok=True)
    # Create the key unreadable to other users before any bytes land in it.
    descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(descriptor, key_bytes)
    finally:
        os.close(descriptor)
    os.chmod(key_path, 0o600)
    cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    logger.info("opcua: generated self-signed client certificate at %s", cert_path)


def _build_security_string(config: dict) -> str | None:
    """Build the asyncua ``set_security_string`` argument from settings.

    Returns ``None`` for ``NoSecurity`` (no secure channel). Raises when a
    secured policy is requested without a client certificate + key.
    """
    security_value = str(config.get("security_policy", "NoSecurity") or "NoSecurity")
    if security_value == "NoSecurity":
        return None

    security_mode = str(config.get("security_mode", "") or "")
    security_policy = security_value
    if ":" in security_value:
        maybe_mode, maybe_policy = security_value.split(":", 1)
        if maybe_mode in {"Sign", "SignAndEncrypt"} and maybe_policy:
            if not security_mode:
                security_mode = maybe_mode
            security_policy = maybe_policy
    if not security_mode:
        security_mode = "SignAndEncrypt"

    cert_path = str(config.get("client_certificate", "") or "")
    key_path = str(config.get("client_private_key", "") or "")
    key_password = str(config.get("client_private_key_password", "") or "")
    server_cert_path = str(config.get("server_certificate", "") or "")

    if not cert_path or not key_path:
        raise RuntimeError(
            "OPC security requires 'client_certificate' and 'client_private_key' settings",
        )

    cert = _resolve_security_path(cert_path)
    key = _resolve_security_path(key_path)
    if not key_password:
        _ensure_client_certificate(cert, key)
    if key_password:
        key = f"{key}::{key_password}"

    sec_parts = [security_policy, security_mode, cert, key]
    if server_cert_path:
        sec_parts.append(_resolve_security_path(server_cert_path))
    return ",".join(sec_parts)


# ── Discovery + connection probe (throwaway clients, pool-independent) ────────

def _normalize_discovery_url(address: str) -> str:
    """Coerce a host / host:port / full URL into an ``opc.tcp://`` endpoint."""
    addr = (address or "").strip()
    if not addr:
        return "opc.tcp://localhost:4840"
    if "://" not in addr:
        addr = f"opc.tcp://{addr}"
    scheme, _, rest = addr.partition("://")
    authority, slash, path = rest.partition("/")
    if authority and ":" not in authority:
        authority = f"{authority}:4840"
    return f"{scheme}://{authority}{slash}{path}"


def _policy_short_name(uri: str) -> str:
    """Map a SecurityPolicy URI to the short names the config UI uses."""
    if not uri:
        return "NoSecurity"
    suffix = uri.rsplit("#", 1)[-1]
    return "NoSecurity" if suffix == "None" else suffix


def _security_mode_name(mode: Any) -> str:
    try:
        name = ua.MessageSecurityMode(mode).name
    except Exception:
        name = str(mode)
    return "None" if name == "None_" else name


def _user_token_types(tokens: Any) -> list[str]:
    result: list[str] = []
    for tok in tokens or []:
        try:
            name = ua.UserTokenType(tok.TokenType).name
        except Exception:
            continue
        label = "Username" if name == "UserName" else name
        if label not in result:
            result.append(label)
    return result


def _short_probe_error(exc: Exception) -> str:
    if isinstance(exc, TimeoutError):
        return "Connection timed out"
    msg = str(exc).strip() or exc.__class__.__name__
    return msg[:300]


async def discover_endpoints(address: str, *, timeout_s: float = 5.0) -> dict:
    """Connect to a server (no session) and enumerate its endpoints.

    Returns ``{ok, error, endpoints}``; ``endpoints`` rows carry the endpoint
    URL, security mode/policy short-names, supported user-token types, and the
    server application name. Failures are reported as ``ok=False`` (never raised).
    """
    url = _normalize_discovery_url(address)
    client = Client(url, timeout=timeout_s)
    try:
        raw = await asyncio.wait_for(
            client.connect_and_get_server_endpoints(), timeout=timeout_s
        )
    except Exception as exc:  # surfaced to the caller as a string
        return {"ok": False, "error": _short_probe_error(exc), "endpoints": []}
    finally:
        with contextlib.suppress(Exception):
            await client.disconnect()

    endpoints: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    for ep in raw:
        server = getattr(ep, "Server", None)
        app_name = ""
        app_uri = ""
        if server is not None:
            name_field = getattr(server, "ApplicationName", None)
            app_name = getattr(name_field, "Text", "") or ""
            app_uri = getattr(server, "ApplicationUri", "") or ""
        row = {
            "endpoint_url": getattr(ep, "EndpointUrl", "") or url,
            "security_mode": _security_mode_name(getattr(ep, "SecurityMode", None)),
            "security_policy": _policy_short_name(getattr(ep, "SecurityPolicyUri", "") or ""),
            "user_tokens": _user_token_types(getattr(ep, "UserIdentityTokens", None)),
            "server_name": app_name,
            "application_uri": app_uri,
        }
        key = (row["endpoint_url"], row["security_mode"], row["security_policy"])
        if key in seen:
            continue
        seen.add(key)
        endpoints.append(row)
    return {"ok": True, "error": None, "endpoints": endpoints}


async def probe_connection(settings: dict, *, timeout_s: float = 5.0) -> dict:
    """Open a throwaway session to verify credentials/reachability.

    Uses the same security semantics as the live engine (NoSecurity unless a
    policy is chosen). Returns ``{ok, error, server_name, namespace_count}``.
    """
    url = str(settings.get("server_url", "opc.tcp://localhost:4840"))
    username = str(settings.get("username", "") or "")
    password = str(settings.get("password", "") or "")
    timeout = float(settings.get("connect_timeout_s", timeout_s) or timeout_s)
    client = Client(url, timeout=timeout)
    try:
        sec = _build_security_string(settings)
        if sec:
            await client.set_security_string(sec)
        if username:
            client.set_user(username)
            client.set_password(password)
        await asyncio.wait_for(client.connect(), timeout=timeout)
    except Exception as exc:  # surfaced to the caller as a string
        with contextlib.suppress(Exception):
            await client.disconnect()
        return {"ok": False, "error": _short_probe_error(exc), "server_name": None, "namespace_count": None}

    server_name: str | None = None
    namespace_count: int | None = None
    with contextlib.suppress(Exception):
        namespace_count = len(await client.get_namespace_array())
    try:
        node = client.get_node(ua.NodeId(ua.ObjectIds.Server_ServerStatus_BuildInfo_ProductName))
        value = await node.read_value()
        server_name = str(value) if value else None
    except Exception:
        pass
    with contextlib.suppress(Exception):
        await client.disconnect()
    return {"ok": True, "error": None, "server_name": server_name, "namespace_count": namespace_count}


class _DsSubHandler:
    """Datachange handler that routes updates through DatasourceManager."""

    def __init__(self, engine: "DatasourceOpcuaEngine") -> None:  # noqa: UP037 -- forward ref; file has no `from __future__ import annotations` and DatasourceOpcuaEngine is defined later, so unquoting NameErrors at import time under eager (pre-3.14) annotation evaluation
        self._engine = engine

    def datachange_notification(self, node, val, data) -> None:
        try:
            # Use the NodeId object directly as the dict key — NodeId implements __hash__
            # and __eq__, so this avoids the to_string() serialisation on every notification.
            node_id = node.nodeid
            dm = self._engine._datasource_manager
            if dm is None:
                return
            ds_name = self._engine.datasource_name
            if node_id in self._engine._node_to_path:
                path = self._engine._node_to_path[node_id]
                dm.update(ds_name, path, val, priority=self._engine._is_priority_path(path))
            elif node_id in self._engine._node_to_field:
                path, field_name, leaf_path = self._engine._node_to_field[node_id]
                dm.update_struct_field(
                    ds_name,
                    path,
                    field_name,
                    val,
                    leaf_path=leaf_path,
                    # Priority handles are tracked by their concrete monitored
                    # leaf paths, even when the user-facing binding targets a
                    # struct/folder aggregate.
                    priority=self._engine._is_priority_path(leaf_path),
                )
        except Exception as exc:
            logger.exception("Datachange callback failed for %s: %s", self._engine.datasource_name, exc)

    async def status_change_notification(self, status) -> None:
        sc = getattr(status, "Status", None)
        if sc is not None and not sc.is_good():
            logger.debug(
                "Subscription status change for %s: %s — scheduling reconnect",
                self._engine.datasource_name,
                sc,
            )
            # Tracked (not pure fire-and-forget) so disconnect() can cancel it
            # instead of leaving it to run against a torn-down engine (§2.5).
            self._engine._status_close_task = asyncio.create_task(self._engine._close_client())


def _collect_struct_leaf_paths(
    folder_entry: dict,
    folder_registry: dict,
    field_prefix: str = "",
) -> list[tuple[str, str]]:
    """Recursively collect (field_path, child_path) for all leaf variables in a struct folder.

    Follows ``_nested_fields`` (sub-struct sub-folders) so that folder-only structs
    (those with no direct variable children) are expanded correctly.
    ``field_path`` is a ``'/'``-joined path of nested field names
    (e.g. ``"stSignalRaw/bVisible"``), used when assembling nested result dicts.
    """
    result: list[tuple[str, str]] = []
    for child_path, field_name in folder_entry.get("_child_paths", {}).items():
        full = f"{field_prefix}/{field_name}" if field_prefix else field_name
        result.append((full, child_path))
    for nested_name, nested_fp in folder_entry.get("_nested_fields", {}).items():
        nested_entry = folder_registry.get(nested_fp)
        if nested_entry is not None:
            prefix = f"{field_prefix}/{nested_name}" if field_prefix else nested_name
            result.extend(_collect_struct_leaf_paths(nested_entry, folder_registry, prefix))
    return result


def _root_folder_paths(folder_registry: dict) -> set[str]:
    """Folders in *folder_registry* that are not nested inside another folder.

    Mirrors the boundary logic in DatasourceEntry._wire_ancestor_map: a folder
    reachable via another registered folder's ``_nested_fields`` or
    ``_element_paths`` is not itself a broadcast root — its leaves roll up
    into that ancestor's folder-level composite key.
    """
    nested_or_elem: set[str] = set()
    for fentry in folder_registry.values():
        nested_or_elem.update(fentry.get("_nested_fields", {}).values())
        nested_or_elem.update(fentry.get("_element_paths", []))
    return set(folder_registry.keys()) - nested_or_elem


def _struct_field_routes(ds_entry: Any) -> dict[str, tuple[str, str]]:
    """Map each struct/array-of-struct leaf variable path to the
    ``(root_folder_path, field_name)`` pair ``DatasourceManager.update_struct_field()``
    expects, so datachange notifications for that leaf can take the O(1)
    single-field patch path instead of a full folder rebuild.

    ``field_name`` is a plain key for a direct struct field, a ``"/"``-joined
    nested path (mirrors ``_collect_struct_leaf_paths``) for a nested
    sub-struct field, or an ``"idx:name"`` reference (mirrors the
    ``array_elem`` encoding in ``read_current_values``) for a direct field of
    an array-of-struct element. Fields nested *inside* an array-of-struct
    element are intentionally left unmapped — those leaves fall back to the
    existing full-rebuild path via ``_node_to_path``, same as before this
    routing existed.
    """
    folder_registry = ds_entry.folder_registry
    routes: dict[str, tuple[str, str]] = {}
    for folder_path in _root_folder_paths(folder_registry):
        fentry = folder_registry[folder_path]
        if fentry.get("_is_array"):
            for idx, elem_path in enumerate(fentry.get("_element_paths", [])):
                elem_entry = folder_registry.get(elem_path)
                if elem_entry is None:
                    continue
                for child_path, field_name in elem_entry.get("_child_paths", {}).items():
                    routes[child_path] = (folder_path, f"{idx}:{field_name}")
        else:
            for field_path, child_path in _collect_struct_leaf_paths(fentry, folder_registry):
                routes[child_path] = (folder_path, field_path)
    return routes


class DatasourceOpcuaEngine:
    """OPC-UA engine for a single datasource, using path-based variable keys."""

    def __init__(self, datasource_name: str) -> None:
        self.datasource_name = datasource_name
        self._client: Client | None = None
        self._connected = False
        self._reconnect_task: asyncio.Task | None = None
        self._shutdown = False
        # In-flight close, so a status-change-triggered close and the
        # reconnect loop's own close coalesce into one execution instead of
        # racing (§2.5).
        self._close_task: asyncio.Task | None = None
        # The fire-and-forget task status_change_notification schedules —
        # tracked so disconnect() can cancel it instead of leaving it to run
        # against a torn-down engine after shutdown (§2.5).
        self._status_close_task: asyncio.Task | None = None
        self._config: dict = {}
        self._datasource_manager = None
        self._status_callback = None
        self._priority_recompute_callback = None
        # Subscriptions
        self._background_sub = None
        self._priority_sub = None
        self._sub_handler: _DsSubHandler | None = None
        # Maps for routing datachange callbacks (keyed by NodeId object, not string)
        self._node_to_path: dict = {}       # NodeId → path
        self._node_to_field: dict = {}      # NodeId → (folder_path, field_name, leaf_path)
        # Reverse map: path → set[NodeId] for O(1) cleanup in remove_subscription_by_path
        self._path_to_node_ids: dict[str, set] = {}
        # Subscription handles per path
        self._bg_path_handles: dict[str, list] = {}
        self._priority_path_handles: dict[str, list] = {}
        # Serialises page-context recomputes (which can arrive concurrently from
        # different WebSocket clients) with dynamic add/remove transitions.
        self._subscription_transition_lock = asyncio.Lock()
        # Logical paths requested by clients (may include folder aggregates).
        # `_current_priority_paths` below contains only concrete leaf paths that
        # are actually live on the priority subscription.
        self._requested_priority_paths: set[str] = set()
        self._current_priority_paths: set[str] = set()
        self._requested_bg_publish_interval_ms = 1000.0
        self._requested_priority_publish_interval_ms = 50.0
        self._requested_priority_sampling_interval_ms = 20.0
        self._requested_priority_ws_batch_ms = 10.0
        self._revised_bg_publish_interval_ms: float | None = None
        self._revised_priority_publish_interval_ms: float | None = None
        self._priority_revised_sampling_count = 0
        self._priority_revised_sampling_sum_ms = 0.0
        self._priority_revised_sampling_min_ms: float | None = None
        self._priority_revised_sampling_max_ms: float | None = None

    @property
    def connected(self) -> bool:
        return self._connected

    def set_datasource_manager(self, dm: Any) -> None:
        self._datasource_manager = dm

    def set_status_callback(self, cb: Any) -> None:
        self._status_callback = cb

    def set_priority_recompute_callback(self, cb: Any) -> None:
        self._priority_recompute_callback = cb

    def _background_publish_interval_ms(self) -> float:
        return get_config_float(self._config, "bg_publish_interval_ms", 1000.0, minimum=250.0, maximum=60_000.0)

    def _priority_publish_interval_ms(self) -> float:
        return get_config_float(self._config, "priority_publish_interval_ms", 50.0, minimum=10.0, maximum=5_000.0)

    def _priority_sampling_interval_ms(self) -> float:
        return get_config_float(self._config, "priority_sampling_interval_ms", 20.0, minimum=0.0, maximum=5_000.0)

    def _priority_ws_batch_ms(self) -> float:
        return get_config_float(self._config, "priority_ws_batch_ms", 10.0, minimum=0.0, maximum=1_000.0)

    def _is_priority_path(self, path: str) -> bool:
        return path in self._priority_path_handles or path in self._current_priority_paths

    def _register_node_route(
        self, path: str, node_id: Any, field_routes: dict[str, tuple[str, str]],
    ) -> None:
        """Route *node_id*'s datachange notifications to the struct-field O(1)
        patch path (_node_to_field) when *path* is a struct/array-of-struct
        leaf, else the plain per-path scalar path (_node_to_path)."""
        route = field_routes.get(path)
        if route is not None:
            folder_path, field_name = route
            self._node_to_field[node_id] = (folder_path, field_name, path)
        else:
            self._node_to_path[node_id] = path

    @staticmethod
    def _expand_priority_paths(paths: set[str], ds_entry: Any) -> set[str]:
        """Resolve logical variable/folder bindings to monitored leaf paths.

        Keeping the transition state in this concrete namespace makes promote
        and demote symmetric: a struct folder that expands to ten monitored
        leaves is later demoted through those same ten keys instead of being
        skipped because the folder itself is not in ``registry``.
        """
        expanded: set[str] = set()
        for path in paths:
            if path in ds_entry.registry:
                expanded.add(path)
                continue
            folder_entry = ds_entry.folder_registry.get(path)
            if folder_entry is None:
                continue
            element_paths = folder_entry.get("_element_paths", [])
            sources = (
                [
                    ds_entry.folder_registry[element_path]
                    for element_path in element_paths
                    if element_path in ds_entry.folder_registry
                ]
                if element_paths
                else [folder_entry]
            )
            for source in sources:
                for _field_path, child_path in _collect_struct_leaf_paths(
                    source, ds_entry.folder_registry,
                ):
                    expanded.add(child_path)
        return expanded

    def _record_priority_revised_sampling(self, samples_ms: list[float]) -> None:
        """Track revised sampling intervals returned by server for priority monitored items."""
        for sample in samples_ms:
            try:
                value = float(sample)
            except (TypeError, ValueError):
                continue
            self._priority_revised_sampling_count += 1
            self._priority_revised_sampling_sum_ms += value
            if self._priority_revised_sampling_min_ms is None or value < self._priority_revised_sampling_min_ms:
                self._priority_revised_sampling_min_ms = value
            if self._priority_revised_sampling_max_ms is None or value > self._priority_revised_sampling_max_ms:
                self._priority_revised_sampling_max_ms = value

    def _priority_revised_sampling_avg_ms(self) -> float | None:
        if self._priority_revised_sampling_count <= 0:
            return None
        return self._priority_revised_sampling_sum_ms / self._priority_revised_sampling_count

    async def _subscribe_priority_nodes_with_revised_sampling(
        self,
        nodes: list[Node],
    ) -> tuple[list[Any], list[float]]:
        """Subscribe nodes on priority subscription and return handles + revised sampling."""
        sub = self._priority_sub
        if sub is None:
            return [], []

        handles = await sub.subscribe_data_change(
            nodes,
            sampling_interval=self._requested_priority_sampling_interval_ms,
        )

        revised_samples: list[float] = []
        for handle in handles:
            if isinstance(handle, ua.StatusCode):
                continue
            try:
                result = await sub.modify_monitored_item(
                    handle,
                    self._requested_priority_sampling_interval_ms,
                    new_queuesize=0,
                    mod_filter_val=-1,
                )
                if result and result[0].StatusCode.is_good():
                    revised_samples.append(float(result[0].RevisedSamplingInterval))
            except Exception as exc:
                logger.debug(
                    "Could not read revised sampling for %s/%s: %s",
                    self.datasource_name,
                    handle,
                    exc,
                )
        return handles, revised_samples

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def connect(self, config: dict) -> None:
        self._config = config
        self._shutdown = False
        self._reconnect_task = asyncio.create_task(self._reconnect_loop())

    async def disconnect(self) -> None:
        self._shutdown = True
        if self._reconnect_task:
            self._reconnect_task.cancel()
            with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(self._reconnect_task, timeout=5.0)
        if self._status_close_task is not None:
            self._status_close_task.cancel()
            with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(self._status_close_task, timeout=5.0)
            self._status_close_task = None
        await self._close_client()

    async def _close_client(self) -> None:
        """Close the current client, coalescing concurrent close requests.

        Both the reconnect loop's own health-check close and the
        subscription status-change callback's close route through here — if
        one is already in flight, later callers await that same task instead
        of each independently racing through teardown (§2.5).
        """
        if self._close_task is not None and not self._close_task.done():
            await self._close_task
            return
        self._close_task = asyncio.ensure_future(self._close_client_impl())
        try:
            await self._close_task
        finally:
            self._close_task = None

    async def _close_client_impl(self) -> None:
        await self._teardown_subscriptions()
        client = self._client
        self._client = None
        if client is not None:
            try:
                await client.disconnect()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("OPC-UA disconnect failed for %s: %s", self.datasource_name, exc)
        was_connected = self._connected
        self._connected = False
        if was_connected and self._status_callback is not None:
            await self._status_callback(self.datasource_name, False)

    async def _reconnect_loop(self) -> None:
        # §2.8: route through the same safe-fallback/clamp helper as the other
        # intervals — a blank/non-numeric value must not kill the reconnect
        # task, and 0/negative must not spin the loop without backoff.
        interval = get_config_float(self._config, "reconnect_interval_s", 5.0, minimum=1.0, maximum=300.0)
        while not self._shutdown:
            if not self._connected:
                try:
                    await self._do_connect()
                except Exception as exc:
                    logger.warning(
                        "OPC-UA connect failed for %s: %s", self.datasource_name, exc
                    )
                    await asyncio.sleep(interval)
                    continue
            await asyncio.sleep(interval)
            if self._connected and not self._shutdown:
                client = self._client
                if client is None:
                    await self._close_client()
                    continue
                try:
                    await client.get_namespace_array()
                except Exception:
                    logger.warning(
                        "OPC-UA connection lost for %s — retrying",
                        self.datasource_name,
                    )
                    await self._close_client()

    async def _do_connect(self) -> None:
        url = self._config.get("server_url", "opc.tcp://localhost:4840")
        username = self._config.get("username", "")
        password = self._config.get("password", "")
        client = Client(url)

        security_string = _build_security_string(self._config)
        if security_string:
            await client.set_security_string(security_string)

        if username:
            client.set_user(username)
            client.set_password(password)
        connect_timeout_s = float(self._config.get("connect_timeout_s", 10.0))
        await asyncio.wait_for(client.connect(), timeout=connect_timeout_s)
        self._client = client
        self._connected = True
        logger.info("OPC-UA connected: %s → %s", self.datasource_name, url)
        if self._status_callback is not None:
            await self._status_callback(self.datasource_name, True)
        try:
            await self._setup_subscriptions()
            # Re-apply priority paths that were requested before the OPC-UA connection
            # was ready.  set_priority_paths() is a no-op when not connected, so those
            # requests were silently dropped.  Apply them now.  Prefer the full
            # recompute (page-driven + alarm triggers + historized variables) so a
            # reconnect doesn't drop alarm/historian subscriptions until the next
            # browser navigation; fall back to the page-driven keys we can derive
            # locally when no recompute callback is wired (e.g. in tests).
            if self._priority_recompute_callback is not None:
                await self._priority_recompute_callback()
            else:
                dm = self._datasource_manager
                if dm is not None:
                    priority_paths: set[str] = set()
                    for key in dm.get_priority_keys():
                        sep = key.find(":")
                        if sep > 0 and key[:sep] == self.datasource_name:
                            path = key[sep + 1:]
                            if path:
                                priority_paths.add(path)
                    if priority_paths:
                        await self.set_priority_paths(priority_paths)
        except Exception:
            # Subscription setup failed after a successful TCP connect. Reset
            # state so the reconnect loop's `if not self._connected` check
            # actually retries next iteration, instead of reporting a healthy
            # connection with zero working subscriptions forever (§2.4).
            await self._close_client()
            raise

    # ── Browse ────────────────────────────────────────────────────────────────

    async def browse(self, node_id: str | None = None) -> dict:
        client = self._client
        if not self._connected or client is None:
            raise RuntimeError(f"Not connected: {self.datasource_name}")
        configured_root = node_id or self._config.get("browse_root_node") or None
        node: Node = (
            client.get_node(configured_root) if configured_root
            else client.get_objects_node()
        )
        result = await self._browse_node(node)
        result["show_root"] = configured_root is not None
        return result

    # ── Batched browse helpers ────────────────────────────────────────────────

    async def _batch_browse_nodes(
        self, nodes: list[Node], chunk_size: int = 100
    ) -> list[list[ua.ReferenceDescription]]:
        """Browse multiple parent nodes using one Browse request per chunk.

        The OPC-UA Browse service accepts a list of BrowseDescriptions and
        returns one BrowseResult per entry, so a single request suffices for
        all nodes at a given BFS level.  Continuation points are handled
        per-slot so no references are lost when the server splits results.
        """
        all_refs: list[list[ua.ReferenceDescription]] = [[] for _ in nodes]
        for start in range(0, len(nodes), chunk_size):
            chunk = nodes[start : start + chunk_size]
            params = ua.BrowseParameters()
            params.RequestedMaxReferencesPerNode = 0
            params.View.Timestamp = ua.get_win_epoch()
            for n in chunk:
                desc = ua.BrowseDescription()
                desc.NodeId = n.nodeid
                desc.BrowseDirection = ua.BrowseDirection.Forward
                desc.ReferenceTypeId = ua.NodeId(ua.ObjectIds.HierarchicalReferences)
                desc.IncludeSubtypes = True
                desc.NodeClassMask = ua.NodeClass.Unspecified
                # BrowseResultMask.All returns NodeClass + DisplayName for free
                desc.ResultMask = ua.BrowseResultMask.All
                params.NodesToBrowse.append(desc)
            results = await self._client.uaclient.browse(params)
            for slot, result in enumerate(results):
                all_refs[start + slot].extend(result.References)
            # Handle continuation points per slot
            pending = [
                (start + i, r.ContinuationPoint)
                for i, r in enumerate(results)
                if r.ContinuationPoint
            ]
            while pending:
                next_params = ua.BrowseNextParameters()
                next_params.ReleaseContinuationPoints = False
                next_params.ContinuationPoints = [cp for _, cp in pending]
                indices = [idx for idx, _ in pending]
                next_results = await self._client.uaclient.browse_next(next_params)
                pending = []
                for idx, result in zip(indices, next_results, strict=False):
                    all_refs[idx].extend(result.References)
                    if result.ContinuationPoint:
                        pending.append((idx, result.ContinuationPoint))
        return all_refs

    async def _batch_read_var_attrs(
        self, node_ids: list[ua.NodeId], chunk_size: int = 300
    ) -> list[tuple[str, bool, int]]:
        """Batch-read DataType, ValueRank, ArrayDimensions and AccessLevel for a
        list of variable NodeIds.

        Returns (data_type_name, writable, array_length) per input NodeId.
        array_length is 0 for scalars; for 1-D arrays with a known fixed size it
        contains that size.  All reads are issued in a single ReadRequest per
        chunk — far fewer round-trips than reading one node at a time.

        DataType resolution is done purely from the returned NodeId:
          - ns=0, identifier 1..25  → ua.VariantType(id).name (no extra RPC)
          - ns=0, identifier 29     → "Int32"  (enumeration canonical type)
          - anything else           → "struct"
        """
        if not node_ids:
            return []
        _WRITE_BIT = 1 << int(ua.AccessLevel.CurrentWrite)  # bit 1 = 0x02
        # 4 attributes per node: DataType, ValueRank, ArrayDimensions, AccessLevel
        _ATTRS = (
            ua.AttributeIds.DataType,
            ua.AttributeIds.ValueRank,
            ua.AttributeIds.ArrayDimensions,
            ua.AttributeIds.AccessLevel,
        )
        _N = len(_ATTRS)
        results_all: list[tuple[str, bool, int]] = []
        for start in range(0, len(node_ids), chunk_size):
            chunk = node_ids[start : start + chunk_size]
            params = ua.ReadParameters()
            params.MaxAge = 0
            params.TimestampsToReturn = ua.TimestampsToReturn.Neither
            for nid in chunk:
                for attr_id in _ATTRS:
                    rv = ua.ReadValueId()
                    rv.NodeId = nid
                    rv.AttributeId = attr_id
                    params.NodesToRead.append(rv)
            results = await self._client.uaclient.read(params)
            for i in range(len(chunk)):
                dt_dv = results[i * _N]
                vr_dv = results[i * _N + 1]
                ad_dv = results[i * _N + 2]
                al_dv = results[i * _N + 3]
                data_type = "Unknown"
                try:
                    if dt_dv.StatusCode.is_good() and dt_dv.Value is not None:
                        dt_nid: ua.NodeId = dt_dv.Value.Value
                        if (
                            isinstance(dt_nid, ua.NodeId)
                            and dt_nid.NamespaceIndex == 0
                            and isinstance(dt_nid.Identifier, int)
                        ):
                            ident = dt_nid.Identifier
                            if 1 <= ident <= 25:
                                data_type = ua.VariantType(ident).name
                            elif ident == 29:
                                data_type = "Int32"  # enumeration
                            else:
                                data_type = "struct"
                        else:
                            data_type = "struct"
                except Exception:
                    pass
                writable = False
                try:
                    if al_dv.StatusCode.is_good() and al_dv.Value is not None:
                        writable = bool(al_dv.Value.Value & _WRITE_BIT)
                except Exception:
                    pass
                # Determine array_length from ValueRank + ArrayDimensions.
                # ValueRank == 1 means a 1-D array.  array_length encodes:
                #   -1  → scalar (ValueRank != 1)
                #    0  → 1-D array of unknown/dynamic size (no ArrayDimensions)
                #   >0  → 1-D array with known fixed size
                array_length = -1
                try:
                    if vr_dv.StatusCode.is_good() and vr_dv.Value is not None:
                        value_rank = vr_dv.Value.Value
                        if value_rank == 1:
                            array_length = 0  # is a 1-D array; size may be unknown
                            if ad_dv.StatusCode.is_good() and ad_dv.Value is not None:
                                dims = ad_dv.Value.Value
                                if dims and len(dims) == 1 and dims[0] > 0:
                                    array_length = int(dims[0])
                except Exception:
                    pass
                results_all.append((data_type, writable, array_length))
        return results_all

    async def _browse_node(self, node: Node) -> dict[str, Any]:
        """BFS browse: ~2 round-trips per tree level instead of 5 per node.

        Browse returns NodeClass + DisplayName for each child for free
        (BrowseResultMask.All).  A separate bulk Read fetches DataType and
        AccessLevel only for Variable nodes at each level.
        """
        # ── Bootstrap: read root's own DisplayName + NodeClass ────────────────
        try:
            params = ua.ReadParameters()
            params.TimestampsToReturn = ua.TimestampsToReturn.Neither
            for attr_id in (ua.AttributeIds.DisplayName, ua.AttributeIds.NodeClass):
                rv = ua.ReadValueId()
                rv.NodeId = node.nodeid
                rv.AttributeId = attr_id
                params.NodesToRead.append(rv)
            root_results = await self._client.uaclient.read(params)
            root_dn = root_results[0].Value.Value.Text if root_results[0].Value else ""
            root_nc = root_results[1].Value.Value if root_results[1].Value else ua.NodeClass.Unspecified
        except Exception:
            root_dn = node.nodeid.to_string()
            root_nc = ua.NodeClass.Unspecified

        root_entry: dict[str, Any] = {
            "node_id": node.nodeid.to_string(),
            "display_name": root_dn or node.nodeid.to_string(),
            "data_type": None,
            "children": [],
        }
        if root_nc == ua.NodeClass.Variable:
            try:
                attrs = await self._batch_read_var_attrs([node.nodeid])
                dt, wr, al = attrs[0]
                root_entry["data_type"] = dt
                root_entry["writable"] = wr
                if al >= 0:  # 0 = dynamic array, >0 = fixed array, -1 = scalar
                    root_entry["is_array"] = True
                    if al > 0:
                        root_entry["array_length"] = al
            except Exception:
                root_entry["data_type"] = "Unknown"
                root_entry["writable"] = False
            return root_entry

        # ── BFS: one Browse + one Read per level ──────────────────────────────
        visited: set[str] = {node.nodeid.to_string()}
        queue: list[tuple[Node, dict]] = [(node, root_entry)]
        while queue:
            parent_nodes = [n for n, _ in queue]
            try:
                batch_refs = await self._batch_browse_nodes(parent_nodes)
            except Exception as exc:
                logger.warning(
                    "Batch browse failed for %s: %s — skipping level",
                    self.datasource_name, exc,
                )
                break

            next_queue: list[tuple[Node, dict]] = []
            var_node_ids: list[ua.NodeId] = []
            var_entries: list[dict] = []

            for (_, parent_entry), refs in zip(queue, batch_refs, strict=False):
                for ref in refs:
                    cid_str = ref.NodeId.to_string()
                    if cid_str in visited:
                        continue
                    visited.add(cid_str)
                    child_entry: dict[str, Any] = {
                        "node_id": cid_str,
                        "display_name": (ref.DisplayName.Text or cid_str),
                        "data_type": None,
                        "children": [],
                    }
                    parent_entry["children"].append(child_entry)
                    if ref.NodeClass == ua.NodeClass.Variable:
                        var_node_ids.append(ref.NodeId)
                        var_entries.append(child_entry)
                    else:
                        next_queue.append(
                            (Node(self._client.uaclient, ref.NodeId), child_entry)
                        )

            if var_node_ids:
                try:
                    attrs = await self._batch_read_var_attrs(var_node_ids)
                    for entry, (dt, wr, al) in zip(var_entries, attrs, strict=False):
                        entry["data_type"] = dt
                        entry["writable"] = wr
                        if al >= 0:  # 0 = dynamic array, >0 = fixed array, -1 = scalar
                            entry["is_array"] = True
                            if al > 0:
                                entry["array_length"] = al
                except Exception as exc:
                    logger.warning(
                        "Batch read var attrs failed for %s: %s",
                        self.datasource_name, exc,
                    )
                    for entry in var_entries:
                        entry["data_type"] = "Unknown"

            queue = next_queue
        return root_entry

    # ── Subscriptions ─────────────────────────────────────────────────────────

    def _make_sub_params(
        self, interval_ms: float, priority: int
    ) -> ua.CreateSubscriptionParameters:
        """Build CreateSubscriptionParameters with explicit priority.

        Priority 0   = background (lowest).
        Priority 200 = active-page fast subscription (server sends these first
        during backpressure, reducing display latency for operator-facing values).

        MaxNotificationsPerPublish = 0 means unlimited per OPC-UA spec § 5.13.2.
        asyncua's default of 10000 can silently truncate when many variables
        change simultaneously.
        """
        params = ua.CreateSubscriptionParameters()
        params.RequestedPublishingInterval = interval_ms
        params.RequestedLifetimeCount = 10000
        # Keep-alive: send a heartbeat after ~30 s of silence
        params.RequestedMaxKeepAliveCount = max(3, int(30_000 / max(interval_ms, 1)))
        params.MaxNotificationsPerPublish = 0  # 0 = unlimited
        params.PublishingEnabled = True
        params.Priority = priority
        return params

    async def _setup_subscriptions(self) -> None:
        async with self._subscription_transition_lock:
            await self._setup_subscriptions_locked()

    async def _setup_subscriptions_locked(self) -> None:
        dm = self._datasource_manager
        if dm is None or self._client is None:
            return
        self._sub_handler = _DsSubHandler(self)
        disable_bg = bool(self._config.get("disable_background_sync", False))
        bg_interval = self._background_publish_interval_ms()
        priority_interval = self._priority_publish_interval_ms()
        priority_sampling = self._priority_sampling_interval_ms()
        self._requested_bg_publish_interval_ms = bg_interval
        self._requested_priority_publish_interval_ms = priority_interval
        self._requested_priority_sampling_interval_ms = priority_sampling
        self._requested_priority_ws_batch_ms = self._priority_ws_batch_ms()
        self._priority_revised_sampling_count = 0
        self._priority_revised_sampling_sum_ms = 0.0
        self._priority_revised_sampling_min_ms = None
        self._priority_revised_sampling_max_ms = None
        if not disable_bg:
            self._background_sub = await self._client.create_subscription(
                self._make_sub_params(bg_interval, priority=0), self._sub_handler,
            )
            self._revised_bg_publish_interval_ms = float(
                self._background_sub.parameters.RequestedPublishingInterval,
            )
        self._priority_sub = await self._client.create_subscription(
            self._make_sub_params(priority_interval, priority=200), self._sub_handler,
        )
        self._revised_priority_publish_interval_ms = float(
            self._priority_sub.parameters.RequestedPublishingInterval,
        )
        self._node_to_path.clear()
        self._node_to_field.clear()
        self._path_to_node_ids.clear()
        self._bg_path_handles.clear()
        self._priority_path_handles.clear()
        self._current_priority_paths.clear()

        ds_entry = dm.get(self.datasource_name)
        if ds_entry is None:
            return

        field_routes = _struct_field_routes(ds_entry)

        if not disable_bg:
            # Collect all enabled (path, node) pairs first, then batch-subscribe
            # in chunks so we send one CreateMonitoredItems request per chunk
            # instead of one per variable — much faster for large variable trees.
            enabled_items: list[tuple[str, Any]] = []
            for path, var_entry in ds_entry.registry.items():
                if not is_subscribable(var_entry):
                    continue
                node_id = var_entry.get("node_id", "")
                if not node_id:
                    continue
                enabled_items.append((path, self._client.get_node(node_id)))

            chunk_size = 500
            for i in range(0, len(enabled_items), chunk_size):
                chunk = enabled_items[i : i + chunk_size]
                nodes = [node for _, node in chunk]
                try:
                    # sampling_interval=-1 → server samples at the publishing interval,
                    # not the asyncua default of 50 ms.  For 500 variables at 1000 ms
                    # this saves the server ~20x unnecessary sampling work.
                    handles = await self._background_sub.subscribe_data_change(
                        nodes, sampling_interval=-1,
                    )
                    if not isinstance(handles, list):
                        handles = [handles]
                    for (path, node), handle in zip(chunk, handles, strict=False):
                        # handle may be ua.StatusCode when the server refuses a node
                        if isinstance(handle, ua.StatusCode):
                            logger.warning(
                                "Subscribe rejected for %s/%s: %s",
                                self.datasource_name, path, handle,
                            )
                            continue
                        self._bg_path_handles[path] = [handle]
                        nid = node.nodeid
                        self._register_node_route(path, nid, field_routes)
                        self._path_to_node_ids.setdefault(path, set()).add(nid)
                except Exception as exc:
                    logger.warning(
                        "Batch subscribe failed for %s (chunk %d): %s — falling back to per-path",
                        self.datasource_name, i // chunk_size, exc,
                    )
                    for path, _node in chunk:
                        var_entry = ds_entry.registry.get(path, {})
                        await self._subscribe_path(path, var_entry, ds_entry, field_routes)

        logger.info(
            "Subscriptions set up for %s: bg requested=%sms revised=%sms enabled=%s, "
            "priority requested=%sms revised=%sms sampling requested=%sms revised avg/min/max=%s/%s/%s, bg paths=%d",
            self.datasource_name,
            self._requested_bg_publish_interval_ms,
            self._revised_bg_publish_interval_ms,
            not disable_bg,
            self._requested_priority_publish_interval_ms,
            self._revised_priority_publish_interval_ms,
            self._requested_priority_sampling_interval_ms,
            self._priority_revised_sampling_avg_ms(),
            self._priority_revised_sampling_min_ms,
            self._priority_revised_sampling_max_ms,
            len(self._bg_path_handles),
        )

    async def _subscribe_path(
        self,
        path: str,
        var_entry: dict,
        ds_entry: Any,
        field_routes: dict[str, tuple[str, str]] | None = None,
    ) -> None:
        """Subscribe a single variable path to the background subscription (fallback/dynamic)."""
        if path in self._bg_path_handles:
            # Already tracked (e.g. a reconnect's full resync racing an
            # independent enable-variable call) — reuse it instead of
            # creating a duplicate monitored item and leaking the existing
            # handle, which would double-deliver every datachange (§2.3).
            return
        try:
            node_id = var_entry.get("node_id", "")
            if not node_id:
                return
            node = self._client.get_node(node_id)
            handles = await self._background_sub.subscribe_data_change(
                [node], sampling_interval=-1,
            )
            if not isinstance(handles, list):
                handles = [handles]
            valid = [h for h in handles if not isinstance(h, ua.StatusCode)]
            if not valid:
                return
            self._bg_path_handles[path] = valid
            nid = node.nodeid
            routes = field_routes if field_routes is not None else _struct_field_routes(ds_entry)
            self._register_node_route(path, nid, routes)
            self._path_to_node_ids.setdefault(path, set()).add(nid)
        except Exception as exc:
            logger.warning(
                "Failed to subscribe %s/%s: %s", self.datasource_name, path, exc,
            )

    async def _teardown_subscriptions(self) -> None:
        async with self._subscription_transition_lock:
            await self._teardown_subscriptions_locked()

    async def _teardown_subscriptions_locked(self) -> None:
        for sub in (self._background_sub, self._priority_sub):
            if sub is not None:
                with contextlib.suppress(Exception):
                    await sub.delete()
        self._background_sub = None
        self._priority_sub = None
        self._sub_handler = None
        self._node_to_path.clear()
        self._node_to_field.clear()
        self._path_to_node_ids.clear()
        self._bg_path_handles.clear()
        self._priority_path_handles.clear()
        self._current_priority_paths.clear()

    # ── Write ─────────────────────────────────────────────────────────────────

    async def write_node(self, node_id: str, value: Any, variant_type: ua.VariantType | None = None) -> None:
        if not self._connected or self._client is None:
            raise RuntimeError(f"Not connected: {self.datasource_name}")
        node = self._client.get_node(node_id)
        if variant_type is not None:
            await node.write_value(ua.Variant(value, variant_type))
            return
        await node.write_value(value)

    async def read_current_values(self, paths: set[str]) -> dict[str, Any]:
        """Bulk-read current values for requested paths and folder structs."""
        if not paths or not self._connected or self._client is None:
            return {}
        dm = self._datasource_manager
        if dm is None:
            return {}
        ds_entry = dm.get(self.datasource_name)
        if ds_entry is None:
            return {}

        requests: list[tuple[str, str, str | None, Node]] = []
        for path in sorted(paths):
            folder_entry = ds_entry.folder_registry.get(path)
            if folder_entry is not None:
                if folder_entry.get("_is_array"):
                    # Array-of-struct: collect leaves from every element subfolder.
                    # Each element is tracked as ("array_elem", array_folder_path,
                    # elem_index, elem_path, field_name, node).
                    for elem_idx, elem_path in enumerate(folder_entry.get("_element_paths", [])):
                        elem_entry = ds_entry.folder_registry.get(elem_path)
                        if elem_entry is None:
                            continue
                        for field_name, child_path in _collect_struct_leaf_paths(
                            elem_entry, ds_entry.folder_registry,
                        ):
                            child_entry = ds_entry.registry.get(child_path)
                            if not child_entry or not is_subscribable(child_entry):
                                continue
                            node_id = child_entry.get("node_id", "")
                            if not node_id:
                                continue
                            requests.append(
                                ("array_elem", path, f"{elem_idx}:{field_name}", self._client.get_node(node_id))
                            )
                else:
                    for field_path, child_path in _collect_struct_leaf_paths(folder_entry, ds_entry.folder_registry):
                        child_entry = ds_entry.registry.get(child_path)
                        if not child_entry or not is_subscribable(child_entry):
                            continue
                        node_id = child_entry.get("node_id", "")
                        if not node_id:
                            continue
                        requests.append(("struct", path, field_path, self._client.get_node(node_id)))
                continue

            entry = ds_entry.registry.get(path)
            if not entry or not is_subscribable(entry):
                continue
            node_id = entry.get("node_id", "")
            if not node_id:
                continue
            requests.append(("scalar", path, None, self._client.get_node(node_id)))

        if not requests:
            return {}

        values = await self._client.read_values([node for _, _, _, node in requests])
        result: dict[str, Any] = {}
        for (kind, path, field_name, _node), value in zip(requests, values, strict=False):
            coerced = dm._coerce(value)
            key = build_var_key(self.datasource_name, path)
            if kind == "struct" and field_name is not None:
                fields = result.get(key)
                if not isinstance(fields, dict):
                    fields = {}
                    result[key] = fields
                # field_name may be a '/'-separated path for nested structs
                # (e.g. "stSignalRaw/bVisible"); build the nested dict accordingly.
                parts = field_name.split("/")
                d: dict = fields
                for part in parts[:-1]:
                    if not isinstance(d.get(part), dict):
                        d[part] = {}
                    d = d[part]
                d[parts[-1]] = coerced
                continue
            if kind == "array_elem" and field_name is not None:
                # field_name is encoded as "elem_idx:field_name"
                sep = field_name.index(":")
                elem_idx = int(field_name[:sep])
                actual_field = field_name[sep + 1:]
                arr = result.get(key)
                if not isinstance(arr, list):
                    arr = []
                    result[key] = arr
                while len(arr) <= elem_idx:
                    arr.append({})
                parts = actual_field.split("/")
                target = arr[elem_idx]
                for part in parts[:-1]:
                    if not isinstance(target.get(part), dict):
                        target[part] = {}
                    target = target[part]
                target[parts[-1]] = coerced
                continue
            result[key] = coerced

        # Indexed struct[] bindings read a concrete element key. Include those
        # keys in bulk reads/prefetches, not only in later subscription updates,
        # so context_ready genuinely means the indexed value is available.
        for path in paths:
            folder_entry = ds_entry.folder_registry.get(path)
            if folder_entry is None or not folder_entry.get("_is_array"):
                continue
            aggregate = result.get(build_var_key(self.datasource_name, path))
            if not isinstance(aggregate, list):
                continue
            for index, elem_path in enumerate(folder_entry.get("_element_paths", [])):
                if index >= len(aggregate):
                    break
                result[build_var_key(self.datasource_name, elem_path)] = dm._snapshot_copy(
                    aggregate[index]
                )
        return result

    # ── Dynamic subscribe/unsubscribe (for variable enable/disable) ───────────

    async def add_subscription_by_path(
        self, path: str, ds_entry: Any,
    ) -> None:
        async with self._subscription_transition_lock:
            if not self._connected or self._background_sub is None:
                return
            var_entry = ds_entry.registry.get(path)
            if not var_entry:
                return
            await self._subscribe_path(path, var_entry, ds_entry)

    async def remove_subscription_by_path(self, ds_name: str, path: str) -> bool:
        """Remove every monitored item for *path* without losing failed handles.

        Returns true only when no background/priority handle remains. Callers
        changing a node identity use this to avoid subscribing the replacement
        alongside an old item whose unsubscribe RPC failed.
        """
        async with self._subscription_transition_lock:
            return await self._remove_subscription_by_path_locked(ds_name, path)

    async def _remove_subscription_by_path_locked(self, ds_name: str, path: str) -> bool:
        bg_handles = self._bg_path_handles.get(path)
        if bg_handles:
            try:
                if self._background_sub is not None:
                    await self._background_sub.unsubscribe(bg_handles)
                    self._bg_path_handles.pop(path, None)
            except Exception as exc:
                logger.warning("remove_subscription failed for %s/%s: %s", ds_name, path, exc)
        priority_handles = self._priority_path_handles.get(path)
        if priority_handles:
            try:
                if self._priority_sub is not None:
                    await self._priority_sub.unsubscribe(priority_handles)
                    self._priority_path_handles.pop(path, None)
            except Exception as exc:
                logger.warning("remove priority sub failed for %s/%s: %s", ds_name, path, exc)
        if path in self._bg_path_handles or path in self._priority_path_handles:
            self._current_priority_paths = set(self._priority_path_handles)
            return False
        # Clean up node routing maps — only remove NodeIds not referenced by other paths
        for nid in self._path_to_node_ids.pop(path, ()):
            still_referenced = any(
                nid in nids
                for p, nids in self._path_to_node_ids.items()
                if p != path
            )
            if not still_referenced:
                self._node_to_path.pop(nid, None)
                self._node_to_field.pop(nid, None)
        self._current_priority_paths = set(self._priority_path_handles)
        return True

    # ── Priority management ───────────────────────────────────────────────────

    async def set_priority_paths(self, paths: set[str]) -> None:
        """Serialise priority transitions for this datasource."""
        async with self._subscription_transition_lock:
            await self._set_priority_paths_locked(paths)

    async def _set_priority_paths_locked(self, paths: set[str]) -> None:
        """Promote paths to priority subscription, demote the rest.

        Uses bulk OPC-UA calls (one DeleteMonitoredItems + one CreateMonitoredItems
        per direction) instead of one call per variable, so a page switch with
        N active variables costs 4 round-trips regardless of N.
        """
        if not self._connected or self._priority_sub is None:
            return
        dm = self._datasource_manager
        if dm is None:
            return
        ds_entry = dm.get(self.datasource_name)
        if ds_entry is None:
            return

        self._requested_priority_paths = set(paths)
        desired_leaf_paths = self._expand_priority_paths(paths, ds_entry)
        field_routes = _struct_field_routes(ds_entry)

        # Handle tracking is the authoritative actual state. Failed operations
        # therefore remain a delta and are retried by the next recompute.
        actual_priority_paths = set(self._priority_path_handles)
        to_promote = desired_leaf_paths - actual_priority_paths
        to_demote = actual_priority_paths - desired_leaf_paths

        # ── Batch promote: bg → priority ──────────────────────────────────────
        # Visible page bindings should be promotable even when they are not part of
        # the datasource's background-enabled set. Stale vars (present_on_server=False)
        # are skipped: subscribing to them only generates "Subscribe rejected" warnings.
        promote_items: list[tuple[str, Any]] = []   # (path, node)
        for path in to_promote:
            entry = ds_entry.registry.get(path)
            if not entry:
                continue
            if not is_present_on_server(entry):
                continue
            node_id = entry.get("node_id", "")
            if not node_id:
                continue
            promote_items.append((path, self._client.get_node(node_id)))

        if promote_items:
            # 1. Bulk-unsubscribe from background (one DeleteMonitoredItems call)
            bg_handles_to_remove: list[Any] = []
            for path, _ in promote_items:
                bg_handles_to_remove.extend(self._bg_path_handles.get(path, []))
            bg_unsubscribe_ok = True
            if bg_handles_to_remove and self._background_sub is not None:
                try:
                    await self._background_sub.unsubscribe(bg_handles_to_remove)
                    for path, _ in promote_items:
                        self._bg_path_handles.pop(path, None)
                except Exception as exc:
                    logger.warning("Bulk bg-unsubscribe failed for %s: %s", self.datasource_name, exc)
                    bg_unsubscribe_ok = False

            # 2. Bulk-subscribe to priority (one CreateMonitoredItems call) —
            # only once the background side is actually cleared, so a node is
            # never live on both subscriptions at once (§2.2). On failure the
            # nodes simply stay on the background sub (no data loss) instead
            # of also landing on the priority sub.
            if bg_unsubscribe_ok:
                nodes = [node for _, node in promote_items]
                try:
                    handles, revised_samples = await self._subscribe_priority_nodes_with_revised_sampling(
                        nodes,
                    )
                    self._record_priority_revised_sampling(revised_samples)
                    for (path, node), handle in zip(promote_items, handles, strict=False):
                        if isinstance(handle, ua.StatusCode):
                            logger.warning("Promote rejected for %s/%s: %s", self.datasource_name, path, handle)
                            continue
                        self._priority_path_handles[path] = [handle]
                        # Always register NodeId routing here — when disable_background_sync=True
                        # _setup_subscriptions never populates _node_to_path/_node_to_field, so
                        # without this the datachange_notification callback silently drops every
                        # priority-sub value.
                        nid = node.nodeid
                        self._register_node_route(path, nid, field_routes)
                        self._path_to_node_ids.setdefault(path, set()).add(nid)
                except Exception as exc:
                    logger.warning("Bulk promote failed for %s: %s — retrying per-path", self.datasource_name, exc)
                    for path, node in promote_items:
                        try:
                            handles, revised_samples = await self._subscribe_priority_nodes_with_revised_sampling(
                                [node],
                            )
                            self._record_priority_revised_sampling(revised_samples)
                            handles_list = [x for x in handles if isinstance(x, int)]
                            if not handles_list:
                                continue
                            self._priority_path_handles[path] = handles_list
                            nid = node.nodeid
                            self._register_node_route(path, nid, field_routes)
                            self._path_to_node_ids.setdefault(path, set()).add(nid)
                        except Exception as e2:
                            logger.warning("Per-path promote failed %s/%s: %s", self.datasource_name, path, e2)
            else:
                logger.warning(
                    "Skipping priority promote for %s (bg-unsubscribe failed) — nodes stay on background sub",
                    self.datasource_name,
                )

            # A successful bg-unsubscribe followed by rejected/failed priority
            # creation must not leave an enabled variable with no monitored item.
            for path, _node in promote_items:
                if path in self._priority_path_handles or path in self._bg_path_handles:
                    continue
                entry = ds_entry.registry.get(path)
                if entry is not None and is_subscribable(entry) and self._background_sub is not None:
                    await self._subscribe_path(path, entry, ds_entry, field_routes)

        # ── Batch demote: priority → bg ───────────────────────────────────────
        demote_items: list[tuple[str, Any]] = []   # (path, node) — only enabled vars
        demote_paths_no_bg: list[str] = []          # disabled — just remove handles
        for path in to_demote:
            entry = ds_entry.registry.get(path)
            if not entry:
                continue
            if is_subscribable(entry) and self._background_sub is not None:
                node_id = entry.get("node_id", "")
                if node_id:
                    demote_items.append((path, self._client.get_node(node_id)))
                    continue
            demote_paths_no_bg.append(path)

        if demote_items or demote_paths_no_bg:
            # 1. Bulk-unsubscribe from priority. Don't discard tracking until
            # the RPC actually succeeds (§2.1) — on failure the items stay
            # tracked as priority (retryable/cleanable later) and step 2 is
            # skipped so a node is never live on both subscriptions at once.
            demote_paths_all = [p for p, _ in demote_items] + list(demote_paths_no_bg)
            prio_handles_to_remove: list[Any] = []
            for path in demote_paths_all:
                prio_handles_to_remove.extend(self._priority_path_handles.get(path, []))
            prio_unsubscribe_ok = True
            if prio_handles_to_remove:
                try:
                    await self._priority_sub.unsubscribe(prio_handles_to_remove)
                    for path in demote_paths_all:
                        self._priority_path_handles.pop(path, None)
                except Exception as exc:
                    logger.warning("Bulk prio-unsubscribe failed for %s: %s", self.datasource_name, exc)
                    prio_unsubscribe_ok = False

            # 2. Bulk-resubscribe to background — only after the priority
            # side was actually cleared.
            if demote_items and prio_unsubscribe_ok:
                nodes = [node for _, node in demote_items]
                try:
                    handles = await self._background_sub.subscribe_data_change(
                        nodes, sampling_interval=-1,
                    )
                    if not isinstance(handles, list):
                        handles = [handles]
                    for (path, _), handle in zip(demote_items, handles, strict=False):
                        if isinstance(handle, ua.StatusCode):
                            logger.warning("Demote-resub rejected for %s/%s: %s", self.datasource_name, path, handle)
                            continue
                        self._bg_path_handles[path] = [handle]
                except Exception as exc:
                    logger.warning("Bulk demote failed for %s: %s — retrying per-path", self.datasource_name, exc)
                    for path, node in demote_items:
                        try:
                            h = await self._background_sub.subscribe_data_change([node], sampling_interval=-1)
                            self._bg_path_handles[path] = [h] if isinstance(h, int) else [x for x in h if isinstance(x, int)]
                        except Exception as e2:
                            logger.warning("Per-path demote failed %s/%s: %s", self.datasource_name, path, e2)
            elif demote_items:
                logger.warning(
                    "Skipping background resubscribe for %s (priority-unsubscribe failed) — "
                    "nodes stay on priority sub",
                    self.datasource_name,
                )

            if prio_unsubscribe_ok:
                for path, _node in demote_items:
                    if path in self._bg_path_handles:
                        continue
                    entry = ds_entry.registry.get(path)
                    if entry is not None and self._background_sub is not None:
                        await self._subscribe_path(path, entry, ds_entry, field_routes)

            # Disabled/dropped paths must remove stale routing so callback map
            # stays consistent — only once their priority unsubscribe actually
            # succeeded (otherwise the subscription is still live).
            if prio_unsubscribe_ok:
                for path in demote_paths_no_bg:
                    for nid in self._path_to_node_ids.pop(path, set()):
                        self._node_to_path.pop(nid, None)
                        self._node_to_field.pop(nid, None)

        # Actual state, deliberately distinct from `_requested_priority_paths`.
        self._current_priority_paths = set(self._priority_path_handles)


class OpcuaPool:
    """Manages multiple DatasourceOpcuaEngine instances."""

    def __init__(self) -> None:
        self._engines: dict[str, DatasourceOpcuaEngine] = {}
        self._datasource_manager = None
        self._status_callback = None
        self._priority_recompute_callback = None

    def set_datasource_manager(self, dm: Any) -> None:
        self._datasource_manager = dm

    def set_status_callback(self, cb: Any) -> None:
        self._status_callback = cb

    def set_priority_recompute_callback(self, cb: Any) -> None:
        self._priority_recompute_callback = cb

    def get(self, name: str) -> DatasourceOpcuaEngine | None:
        return self._engines.get(name)

    async def start(self, name: str, settings: dict) -> None:
        if name in self._engines:
            await self.stop(name)
        engine = DatasourceOpcuaEngine(name)
        engine.set_datasource_manager(self._datasource_manager)
        if self._status_callback:
            engine.set_status_callback(self._status_callback)
        if self._priority_recompute_callback:
            engine.set_priority_recompute_callback(self._priority_recompute_callback)
        self._engines[name] = engine
        await engine.connect(settings)

    async def stop(self, name: str) -> None:
        engine = self._engines.pop(name, None)
        if engine:
            await engine.disconnect()

    async def restart(self, name: str, settings: dict) -> None:
        await self.stop(name)
        await self.start(name, settings)

    def connection_status(self) -> dict[str, bool]:
        """Point-in-time snapshot of connected state for all active engines.

        Read-only: callers cannot mutate pool ownership through this mapping.
        """
        return {name: engine.connected for name, engine in self._engines.items()}

    def subscription_status(self) -> dict[str, dict]:
        """Return subscription diagnostics for all active engines."""
        return {
            name: {
                "priority_paths": sorted(engine._requested_priority_paths),
                "priority_leaf_paths": sorted(
                    path
                    for path in engine._priority_path_handles
                    if path not in engine._requested_priority_paths
                ),
                "connected": engine.connected,
                "bg_enabled": engine._background_sub is not None,
                "bg_publish_interval_ms": engine._requested_bg_publish_interval_ms,
                "bg_publish_interval_revised_ms": engine._revised_bg_publish_interval_ms,
                "priority_publish_interval_ms": engine._requested_priority_publish_interval_ms,
                "priority_publish_interval_revised_ms": engine._revised_priority_publish_interval_ms,
                "priority_sampling_interval_ms": engine._requested_priority_sampling_interval_ms,
                "priority_sampling_interval_revised_avg_ms": engine._priority_revised_sampling_avg_ms(),
                "priority_sampling_interval_revised_min_ms": engine._priority_revised_sampling_min_ms,
                "priority_sampling_interval_revised_max_ms": engine._priority_revised_sampling_max_ms,
                "priority_ws_batch_ms": engine._requested_priority_ws_batch_ms,
            }
            for name, engine in self._engines.items()
        }

    async def start_all(self, datasource_manager: Any) -> None:
        """Start engines for all opcua-client datasources."""
        for name, entry in datasource_manager.datasources.items():
            if entry.ds_type == "opcua-client":
                await self.start(name, entry.config.get("settings", {}))

    async def stop_all(self) -> None:
        names = list(self._engines.keys())
        for name in names:
            await self.stop(name)


opcua_pool = OpcuaPool()
