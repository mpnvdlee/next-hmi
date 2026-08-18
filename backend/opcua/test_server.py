"""
opcua.test_server — managed OPC-UA test server instances.

One TestServerInstance per datasource of type 'opcua-test-server'.
Each instance creates an asyncua.Server, populates OPC-UA Variable nodes from
the datasource's variable tree, and runs a simple simulation loop that updates
read-only variables with sine-wave-based values.
"""

import asyncio
import contextlib
import errno
import logging
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from asyncua import Server, ua
from core.exceptions import DatasourceConflictError
from core.value_types import is_array_shape, is_fixed_array

logger = logging.getLogger(__name__)


def _start_error_message(port: int, exc: Exception) -> str:
    """A user-facing reason a test server failed to bind/start."""
    if isinstance(exc, OSError) and exc.errno in (errno.EADDRINUSE, errno.EACCES):
        return (
            f"Port {port} is already in use — another OPC-UA server (or a test "
            f"server in another project) is bound to it. Change this datasource's "
            f"port or stop the conflicting server."
        )
    return f"Failed to start test server on port {port}: {exc}"


@dataclass
class _SimNode:
    node_id: str
    var_node: Any
    variant_type: ua.VariantType
    writable: bool
    sim_index: int
    array_length: int  # 0 = scalar, >0 = number of elements simulated
    # Optional `sim_min` / `sim_max` from the variable's config. Without them the
    # generated value is index-derived and domain-blind, which reads as broken
    # for anything with a real-world range (a product temperature swinging to
    # 375 °C). With both set, the wave stays inside the band.
    sim_min: float | None = None
    sim_max: float | None = None

def _sim_bound(value: Any) -> float | None:
    """Read an optional `sim_min` / `sim_max` off a variable's config. Anything
    non-numeric is treated as absent so a hand-edited datasource file cannot
    break the simulation loop."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


# Concrete element count used to simulate a dynamic (unbounded-length) array —
# OPC-UA values always carry a concrete length even when ValueRank/ArrayDimensions
# declare the node as dynamically sized.
_DYNAMIC_ARRAY_SIM_LENGTH = 3
_SIM_LABELS = (
    "Alpha",
    "Bravo",
    "Charlie",
    "Delta",
    "Echo",
    "Foxtrot",
    "Golf",
    "Hotel",
    "India",
    "Juliet",
)

# OPC-UA variant type mapping from data_type strings
_VARIANT_MAP: dict[str, ua.VariantType] = {
    "Boolean": ua.VariantType.Boolean,
    "Bool": ua.VariantType.Boolean,
    "Float": ua.VariantType.Float,
    "Double": ua.VariantType.Double,
    "SByte": ua.VariantType.SByte,
    "Int8": ua.VariantType.SByte,
    "Int16": ua.VariantType.Int16,
    "Int32": ua.VariantType.Int32,
    "Int64": ua.VariantType.Int64,
    "Byte": ua.VariantType.Byte,
    "UInt8": ua.VariantType.Byte,
    "UInt16": ua.VariantType.UInt16,
    "UInt32": ua.VariantType.UInt32,
    "UInt64": ua.VariantType.UInt64,
    "String": ua.VariantType.String,
    "DateTime": ua.VariantType.DateTime,
}

_DEFAULT_VALUES: dict[ua.VariantType, Any] = {
    ua.VariantType.Boolean: False,
    ua.VariantType.Float: 0.0,
    ua.VariantType.Double: 0.0,
    ua.VariantType.SByte: 0,
    ua.VariantType.Int16: 0,
    ua.VariantType.Int32: 0,
    ua.VariantType.Int64: 0,
    ua.VariantType.Byte: 0,
    ua.VariantType.UInt16: 0,
    ua.VariantType.UInt32: 0,
    ua.VariantType.UInt64: 0,
    ua.VariantType.String: "",
    ua.VariantType.DateTime: datetime.now(UTC),
}


class TestServerInstance:
    """A single managed OPC-UA test server."""

    def __init__(self, name: str) -> None:
        self.name = name
        self._server: Server | None = None
        self._sim_task: asyncio.Task | None = None
        self._running = False
        self._error: str | None = None
        self._sim_nodes: list[_SimNode] = []

    @property
    def running(self) -> bool:
        return self._running

    @property
    def error(self) -> str | None:
        """Reason the server is not running, or ``None`` while healthy."""
        return self._error

    async def start(self, config: dict) -> None:
        """Start the OPC-UA server and populate variables from config.

        Raises :class:`DatasourceConflictError` if the configured port can't be
        bound (e.g. another server already owns it). The instance is left in a
        stopped state with :attr:`error` set so callers can surface the reason
        without the process going down.
        """
        settings = config.get("settings", {})
        port = settings.get("port", 4855)
        endpoint_path = settings.get("endpoint_path", "/nexthmi/test/")
        variables = config.get("variables", [])

        self._error = None
        server = Server()
        await server.init()
        endpoint = f"opc.tcp://0.0.0.0:{port}{endpoint_path}"
        server.set_endpoint(endpoint)
        server.set_server_name(f"NEXT HMI Test Server - {self.name}")
        server.set_security_policy([ua.SecurityPolicyType.NoSecurity])

        uri = f"http://nexthmi.local/test/{self.name}"
        idx = await server.register_namespace(uri)
        objects = server.get_objects_node()

        self._sim_nodes = []
        sim_idx = 0
        await self._populate_nodes(objects, idx, variables, sim_idx)

        try:
            await server.start()
        except Exception as exc:
            message = _start_error_message(port, exc)
            self._error = message
            self._running = False
            with contextlib.suppress(Exception):
                await server.stop()
            logger.error("Test server '%s' failed to start: %s", self.name, message)
            raise DatasourceConflictError(message) from exc

        self._server = server
        self._running = True
        self._error = None
        self._sim_task = asyncio.create_task(self._simulation_loop())
        logger.info("Test server '%s' started on %s", self.name, endpoint)

    async def _populate_nodes(
        self,
        parent: Any,
        idx: int,
        nodes: list[dict],
        sim_idx: int,
    ) -> int:
        """Recursively create OPC-UA nodes from the variable tree.

        Also writes the assigned ``node_id`` back into each config dict so
        the paired OPC-UA client can subscribe without a separate browse step.
        """
        for node in nodes:
            if not isinstance(node, dict):
                continue
            if node.get("kind") == "folder":
                folder = await parent.add_object(idx, node.get("name", "Folder"))
                node["node_id"] = folder.nodeid.to_string()
                sim_idx = await self._populate_nodes(
                    folder, idx, node.get("children", []), sim_idx,
                )
            else:
                display_name = node.get("display_name", "Variable")
                data_type_str = node.get("data_type", "Float")
                writable = node.get("writable", False)
                node_is_array = is_array_shape(node)
                fixed_length = node.get("array_length") if is_fixed_array(node) else None
                array_length = (
                    fixed_length if fixed_length else
                    (_DYNAMIC_ARRAY_SIM_LENGTH if node_is_array else 0)
                )
                variant_type = _VARIANT_MAP.get(data_type_str, ua.VariantType.Float)
                default = _DEFAULT_VALUES.get(variant_type, 0.0)
                if node_is_array:
                    initial_value = ua.Variant(
                        [default] * array_length, variant_type,
                    )
                else:
                    initial_value = ua.Variant(default, variant_type)
                var_node = await parent.add_variable(
                    idx, display_name, initial_value,
                )
                if node_is_array:
                    # Set ValueRank=1 and ArrayDimensions so OPC-UA clients
                    # can detect this as a 1-D array via standard attributes.
                    # ArrayDimensions=[0] means "dynamic/unconstrained length".
                    await var_node.write_attribute(
                        ua.AttributeIds.ValueRank,
                        ua.DataValue(ua.Variant(1, ua.VariantType.Int32)),
                    )
                    await var_node.write_attribute(
                        ua.AttributeIds.ArrayDimensions,
                        ua.DataValue(
                            ua.Variant([fixed_length or 0], ua.VariantType.UInt32)
                        ),
                    )
                await var_node.set_writable(writable)
                node["node_id"] = var_node.nodeid.to_string()
                self._sim_nodes.append(_SimNode(
                    node_id=var_node.nodeid.to_string(),
                    var_node=var_node,
                    variant_type=variant_type,
                    writable=writable,
                    sim_index=sim_idx,
                    array_length=array_length,
                    sim_min=_sim_bound(node.get("sim_min")),
                    sim_max=_sim_bound(node.get("sim_max")),
                ))
                sim_idx += 1
        return sim_idx

    async def _simulation_loop(self) -> None:
        """Simple sine-wave simulation for read-only variables."""
        t = 0.0
        while self._running:
            await asyncio.sleep(0.1)
            t += 0.1
            for sn in self._sim_nodes:
                if sn.writable:
                    continue  # Don't overwrite operator-written values
                try:
                    if sn.array_length > 0:
                        value = self._compute_sim_value_array(
                            sn.variant_type, t, sn.sim_index, sn.array_length,
                            sn.sim_min, sn.sim_max,
                        )
                    else:
                        value = self._compute_sim_value(
                            sn.variant_type, t, sn.sim_index, sn.sim_min, sn.sim_max,
                        )
                    await sn.var_node.write_value(
                        ua.DataValue(ua.Variant(value, sn.variant_type)),
                    )
                except Exception as exc:
                    logger.debug(
                        "Sim write failed for %s node %s: %s",
                        self.name, sn.node_id, exc,
                    )

    @staticmethod
    def _compute_sim_value(
        vtype: ua.VariantType,
        t: float,
        idx: int,
        sim_min: float | None = None,
        sim_max: float | None = None,
    ) -> Any:
        """Generate a simulated value based on type and time.

        With `sim_min`/`sim_max` both set, numeric types oscillate inside that
        band instead of the index-derived default range."""
        phase = idx * 0.7
        if sim_min is not None and sim_max is not None and sim_min < sim_max:
            mid = (sim_min + sim_max) / 2.0
            amplitude = (sim_max - sim_min) / 2.0
            wave = mid + amplitude * math.sin(t / (5.0 + idx) + phase)
            if vtype == ua.VariantType.Boolean:
                return wave > mid
            if vtype in (ua.VariantType.Float, ua.VariantType.Double):
                return round(wave, 2)
            if vtype in (
                ua.VariantType.SByte, ua.VariantType.Byte,
                ua.VariantType.Int16, ua.VariantType.Int32, ua.VariantType.Int64,
                ua.VariantType.UInt16, ua.VariantType.UInt32, ua.VariantType.UInt64,
            ):
                return round(wave)
        if vtype == ua.VariantType.Boolean:
            return math.sin(t / (3.0 + idx * 0.5) + phase) > 0
        if vtype in (ua.VariantType.Float, ua.VariantType.Double):
            base = 50.0 + idx * 10.0
            return round(base + 20.0 * math.sin(t / (5.0 + idx) + phase), 2)
        if vtype == ua.VariantType.SByte:  # -128..127
            return round(60 * math.sin(t / (4.0 + idx) + phase))
        if vtype in (ua.VariantType.Int16, ua.VariantType.Int32, ua.VariantType.Int64):
            return int(50 + 40 * math.sin(t / (4.0 + idx) + phase))
        if vtype == ua.VariantType.Byte:  # 0..255
            return int(abs(round(127 + 100 * math.sin(t / (5.0 + idx) + phase))))
        if vtype in (ua.VariantType.UInt16, ua.VariantType.UInt32, ua.VariantType.UInt64):
            return int(abs(100 + 80 * math.sin(t / (6.0 + idx) + phase)))
        if vtype == ua.VariantType.String:
            # Cycle through labels every ~3 s, offset per variable index
            step = int(t / 3.0 + idx) % len(_SIM_LABELS)
            return _SIM_LABELS[step]
        if vtype == ua.VariantType.DateTime:
            # Ticking timestamp: now offset by the elapsed sim time + per-var phase.
            return datetime.now(UTC) + timedelta(seconds=t + phase)
        return 0

    @classmethod
    def _compute_sim_value_array(
        cls,
        vtype: ua.VariantType,
        t: float,
        sim_idx: int,
        array_length: int,
        sim_min: float | None = None,
        sim_max: float | None = None,
    ) -> list[Any]:
        """Generate a simulated array value; each element gets a distinct phase offset."""
        return [
            cls._compute_sim_value(vtype, t, sim_idx * array_length + i, sim_min, sim_max)
            for i in range(array_length)
        ]

    async def update_writable_flags(self, registry: dict) -> None:
        """Update writable flags from a refreshed variable registry.

        Called after a config change so the simulation immediately starts (or stops)
        generating values for a variable, and the node's live OPC-UA AccessLevel
        reflects the new intent, without requiring a full server restart.
        """
        node_id_to_writable = {
            e["node_id"]: bool(e.get("writable", False))
            for e in registry.values()
            if e.get("node_id")
        }
        for sn in self._sim_nodes:
            if sn.node_id in node_id_to_writable:
                new_writable = node_id_to_writable[sn.node_id]
                if new_writable != sn.writable:
                    await sn.var_node.set_writable(new_writable)
                sn.writable = new_writable

    async def stop(self) -> None:
        """Stop the server and simulation."""
        self._running = False
        if self._sim_task:
            self._sim_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._sim_task
            self._sim_task = None
        if self._server:
            with contextlib.suppress(Exception):
                await self._server.stop()
            self._server = None
        logger.info("Test server '%s' stopped", self.name)


class TestServerPool:
    """Manages multiple TestServerInstance objects."""

    def __init__(self) -> None:
        self._instances: dict[str, TestServerInstance] = {}
        self._opcua_pool = None
        self._datasource_manager = None

    def set_opcua_pool(self, pool: Any) -> None:
        """Set the OpcuaPool so we can auto-create client connections."""
        self._opcua_pool = pool

    def set_datasource_manager(self, dm: Any) -> None:
        """Set the DatasourceManager for persisting auto-discovered node_ids."""
        self._datasource_manager = dm

    def get(self, name: str) -> TestServerInstance | None:
        return self._instances.get(name)

    async def start(self, name: str, config: dict) -> None:
        """Start a test server instance and optionally a paired OPC-UA client."""
        if name in self._instances:
            await self.stop(name)
        instance = TestServerInstance(name)
        # Register before starting so a failed start leaves a queryable instance
        # (with .error set) for the status API instead of vanishing.
        self._instances[name] = instance
        await instance.start(config)
        # _populate_nodes wrote node_ids into config entries in-place.
        # Re-save so the datasource registry picks them up before the
        # paired OPC-UA client tries to subscribe.
        if self._datasource_manager is not None:
            self._datasource_manager.save(name, config)
        # Start a paired OPC-UA client engine that connects to this test server
        if self._opcua_pool:
            settings = config.get("settings", {})
            port = settings.get("port", 4855)
            endpoint_path = settings.get("endpoint_path", "/nexthmi/test/")
            client_settings = {
                "server_url": f"opc.tcp://localhost:{port}{endpoint_path}",
                "security_policy": "NoSecurity",
                "reconnect_interval_s": 3,
            }
            await self._opcua_pool.start(name, client_settings)

    async def stop(self, name: str) -> None:
        """Stop a test server instance and its paired client."""
        if self._opcua_pool:
            await self._opcua_pool.stop(name)
        instance = self._instances.pop(name, None)
        if instance:
            await instance.stop()

    async def restart(self, name: str, config: dict) -> None:
        await self.stop(name)
        await self.start(name, config)

    async def start_all(self, datasource_manager: Any) -> None:
        """Start instances for all opcua-test-server datasources.

        Best-effort: a server that can't bind (port conflict, etc.) is logged
        and left with its ``error`` recorded so the status API can report it —
        it must not abort startup of the rest of the backend.
        """
        for ds_name, entry in datasource_manager.datasources.items():
            if entry.ds_type == "opcua-test-server":
                try:
                    await self.start(ds_name, entry.config)
                except Exception:
                    logger.exception("Test server '%s' failed to start", ds_name)

    async def stop_all(self) -> None:
        names = list(self._instances.keys())
        for name in names:
            await self.stop(name)


test_server_pool = TestServerPool()
