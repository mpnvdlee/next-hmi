"""Operator password hashing and legacy verification."""

import core.passwords as passwords
from core.passwords import (
    has_password,
    hash_password,
    is_valid_hash,
    verify_absent_user,
    verify_password,
)


def _count_derivations(monkeypatch) -> list[int]:
    """Collect one entry per PBKDF2 derivation — the cost an attacker times."""
    calls: list[int] = []
    real = passwords.hashlib.pbkdf2_hmac

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(passwords.hashlib, "pbkdf2_hmac", counting)
    return calls


def test_hash_is_versioned_salted_and_never_contains_plaintext() -> None:
    first = hash_password("operator-secret")
    second = hash_password("operator-secret")

    assert first["version"] == 1
    assert first["algorithm"] == "pbkdf2-sha256"
    assert first["iterations"] == 200_000
    assert "operator-secret" not in str(first)
    assert first != second
    assert is_valid_hash(first) is True
    assert is_valid_hash(second) is True


def test_hash_verification_accepts_only_valid_password() -> None:
    stored = hash_password("correct")

    user = {"password": "", "passwordHash": stored}
    assert verify_password(user, "correct") is True
    assert verify_password(user, "incorrect") is False


def test_legacy_plaintext_verification_remains_compatible() -> None:
    assert verify_password({"password": "legacy-secret"}, "legacy-secret") is True
    assert verify_password({"password": "legacy-secret"}, "wrong") is False


def test_hash_prefix_like_legacy_plaintext_is_literal() -> None:
    legacy = "$nexthmi$pbkdf2-sha256$v1$anything"
    assert verify_password({"password": legacy}, legacy) is True
    assert verify_password({"password": legacy}, "anything") is False


def test_invalid_or_unknown_hash_fails_closed() -> None:
    assert verify_password({"passwordHash": {"version": 1}}, "bad") is False
    assert (
        verify_password({"password": "ignored", "passwordHash": "bad"}, "ignored")
        is False
    )
    assert is_valid_hash({"version": 1}) is False


def test_non_string_candidate_fails_closed() -> None:
    assert (
        verify_password({"password": "legacy-secret"}, {"value": "legacy-secret"})
        is False
    )


def test_account_with_no_password_never_verifies() -> None:
    """The editor creates every user as ``password: ""``, and ``guest`` stays
    that way for ever. Against a bare ``compare_digest(b"", b"")`` an empty
    candidate matched, so knowing the name was the whole credential."""
    for user in (
        {"password": ""},
        {"username": "guest", "password": "", "groups": ["guest"]},
        {"id": "u1", "groups": ["engineer"]},
        {"password": "", "passwordHash": None},
    ):
        assert verify_password(user, "") is False
        assert verify_password(user, "anything") is False


def test_has_password_reports_what_can_actually_be_presented() -> None:
    assert has_password({"password": ""}) is False
    assert has_password({"groups": ["guest"]}) is False
    assert has_password({"password": "legacy-secret"}) is True
    assert has_password({"password": "", "passwordHash": hash_password("x")}) is True
    assert has_password({"passwordHash": "not-a-hash"}) is False
    assert has_password("not-a-user") is False


def test_absent_user_verification_always_fails() -> None:
    assert verify_absent_user("anything") is False
    assert verify_absent_user("") is False
    assert verify_absent_user(None) is False


def test_a_miss_costs_exactly_what_a_wrong_password_costs(monkeypatch) -> None:
    """Unknown user 0.5 ms vs wrong password 25.7 ms enumerated the roster.
    Counting derivations pins the same property without timing anything."""
    stored = hash_password("correct")
    calls = _count_derivations(monkeypatch)

    assert verify_password({"password": "", "passwordHash": stored}, "wrong") is False
    wrong_password = len(calls)
    calls.clear()

    assert verify_absent_user("wrong") is False
    unknown_user = len(calls)
    calls.clear()

    assert verify_password({"password": ""}, "wrong") is False
    no_credential = len(calls)
    calls.clear()

    assert verify_password({"passwordHash": "corrupt"}, "wrong") is False
    unusable_hash = len(calls)
    calls.clear()

    assert verify_password({"password": "legacy-secret"}, "legacy-secret") is True
    legacy_hit = len(calls)
    calls.clear()

    assert verify_password({"password": "legacy-secret"}, "wrong") is False
    legacy_miss = len(calls)

    assert wrong_password == 1
    assert (unknown_user, no_credential, unusable_hash) == (1, 1, 1)
    assert (legacy_hit, legacy_miss) == (1, 1)
