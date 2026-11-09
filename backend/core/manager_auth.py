"""Device-admin authentication for the manager.

The manager is the always-on, LAN-exposed front door (it can start/stop/delete
projects), so it sits behind a single device-admin password set on first run. State lives in ``<runtime_home>/.manager-auth.json``:

    { "salt": <hex>, "hash": <hex>, "iterations": N, "secret": <hex>,
      "sessions": { <SHA-256 of a session token, hex>: <expiry, epoch seconds> } }

Passwords are stored as PBKDF2-HMAC-SHA256 digests (stdlib only — no bcrypt/argon2
dependency). A session token is a random value carried in a cookie; the file
keeps only its digest, so a session ends on the server when it is signed out, at
"sign out everywhere", on a password change and when HTTPS is turned on, and a
restart does not bring an ended one back. ``secret`` rotates with the password
and binds MCP, API and peer tokens to it (:func:`credential_generation`).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import math
import secrets
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

from core import runtime_home
from core.exceptions import RateLimitError
from core.storage import write_text_atomic

SESSION_COOKIE = "nexthmi_manager_session"
# Absolute lifetime from sign-in, not an idle timeout: nothing refreshes the
# token, so a browser left signed in on the plant floor stops being a key
# within a day whether or not it was used.
SESSION_TTL_SECONDS = 24 * 3600
# Signing in past this many live sessions ends the oldest, so the file stays small.
_MAX_SESSIONS = 100
# For a new password only (setup, change password): sign-in accepts whatever
# password is stored, so an install with a shorter one keeps working.
MIN_PASSWORD_LENGTH = 8
# OWASP's figure for PBKDF2-HMAC-SHA256. A stored hash records its own count and
# is re-hashed at this one the next time its password verifies.
_PBKDF2_ITERATIONS = 600_000
_LEGACY_PBKDF2_ITERATIONS = 200_000
_AUTH_FILENAME = ".manager-auth.json"

# Sign-in throttle, per client address, so that a script guessing from one
# machine locks out that machine and not every admin: this many consecutive
# failures from an address refuse it for the cooldown below. In memory (resets
# on manager restart) — enough to blunt online brute force without a datastore.
_LOCKOUT_THRESHOLD = 5
_LOCKOUT_SECONDS = 60.0
# Addresses are cheap to come by (an IPv6 /64 holds 2^64 of them), so the table
# is capped and the address whose last failure is oldest is dropped first.
_MAX_TRACKED_ADDRESSES = 1024
# Safety net for guessing spread over many addresses: this many failures within
# one window, all addresses together, refuse every address for the cooldown.
# One address adds at most _LOCKOUT_THRESHOLD a window, so it takes about 20.
_GLOBAL_THRESHOLD = 100
_GLOBAL_WINDOW_SECONDS = 60.0
_throttle_lock = threading.Lock()
_failures: OrderedDict[str, tuple[int, float]] = OrderedDict()  # address → (count, locked until)
_global_window_start = 0.0
_global_failures = 0
_global_lockout_until = 0.0

# One password check at a time, the lockout read inside: checked outside, every
# guess already in flight would pass it before the first failure counted.
_password_lock = asyncio.Lock()

# Serializes read-modify-write of the auth file (sign-in, sign-out, re-hash).
_state_lock = threading.Lock()

# The last password that verified, as an HMAC under a key that never leaves
# this process, next to the stored digest it matched. API v1's Basic auth sends
# the password with every request; without this each one would pay a full
# derivation (~70 ms on a desktop CPU, far more on a panel PC) one at a time. A
# wrong password never matches it and still pays in full.
_verified_key = secrets.token_bytes(32)
_verified: tuple[str, bytes] | None = None

# First-run setup code. Until a password exists, /setup has nothing to check a
# caller against, and a website that points a name of its own at the device (DNS
# rebinding) passes the Origin check like the device itself. The code is printed
# on the console and in the log, which no website can read. Memory only: every
# start prints a fresh one.
_SETUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L
_setup_code: str | None = None


def client_address(request: Any) -> str:
    """The address the throttle counts *request* against.

    ``request.client`` already reflects a trusted proxy's forwarded header
    (uvicorn's ``proxy_headers`` with ``NEXTHMI_FORWARDED_ALLOW_IPS``).
    """
    return request.client.host if request.client else "unknown"


def _remaining(address: str) -> tuple[float, float]:
    """Seconds left on *address*'s own lockout and on the device-wide one."""
    now = time.monotonic()
    own = _failures.get(address, (0, 0.0))[1]
    return max(0.0, own - now), max(0.0, _global_lockout_until - now)


def lockout_remaining(address: str) -> float:
    """Seconds sign-in stays locked for *address*, or ``0.0`` if it is open."""
    with _throttle_lock:
        return max(_remaining(address))


def require_not_locked_out(address: str) -> None:
    """Raise ``RateLimitError`` (429 with ``Retry-After``) while *address* is locked out."""
    with _throttle_lock:
        own, everyone = _remaining(address)
    if own <= 0 and everyone <= 0:
        return
    seconds = math.ceil(max(own, everyone))
    if own >= everyone:
        raise RateLimitError(
            f"Too many failed attempts from {address}. Try again in {seconds}s.",
            retry_after=seconds,
            clientAddress=address,
        )
    raise RateLimitError(
        f"Too many failed attempts on this device. Try again in {seconds}s.",
        retry_after=seconds,
    )


def register_login_failure(address: str) -> None:
    """Count a bad password from *address*; trip its lockout, or everyone's, at the threshold."""
    global _global_window_start, _global_failures, _global_lockout_until
    with _throttle_lock:
        now = time.monotonic()
        count, until = _failures.pop(address, (0, 0.0))
        count += 1
        if count >= _LOCKOUT_THRESHOLD:
            count, until = 0, now + _LOCKOUT_SECONDS
        _failures[address] = (count, until)
        while len(_failures) > _MAX_TRACKED_ADDRESSES:
            _failures.popitem(last=False)
        if now - _global_window_start >= _GLOBAL_WINDOW_SECONDS:
            _global_window_start, _global_failures = now, 0
        _global_failures += 1
        if _global_failures >= _GLOBAL_THRESHOLD:
            _global_lockout_until = now + _LOCKOUT_SECONDS
            _global_failures = 0


def register_login_success(address: str) -> None:
    """Clear *address*'s failure count after a good password."""
    with _throttle_lock:
        _failures.pop(address, None)


def reset_throttle() -> None:
    """Forget every failure and lockout (tests)."""
    global _global_window_start, _global_failures, _global_lockout_until
    with _throttle_lock:
        _failures.clear()
        _global_window_start = _global_lockout_until = 0.0
        _global_failures = 0


async def check_password(address: str, password: str, *, count_success: bool = True) -> bool:
    """The device-admin password check every admin path shares.

    Refused with a 429 while *address* is locked out; a wrong password counts
    toward its lockout. The derivation runs in a worker thread so the event
    loop, which carries every proxied HMI connection, keeps serving.
    ``count_success=False`` leaves the failure count alone on success — see
    API v1's Basic auth.
    """
    async with _password_lock:
        require_not_locked_out(address)
        if not await asyncio.to_thread(verify_password, password):
            register_login_failure(address)
            return False
        if count_success:
            register_login_success(address)
        return True


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


def _save(data: dict[str, Any]) -> None:
    write_text_atomic(auth_path(), json.dumps(data, indent=2))


def is_password_set() -> bool:
    data = _load()
    return bool(data and data.get("hash") and data.get("salt"))


def setup_code() -> str | None:
    """The code first-run setup requires (``XXXX-XXXX``), or ``None`` once a
    password is set."""
    global _setup_code
    if is_password_set():
        _setup_code = None
        return None
    if _setup_code is None:
        raw = "".join(secrets.choice(_SETUP_CODE_ALPHABET) for _ in range(8))
        _setup_code = f"{raw[:4]}-{raw[4:]}"
    return _setup_code


def _normalized_code(code: str) -> bytes:
    # Typed from a terminal: case, the dash and stray spaces must not matter.
    return "".join(ch for ch in code.upper() if ch.isalnum()).encode("utf-8")


def verify_setup_code(candidate: str) -> bool:
    expected = setup_code()
    if expected is None:
        return False
    return hmac.compare_digest(_normalized_code(candidate), _normalized_code(expected))


def _hash_password(password: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)


def _new_hash(password: str) -> dict[str, Any]:
    salt = secrets.token_bytes(16)
    digest = _hash_password(password, salt, _PBKDF2_ITERATIONS)
    return {"salt": salt.hex(), "hash": digest.hex(), "iterations": _PBKDF2_ITERATIONS}


def set_password(password: str) -> None:
    """Create or replace the device-admin password.

    Rotates the secret MCP, API and peer tokens are bound to and ends every
    session; spends the setup code, which opens first-run setup once, never again.
    """
    global _setup_code
    if not password:
        raise ValueError("Password must not be empty")
    payload = {**_new_hash(password), "secret": secrets.token_hex(32), "sessions": {}}
    with _state_lock:
        _save(payload)
    _setup_code = None


def verify_password(password: str) -> bool:
    global _verified
    data = _load()
    if not data:
        return False
    try:
        stored = data["hash"]
        salt = bytes.fromhex(data["salt"])
        expected = bytes.fromhex(stored)
        iterations = int(data.get("iterations", _LEGACY_PBKDF2_ITERATIONS))
    except (KeyError, TypeError, ValueError):
        return False
    tag = hmac.new(_verified_key, password.encode("utf-8"), hashlib.sha256).digest()
    cached = _verified
    if cached is not None and cached[0] == stored and hmac.compare_digest(cached[1], tag):
        return True
    if not hmac.compare_digest(_hash_password(password, salt, iterations), expected):
        return False
    if iterations < _PBKDF2_ITERATIONS:
        stored = _rehash(password, stored) or stored
    _verified = (stored, tag)
    return True


def _rehash(password: str, old_hash: str) -> str | None:
    """Re-hash at the current count, keeping the secret and the sessions.

    ``None`` when the password changed meanwhile and there is nothing to upgrade.
    """
    fresh = _new_hash(password)
    with _state_lock:
        data = _load()
        if not data or data.get("hash") != old_hash:
            return None
        _save({**data, **fresh})
    return fresh["hash"]


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


def _session_key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _live_sessions(data: dict[str, Any]) -> dict[str, int]:
    raw = data.get("sessions")
    if not isinstance(raw, dict):
        return {}
    now = time.time()
    return {
        key: expires
        for key, expires in raw.items()
        if isinstance(key, str) and type(expires) is int and expires > now
    }


def issue_token(ttl_seconds: int = SESSION_TTL_SECONDS) -> str:
    """Start a session and return its token. Caller must have verified the password."""
    token = secrets.token_urlsafe(32)
    with _state_lock:
        data = _load()
        if not data or not data.get("hash"):
            raise ValueError("Auth not configured")
        sessions = _live_sessions(data)
        sessions[_session_key(token)] = int(time.time()) + ttl_seconds
        while len(sessions) > _MAX_SESSIONS:
            del sessions[min(sessions, key=sessions.__getitem__)]
        _save({**data, "sessions": sessions})
    return token


def verify_token(token: str | None) -> bool:
    if not token:
        return False
    data = _load()
    sessions = data.get("sessions") if data else None
    if not isinstance(sessions, dict):
        return False
    expires = sessions.get(_session_key(token))
    return type(expires) is int and expires > time.time()


def revoke_token(token: str | None) -> None:
    """End the session *token* belongs to, if it is live."""
    if not token:
        return
    with _state_lock:
        data = _load()
        if not data:
            return
        sessions = _live_sessions(data)
        if sessions.pop(_session_key(token), None) is None:
            return
        _save({**data, "sessions": sessions})


def revoke_all_sessions() -> None:
    """End every browser session. MCP, API and peer tokens are not sessions and stay."""
    with _state_lock:
        data = _load()
        if not data or not data.get("sessions"):
            return
        _save({**data, "sessions": {}})
