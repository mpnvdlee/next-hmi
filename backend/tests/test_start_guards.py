"""The instance-start seam. The public build registers nothing with it.

``core.start_guards`` is generic plumbing, like ``core.audit`` — the behaviour
worth pinning is that an empty registry is inert, that a refusal reaches the
caller as the start error verbatim, and that a *broken* guard cannot hold a
factory's screens down.
"""
from __future__ import annotations

from core import start_guards


def _reject(reason: str):
    return lambda _project_id: reason


class TestRegistry:
    def test_no_guards_means_no_refusal(self) -> None:
        assert start_guards.refusal("plant-a") is None

    def test_a_guard_returning_none_allows(self) -> None:
        guard = lambda _project_id: None  # noqa: E731
        start_guards.register_guard(guard)
        try:
            assert start_guards.refusal("plant-a") is None
        finally:
            start_guards.unregister_guard(guard)

    def test_first_refusal_wins(self) -> None:
        first, second = _reject("no licence"), _reject("some other reason")
        start_guards.register_guard(first)
        start_guards.register_guard(second)
        try:
            assert start_guards.refusal("plant-a") == "no licence"
        finally:
            start_guards.unregister_guard(first)
            start_guards.unregister_guard(second)

    def test_registration_is_deduplicated(self) -> None:
        """A re-imported entrypoint must not stack a second copy of its guard."""
        guard = _reject("no licence")
        start_guards.register_guard(guard)
        start_guards.register_guard(guard)
        start_guards.unregister_guard(guard)

        assert start_guards.refusal("plant-a") is None

    def test_unregistering_an_absent_guard_is_a_no_op(self) -> None:
        start_guards.unregister_guard(_reject("never registered"))

    def test_the_project_id_is_passed_through(self) -> None:
        seen: list[str] = []

        def guard(project_id: str) -> None:
            seen.append(project_id)
            return None

        start_guards.register_guard(guard)
        try:
            start_guards.refusal("plant-a")
        finally:
            start_guards.unregister_guard(guard)
        assert seen == ["plant-a"]


class TestFailOpen:
    def test_a_raising_guard_is_skipped(self) -> None:
        """A broken gate must not be able to keep every project down."""

        def broken(_project_id: str) -> str:
            raise RuntimeError("fingerprint source exploded")

        start_guards.register_guard(broken)
        try:
            assert start_guards.refusal("plant-a") is None
        finally:
            start_guards.unregister_guard(broken)

    def test_a_raising_guard_does_not_hide_a_later_refusal(self) -> None:
        def broken(_project_id: str) -> str:
            raise RuntimeError("boom")

        good = _reject("no licence")
        start_guards.register_guard(broken)
        start_guards.register_guard(good)
        try:
            assert start_guards.refusal("plant-a") == "no licence"
        finally:
            start_guards.unregister_guard(broken)
            start_guards.unregister_guard(good)
