"""
opcua.client_pool — compatibility facade over the OPC-UA client modules.

The implementation lives in ``opcua.security``, ``opcua.discovery``,
``opcua.limits``, ``opcua.browse``, ``opcua.routing``, ``opcua.engine`` and
``opcua.pool``; this module re-exports every name it used to define so
existing ``from opcua.client_pool import …`` imports keep working. New code
imports from the owning module.

Patch a global where the function that reads it is defined — e.g.
``opcua.security.active_project_root``, ``opcua.engine.Client`` — never here:
rebinding a name on this module changes nothing the moved code looks up. Those
looked-up globals are deliberately not re-exported, so a stale patch target
fails loudly instead of silently patching nothing.
"""

from .browse import (
    _BROWSE_NODE_CLASSES,
    _HAS_COMPONENT,
    _UNKNOWN_VAR_ATTRS,
    _VAR_ATTRS,
    AddressSpaceBrowser,
    _builtin_data_type_name,
    _decode_var_attrs,
)
from .discovery import (
    _endpoint_supported,
    _normalize_discovery_url,
    _policy_short_name,
    _security_mode_name,
    _short_probe_error,
    _user_token_types,
    discover_endpoints,
    probe_connection,
)
from .engine import DatasourceOpcuaEngine, _DsSubHandler
from .limits import (
    DEFAULT_MAX_BROWSE_NODES,
    DEFAULT_MAX_MONITORED_ITEMS_PER_CALL,
    DEFAULT_MAX_READ_OPS,
    OperationLimits,
    read_operation_limits,
)
from .pool import OpcuaPool, opcua_pool
from .routing import (
    _collect_struct_leaf_paths,
    _root_folder_paths,
    _struct_field_routes,
)
from .security import (
    SECURE_POLICY_NAMES,
    SECURITY_MODES,
    SecuritySettings,
    _pem_or_der,
    _resolve_security_path,
    _resolve_security_settings,
    apply_client_security,
    ensure_client_certificate,
    generate_self_signed_client_certificate,
)

__all__ = [
    "DEFAULT_MAX_BROWSE_NODES",
    "DEFAULT_MAX_MONITORED_ITEMS_PER_CALL",
    "DEFAULT_MAX_READ_OPS",
    "SECURE_POLICY_NAMES",
    "SECURITY_MODES",
    "_BROWSE_NODE_CLASSES",
    "_HAS_COMPONENT",
    "_UNKNOWN_VAR_ATTRS",
    "_VAR_ATTRS",
    "AddressSpaceBrowser",
    "DatasourceOpcuaEngine",
    "OpcuaPool",
    "OperationLimits",
    "SecuritySettings",
    "_DsSubHandler",
    "_builtin_data_type_name",
    "_collect_struct_leaf_paths",
    "_decode_var_attrs",
    "_endpoint_supported",
    "_normalize_discovery_url",
    "_pem_or_der",
    "_policy_short_name",
    "_resolve_security_path",
    "_resolve_security_settings",
    "_root_folder_paths",
    "_security_mode_name",
    "_short_probe_error",
    "_struct_field_routes",
    "_user_token_types",
    "apply_client_security",
    "discover_endpoints",
    "ensure_client_certificate",
    "generate_self_signed_client_certificate",
    "opcua_pool",
    "probe_connection",
    "read_operation_limits",
]
