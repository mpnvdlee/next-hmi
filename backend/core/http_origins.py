"""The origin allowlist behind ``POST /api/http-request``.

``$http`` property sources are authored in the editor, which sits behind the
device-admin session; the runtime is public. The runtime posts the *resolved*
url (the template is rendered client-side, see
``frontend/src/hmi/utils/propertySourceEval.ts``), so the executed request can
never be compared against a stored string. It can be compared against an
**origin** — scheme + host + port — and that is what this module derives.

Deriving it means walking every document the validation layer resolves property
values in. That is two layers, not one: ``core/validation/structure.py`` for the
page tree — ``config.json`` (shell widget arrays, page-group chrome, shell regions,
``globalEvents`` action payloads), every page file, every reusable component —
and ``core/validation/domains.py`` for the domains that live in their own files:
``alarms.json`` (alarm ``title``/``description``/``image``, every entry of
``resolutions``, and ``trigger.source_value``/``min``/``max``) and
``recipes.json`` (each parameter's ``binding``). The two remaining domains
``domains.py`` validates hold no property value at all — ``historian/config.json``
keys are ``datasource:path`` composites checked as variable refs, and
``users.json`` holds usernames and group ids — so no ``$http`` can reach them and
they are not walked. ``$http`` can sit at any property value in any of the
documents that are, including nested inside another source's ``wildcards`` bag,
so the collection walk is a plain recursive descent over each document rather
than the schema-driven one — a schema-driven walk skips keys the schema does not
declare, and a missed source is a refused request at runtime.

The result is cached per live project and keyed on the mtimes of the documents
it was derived from, so an edit through any path — REST, MCP, a direct disk
write — rebuilds it. :func:`invalidate_http_origin_cache` drops it outright and
is called from the config-write path and the internal reload hook, which covers
filesystems whose mtime granularity is coarser than a single edit.

**Dynamic hosts.** ``$http`` url templates interpolate ``{name}`` placeholders
(single braces — ``PLACEHOLDER_RE`` in ``propertySourceEval.ts``,
``_WILDCARD_RE`` in ``core/validation/structure.py``). Exactly one position
matters: a placeholder in the *scheme, host or port* of an absolute template
means the author wrote a source whose origin is decided at render time — they
have deliberately opted out of origin pinning for that source, and no allowlist
can express "whatever that variable says". Such a template is recorded on the
policy (:attr:`HttpOriginPolicy.dynamic_templates`) and logged, and while one
exists in the project the policy permits any http(s) origin — except back at
this machine. Loopback, link-local and unspecified addresses, and the names
that reach them by convention, stay refused even while unpinned
(:func:`_is_local_destination`), because a project instance answers its own
API with no auth of its own: an unpinned policy may go anywhere the operator
might have meant, but "anywhere" cannot include the request endpoint's own
host. That is still a real widening of the proxy, so what remains of it is
never silent: it takes an explicit edit in the editor, which only the device
admin can reach.

Everywhere else a placeholder is irrelevant. In the *path*, *query* or
*fragment* the origin is still fixed — and so it is in the *userinfo*, the one
part of the authority that names no origin: ``https://{user}:{pass}@plant.local``
pins ``https://plant.local:443`` exactly as a literal credential would, because
both this module and every url parser drop credentials before comparing.
Counting that as a dynamic host is what let one ordinary credentialed source
open the proxy project-wide. And a template with no ``://`` at all —
``/api/status/{machineId}``, ``{base}/api/x`` — names no origin: it adds nothing
to the allowlist and, just as importantly, opts out of nothing. Treating it as
an opt-out would mean one ordinary relative template anywhere in the project
turned this endpoint into an open proxy; an author who wants a computed host
writes it where it is visible, in the authority.
"""
from __future__ import annotations

import ipaddress
import logging
import re
import socket
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from core.page_index import page_document_files
from core.storage import (
    NoLiveProjectError,
    active_alarms_config_path,
    active_config_dir,
    active_project_root,
    active_recipes_config_path,
    component_files,
    read_json,
)

logger = logging.getLogger(__name__)

_DEFAULT_PORTS = {"http": 80, "https": 443}

_AUTHORITY_TERMINATORS = "/?#"

# A scheme, or a placeholder standing in for one — anything else before the
# "://" means the template is relative and merely quotes a url further along
# (`/api/x?next=http://{h}/y`).
_SCHEME_RE = re.compile(r"^[A-Za-z{][A-Za-z0-9+.\-{}]*$")


class _Dynamic:
    """Sentinel: this template's origin is only known once it is rendered."""

    __slots__ = ()


_DYNAMIC = _Dynamic()


def _is_local_destination(url: str) -> bool:
    """Loopback, link-local and unspecified addresses, plus the names and
    numeric spellings that reach them without a lookup. An unpinned policy
    may go anywhere the operator might have meant — except back at this
    machine, where the project instance answers with no auth of its own.

    Classification never resolves a hostname. ``permits()`` runs on the
    event loop that also drives the OPC-UA and WebSocket variable pipeline,
    and this check gates an anonymous, LAN-reachable endpoint — a caller
    could name a black-holed nameserver and stall that loop for the length
    of the system resolver's own timeout, once per redirect hop. A DNS
    lookup traded the SSRF this module closes for a DoS, which is worse.

    What is checked instead is every *numeric* IPv4 spelling, not just the
    canonical dotted-quad ``ipaddress.ip_address`` accepts: ``inet_aton`` is
    the C library's own address parser, so ``127.1``, ``2130706433``,
    ``0177.0.0.1`` and ``0x7f.0.0.1`` all still classify as 127.0.0.1 even
    though only the first parses as a literal on its own. A hostname
    ``inet_aton`` rejects is a name, not a number, and is not classified
    here.

    Not covered, and not fixable without the lookup this function
    deliberately avoids: a name that *resolves* to loopback
    (``127.0.0.1.nip.io`` and the like) reads as remote here. This is the
    same limitation as DNS rebinding between an earlier check and the
    connection that follows it — a pre-connect lookup cannot bind the
    address the connection later uses, so skipping the lookup here does not
    give anything up that a lookup would actually have secured.
    """
    try:
        host = urlsplit(url.strip()).hostname
    except ValueError:
        return True
    if not host:
        return True
    host = host.strip("[]").lower()
    if host in {"localhost", "localhost.localdomain", ""} or host.endswith(".localhost"):
        return True
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        try:
            addr = ipaddress.ip_address(socket.inet_aton(host))
        except OSError:
            return False
    return addr.is_loopback or addr.is_link_local or addr.is_unspecified


class HttpOriginPolicy:
    """What ``POST /api/http-request`` is allowed to reach for one project."""

    __slots__ = ("dynamic_templates", "origins")

    def __init__(self, origins: frozenset[str], dynamic_templates: tuple[str, ...]) -> None:
        self.origins = origins
        self.dynamic_templates = dynamic_templates

    @property
    def allows_any_origin(self) -> bool:
        """True while the project holds a template with a placeholder in its host.

        See the module docstring: such a source has opted out of pinning, and
        the opt-out is project-wide because a resolved request carries nothing
        that ties it back to the source that produced it.
        """
        return bool(self.dynamic_templates)

    def permits(self, url: str) -> bool:
        if self.allows_any_origin:
            return not _is_local_destination(url)
        origin = normalize_origin(url)
        return origin is not None and origin in self.origins

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return (
            f"HttpOriginPolicy(origins={sorted(self.origins)!r}, "
            f"dynamic_templates={list(self.dynamic_templates)!r})"
        )


_EMPTY_POLICY = HttpOriginPolicy(frozenset(), ())


def normalize_origin(url: str) -> str | None:
    """``scheme://host:port`` for *url*, or ``None`` when it names no http(s) origin.

    Comparison form for both sides of the check: the scheme and host are
    lower-cased and a missing port is filled in with the scheme default, so
    ``https://Plant.Local`` and ``https://plant.local:443`` are one origin.
    IPv6 literals keep their brackets so the string stays re-parseable.
    """
    try:
        parts = urlsplit(url.strip())
        scheme = parts.scheme.lower()
        if scheme not in _DEFAULT_PORTS:
            return None
        host = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if not host:
        return None
    if port is None:
        port = _DEFAULT_PORTS[scheme]
    if ":" in host:
        host = f"[{host}]"
    return f"{scheme}://{host}:{port}"


def _split_authority(template: str) -> tuple[str, str] | None:
    """``(scheme, raw authority)`` of an absolute URL, ``None`` if it has none.

    Hand-split rather than ``urlsplit``-ed because a template may carry a
    placeholder anywhere, including a ``{port}`` that makes ``urlsplit.port``
    raise before we get the chance to classify it. The scheme is shape-checked
    so ``/api/x?next=http://{h}/y`` — a relative template quoting a url in its
    query — does not read as an absolute one with a dynamic authority.
    """
    scheme, separator, rest = template.strip().partition("://")
    if not separator or not _SCHEME_RE.match(scheme):
        return None
    for index, char in enumerate(rest):
        if char in _AUTHORITY_TERMINATORS:
            return scheme, rest[:index]
    return scheme, rest


def _host_and_port(authority: str) -> str:
    """The origin-bearing half of an authority — any ``userinfo@`` dropped.

    Credentials are not part of an origin. ``urlsplit`` — and so
    :func:`normalize_origin`, the request side of this check — discards them by
    splitting at the *last* ``@``, and classification has to split the same way
    or the two sides disagree about what a template pins.
    """
    return authority.rpartition("@")[2]


def _classify_template(template: str) -> str | _Dynamic | None:
    """Normalized origin, ``_DYNAMIC``, or ``None`` when it pins and widens nothing.

    See the module docstring: only a placeholder in the scheme, host or port of
    an absolute template is the opt-out.
    """
    split = _split_authority(template)
    if split is None:
        # Relative — no scheme, no authority, so no origin either way. Whatever
        # `{base}` or `{id}` renders into has to be named by some template that
        # does carry an authority, or it is not reachable.
        return None
    scheme, authority = split
    if "{" in scheme:
        return _DYNAMIC
    if scheme.lower() not in _DEFAULT_PORTS:
        # `ftp://{host}/x` can never become an http(s) request, so it is not an
        # opt-out from an http(s) allowlist — the endpoint refuses the scheme.
        return None
    if "{" in _host_and_port(authority):
        return _DYNAMIC
    return normalize_origin(template)


def _collect_http_urls(node: Any, out: set[str]) -> None:
    if isinstance(node, dict):
        payload = node.get("$http")
        if isinstance(payload, dict) and isinstance(payload.get("url"), str):
            out.add(payload["url"])
        for value in node.values():
            _collect_http_urls(value, out)
    elif isinstance(node, list):
        for item in node:
            _collect_http_urls(item, out)


def _project_documents() -> list[Path]:
    """Every project file a property value — and so an ``$http`` source — can live in.

    The page tree ``core/validation/structure.py`` validates, plus the two
    own-file domains ``core/validation/domains.py`` resolves property values in
    (see the module docstring). ``__``-prefixed stems are reserved/internal
    everywhere else in the backend and are skipped here too.
    """
    documents: list[Path] = []
    for path in (
        active_config_dir() / "config.json",
        active_alarms_config_path(),
        active_recipes_config_path(),
    ):
        if path.is_file():
            documents.append(path)
    documents.extend(page_document_files())
    documents.extend(
        path for path, _group in component_files() if not path.stem.startswith("__")
    )
    return documents


def _fingerprint(documents: list[Path]) -> frozenset[tuple[str, int]]:
    marks: set[tuple[str, int]] = set()
    for path in documents:
        try:
            marks.add((str(path), path.stat().st_mtime_ns))
        except OSError:
            continue
    return frozenset(marks)


def _derive_policy(documents: list[Path]) -> HttpOriginPolicy:
    origins: set[str] = set()
    dynamic: set[str] = set()
    for path in documents:
        try:
            document = read_json(path)
        except Exception:
            # A hand-broken file must not silently shrink the allowlist without
            # a trace; the config and component APIs report their own parse
            # errors, this one just needs to be visible in the log.
            logger.warning("http origins: could not read %s", path)
            continue
        urls: set[str] = set()
        _collect_http_urls(document, urls)
        for url in urls:
            classified = _classify_template(url)
            if isinstance(classified, _Dynamic):
                dynamic.add(url)
            elif classified is not None:
                origins.add(classified)
    policy = HttpOriginPolicy(frozenset(origins), tuple(sorted(dynamic)))
    if policy.allows_any_origin:
        logger.warning(
            "http origins: %d $http source(s) interpolate their host (%s), so "
            "/api/http-request accepts any http(s) origin for this project",
            len(policy.dynamic_templates),
            ", ".join(policy.dynamic_templates),
        )
    else:
        logger.debug("http origins: %s", sorted(policy.origins))
    return policy


_cache: tuple[Path, frozenset[tuple[str, int]], HttpOriginPolicy] | None = None
_cache_lock = threading.Lock()


def invalidate_http_origin_cache() -> None:
    """Drop the derived allowlist. Call after any write to config/pages/components."""
    global _cache
    with _cache_lock:
        _cache = None


def http_origin_policy() -> HttpOriginPolicy:
    """The live project's allowlist, rebuilt whenever its documents change."""
    global _cache
    try:
        root = active_project_root()
    except NoLiveProjectError:
        # Nothing configured means nothing reachable — the proxy exists to serve
        # a project's own sources, so with no project it serves none.
        return _EMPTY_POLICY
    documents = _project_documents()
    fingerprint = _fingerprint(documents)
    with _cache_lock:
        cached = _cache
    if cached is not None and cached[0] == root and cached[1] == fingerprint:
        return cached[2]
    policy = _derive_policy(documents)
    with _cache_lock:
        _cache = (root, fingerprint, policy)
    return policy
