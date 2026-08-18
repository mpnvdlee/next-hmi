from collections.abc import Mapping
from typing import Any


def get_config_float(
    config: Mapping[str, Any] | None,
    key: str,
    default: float,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    """Read a float-like config value with safe fallback and clamping."""
    raw = config.get(key, default) if isinstance(config, Mapping) else default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = float(default)
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value
