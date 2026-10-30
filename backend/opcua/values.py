"""
opcua.values — OPC-UA values in the form the value cache and ``/ws`` carry.

Applied where a value leaves asyncua: the datachange handler and
``DatasourceOpcuaEngine.read_current_values``. Everything downstream — the
DatasourceManager cache, alarms, historian, recipes, the browser — sees only
JSON-ready primitives and never an asyncua type.
"""

from typing import Any

from asyncua import ua
from core.value_types import MAX_SAFE_INTEGER, json_ready_scalar


def normalize_value(value: Any) -> Any:
    """*value* as the cache holds it.

    LocalizedText becomes its text, NodeId/ExpandedNodeId/QualifiedName their
    canonical strings (``ns=3;s=Tag``, ``2:Speed``); the rest follows
    ``core.value_types.json_ready_scalar`` — DateTime as ISO 8601 UTC with
    milliseconds, an integer beyond ±(2**53 - 1) as its decimal string, bytes
    as base64, anything else as ``str()``. Lists are normalized element-wise.
    """
    cls = type(value)
    # The datachange hot path: almost every notification is one of these.
    if cls is float or cls is bool or cls is str or value is None:
        return value
    if cls is int:
        return value if -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER else str(value)
    if isinstance(value, (list, tuple)):
        return [normalize_value(v) for v in value]
    if isinstance(value, dict):
        return {k: normalize_value(v) for k, v in value.items()}
    # Their str() is the dataclass repr — "LocalizedText(Locale='de', Text=…)"
    # — which would reach the screen verbatim. Status texts, messages and the
    # device info a PLC publishes (Manufacturer, Model) are LocalizedText.
    if isinstance(value, ua.LocalizedText):
        return value.Text or ""
    if isinstance(value, (ua.NodeId, ua.QualifiedName)):
        return value.to_string()
    return json_ready_scalar(value)
