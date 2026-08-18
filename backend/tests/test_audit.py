"""The audit seam, and the guarantee that it is inert in the public build."""
from __future__ import annotations

import asyncio
import threading

import pytest
from core import audit


@pytest.fixture(autouse=True)
def _no_leftover_listeners():
    yield
    audit._listeners.clear()


def test_public_build_registers_no_listeners():
    """The whole point: emit() must be a no-op in the open-source build."""
    assert audit._listeners == []


def test_emit_reaches_every_registered_listener():
    seen: list[audit.AuditEvent] = []
    audit.register_listener(seen.append)

    audit.emit(audit.AuditEvent(actor="ops", action="alarm.ack", subject="a1"))

    assert [(e.actor, e.action, e.subject) for e in seen] == [("ops", "alarm.ack", "a1")]


def test_registering_twice_delivers_once():
    seen: list[audit.AuditEvent] = []
    audit.register_listener(seen.append)
    audit.register_listener(seen.append)

    audit.emit(audit.AuditEvent(actor="ops", action="x", subject="y"))

    assert len(seen) == 1


def test_unregister_stops_delivery_and_is_idempotent():
    seen: list[audit.AuditEvent] = []
    audit.register_listener(seen.append)
    audit.unregister_listener(seen.append)
    audit.unregister_listener(seen.append)  # no-op, must not raise

    audit.emit(audit.AuditEvent(actor="ops", action="x", subject="y"))

    assert seen == []


def test_a_failing_listener_cannot_break_the_audited_operation():
    """A listener is arbitrary code; the caller is mid-acknowledgement."""
    survivors: list[str] = []

    def boom(_event: audit.AuditEvent) -> None:
        raise RuntimeError("listener exploded")

    audit.register_listener(boom)
    audit.register_listener(lambda e: survivors.append(e.action))

    audit.emit(audit.AuditEvent(actor="ops", action="alarm.ack", subject="a1"))

    assert survivors == ["alarm.ack"]


def test_event_carries_a_timestamp_by_default():
    event = audit.AuditEvent(actor="ops", action="x", subject="y")
    assert event.ts.tzinfo is not None
    assert event.detail == {}


class TestActorProvenance:
    """An auditor must be able to tell a name the server knows from one it was told."""

    def test_an_unstated_actor_source_defaults_to_claimed(self):
        """Fail closed: forgetting to say must under-claim, never over-claim."""
        assert audit.AuditEvent(actor="ops", action="x", subject="y").actor_source == (
            audit.ACTOR_CLAIMED
        )

    def test_the_two_provenances_are_distinguishable(self):
        assert audit.ACTOR_SESSION != audit.ACTOR_CLAIMED

    def test_provenance_reaches_the_listener(self):
        seen: list[audit.AuditEvent] = []
        audit.register_listener(seen.append)

        audit.emit(
            audit.AuditEvent(
                actor="ops", action="x", subject="y", actor_source=audit.ACTOR_SESSION
            )
        )

        assert [e.actor_source for e in seen] == [audit.ACTOR_SESSION]


class TestEmitAsync:
    def test_it_delivers_the_event(self):
        seen: list[audit.AuditEvent] = []
        audit.register_listener(seen.append)

        asyncio.run(audit.emit_async(audit.AuditEvent(actor="ops", action="x", subject="y")))

        assert [e.action for e in seen] == ["x"]

    def test_a_blocking_listener_runs_off_the_event_loop_thread(self):
        """The listener persists with fsync; the loop also drives OPC-UA and the fan-out."""
        listener_threads: list[int] = []
        audit.register_listener(lambda _e: listener_threads.append(threading.get_ident()))

        async def scenario() -> int:
            await audit.emit_async(audit.AuditEvent(actor="ops", action="x", subject="y"))
            return threading.get_ident()

        loop_thread = asyncio.run(scenario())

        assert listener_threads and listener_threads[0] != loop_thread

    def test_a_failing_listener_cannot_break_the_audited_operation(self):
        def boom(_event: audit.AuditEvent) -> None:
            raise RuntimeError("listener exploded")

        audit.register_listener(boom)

        asyncio.run(audit.emit_async(audit.AuditEvent(actor="ops", action="x", subject="y")))

    def test_it_is_a_no_op_with_no_listeners(self):
        asyncio.run(audit.emit_async(audit.AuditEvent(actor="ops", action="x", subject="y")))
