"""Operator password hashing and legacy verification."""

from core.passwords import hash_password, is_valid_hash, verify_password


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
