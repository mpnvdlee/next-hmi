"""Versioned operator-password hashes with unambiguous legacy plaintext support."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Any

HASH_VERSION = 1
HASH_ALGORITHM = "pbkdf2-sha256"
HASH_ITERATIONS = 200_000
_SALT_BYTES = 16


def hash_password(password: str) -> dict[str, Any]:
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, HASH_ITERATIONS
    )
    return {
        "version": HASH_VERSION,
        "algorithm": HASH_ALGORITHM,
        "iterations": HASH_ITERATIONS,
        "salt": salt.hex(),
        "digest": digest.hex(),
    }


def is_valid_hash(value: Any) -> bool:
    return _parse_hash(value) is not None


def verify_password(user: dict[str, Any], candidate: Any) -> bool:
    """Prefer explicit passwordHash; otherwise treat password as literal legacy text."""
    if not isinstance(candidate, str):
        return False
    if "passwordHash" in user:
        parsed = _parse_hash(user.get("passwordHash"))
        if parsed is None:
            return False
        iterations, salt, expected = parsed
        actual = hashlib.pbkdf2_hmac(
            "sha256", candidate.encode("utf-8"), salt, iterations
        )
        return hmac.compare_digest(actual, expected)
    legacy = str(user.get("password", ""))
    return hmac.compare_digest(legacy.encode("utf-8"), candidate.encode("utf-8"))


def _parse_hash(value: Any) -> tuple[int, bytes, bytes] | None:
    if not isinstance(value, dict) or set(value) != {
        "version",
        "algorithm",
        "iterations",
        "salt",
        "digest",
    }:
        return None
    if (
        value.get("version") != HASH_VERSION
        or value.get("algorithm") != HASH_ALGORITHM
        or value.get("iterations") != HASH_ITERATIONS
    ):
        return None
    try:
        salt = bytes.fromhex(value["salt"])
        digest = bytes.fromhex(value["digest"])
    except (TypeError, ValueError):
        return None
    if len(salt) != _SALT_BYTES or len(digest) != 32:
        return None
    return HASH_ITERATIONS, salt, digest
