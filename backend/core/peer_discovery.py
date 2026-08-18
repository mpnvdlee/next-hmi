"""mDNS-based peer discovery for LAN push/pull.

Advertises this runtime under ``_nexthmi._tcp.local.`` and maintains an
in-memory list of peers it sees on the same network. The frontend's
``PeerPicker`` reads the discovered list via ``GET /api/peers/discovered``
and unions it with the manifest's manual ``peers[]``.

Discovery is best-effort. If zeroconf can't bind (no responder, containerised
network without host networking, mDNS blocked by the LAN), ``start()`` logs a
warning and the runtime keeps working — manual peer entries still resolve.

Design notes:
- A per-process ``runtimeId`` UUID is encoded into the TXT record so two
  runtimes on the same host (different ports) don't shadow each other.
- The browser filters out our own service by ``runtimeId``, not by name.
- Resolution timing: zeroconf's ``add_service`` callback fires before the
  service's A record has arrived. We re-resolve via ``AsyncServiceInfo`` in
  a task so the public ``discovered()`` list only contains usable entries.
"""
from __future__ import annotations

import asyncio
import logging
import socket
import uuid
from dataclasses import dataclass, field
from typing import Any

from core.manifest import PeerScheme

logger = logging.getLogger(__name__)

SERVICE_TYPE = "_nexthmi._tcp.local."

# Quietly tolerate a missing zeroconf install — peer discovery becomes a no-op
# but the rest of the runtime keeps working. Importing eagerly so failures land
# at module-load time.
try:
    from zeroconf import IPVersion, ServiceInfo, ServiceStateChange
    from zeroconf.asyncio import (
        AsyncServiceBrowser,
        AsyncServiceInfo,
        AsyncZeroconf,
    )

    _ZEROCONF_AVAILABLE = True
except ImportError:  # pragma: no cover — dev fallback
    _ZEROCONF_AVAILABLE = False
    IPVersion = None  # type: ignore[assignment]
    ServiceInfo = None  # type: ignore[assignment]
    ServiceStateChange = None  # type: ignore[assignment]
    AsyncServiceBrowser = None  # type: ignore[assignment]
    AsyncServiceInfo = None  # type: ignore[assignment]
    AsyncZeroconf = None  # type: ignore[assignment]


@dataclass
class DiscoveredPeer:
    name: str
    host: str
    port: int
    runtime_id: str
    scheme: PeerScheme = "http"
    addresses: list[str] = field(default_factory=list)


def _own_scheme() -> PeerScheme:
    """What this runtime is serving — see ``launcher._resolve_tls``."""
    from core import tls_settings

    return "https" if tls_settings.resolve() is not None else "http"


def _safe_hostname() -> str:
    try:
        return socket.gethostname() or "nexthmi"
    except OSError:
        return "nexthmi"


def _slug(name: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-._" else "-" for ch in name).strip("-.")
    return cleaned or "nexthmi"


class PeerDiscovery:
    """Singleton — instantiated at module bottom; lifecycle owned by main.lifespan."""

    def __init__(self) -> None:
        self._aiozc: Any = None
        self._browser: Any = None
        self._service_info: Any = None
        # Peers keyed by their advertised runtime_id so two runtimes on the
        # same host (different ports) don't collide.
        self._peers: dict[str, DiscoveredPeer] = {}
        self._resolve_tasks: set[asyncio.Task] = set()
        self._lock = asyncio.Lock()
        self._runtime_id = uuid.uuid4().hex
        self._port = 8000
        self._started = False

    @property
    def runtime_id(self) -> str:
        return self._runtime_id

    async def start(self, *, port: int = 8000, host_label: str | None = None) -> None:
        """Begin advertising + browsing. Idempotent; second call is a no-op."""
        if self._started:
            return
        if not _ZEROCONF_AVAILABLE:
            logger.warning("peer_discovery: zeroconf not installed — discovery disabled")
            return
        self._port = port
        try:
            self._aiozc = AsyncZeroconf(ip_version=IPVersion.V4Only)
        except OSError as exc:
            logger.warning("peer_discovery: failed to open mDNS socket: %s", exc)
            self._aiozc = None
            return

        hostname = host_label or _safe_hostname()
        service_name = f"{_slug(hostname)}-{self._runtime_id[:6]}.{SERVICE_TYPE}"
        try:
            local_addr = socket.gethostbyname(socket.gethostname())
        except OSError:
            local_addr = "127.0.0.1"
        try:
            packed = socket.inet_aton(local_addr)
        except OSError:
            packed = socket.inet_aton("127.0.0.1")

        self._service_info = ServiceInfo(
            type_=SERVICE_TYPE,
            name=service_name,
            addresses=[packed],
            port=port,
            properties={
                "runtimeId": self._runtime_id,
                "hostname": hostname,
                "scheme": _own_scheme(),
                "version": "1",
            },
            server=f"{_slug(hostname)}-{self._runtime_id[:6]}.local.",
        )

        try:
            await self._aiozc.async_register_service(self._service_info)
        except Exception as exc:
            logger.warning("peer_discovery: failed to register service: %s", exc)
            await self._aiozc.async_close()
            self._aiozc = None
            self._service_info = None
            return

        self._browser = AsyncServiceBrowser(
            self._aiozc.zeroconf,
            [SERVICE_TYPE],
            handlers=[self._on_service_state_change],
        )
        self._started = True
        logger.info(
            "peer_discovery: advertising %s on port %d (runtimeId=%s)",
            service_name,
            port,
            self._runtime_id[:8],
        )

    async def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        if self._browser is not None:
            try:
                await self._browser.async_cancel()
            except Exception as exc:  # pragma: no cover — best-effort teardown
                logger.debug("peer_discovery: browser cancel error: %s", exc)
            self._browser = None
        if self._aiozc is not None and self._service_info is not None:
            try:
                await self._aiozc.async_unregister_service(self._service_info)
            except Exception as exc:  # pragma: no cover
                logger.debug("peer_discovery: unregister error: %s", exc)
        if self._aiozc is not None:
            try:
                await self._aiozc.async_close()
            except Exception as exc:  # pragma: no cover
                logger.debug("peer_discovery: close error: %s", exc)
        self._aiozc = None
        self._service_info = None
        self._peers.clear()

    def discovered(self) -> list[dict[str, Any]]:
        """Snapshot of currently visible peers (excludes ourselves)."""
        return [
            {
                "name": peer.name,
                "host": peer.host,
                "port": peer.port,
                "scheme": peer.scheme,
                "runtimeId": peer.runtime_id,
                "addresses": list(peer.addresses),
                "source": "mdns",
            }
            for peer in self._peers.values()
            if peer.runtime_id != self._runtime_id
        ]

    def _on_service_state_change(
        self,
        zeroconf: Any,
        service_type: str,
        name: str,
        state_change: Any,
    ) -> None:
        """Bridge sync zeroconf callback into the async resolution path."""
        if state_change == ServiceStateChange.Removed:
            self._peers.pop(name, None)
            return
        if state_change not in (ServiceStateChange.Added, ServiceStateChange.Updated):
            return
        task = asyncio.ensure_future(self._resolve_and_store(zeroconf, service_type, name))
        self._resolve_tasks.add(task)
        task.add_done_callback(self._resolve_tasks.discard)

    async def _resolve_and_store(
        self, zeroconf: Any, service_type: str, name: str,
    ) -> None:
        info = AsyncServiceInfo(service_type, name)
        try:
            await info.async_request(zeroconf, 3000)
        except Exception as exc:  # pragma: no cover
            logger.debug("peer_discovery: resolve %s failed: %s", name, exc)
            return
        addresses = info.parsed_addresses() if info else []
        if not addresses:
            return
        props = info.properties or {}
        runtime_id_raw = props.get(b"runtimeId") if props else None
        runtime_id = runtime_id_raw.decode() if isinstance(runtime_id_raw, bytes) else ""
        hostname_raw = props.get(b"hostname") if props else None
        hostname = (
            hostname_raw.decode() if isinstance(hostname_raw, bytes) else name.split(".", 1)[0]
        )
        scheme_raw = props.get(b"scheme") if props else None
        scheme = scheme_raw.decode() if isinstance(scheme_raw, bytes) else "http"
        async with self._lock:
            self._peers[name] = DiscoveredPeer(
                name=hostname,
                host=addresses[0],
                port=int(info.port or 0),
                runtime_id=runtime_id,
                scheme="https" if scheme == "https" else "http",
                addresses=addresses,
            )


peer_discovery = PeerDiscovery()
