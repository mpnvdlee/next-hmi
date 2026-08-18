"""Device-admin authentication for the manager.

The manager is the always-on, LAN-exposed front door (it can start/stop/delete
projects), so it sits behind a single device-admin password set on first run. State lives in ``<runtime_home>/.manager-auth.json``:

    { "salt": <hex>, "hash": <hex>, "iterations": N, "secret": <hex> }

Passwords are stored as PBKDF2-HMAC-SHA256 digests (stdlib only — no bcrypt/argon2
dependency). Sessions are stateless HMAC-signed tokens carried in a cookie, signed
with the per-install ``secret`` so they survive a manager restart but are
invalidated if the auth file is rotated.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from core import runtime_home
from core.storage import write_text_atomic

SESSION_COOKIE = "nexthmi_manager_session"
_DEFAULT_TTL_SECONDS = 7 * 24 * 3600
_PBKDF2_ITERATIONS = 200_000
_AUTH_FILENAME = ".manager-auth.json"

# Login throttle: after this many consecutive failures the login endpoint is
# locked for the cooldown below. In-memory (resets on manager restart) — enough
# to blunt online brute force against the LAN front door without a datastore.
_LOCKOUT_THRESHOLD = 5
_LOCKOUT_SECONDS = 60.0
_throttle_lock = threading.Lock()
_failed_attempts = 0
_lockout_until = 0.0


def lockout_remaining() -> float:
    """Seconds the login endpoint stays locked, or ``0.0`` if it is open."""
    with _throttle_lock:
        return max(0.0, _lockout_until - time.monotonic())


def register_login_failure() -> None:
    """Count a bad password; trip the lockout once the threshold is reached."""
    global _failed_attempts, _lockout_until
    with _throttle_lock:
        _failed_attempts += 1
        if _failed_attempts >= _LOCKOUT_THRESHOLD:
            _lockout_until = time.monotonic() + _LOCKOUT_SECONDS
            _failed_attempts = 0


def register_login_success() -> None:
    """Clear the failure counter and any active lockout after a good password."""
    global _failed_attempts, _lockout_until
    with _throttle_lock:
        _failed_attempts = 0
        _lockout_until = 0.0


def auth_path() -> Path:
    return runtime_home.runtime_home_path() / _AUTH_FILENAME


def _load() -> dict[str, Any] | None:
    path = auth_path()
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def is_password_set() -> bool:
    data = _load()
    return bool(data and data.get("hash") and data.get("salt"))


def _hash_password(password: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)


def set_password(password: str) -> None:
    """Create or replace the device-admin password (and rotate the session secret)."""
    if not password:
        raise ValueError("Password must not be empty")
    salt = secrets.token_bytes(16)
    digest = _hash_password(password, salt, _PBKDF2_ITERATIONS)
    payload = {
        "salt": salt.hex(),
        "hash": digest.hex(),
        "iterations": _PBKDF2_ITERATIONS,
        "secret": secrets.token_hex(32),
    }
    write_text_atomic(auth_path(), json.dumps(payload, indent=2))


def verify_password(password: str) -> bool:
    data = _load()
    if not data:
        return False
    try:
        salt = bytes.fromhex(data["salt"])
        expected = bytes.fromhex(data["hash"])
        iterations = int(data.get("iterations", _PBKDF2_ITERATIONS))
    except (KeyError, ValueError):
        return False
    candidate = _hash_password(password, salt, iterations)
    return hmac.compare_digest(candidate, expected)


def _secret() -> bytes | None:
    data = _load()
    if not data:
        return None
    raw = data.get("secret")
    if not isinstance(raw, str):
        return None
    try:
        return bytes.fromhex(raw)
    except ValueError:
        return None


def credential_generation() -> str | None:
    """Opaque generation identifier rotated with the device-admin password."""
    secret = _secret()
    return hashlib.sha256(secret).hexdigest() if secret is not None else None


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def issue_token(ttl_seconds: int = _DEFAULT_TTL_SECONDS) -> str:
    """Mint a signed session token. Caller must have verified the password."""
    secret = _secret()
    if secret is None:
        raise ValueError("Auth not configured")
    payload = json.dumps({"exp": int(time.time()) + ttl_seconds}).encode("utf-8")
    sig = hmac.new(secret, payload, hashlib.sha256).digest()
    return f"{_b64encode(payload)}.{_b64encode(sig)}"


def verify_token(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    secret = _secret()
    if secret is None:
        return False
    payload_b64, sig_b64 = token.split(".", 1)
    try:
        payload = _b64decode(payload_b64)
        sig = _b64decode(sig_b64)
    except (ValueError, TypeError):
        return False
    expected = hmac.new(secret, payload, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        return False
    try:
        data = json.loads(payload)
    except ValueError:
        return False
    return int(data.get("exp", 0)) > int(time.time())
