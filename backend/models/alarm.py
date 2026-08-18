"""Alarm system configuration and runtime state models."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from models.binding import resolve_var_binding, resolve_var_index

# ── Type constants ────────────────────────────────────────────────────────────

AlarmLevel = Literal["error", "warning", "info"]
AlarmTriggerType = Literal["value_range", "bool"]


# ── Configuration models (persisted in alarms.json) ──────────────────────────


class AlarmTrigger(BaseModel):
    """Trigger condition that fires/clears an alarm."""

    model_config = ConfigDict(extra="forbid")

    type: AlarmTriggerType
    # Binding value for the monitored variable: { "$var": { "path": "datasource:location" } }
    source_value: Any = None
    # value_range thresholds: plain number, { "$static": n }, or { "$var": ... }
    min: Any = None
    max: Any = None
    # bool trigger: fire when variable equals on_true
    on_true: bool = True

    def resolve_datasource_path(self) -> tuple[str, str]:
        """Extract datasource and location from the source_value $var binding."""
        return resolve_var_binding(self.source_value)

    def resolve_index(self) -> int | None:
        """Return the array element index from a $var binding, or None if not indexed."""
        return resolve_var_index(self.source_value)

    @staticmethod
    def resolve_threshold(value: Any) -> float | None:
        """Extract a numeric threshold from static or plain value."""
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, dict):
            static = value.get("$static")
            if static is not None:
                try:
                    return float(static)
                except (TypeError, ValueError):
                    return None
        return None


class AlarmDefinition(BaseModel):
    """Single alarm definition within a group."""

    model_config = ConfigDict(extra="forbid")

    id: str = ""  # slug assigned by the service layer from `code`/`title`
    code: str = ""
    level: AlarmLevel = "error"
    title: Any = ""
    description: Any = ""
    image: Any = ""
    auto_popup: bool = True
    resolutions: list[Any] = Field(default_factory=list)
    trigger: AlarmTrigger = Field(default_factory=lambda: AlarmTrigger(type="value_range"))
    ack_groups: list[str] = Field(default_factory=list)

    @staticmethod
    def resolve_string(value: Any) -> str:
        """Extract a plain string from a string field (str, $static, or $loc key)."""
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            static = value.get("$static")
            if isinstance(static, str):
                return static
            loc = value.get("$loc")
            if isinstance(loc, str):
                return loc
            string_expr = value.get("$stringExpr")
            if isinstance(string_expr, dict):
                template = string_expr.get("template")
                if isinstance(template, str):
                    return template
        return ""

    def resolve_image(self) -> str:
        """Extract asset-relative path (e.g. 'images/foo.png') from image field.

        Bare strings and `$static` string payloads are filenames and get the
        images/ prefix. A `$static` `{ path }` payload already carries the full
        asset-relative path.
        """
        if isinstance(self.image, str) and self.image:
            return f"images/{self.image}"
        if isinstance(self.image, dict):
            static = self.image.get("$static")
            if isinstance(static, str) and static:
                return f"images/{static}"
            if isinstance(static, dict):
                return static.get("path", "")
        return ""


class AlarmGroup(BaseModel):
    """Named group of alarm definitions."""

    model_config = ConfigDict(extra="forbid")

    id: str = ""  # slug assigned by the service layer from `title`
    title: str = ""
    alarms: list[AlarmDefinition] = Field(default_factory=list)


class AlarmConfig(BaseModel):
    """Top-level alarm configuration document."""

    model_config = ConfigDict(extra="forbid")

    version: int = 1
    groups: list[AlarmGroup] = Field(default_factory=list)


# ── Runtime state models (persisted in alarm_state.json) ─────────────────────


class AlarmInstance(BaseModel):
    """Active alarm instance — denormalized from definition at fire time."""

    model_config = ConfigDict(extra="forbid")

    id: str = ""  # slug assigned by the alarm manager at fire/clear time
    alarm_id: str
    code: str = ""
    level: AlarmLevel = "error"
    title: str = ""
    description: str = ""
    image: str = ""
    resolutions: list[Any] = Field(default_factory=list)
    group_title: str = ""
    auto_popup: bool = True
    ack_groups: list[str] = Field(default_factory=list)
    triggered_at: str = ""
    acked: bool = False
    acked_by: str = ""
    acked_at: str = ""


class AlarmHistoryEntry(BaseModel):
    """Cleared or historical alarm record."""

    model_config = ConfigDict(extra="forbid")

    id: str = ""  # slug assigned by the alarm manager at fire/clear time
    alarm_id: str
    code: str = ""
    level: AlarmLevel = "error"
    title: str = ""
    group_title: str = ""
    triggered_at: str = ""
    cleared_at: str = ""
    acked: bool = False
    acked_by: str = ""
    acked_at: str = ""


class AlarmSummary(BaseModel):
    """Computed summary counts for the frontend."""

    model_config = ConfigDict(extra="forbid")

    total: int = 0
    unacked: int = 0
    error_count: int = 0
    warning_count: int = 0
    info_count: int = 0


class AlarmState(BaseModel):
    """Persisted runtime state: active alarms + history."""

    model_config = ConfigDict(extra="forbid")

    active: list[AlarmInstance] = Field(default_factory=list)
    history: list[AlarmHistoryEntry] = Field(default_factory=list)
