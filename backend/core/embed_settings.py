"""Sites allowed to show NEXT HMI inside a frame (Settings → Sites that may embed NEXT HMI).

Device-level like HTTPS: one origin serves the dashboard and every project's
screens, so one list covers them all. Stored in the runtime home, which the
manager and every project instance share, and read by
``core.security_headers`` on each HTML response in both — a change applies to
the next page load, with no restart. Each process keeps the parsed list until
the file changes.

An entry is an origin and nothing more — ``scheme://host[:port]`` — because it
lands verbatim in a ``frame-ancestors`` header: the strict shape is what keeps
an entry from smuggling another CSP directive in with it. The list is capped
for the same reason: every HTML page carries it, and a header past the
browser's limit fails every page, the Settings page that would undo it among
them.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from core import runtime_home
from core.storage import write_text_atomic

logger = logging.getLogger(__name__)

_FILENAME = ".embedding.json"
MAX_ORIGINS = 32
_MAX_HOST_LENGTH = 253  # the longest DNS name
_DEFAULT_PORTS = {"http": 80, "https": 443}
# CSP's host-source grammar: dot-separated labels of letters, digits and
# hyphens. That excludes IPv6 literals, which browsers do not match there.
_HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$")
_lock = threading.Lock()
# path -> (the file's (inode, mtime, size), the list parsed from it). Every
# write replaces the file whole, so a change any process makes shows as a new
# key here.
_cache: dict[Path, tuple[tuple[int, int, int], tuple[str, ...]]] = {}


def _path(home: Path | None = None) -> Path:
    return (home or runtime_home.runtime_home_path()) / _FILENAME


def parse_origin(entry: Any) -> str:
    """The canonical ``scheme://host[:port]`` that *entry* names.

    Lower-cased, one trailing slash tolerated, a default port dropped. Raises
    ``ValueError`` with a message fit for the Settings page otherwise.
    """
    text = entry.strip() if isinstance(entry, str) else ""
    if text.endswith("/"):
        text = text[:-1]
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        parts, port = None, None
    scheme = parts.scheme.lower() if parts else ""
    host = parts.hostname if parts else None
    if (
        parts is None
        or scheme not in _DEFAULT_PORTS
        or not host
        or len(host) > _MAX_HOST_LENGTH
        or not _HOST_RE.match(host)
        or parts.username is not None
        or port == 0
        or parts.path
        or parts.query
        or parts.fragment
    ):
        raise ValueError(
            f'"{entry}" is not a site address. Enter only the scheme, host and optional '
            "port, such as https://portal.example.com:8443."
        )
    if port is None or port == _DEFAULT_PORTS[scheme]:
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


def allowed_origins(home: Path | None = None) -> tuple[str, ...]:
    """The stored sites, in order, at most ``MAX_ORIGINS``.

    A hand-edited entry that would be refused is skipped, and so is every one
    past the cap. Parsed once per version of the file: this runs on every HTML
    response.
    """
    path = _path(home)
    try:
        stat = path.stat()
    except OSError:
        return ()
    version = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
    cached = _cache.get(path)
    if cached is not None and cached[0] == version:
        return cached[1]
    origins = _read(path)
    _cache[path] = (version, origins)
    return origins


def _read(path: Path) -> tuple[str, ...]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ()
    entries = raw.get("allowedOrigins") if isinstance(raw, dict) else None
    origins: dict[str, None] = {}
    for entry in entries if isinstance(entries, list) else ():
        if len(origins) == MAX_ORIGINS:
            logger.warning("embedding: %s lists over %d sites; ignoring the rest", _FILENAME, MAX_ORIGINS)
            break
        try:
            origins[parse_origin(entry)] = None
        except ValueError as exc:
            logger.warning("embedding: ignoring %s entry: %s", _FILENAME, exc)
    return tuple(origins)


def set_allowed_origins(entries: list[Any], home: Path | None = None) -> tuple[str, ...]:
    """Validate and store *entries*; nothing is written when one is refused."""
    origins = tuple(dict.fromkeys(parse_origin(entry) for entry in entries))
    if len(origins) > MAX_ORIGINS:
        raise ValueError(
            f"At most {MAX_ORIGINS} sites may embed NEXT HMI, and this list has "
            f"{len(origins)}. Remove the ones that no longer need to."
        )
    path = _path(home)
    with _lock:
        write_text_atomic(
            path, json.dumps({"version": 1, "allowedOrigins": list(origins)}, indent=2),
        )
        _cache.pop(path, None)
    return origins
