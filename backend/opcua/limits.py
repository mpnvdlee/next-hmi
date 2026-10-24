"""
opcua.limits — the server's OperationLimits and the batch sizes they allow.

Read once per connection by the engine and shared with everything that batches
requests: the browse walker, bulk reads and monitored-item creation.
"""

import logging
from dataclasses import dataclass

from asyncua import Client, ua

logger = logging.getLogger(__name__)

# Batch sizes used when a server advertises no OperationLimits (0 or absent
# means "no limit" per OPC-UA Part 5 § 6.3.2). A server that *does* enforce a
# limit rejects an oversized request with a BadTooManyOperations *service*
# fault, which fails every operation in the request rather than the ones past
# the limit — so `read_operation_limits` reads the real values on connect
# and every batched service call clamps itself to them.
DEFAULT_MAX_READ_OPS = 1000
DEFAULT_MAX_BROWSE_NODES = 100
DEFAULT_MAX_MONITORED_ITEMS_PER_CALL = 500


@dataclass(frozen=True)
class OperationLimits:
    """A server's OperationLimits. None means "not read yet or not advertised"
    — the DEFAULT_MAX_* batch sizes then apply."""

    max_read_ops: int | None = None
    max_browse_nodes: int | None = None
    max_monitored_items_per_call: int | None = None

    def read_ops_budget(self) -> int:
        """Operations allowed in one Read request."""
        return self.max_read_ops or DEFAULT_MAX_READ_OPS

    def browse_nodes_budget(self) -> int:
        """BrowseDescriptions allowed in one Browse request."""
        return self.max_browse_nodes or DEFAULT_MAX_BROWSE_NODES

    def monitored_items_budget(self) -> int:
        """Items allowed in one CreateMonitoredItems/DeleteMonitoredItems call."""
        return self.max_monitored_items_per_call or DEFAULT_MAX_MONITORED_ITEMS_PER_CALL


async def read_operation_limits(client: Client, datasource_name: str = "") -> OperationLimits:
    """Read the server's OperationLimits so batched requests stay legal.

    Servers reject an oversized Read/Browse/CreateMonitoredItems with a
    BadTooManyOperations *service* fault: the whole request fails, not just
    the operations past the limit. CODESYS advertises MaxNodesPerRead = 100,
    and the browse attribute read asks for four attributes per variable, so
    without this a level of 26 variables was enough to lose every type on
    that level.
    """
    limit_ids = (
        ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead,
        ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerBrowse,
        ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxMonitoredItemsPerCall,
    )
    try:
        params = ua.ReadParameters()
        params.MaxAge = 0
        params.TimestampsToReturn = ua.TimestampsToReturn.Neither
        for ident in limit_ids:
            rv = ua.ReadValueId()
            rv.NodeId = ua.NodeId(ident)
            rv.AttributeId = ua.AttributeIds.Value
            params.NodesToRead.append(rv)
        results = await client.uaclient.read(params)
    except Exception as exc:
        # An optional part of the address space: a server may omit it
        # entirely. The defaults then apply, as they did before.
        logger.debug(
            "Could not read OperationLimits for %s: %s", datasource_name, exc
        )
        return OperationLimits()
    limits: list[int | None] = []
    for dv in results:
        value: int | None = None
        try:
            if dv.StatusCode.is_good() and dv.Value is not None:
                raw = dv.Value.Value
                # 0 means "no limit"; keep None so the defaults apply.
                if isinstance(raw, int) and raw > 0:
                    value = raw
        except Exception:
            value = None
        limits.append(value)
    max_read_ops, max_browse_nodes, max_monitored_items_per_call = limits
    logger.info(
        "OPC-UA operation limits for %s: MaxNodesPerRead=%s MaxNodesPerBrowse=%s "
        "MaxMonitoredItemsPerCall=%s",
        datasource_name,
        max_read_ops or "unlimited",
        max_browse_nodes or "unlimited",
        max_monitored_items_per_call or "unlimited",
    )
    return OperationLimits(max_read_ops, max_browse_nodes, max_monitored_items_per_call)
