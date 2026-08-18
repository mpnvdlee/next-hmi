"""
Alarm manager — evaluates alarm triggers against live variable values,
manages active alarm state and history, and broadcasts changes via WebSocket.

The manager registers itself as a value listener on datasource_manager.
When a variable value changes, it checks all trigger conditions that reference
that variable and fires or clears alarms accordingly.

State (active alarms + history) is persisted to alarm_state.json so that it
survives server restarts.  Configuration (alarm definitions) is persisted
separately in alarms.json.
"""

import logging
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from core import audit
from core.ids import slug_id
from core.storage import (
    active_alarm_state_path,
    active_alarms_config_path,
    load_json_or_default,
    write_json,
)
from models.alarm import (
    AlarmConfig,
    AlarmDefinition,
    AlarmGroup,
    AlarmHistoryEntry,
    AlarmInstance,
    AlarmState,
    AlarmSummary,
)
from models.datasource import build_var_key

logger = logging.getLogger(__name__)

_MAX_HISTORY = 500


def _assign_config_ids(config: AlarmConfig) -> None:
    """Backfill slug IDs for any group/definition that lacks one (in place).

    Group IDs are unique among groups; alarm IDs are unique across the whole
    config because `alarm_id` is matched globally against active instances.
    """
    group_ids: set[str] = {g.id for g in config.groups if g.id}
    alarm_ids: set[str] = {a.id for g in config.groups for a in g.alarms if a.id}
    for group in config.groups:
        if not group.id:
            group.id = slug_id(group.title or "group", group_ids)
            group_ids.add(group.id)
        for alarm in group.alarms:
            if not alarm.id:
                alarm.id = slug_id(alarm.code or "alarm", alarm_ids)
                alarm_ids.add(alarm.id)


class AlarmManager:
    """Singleton alarm evaluator and state tracker."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._config: AlarmConfig = AlarmConfig()
        self._state: AlarmState = AlarmState()
        # Maps composite variable key -> list of (AlarmDefinition, AlarmGroup)
        self._trigger_map: dict[str, list[tuple[AlarmDefinition, AlarmGroup]]] = {}
        # Async broadcast callback set by main.py wiring
        self._broadcast_callback: Callable[..., Any] | None = None
        # Callback that schedules an OPC-UA priority-subscription recompute,
        # set by main.py wiring. Sync + fire-and-forget, mirroring
        # _broadcast_callback, so config saves never block on OPC-UA.
        self._recompute_callback: Callable[..., Any] | None = None

    # ── Wiring ────────────────────────────────────────────────────────────────

    def set_broadcast_callback(self, fn: Callable[..., Any]) -> None:
        self._broadcast_callback = fn

    def set_recompute_callback(self, fn: Callable[..., Any]) -> None:
        self._recompute_callback = fn

    # ── Load / Save ───────────────────────────────────────────────────────────

    def load(self) -> None:
        """Load config and state from disk."""
        with self._lock:
            self._load_config()
            self._load_state()
            self._rebuild_trigger_map()

    def _load_config(self) -> None:
        self._config = load_json_or_default(
            active_alarms_config_path(), AlarmConfig, AlarmConfig.model_validate,
        )

    def _load_state(self) -> None:
        self._state = load_json_or_default(
            active_alarm_state_path(), AlarmState, AlarmState.model_validate,
        )

    def _save_config(self) -> None:
        write_json(active_alarms_config_path(), self._config.model_dump())

    def _save_state(self) -> None:
        write_json(active_alarm_state_path(), self._state.model_dump())

    # ── Config accessors ──────────────────────────────────────────────────────

    def get_config(self) -> AlarmConfig:
        with self._lock:
            return self._config.model_copy(deep=True)

    def set_config(self, config: AlarmConfig) -> None:
        with self._lock:
            _assign_config_ids(config)
            self._config = config
            self._save_config()
            self._rebuild_trigger_map()
            self._request_recompute()
        logger.info("Alarm config updated (%d groups)", len(config.groups))

    def apply_config(self, config: AlarmConfig) -> None:
        """Refresh in-memory config + trigger map without writing to disk.

        For external writers (e.g. MCP tools) that have already persisted the
        document and just need the runtime state synced so trigger evaluation
        and priority-path subscriptions pick up the new alarms.
        """
        with self._lock:
            self._config = config
            self._rebuild_trigger_map()
            self._request_recompute()

    def get_trigger_paths_by_datasource(self) -> dict[str, set[str]]:
        """Return {datasource: set-of-paths} for all configured alarm triggers.

        Used by the websocket manager to keep alarm trigger variables on the
        priority (fast) OPC-UA subscription at all times.
        """
        with self._lock:
            result: dict[str, set[str]] = {}
            for key in self._trigger_map:
                ds, path = key.split(":", 1)
                result.setdefault(ds, set()).add(path)
            return result

    def _rebuild_trigger_map(self) -> None:
        """Rebuild the mapping from composite variable keys to alarm definitions."""
        self._trigger_map.clear()
        for group in self._config.groups:
            for alarm in group.alarms:
                trigger = alarm.trigger
                ds, path = trigger.resolve_datasource_path()
                if not ds or not path:
                    continue
                key = build_var_key(ds, path)
                self._trigger_map.setdefault(key, []).append((alarm, group))

    # ── Active alarms & history ───────────────────────────────────────────────

    def get_active(self) -> list[AlarmInstance]:
        with self._lock:
            return [inst.model_copy() for inst in self._state.active]

    def get_history(self, limit: int = 100, offset: int = 0) -> list[AlarmHistoryEntry]:
        with self._lock:
            # History is stored newest-first
            return [e.model_copy() for e in self._state.history[offset : offset + limit]]

    def get_summary(self) -> AlarmSummary:
        with self._lock:
            return self._compute_summary()

    def _compute_summary(self) -> AlarmSummary:
        active = self._state.active
        return AlarmSummary(
            total=len(active),
            unacked=sum(1 for a in active if not a.acked),
            error_count=sum(1 for a in active if a.level == "error"),
            warning_count=sum(1 for a in active if a.level == "warning"),
            info_count=sum(1 for a in active if a.level == "info"),
        )

    # ── Value listener (called from datasource_manager thread) ────────────────

    def on_variable_change(self, key: str, value: Any) -> None:
        """Evaluate all triggers that depend on this variable key."""
        with self._lock:
            definitions = self._trigger_map.get(key)
            if not definitions:
                return

            changed = False
            for alarm_def, group in definitions:
                triggered = self._evaluate_trigger(alarm_def.trigger, value)
                existing = self._find_active_by_alarm_id(alarm_def.id)

                if triggered and existing is None:
                    self._fire_alarm(alarm_def, group)
                    changed = True
                elif not triggered and existing is not None:
                    self._clear_alarm(existing)
                    changed = True

            if changed:
                self._save_state()
                self._request_broadcast()

    def _evaluate_trigger(self, trigger: Any, value: Any) -> bool:
        """Return True if the trigger condition is met for the given value."""
        # If the trigger targets a specific array element, extract it first
        index = trigger.resolve_index()
        if index is not None and isinstance(value, (list, tuple)):
            if index >= len(value):
                return False
            value = value[index]

        if trigger.type == "bool":
            if isinstance(value, bool):
                return value == trigger.on_true
            # Coerce numeric / string to bool
            try:
                return bool(value) == trigger.on_true
            except (TypeError, ValueError):
                return False

        if trigger.type == "value_range":
            try:
                num_val = float(value)
            except (TypeError, ValueError):
                return False
            min_val = trigger.resolve_threshold(trigger.min)
            max_val = trigger.resolve_threshold(trigger.max)
            if min_val is not None and num_val < min_val:
                return False
            if max_val is not None and num_val > max_val:
                return False
            # If both min and max are None, never trigger (unconfigured)
            return not (min_val is None and max_val is None)

        return False

    def _find_active_by_alarm_id(self, alarm_id: str) -> AlarmInstance | None:
        for inst in self._state.active:
            if inst.alarm_id == alarm_id:
                return inst
        return None

    def _used_instance_ids(self) -> set[str]:
        return {a.id for a in self._state.active} | {h.id for h in self._state.history}

    def _fire_alarm(self, definition: AlarmDefinition, group: AlarmGroup) -> None:
        now = datetime.now(UTC).isoformat()
        instance = AlarmInstance(
            id=slug_id(definition.id or definition.code or "alarm", self._used_instance_ids()),
            alarm_id=definition.id,
            code=definition.code,
            level=definition.level,
            title=definition.resolve_string(definition.title),
            description=definition.resolve_string(definition.description),
            image=definition.resolve_image(),
            resolutions=list(definition.resolutions),
            group_title=group.title,
            auto_popup=definition.auto_popup,
            ack_groups=list(definition.ack_groups),
            triggered_at=now,
        )
        self._state.active.append(instance)
        logger.info("Alarm fired: [%s] %s (%s)", definition.code, definition.title, definition.level)

    def _clear_alarm(self, instance: AlarmInstance) -> None:
        now = datetime.now(UTC).isoformat()
        history_entry = AlarmHistoryEntry(
            id=slug_id(instance.alarm_id or instance.code or "alarm", self._used_instance_ids()),
            alarm_id=instance.alarm_id,
            code=instance.code,
            level=instance.level,
            title=instance.title,
            group_title=instance.group_title,
            triggered_at=instance.triggered_at,
            cleared_at=now,
            acked=instance.acked,
            acked_by=instance.acked_by,
            acked_at=instance.acked_at,
        )
        self._state.active = [a for a in self._state.active if a.id != instance.id]
        self._state.history.insert(0, history_entry)
        # Trim history
        if len(self._state.history) > _MAX_HISTORY:
            self._state.history = self._state.history[:_MAX_HISTORY]
        logger.info("Alarm cleared: [%s] %s", instance.code, instance.title)

    # ── Acknowledgment ────────────────────────────────────────────────────────

    def ack_alarm(
        self, instance_id: str, username: str, *, actor_source: str = audit.ACTOR_CLAIMED
    ) -> bool:
        """Acknowledge a single active alarm. Alarm stays active until the trigger drops.

        Only a real unacked -> acked transition records anything. An alarm has
        exactly one ``acked_by``, so a second press either has to overwrite it —
        leaving the trail naming someone the stored state does not — or change
        nothing. It changes nothing: whoever got there first owns the
        acknowledgement, and the trail says the same. A double-click, a retried
        POST and a second operator pressing an already-lit button are all the
        same non-event, and an append-only file that can never be corrected is
        the wrong place to write non-events.

        Still returns True when the instance exists, acked or not, so a retry
        reads as success rather than as a vanished alarm (the route maps False
        to 404).
        """
        found = False
        acked: dict[str, Any] | None = None
        with self._lock:
            for inst in self._state.active:
                if inst.id == instance_id:
                    found = True
                    if not inst.acked:
                        inst.acked = True
                        inst.acked_by = username
                        inst.acked_at = datetime.now(UTC).isoformat()
                        self._save_state()
                        self._request_broadcast()
                        logger.info("Alarm acked: [%s] %s by %s", inst.code, inst.title, username)
                        acked = {"code": inst.code, "title": inst.title}
                    break
        if acked is not None:
            # Emitted outside the lock — a listener is arbitrary code and must not
            # run while the alarm state is held.
            audit.emit(
                audit.AuditEvent(
                    actor=username,
                    actor_source=actor_source,
                    action="alarm.ack",
                    subject=instance_id,
                    detail=acked,
                )
            )
        return found

    def ack_all(self, username: str, *, actor_source: str = audit.ACTOR_CLAIMED) -> int:
        """Acknowledge all active alarms. Alarms stay active until their triggers drop."""
        with self._lock:
            now = datetime.now(UTC).isoformat()
            count = 0
            for inst in self._state.active:
                if not inst.acked:
                    inst.acked = True
                    inst.acked_by = username
                    inst.acked_at = now
                    count += 1
            if count > 0:
                self._save_state()
                self._request_broadcast()
                logger.info("Acked all alarms (%d) by %s", count, username)
        if count:
            audit.emit(
                audit.AuditEvent(
                    actor=username,
                    actor_source=actor_source,
                    action="alarm.ack_all",
                    subject="*",
                    detail={"count": count},
                )
            )
        return count

    # ── Broadcast helpers ─────────────────────────────────────────────────────

    def _active_payload_data(self) -> dict[str, Any]:
        """Shared active-alarm + summary data; call only while holding self._lock."""
        return {
            "active": [inst.model_dump() for inst in self._state.active],
            "summary": self._compute_summary().model_dump(),
        }

    def _request_broadcast(self) -> None:
        if self._broadcast_callback is not None:
            payload = {"type": "alarm_update", **self._active_payload_data()}
            try:
                self._broadcast_callback(payload)
            except Exception:
                logger.exception("Failed to broadcast alarm update")

    def _request_recompute(self) -> None:
        """Ask the wired callback to schedule an OPC-UA priority recompute.

        Call only while holding self._lock, after the config is persisted, so
        the save itself always succeeds regardless of OPC-UA/recompute state.
        """
        if self._recompute_callback is not None:
            try:
                self._recompute_callback()
            except Exception:
                logger.exception("Failed to schedule alarm priority recompute")

    def build_snapshot_payload(self) -> dict[str, Any]:
        """Build the full alarm snapshot payload for newly connected clients."""
        with self._lock:
            return {"type": "alarm_snapshot", **self._active_payload_data()}


# Singleton instance
alarm_manager = AlarmManager()
