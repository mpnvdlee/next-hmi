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

# A credential nothing can present: real salt, random bytes where a digest
# would be. Verifying against it costs exactly what verifying a real hash costs
# and can never succeed, so a username that misses and an account with no
# password set both answer in the time a wrong password takes — the difference
# was an oracle that enumerated the roster. Built without running PBKDF2, so
# importing this module stays free.
_DECOY_CREDENTIAL: tuple[int, bytes, bytes] = (
    HASH_ITERATIONS,
    secrets.token_bytes(_SALT_BYTES),
    secrets.token_bytes(32),
)


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


def has_password(user: Any) -> bool:
    """True when *user* carries a credential that can be presented at sign-in.

    The editor creates every new user with ``password: ""`` and no hash, and
    ``guest`` is stored that way permanently. Such an account has nothing to
    verify against: it is an identity the runtime can *be* (auto-login,
    logout), never one anybody can *sign in as*.
    """
    if not isinstance(user, dict):
        return False
    if "passwordHash" in user:
        return _parse_hash(user.get("passwordHash")) is not None
    return bool(str(user.get("password", "")))


def verify_password(user: dict[str, Any], candidate: Any) -> bool:
    """Prefer explicit passwordHash; otherwise treat password as literal legacy text.

    Every call costs exactly one PBKDF2 derivation, whatever it decides, so
    nothing about the account leaks from how long the answer took.

    An account with no credential never verifies — not even against the empty
    string, which the plain ``compare_digest(b"", b"")`` accepted and thereby
    made every passwordless account (``guest`` included, and every user the
    editor had just created) signed-in-able by anyone who knew the name.
    """
    if not isinstance(candidate, str):
        return False
    if "passwordHash" in user:
        parsed = _parse_hash(user.get("passwordHash"))
        if parsed is None:
            return _refuse(candidate)
        return _verify_pbkdf2(parsed, candidate)
    legacy = str(user.get("password", ""))
    if not legacy:
        return _refuse(candidate)
    # One derivation for this branch too. The compare itself is constant-time
    # but free, so without it a legacy account answers in the time a *miss*
    # used to — which says which names still carry a plaintext password.
    _verify_pbkdf2(_DECOY_CREDENTIAL, candidate)
    return hmac.compare_digest(legacy.encode("utf-8"), candidate.encode("utf-8"))


def verify_absent_user(candidate: Any) -> bool:
    """Always ``False``, at the cost of a real verification.

    Called where a username matched no account. Returning early there answered
    ~50x faster than a wrong password did, which told an anonymous caller
    exactly which names exist.
    """
    if not isinstance(candidate, str):
        return False
    return _refuse(candidate)


def _verify_pbkdf2(parsed: tuple[int, bytes, bytes], candidate: str) -> bool:
    iterations, salt, expected = parsed
    actual = hashlib.pbkdf2_hmac("sha256", candidate.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


def _refuse(candidate: str) -> bool:
    """Spend a verification's worth of work on a credential that cannot match."""
    _verify_pbkdf2(_DECOY_CREDENTIAL, candidate)
    return False


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
