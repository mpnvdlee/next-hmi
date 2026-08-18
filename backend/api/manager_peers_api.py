"""Authenticated manager-to-manager project transfer.

The wire transport is deliberately HTTP for trusted LANs.  The device-admin
password is used only by ``/pair``; later calls use a random bearer token whose
digest is the only token material persisted by the destination manager.
"""

from __future__ import annotations

import asyncio
import errno
import hashlib
import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import ssl
import stat
import tempfile
import threading
import time
import uuid
import zipfile
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import ExitStack, contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import httpx
from core import manager_auth, peer_tokens, peer_trust, runtime_home
from core.exceptions import (
    ConflictError,
    NotFoundError,
    RateLimitError,
    ValidationError,
)
from core.manifest import (
    PeerEntry,
    PeerScheme,
    ProjectEntry,
    ProjectMetadata,
    find_project,
    load_manifest,
    manifest_transaction,
    read_project_metadata,
    running_entry,
    save_manifest,
    validate_project_id,
    write_project_metadata,
)
from core.peer_discovery import peer_discovery
from core.project_packer import (
    UnsafeArchiveError,
    max_zip_bytes,
    pack_project,
    safe_filename,
    unpack_project,
)
from core.storage import write_text_atomic
from core.time_utils import iso_now
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from services.supervisor import supervisor

from api.projects_api import (
    _atomic_rename_noreplace,
    _bind_staging_directory,
    _validate_staging_binding,
)

public_router = APIRouter(prefix="/api/manager/peer", tags=["manager-peer"])
manager_router = APIRouter(prefix="/api/manager", tags=["manager-peer"])
logger = logging.getLogger(__name__)

_HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=600.0, pool=10.0)
_TRANSFER_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_receive_cancellations: dict[str, threading.Event] = {}
_receipt_lock = threading.RLock()
_pull_journal_lock = threading.RLock()
_target_lock_guard = threading.Lock()
_target_locks: dict[str, threading.Lock] = {}
_target_lock_users: dict[str, int] = {}


def _bearer(request: Request) -> str | None:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    return token if scheme.lower() == "bearer" else None


def _require_peer(request: Request) -> None:
    _require_private_client(request)
    if not peer_tokens.verify(_bearer(request)):
        raise HTTPException(status_code=401, detail="Invalid or revoked peer token")


def _require_private_client(request: Request) -> None:
    host = request.client.host if request.client else ""
    if host == "testclient" and os.environ.get("PYTEST_CURRENT_TEST"):
        return
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise HTTPException(
            status_code=403, detail="Peer source address is not trusted"
        ) from exc
    allow_loopback = os.environ.get("NEXTHMI_ALLOW_LOOPBACK_PEERS") == "1"
    if (
        address.is_unspecified
        or address.is_multicast
        or address.is_link_local
        or (address.is_loopback and not allow_loopback)
        or (not address.is_private and not address.is_loopback)
    ):
        raise HTTPException(
            status_code=403, detail="Peer source must be on a private trusted LAN"
        )


def _root() -> Path:
    manifest = load_manifest()
    raw = manifest.defaultProjectsRoot
    root = (
        Path(raw).expanduser()
        if raw and raw.strip()
        else runtime_home.runtime_home_path() / "Projects"
    )
    root = root.absolute()
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink() or not root.is_dir():
        raise ValidationError(
            "Configured projects root must be a real directory, not a symlink"
        )
    return root


def _target_in_root(folder: str) -> Path:
    if not folder.strip() or folder.startswith(".") or Path(folder).name != folder:
        raise ValidationError(
            "destinationFolder must be one folder name under the target root"
        )
    root = _root()
    return root / folder


_TARGET_LOCKS_KEPT = 256


@contextmanager
def _target_path_lock(target: Path) -> Iterator[threading.Lock]:
    """Hand out the lock for a target path, pinned for as long as it is in use.

    Eviction keyed on ``locked()`` alone is not enough: a transfer holds its
    lock object as a local reference well before it acquires it, so a busy
    manager could evict that entry mid-transfer and hand the next caller a
    different ``Lock`` for the same folder — which stops serializing anything.
    """
    key = str(target.absolute())
    with _target_lock_guard:
        lock = _target_locks.setdefault(key, threading.Lock())
        _target_lock_users[key] = _target_lock_users.get(key, 0) + 1
    try:
        yield lock
    finally:
        with _target_lock_guard:
            remaining = _target_lock_users.get(key, 1) - 1
            if remaining <= 0:
                _target_lock_users.pop(key, None)
            else:
                _target_lock_users[key] = remaining
            if len(_target_locks) > _TARGET_LOCKS_KEPT:
                for stale_key, stale_lock in list(_target_locks.items()):
                    if stale_key not in _target_lock_users and not stale_lock.locked():
                        del _target_locks[stale_key]


@dataclass(frozen=True)
class PeerEndpoint:
    """Where to send a peer request, and how to trust what answers.

    ``base_url`` always addresses the resolved private IP rather than the name
    the operator typed, so DNS cannot redirect a transfer after the address
    check; ``headers`` carries the original name back as ``Host``.
    """

    base_url: str
    headers: dict[str, str]
    verify: ssl.SSLContext | bool
    host: str
    port: int
    address: str

    def client(self, timeout: httpx.Timeout) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=timeout, verify=self.verify)

    async def certificate_mismatch(self) -> str | None:
        """Whether a changed certificate explains a failed request to this peer.

        A pin rejection arrives as an opaque verification error, so the probe
        that ``ensure_pin`` no longer does up front happens here, on the failure
        path. ``None`` for a plain-HTTP peer or a pin that still matches.

        Runs the handshake off the event loop: it is a blocking socket connect
        plus TLS handshake with a multi-second timeout (see
        ``peer_trust._HANDSHAKE_TIMEOUT_SECONDS``), and every caller reaches
        this from an ``async def`` request handler or background task.
        """
        if not isinstance(self.verify, ssl.SSLContext):
            return None
        return await asyncio.to_thread(
            peer_trust.describe_mismatch, self.host, self.port, self.address
        )

    async def unreachable(self, exc: Exception) -> ConflictError:
        """The error to raise when a short request to this peer failed."""
        mismatch = await self.certificate_mismatch()
        if mismatch is not None:
            return ConflictError(mismatch)
        return ConflictError(f"Could not reach peer {self.host}:{self.port}: {exc}")


async def _peer_endpoint(host: str, port: int, scheme: PeerScheme = "http") -> PeerEndpoint:
    """Resolve, address-check, and (over HTTPS) pin the peer's certificate."""
    return await asyncio.to_thread(_resolve_private_peer, host, port, scheme)


def _resolve_private_peer(host: str, port: int, scheme: PeerScheme = "http") -> PeerEndpoint:
    """Resolve once and pin the connection to private unicast addresses."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ValidationError(f"Could not resolve peer host '{host}': {exc}") from exc
    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise ValidationError(f"Peer host '{host}' resolved to no addresses")
    allow_loopback = os.environ.get("NEXTHMI_ALLOW_LOOPBACK_PEERS") == "1" or bool(
        os.environ.get("PYTEST_CURRENT_TEST")
    )
    parsed = [ipaddress.ip_address(address) for address in addresses]
    if any(
        address.is_unspecified
        or address.is_multicast
        or address.is_link_local
        or (address.is_loopback and not allow_loopback)
        or (not address.is_private and not address.is_loopback)
        for address in parsed
    ):
        raise ValidationError(
            "Peer host must resolve exclusively to private trusted-LAN addresses"
        )
    address = sorted(parsed, key=lambda item: (item.version, str(item)))[0]
    rendered = f"[{address}]" if address.version == 6 else str(address)
    headers = {"Host": f"{host}:{port}"}
    # A peer seen over TLS once is never spoken to in the clear again. The
    # scheme reaches us from an mDNS TXT record any host on the LAN can forge,
    # so it may only ever upgrade the transport, never downgrade it.
    if peer_trust.load_pin(host, port) is not None:
        scheme = "https"
    if scheme != "https":
        return PeerEndpoint(
            f"http://{rendered}:{port}", headers, True, host, port, str(address)
        )
    try:
        pin = peer_trust.ensure_pin(host, port, str(address))
    except peer_trust.CertificateMismatch as exc:
        raise ValidationError(str(exc)) from exc
    except OSError as exc:
        raise ValidationError(
            f"Could not start a TLS session with peer {host}:{port}: {exc}"
        ) from exc
    return PeerEndpoint(
        f"https://{rendered}:{port}",
        headers,
        peer_trust.ssl_context(pin),
        host,
        port,
        str(address),
    )


def _rename_bound(source: Path, destination: Path, binding) -> None:
    try:
        _atomic_rename_noreplace(source, destination, binding)
    except OSError as exc:
        if exc.errno in {errno.EEXIST, errno.ENOTEMPTY}:
            raise ConflictError(
                f"Path appeared during transfer and was preserved: {destination}"
            ) from exc
        raise


_LOCK_ACQUIRE_TIMEOUT_SECONDS = 120.0


async def _acquire_lock_cancel_safe(
    lock: threading.Lock, *, timeout: float = _LOCK_ACQUIRE_TIMEOUT_SECONDS
) -> bool:
    """Acquire a threading lock without leaking it if the await is cancelled.

    ``asyncio.to_thread`` cannot cancel the worker: when the request deadline
    fires while the thread is still blocked on ``acquire``, the thread goes on
    to take a lock nobody will ever release, wedging every later transfer and
    supervisor call for that project until the manager restarts. So bound the
    wait, and hand the lock straight back if our caller has already gone.
    """
    task = asyncio.ensure_future(asyncio.to_thread(lock.acquire, True, timeout))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        def _release_if_acquired(finished: asyncio.Future) -> None:
            try:
                if not finished.cancelled() and finished.exception() is None:  # noqa: SIM102 -- no autofix offered, left as-is per the mechanical-only policy for this family
                    if finished.result():
                        lock.release()
            except Exception:
                logger.exception("peer transfer: orphaned lock release failed")

        task.add_done_callback(_release_if_acquired)
        raise


def _cancel_check(cancel: threading.Event, message: str) -> None:
    if cancel.is_set():
        raise asyncio.CancelledError(message)


def _handle_bound_removal_supported() -> bool:
    """Whether staging removal can be bound to an open directory handle."""
    return os.name == "posix"


def _clear_bound_directory(path: Path, binding) -> None:
    """Remove only children reached through the already-bound directory handle."""
    _validate_staging_binding(path, binding)
    if not _handle_bound_removal_supported():
        # No handle-bound removal here, so this removes the whole staging tree
        # by path. Same weaker guarantee as the Windows rename: the binding was
        # just validated, but the walk itself is not bound to that handle.
        shutil.rmtree(path, ignore_errors=False)
        return

    def clear_fd(directory_fd: int) -> None:
        for name in os.listdir(directory_fd):
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child_fd = os.open(
                    name,
                    os.O_RDONLY
                    | getattr(os, "O_DIRECTORY", 0)
                    | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=directory_fd,
                )
                try:
                    clear_fd(child_fd)
                finally:
                    os.close(child_fd)
                os.rmdir(name, dir_fd=directory_fd)
            else:
                os.unlink(name, dir_fd=directory_fd)

    clear_fd(binding.handle)
    _validate_staging_binding(path, binding)


class PairBody(BaseModel):
    password: str = Field(min_length=1, max_length=512)
    name: str | None = Field(default=None, max_length=200)


@public_router.post("/pair", status_code=201)
async def pair(body: PairBody, request: Request) -> dict[str, Any]:
    _require_private_client(request)
    remaining = manager_auth.lockout_remaining()
    if remaining > 0:
        raise RateLimitError(
            f"Too many failed attempts. Try again in {int(remaining) + 1}s."
        )
    if not manager_auth.verify_password(body.password):
        manager_auth.register_login_failure()
        raise ValidationError("Incorrect device-admin password")
    manager_auth.register_login_success()
    token_id, token = peer_tokens.issue(body.name)
    return {
        "tokenId": token_id,
        "token": token,
        "transport": "http",
        "trustedLanOnly": True,
    }


@public_router.get("/projects")
async def peer_projects(request: Request) -> dict[str, Any]:
    _require_peer(request)
    manifest = load_manifest()
    return {
        "projects": [
            {
                "id": entry.id,
                "name": entry.name,
                "folder": Path(entry.path).name,
                "running": running_entry(manifest, entry.id) is not None,
            }
            for entry in manifest.projects
            if Path(entry.path).expanduser().is_dir()
        ]
    }


@public_router.get("/projects/{project_id}/archive")
async def peer_project_archive(project_id: str, request: Request) -> StreamingResponse:
    """Stream a registered project as a zip, for the pull direction of transfer.

    Symmetric counterpart to ``peer_projects``: that lists what's pullable, this
    is what actually gets pulled. Same auth as every other peer route.
    """
    _require_peer(request)
    entry = find_project(load_manifest(), project_id)
    if entry is None:
        raise NotFoundError(f"Project '{project_id}' not found")
    project_root = Path(entry.path).expanduser()
    if not project_root.is_dir():
        raise ConflictError(f"Project folder is missing at {entry.path}")

    # Same spooled-temp-file shape as projects_api.export_project: don't buffer
    # the whole archive in memory, but don't tie the response generator to a
    # long-lived path either.
    spool = tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024, mode="w+b")  # noqa: SIM115 -- must outlive this function: streamed and closed later by the `_iter()` generator, so a `with` block here would close it before the response body is read
    try:
        await asyncio.to_thread(pack_project, project_root, spool)
    except Exception:
        spool.close()
        raise
    spool.seek(0)

    def _iter() -> Iterator[bytes]:
        try:
            while True:
                chunk = spool.read(64 * 1024)
                if not chunk:
                    return
                yield chunk
        finally:
            spool.close()

    filename = f"{safe_filename(entry.name)}.nexthmi.zip"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(_iter(), media_type="application/zip", headers=headers)


@manager_router.get("/peer-tokens")
async def peer_token_list() -> dict[str, Any]:
    return {"tokens": peer_tokens.list_tokens()}


@manager_router.delete("/peer-tokens/{token_id}")
async def peer_token_revoke(token_id: str) -> dict[str, Any]:
    if not peer_tokens.revoke(token_id):
        raise NotFoundError(f"Peer token '{token_id}' not found")
    return {"revoked": True, "tokenId": token_id}


class ManualPeerBody(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=8000, ge=1, le=65535)
    scheme: PeerScheme = "http"
    name: str | None = None


@manager_router.get("/peers/discovered")
async def discovered_peers() -> dict[str, Any]:
    manifest = load_manifest()
    manual = [
        {
            "name": peer.name,
            "host": peer.host,
            "port": peer.port,
            "scheme": peer.scheme,
            "addedAt": peer.addedAt,
            "source": "manual",
        }
        for peer in manifest.peers
    ]
    return {
        "discovered": peer_discovery.discovered(),
        "manual": manual,
        "ownRuntimeId": peer_discovery.runtime_id,
    }


@manager_router.post("/peers/manual", status_code=201)
async def add_manager_manual_peer(body: ManualPeerBody) -> dict[str, Any]:
    host = body.host.strip()
    with manifest_transaction() as manifest:
        if any(peer.host == host and peer.port == body.port for peer in manifest.peers):
            raise ConflictError(f"Manual peer {host}:{body.port} already exists")
        entry = PeerEntry(
            name=(body.name or host).strip() or host,
            host=host,
            port=body.port,
            scheme=body.scheme,
            addedAt=iso_now(),
        )
        manifest.peers.append(entry)
        save_manifest(manifest)
    return entry.model_dump(mode="json")


@manager_router.delete("/peers/manual")
async def remove_manager_manual_peer(host: str, port: int = 8000) -> dict[str, Any]:
    with manifest_transaction() as manifest:
        before = len(manifest.peers)
        manifest.peers = [
            peer
            for peer in manifest.peers
            if not (peer.host == host and peer.port == port)
        ]
        if len(manifest.peers) == before:
            raise NotFoundError(f"No manual peer at {host}:{port}")
        save_manifest(manifest)
    return {"host": host, "port": port, "removed": True}


@manager_router.get("/peers/trust")
async def list_peer_certificate_pins() -> dict[str, Any]:
    return {"pins": peer_trust.list_pins()}


@manager_router.delete("/peers/trust")
async def forget_peer_certificate_pin(host: str, port: int = 8000) -> dict[str, Any]:
    """Drop a pinned certificate so the next contact re-pins it.

    The only recovery path after a peer renews its certificate — and the reason
    it is an explicit operator action: dropping a pin discards the evidence that
    would otherwise expose an interception.
    """
    if not peer_trust.forget(host, port):
        raise NotFoundError(f"No pinned certificate for {host}:{port}")
    return {"host": host, "port": port, "forgotten": True}


class RemotePairBody(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=8000, ge=1, le=65535)
    scheme: PeerScheme = "http"
    password: str = Field(min_length=1, max_length=512)
    name: str | None = None


@manager_router.post("/peer-pair")
async def pair_remote(body: RemotePairBody) -> dict[str, Any]:
    peer = await _peer_endpoint(body.host, body.port, body.scheme)
    try:
        async with peer.client(httpx.Timeout(10.0)) as client:
            response = await client.post(
                f"{peer.base_url}/api/manager/peer/pair",
                headers=peer.headers,
                json={"password": body.password, "name": body.name},
            )
    except httpx.HTTPError as exc:
        raise await peer.unreachable(exc) from exc
    if response.status_code >= 400:
        raise ConflictError(f"Peer pairing failed: HTTP {response.status_code}")
    result = response.json()
    # Surface what was pinned so an operator can compare it with the peer's own
    # fingerprint out of band — the one check TOFU cannot make for them.
    pin = peer_trust.load_pin(body.host, body.port)
    if isinstance(result, dict) and pin is not None:
        result["certificateFingerprint"] = pin.fingerprint
    return result


class RemoteProjectsBody(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=8000, ge=1, le=65535)
    scheme: PeerScheme = "http"
    token: str = Field(min_length=1)


@manager_router.post("/peer-projects")
async def list_remote_projects(body: RemoteProjectsBody) -> dict[str, Any]:
    peer = await _peer_endpoint(body.host, body.port, body.scheme)
    try:
        async with peer.client(httpx.Timeout(10.0)) as client:
            response = await client.get(
                f"{peer.base_url}/api/manager/peer/projects",
                headers={**peer.headers, "Authorization": f"Bearer {body.token}"},
            )
    except httpx.HTTPError as exc:
        raise await peer.unreachable(exc) from exc
    if response.status_code >= 400:
        raise ConflictError(f"Peer project lookup failed: HTTP {response.status_code}")
    return response.json()


@dataclass
class TransferState:
    transferId: str
    fingerprint: str
    sourceProjectId: str
    destinationProjectId: str
    phase: str = "queued"
    status: Literal["active", "complete", "error", "cancelled"] = "active"
    bytesDone: int = 0
    bytesTotal: int = 0
    message: str | None = None
    result: dict[str, Any] | None = None
    task: asyncio.Task[None] | None = None

    def public(self) -> dict[str, Any]:
        # Built field by field on purpose: `asdict` deep-copies every field
        # before anything can be dropped, and deep-copying the `task` raises
        # `TypeError: cannot pickle '_asyncio.Task'` — which would 500 every
        # sender endpoint the moment a transfer is actually running.
        return {
            "transferId": self.transferId,
            "sourceProjectId": self.sourceProjectId,
            "destinationProjectId": self.destinationProjectId,
            "phase": self.phase,
            "status": self.status,
            "bytesDone": self.bytesDone,
            "bytesTotal": self.bytesTotal,
            "message": self.message,
            "result": self.result,
        }


_transfers: dict[str, TransferState] = {}
_transfer_requests: dict[str, TransferBody] = {}
_sender_cancellations: dict[str, threading.Event] = {}
_sender_journal_lock = threading.RLock()


def _sender_journal_path() -> Path:
    return runtime_home.runtime_home_path() / ".peer-transfer-sender.json"


def _load_sender_journal() -> dict[str, Any]:
    with _sender_journal_lock:
        try:
            data = json.loads(_sender_journal_path().read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"version": 1, "transfers": {}}
        except (OSError, ValueError) as exc:
            raise ConflictError(
                "Sender transfer journal is unreadable; refusing transfer"
            ) from exc
        if not isinstance(data, dict) or not isinstance(data.get("transfers"), dict):
            raise ConflictError("Sender transfer journal is corrupt; refusing transfer")
        return data


_JOURNAL_ENTRIES_KEPT = 200


def _prune_journal_entries(entries: dict[str, Any], keep_id: str) -> None:
    """Drop the oldest settled entries so a journal cannot grow forever.

    Anything still ``active`` (or needing admin recovery) is never dropped —
    crash reconciliation depends on it.
    """
    if len(entries) <= _JOURNAL_ENTRIES_KEPT:
        return
    settled = [
        (entry.get("updatedAt") or "", transfer_id)
        for transfer_id, entry in entries.items()
        if transfer_id != keep_id
        and isinstance(entry, dict)
        and entry.get("status") not in {"active", "recovery_required"}
    ]
    settled.sort()
    for _, transfer_id in settled[: len(entries) - _JOURNAL_ENTRIES_KEPT]:
        entries.pop(transfer_id, None)


def _sender_update(transfer_id: str, **updates: Any) -> None:
    with _sender_journal_lock:
        data = _load_sender_journal()
        entry = data["transfers"].setdefault(transfer_id, {})
        entry.update(updates)
        entry["updatedAt"] = iso_now()
        _prune_journal_entries(data["transfers"], transfer_id)
        write_text_atomic(_sender_journal_path(), json.dumps(data, indent=2))


def _identity_matches(binding, raw: Any) -> bool:
    return (
        isinstance(raw, dict)
        and raw.get("device") == binding.identity.device
        and raw.get("inode") == binding.identity.inode
    )


def _binding_identity(binding) -> dict[str, int]:
    return {"device": binding.identity.device, "inode": binding.identity.inode}


def _cleanup_owned_container(transfer_id: str, entry: dict[str, Any]) -> None:
    raw_container = entry.get("containerPath")
    raw_target = entry.get("targetPath")
    if not isinstance(raw_container, str) or not isinstance(raw_target, str):
        return
    container = Path(raw_container)
    target = Path(raw_target)
    if (
        container.parent.absolute() != target.parent.absolute()
        or not container.name.startswith(f".nexthmi-transfer-{transfer_id}-")
    ):
        raise ValidationError("Transfer container is outside its proven target root")
    binding = _bind_staging_directory(container)
    try:
        if not _identity_matches(binding, entry.get("containerIdentity")):
            raise ValidationError("Transfer container identity changed")
        _clear_bound_directory(container, binding)
        if not _handle_bound_removal_supported():
            # The non-posix branch above already removed the tree by path.
            return
        parent_binding = _bind_staging_directory(container.parent)
        try:
            current = os.stat(
                container.name,
                dir_fd=parent_binding.handle,
                follow_symlinks=False,
            )
            if (current.st_dev, current.st_ino) != (
                binding.identity.device,
                binding.identity.inode,
            ):
                raise ValidationError("Transfer container changed before removal")
            os.rmdir(container.name, dir_fd=parent_binding.handle)
        finally:
            parent_binding.close()
    finally:
        binding.close()


_deferred_cleanups: set[asyncio.Task[None]] = set()


_STAGING_DRAIN_TIMEOUT_SECONDS = 300.0
# Dedicated so a saturated default executor cannot delay an unpack (and so the
# concurrent future's cancellation state stays meaningful).
_staging_executor = ThreadPoolExecutor(
    max_workers=4, thread_name_prefix="nexthmi-transfer-unpack"
)


def _swallow_future_exception(future: asyncio.Future) -> None:
    """Consume an abandoned future's exception so it is not logged as unretrieved."""

    def _consume(finished: asyncio.Future) -> None:
        if not finished.cancelled():
            finished.exception()

    future.add_done_callback(_consume)


def _defer_container_cleanup(
    transfer_id: str,
    container: Path,
    thread_done: threading.Event,
    worker: Future,
) -> None:
    """Remove a staging container once the thread still writing to it stops.

    Waits on the extracting *thread*, not on the future: cancelling the request
    resolves the future immediately while the thread keeps unpacking, and
    removing the tree under it just races into ``ENOTEMPTY``.

    A future that cancelled *successfully* is the opposite case — the executor
    dropped the job before it ran, so nothing ever wrote to the container and
    waiting on the thread would block until the drain timeout for an event that
    can never be set.
    """

    async def _remove_container() -> None:
        try:
            await asyncio.to_thread(shutil.rmtree, container, True)
        except Exception as exc:
            logger.warning(
                "peer transfer %s: deferred staging cleanup failed for %s: %s",
                transfer_id,
                container,
                exc,
            )

    async def _wait_then_remove() -> None:
        if worker.cancelled():
            await _remove_container()
            return
        if not await asyncio.to_thread(
            thread_done.wait, _STAGING_DRAIN_TIMEOUT_SECONDS
        ):
            logger.warning(
                "peer transfer %s: extract thread still running after %.0fs; "
                "leaving staging container %s for startup reconciliation",
                transfer_id,
                _STAGING_DRAIN_TIMEOUT_SECONDS,
                container,
            )
            return
        await _remove_container()

    try:
        task = asyncio.create_task(_wait_then_remove())
    except RuntimeError:
        return
    # Held so the task is not garbage-collected mid-flight.
    _deferred_cleanups.add(task)
    task.add_done_callback(_deferred_cleanups.discard)


def _cleanup_container_best_effort(transfer_id: str, entry: dict[str, Any]) -> None:
    """Remove a leftover staging container without risking the proven verdict.

    These calls run *after* reconciliation has already decided what the on-disk
    state proves. A container an operator or tmp reaper removed first must not
    turn a committed, complete transfer into ``recovery_required``.
    """
    try:
        _cleanup_owned_container(transfer_id, entry)
    except Exception as exc:
        logger.warning(
            "peer transfer %s: leftover staging container could not be removed: %s",
            transfer_id,
            exc,
        )


def reconcile_transfer_journals() -> None:
    """Resolve interrupted phases before the manager resumes project processes."""
    try:
        sender = _load_sender_journal()
        changed = False
        for entry in sender["transfers"].values():
            if isinstance(entry, dict) and entry.get("status") == "active":
                entry.update(
                    status="error",
                    phase="interrupted_retryable",
                    message="Manager restarted; retry with the same transferId",
                    updatedAt=iso_now(),
                )
                changed = True
        if changed:
            write_text_atomic(_sender_journal_path(), json.dumps(sender, indent=2))
    except ConflictError as exc:
        logger.error("sender transfer journal requires repair: %s", exc)

    try:
        receiver = _load_receipts()
    except ConflictError as exc:
        logger.error("receiver transfer journal requires repair: %s", exc)
    else:
        if _reconcile_install_journal(receiver["receipts"]):
            _write_journal(receiver)

    try:
        pulls = _load_pull_journal()
    except ConflictError as exc:
        logger.error("pull transfer journal requires repair: %s", exc)
    else:
        if _reconcile_install_journal(pulls["pulls"]):
            _write_pull_journal(pulls)


def _reconcile_install_journal(entries: dict[str, Any]) -> bool:
    """Resolve interrupted install phases for one receiver-style journal.

    Shared between the receive-transfer receipts and the pull journal: once an
    archive is staged, "did the install commit" is decided purely from the
    entry's phase plus on-disk device/inode identity, regardless of which
    direction the transfer came from. Mutates ``entries`` in place; returns
    whether anything changed.
    """
    changed = False
    for transfer_id, entry in entries.items():
        if not isinstance(entry, dict) or entry.get("status") != "active":
            continue
        phase = entry.get("phase")
        if phase in {"claimed", "preflight", "extracting", "validated"}:
            # These phases never moved the destination, so the transfer is
            # provably retryable whatever the staging container looks like.
            # `recovery_required` is permanent and no endpoint can clear it —
            # too harsh a verdict for a leftover nobody can be harmed by.
            _cleanup_container_best_effort(transfer_id, entry)
            entry.update(
                status="error",
                phase="interrupted_retryable",
                message="Interrupted before a committed install; retry with the same transferId",
                updatedAt=iso_now(),
            )
            changed = True
            continue
        try:
            target = Path(entry["targetPath"])
            backup_raw = entry.get("backupPath")
            backup = Path(backup_raw) if isinstance(backup_raw, str) else None
            destination_id = validate_project_id(entry["destinationProjectId"])
            manifest = load_manifest()
            manifest_entry = find_project(manifest, destination_id)
            installed_identity = entry.get("installedIdentity")
            committed = False
            if (
                manifest_entry is not None
                and Path(manifest_entry.path).expanduser().absolute()
                == target.absolute()
                and isinstance(installed_identity, dict)
            ):
                committed_binding = _bind_staging_directory(target)
                try:
                    metadata = read_project_metadata(target)
                    committed = (
                        _identity_matches(committed_binding, installed_identity)
                        and metadata is not None
                        and metadata.id == destination_id
                    )
                finally:
                    committed_binding.close()
            if committed:
                result = {
                    "transferId": transfer_id,
                    "sourceProjectId": entry.get("sourceProjectId"),
                    "destinationProjectId": destination_id,
                    "destinationFolder": target.name,
                    "replaced": entry.get("collisionPolicy") == "replace",
                    "backupPath": str(backup) if backup is not None else None,
                    "startRequested": bool(entry.get("startRequested")),
                    "started": False,
                    "startError": "Authenticated retry is required after manager restart",
                }
                if entry.get("startRequested"):
                    entry.update(
                        status="applied_pending_start",
                        phase="applied_pending_start",
                        result=result,
                        updatedAt=iso_now(),
                    )
                else:
                    entry.update(
                        status="complete",
                        phase="receipt",
                        result=result,
                        completedAt=iso_now(),
                        updatedAt=iso_now(),
                    )
                changed = True
                _cleanup_container_best_effort(transfer_id, entry)
                continue

            if (
                phase in {"backing_up", "backup_created"}
                and backup is not None
                and not target.exists()
            ):
                backup_binding = _bind_staging_directory(backup)
                try:
                    if not _identity_matches(
                        backup_binding, entry.get("backupIdentity")
                    ):
                        raise ValidationError("Backup identity changed")
                    _rename_bound(backup, target, backup_binding)
                finally:
                    backup_binding.close()
                entry.update(
                    status="error",
                    phase="rolled_back_after_restart",
                    message="Interrupted replacement was rolled back; retry is safe",
                    updatedAt=iso_now(),
                )
                changed = True
                _cleanup_container_best_effort(transfer_id, entry)
                continue

            if (
                phase == "backing_up"
                and target.exists()
                and (backup is None or not backup.exists())
            ):
                target_binding = _bind_staging_directory(target)
                try:
                    if not _identity_matches(
                        target_binding, entry.get("backupIdentity")
                    ):
                        raise ValidationError("Replacement target identity changed")
                finally:
                    target_binding.close()
                entry.update(
                    status="error",
                    phase="interrupted_retryable",
                    message="Interrupted before backup rename; retry with the same transferId",
                    updatedAt=iso_now(),
                )
                changed = True
                _cleanup_container_best_effort(transfer_id, entry)
                continue

            if (
                phase in {"installing", "installed", "committing_manifest"}
                and target.exists()
            ):
                installed_binding = _bind_staging_directory(target)
                backup_binding = None
                try:
                    if not _identity_matches(
                        installed_binding, entry.get("installedIdentity")
                    ):
                        raise ValidationError("Installed target identity changed")
                    if backup is not None:
                        backup_binding = _bind_staging_directory(backup)
                        if not _identity_matches(
                            backup_binding, entry.get("backupIdentity")
                        ):
                            raise ValidationError("Backup identity changed")
                    quarantine = target.parent / f".nexthmi-recovery-{transfer_id}"
                    _rename_bound(target, quarantine, installed_binding)
                    if backup is not None and backup_binding is not None:
                        _rename_bound(backup, target, backup_binding)
                finally:
                    installed_binding.close()
                    if backup_binding is not None:
                        backup_binding.close()
                entry.update(
                    status="error",
                    phase="rolled_back_after_restart",
                    message=f"Interrupted install quarantined at {quarantine}; retry is safe",
                    updatedAt=iso_now(),
                )
                changed = True
                _cleanup_container_best_effort(transfer_id, entry)
                continue

            if phase == "installing" and not target.exists():
                if backup is not None:
                    backup_binding = _bind_staging_directory(backup)
                    try:
                        if not _identity_matches(
                            backup_binding, entry.get("backupIdentity")
                        ):
                            raise ValidationError("Backup identity changed")
                        _rename_bound(backup, target, backup_binding)
                    finally:
                        backup_binding.close()
                entry.update(
                    status="error",
                    phase="rolled_back_after_restart"
                    if backup is not None
                    else "interrupted_retryable",
                    message="Interrupted before install rename; retry with the same transferId",
                    updatedAt=iso_now(),
                )
                changed = True
                _cleanup_container_best_effort(transfer_id, entry)
                continue
            raise ValidationError("Interrupted transfer state cannot be proven safe")
        except Exception as exc:
            entry.update(
                status="recovery_required",
                phase="recovery_required",
                message=str(exc),
                updatedAt=iso_now(),
            )
            changed = True
    return changed


_PROGRESS_PERSIST_INTERVAL_SECONDS = 2.0


class _ProgressFile:
    def __init__(self, source, state: TransferState, cancel: threading.Event) -> None:
        self._source = source
        self._state = state
        self._cancel = cancel
        self._last_persisted_at = 0.0

    def read(self, size: int = -1) -> bytes:
        if self._cancel.is_set():
            raise RuntimeError("Transfer cancelled")
        chunk = self._source.read(size)
        self._state.bytesDone += len(chunk)
        # In-memory progress is updated per chunk; the durable journal is a
        # blocking read-modify-write of the whole file, so persist it on a time
        # budget rather than once per megabyte of a multi-gigabyte upload.
        now = time.monotonic()
        if not chunk or now - self._last_persisted_at >= _PROGRESS_PERSIST_INTERVAL_SECONDS:
            _sender_update(
                self._state.transferId,
                phase="uploading",
                bytesDone=self._state.bytesDone,
                bytesTotal=self._state.bytesTotal,
            )
            self._last_persisted_at = now
        return chunk

    def seek(self, offset: int, whence: int = 0) -> int:
        position = self._source.seek(offset, whence)
        if position == 0:
            self._state.bytesDone = 0
            # A retry restarts the byte count, so let it publish immediately
            # instead of inheriting the previous attempt's budget.
            self._last_persisted_at = 0.0
        return position

    def tell(self) -> int:
        return self._source.tell()


class TransferBody(BaseModel):
    sourceProjectId: str = Field(min_length=1)
    destinationProjectId: str = Field(min_length=1)
    destinationFolder: str = Field(min_length=1, max_length=255)
    peerHost: str = Field(min_length=1, max_length=255)
    peerPort: int = Field(default=8000, ge=1, le=65535)
    peerScheme: PeerScheme = "http"
    token: str = Field(min_length=1)
    collisionPolicy: Literal["reject", "replace", "copy"] = "reject"
    confirmReplace: bool = False
    start: bool = False
    transferId: str | None = None

    _validate_project_ids = field_validator("sourceProjectId", "destinationProjectId")(
        validate_project_id
    )


_FINISHED_TRANSFERS_KEPT = 50


def _prune_finished_transfers() -> None:
    """Bound the in-memory history; the journal remains the durable record."""
    finished = [
        transfer_id
        for transfer_id, state in _transfers.items()
        if state.status != "active"
    ]
    for transfer_id in finished[: max(0, len(finished) - _FINISHED_TRANSFERS_KEPT)]:
        _transfers.pop(transfer_id, None)


def _fingerprint(body: TransferBody) -> str:
    canonical = body.model_dump(exclude={"transferId", "token"}, mode="json")
    return hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()


@manager_router.post("/transfers", status_code=202)
async def begin_transfer(body: TransferBody) -> dict[str, Any]:
    transfer_id = body.transferId or f"tx-{uuid.uuid4().hex}"
    if not _TRANSFER_ID.fullmatch(transfer_id):
        raise ValidationError(
            "transferId must contain only letters, digits, '.', '_' or '-'"
        )
    fingerprint = _fingerprint(body)
    durable = _load_sender_journal()["transfers"].get(transfer_id)
    if isinstance(durable, dict):
        if durable.get("fingerprint") != fingerprint:
            raise ConflictError(
                "transferId was already used with different transfer parameters"
            )
        if durable.get("status") == "complete":
            return {"transferId": transfer_id, **durable}
    previous = _transfers.get(transfer_id)
    if previous is not None:
        if previous.fingerprint != fingerprint:
            raise ConflictError(
                "transferId was already used with different transfer parameters"
            )
        if previous.status in {"active", "complete"}:
            return previous.public()
    source = find_project(load_manifest(), body.sourceProjectId)
    if source is None:
        raise NotFoundError(f"Source project '{body.sourceProjectId}' not found")
    if not Path(source.path).expanduser().is_dir():
        raise ConflictError(f"Source project folder is missing at {source.path}")
    state = TransferState(
        transferId=transfer_id,
        fingerprint=fingerprint,
        sourceProjectId=body.sourceProjectId,
        destinationProjectId=body.destinationProjectId,
    )
    _transfers[transfer_id] = state
    _transfer_requests[transfer_id] = body
    _sender_cancellations[transfer_id] = threading.Event()
    _sender_update(
        transfer_id,
        fingerprint=fingerprint,
        sourceProjectId=body.sourceProjectId,
        destinationProjectId=body.destinationProjectId,
        destinationFolder=body.destinationFolder,
        status="active",
        phase="queued",
        bytesDone=0,
        bytesTotal=0,
    )
    state.task = asyncio.create_task(
        _send_transfer(state, body, Path(source.path), source.name)
    )
    return state.public()


async def _send_transfer(
    state: TransferState, body: TransferBody, source: Path, source_name: str
) -> None:
    tmp_dir = Path(tempfile.mkdtemp(prefix="nexthmi-manager-transfer-"))
    zip_path = tmp_dir / f"{safe_filename(source_name)}.zip"
    try:
        state.phase = "packing"
        _sender_update(state.transferId, status="active", phase="packing")
        cancel = _sender_cancellations[state.transferId]
        peer = await _peer_endpoint(body.peerHost, body.peerPort, body.peerScheme)

        def progress(done: int, total: int) -> None:
            if cancel.is_set():
                raise RuntimeError("Transfer cancelled")
            state.bytesDone = done
            state.bytesTotal = total

        with zip_path.open("wb") as output:
            await asyncio.to_thread(pack_project, source, output, progress)
        archive_sha256 = await asyncio.to_thread(_file_sha256, zip_path)
        durable = _load_sender_journal()["transfers"].get(state.transferId, {})
        previous_archive = durable.get("archiveSha256")
        if previous_archive is not None and previous_archive != archive_sha256:
            raise ConflictError(
                "Source project changed since this transferId was first attempted; use a new id"
            )
        state.phase = "uploading"
        state.bytesDone = 0
        state.bytesTotal = zip_path.stat().st_size
        _sender_update(
            state.transferId,
            phase="uploading",
            archiveSha256=archive_sha256,
            bytesDone=0,
            bytesTotal=state.bytesTotal,
        )
        fields = {
            "transferId": state.transferId,
            "sourceProjectId": body.sourceProjectId,
            "destinationProjectId": body.destinationProjectId,
            "destinationFolder": body.destinationFolder,
            "collisionPolicy": body.collisionPolicy,
            "confirmReplace": str(body.confirmReplace).lower(),
            "start": str(body.start).lower(),
        }
        # The file handle is a plain context manager; grouping it into the
        # ``async with`` makes Python demand ``__aenter__`` of it and the upload
        # dies before a byte leaves.
        try:
            with zip_path.open("rb") as source_file:
                async with peer.client(_HTTP_TIMEOUT) as client:
                    response = await client.post(
                        f"{peer.base_url}/api/manager/peer/transfers",
                        headers={**peer.headers, "Authorization": f"Bearer {body.token}"},
                        data=fields,
                        files={
                            "file": (
                                zip_path.name,
                                _ProgressFile(source_file, state, cancel),
                                "application/zip",
                            )
                        },
                    )
        except httpx.HTTPError as exc:
            # The peer was reached, so "could not reach" would be wrong here;
            # only a changed pin earns a rewritten message.
            mismatch = await peer.certificate_mismatch()
            if mismatch is not None:
                raise ConflictError(mismatch) from exc
            raise
        if response.status_code >= 400:
            detail = response.text
            with suppress(ValueError):
                detail = response.json().get("detail", detail)
            raise ConflictError(f"Destination rejected transfer: {detail}")
        state.phase = "complete"
        state.status = "complete"
        state.bytesDone = state.bytesTotal
        state.result = response.json()
        state.message = "Transferred successfully"
        _sender_update(
            state.transferId,
            status="complete",
            phase="complete",
            bytesDone=state.bytesDone,
            bytesTotal=state.bytesTotal,
            message=state.message,
            result=state.result,
        )
    except (asyncio.CancelledError, RuntimeError) as exc:
        if (
            not isinstance(exc, asyncio.CancelledError)
            and "cancelled" not in str(exc).lower()
        ):
            state.phase = "error"
            state.status = "error"
            state.message = str(exc)
            _sender_update(
                state.transferId,
                status="error",
                phase="error",
                message=state.message,
            )
            # Same reasoning as the generic error path: a failure here says
            # nothing about whether the destination committed.
            await _reconcile_terminal_state_with_receiver(state, body)
            return
        state.phase = "cancelled"
        state.status = "cancelled"
        state.message = "Transfer cancelled"
        _sender_update(
            state.transferId,
            status="cancelled",
            phase="cancelled",
            message=state.message,
        )
        # Swallowing this would leave the task reporting "completed" to anyone
        # inspecting it; a task cancelled from outside must finish cancelled.
        if isinstance(exc, asyncio.CancelledError):
            raise
    except Exception as exc:
        state.phase = "error"
        state.status = "error"
        state.message = str(exc)
        _sender_update(
            state.transferId,
            status="error",
            phase="error",
            message=state.message,
        )
        # A read timeout or reset after the archive was fully sent says nothing
        # about whether the destination committed — ask it before reporting.
        await _reconcile_terminal_state_with_receiver(state, body)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        # The request carries the destination's bearer token; drop it as soon
        # as the transfer is terminal rather than holding it for the life of
        # the process. Status stays available from `_transfers` / the journal.
        #
        # Only if this attempt is still the registered one: a retry with the
        # same transferId installs fresh entries, and a slow predecessor
        # unwinding afterwards would otherwise deregister the live attempt —
        # leaving its cancellation silently inert and its token unavailable to
        # the remote DELETE.
        if _transfers.get(state.transferId) is state:
            _transfer_requests.pop(state.transferId, None)
            _sender_cancellations.pop(state.transferId, None)
        _prune_finished_transfers()


@manager_router.get("/transfers/{transfer_id}")
async def transfer_status(transfer_id: str) -> dict[str, Any]:
    state = _transfers.get(transfer_id)
    if state is None:
        durable = _load_sender_journal()["transfers"].get(transfer_id)
        if not isinstance(durable, dict):
            raise NotFoundError(f"Transfer '{transfer_id}' not found")
        return {"transferId": transfer_id, **durable}
    return state.public()


@manager_router.delete("/transfers/{transfer_id}")
async def cancel_transfer(transfer_id: str) -> dict[str, Any]:
    state = _transfers.get(transfer_id)
    if state is None:
        # After a manager restart the in-memory state is gone but the durable
        # journal still owns the outcome; report it instead of a bare 404.
        durable = _load_sender_journal()["transfers"].get(transfer_id)
        if not isinstance(durable, dict):
            raise NotFoundError(f"Transfer '{transfer_id}' not found")
        return {"transferId": transfer_id, **durable}
    if state.status == "active" and state.task is not None:
        _sender_cancellations.setdefault(transfer_id, threading.Event()).set()
        body = _transfer_requests.get(transfer_id)
        if body is not None:
            try:
                peer = await _peer_endpoint(
                    body.peerHost, body.peerPort, body.peerScheme
                )
                async with peer.client(httpx.Timeout(5.0)) as client:
                    await client.delete(
                        f"{peer.base_url}/api/manager/peer/transfers/{transfer_id}",
                        headers={
                            **peer.headers,
                            "Authorization": f"Bearer {body.token}",
                        },
                    )
            except (httpx.HTTPError, ValidationError):
                pass
        try:
            await asyncio.wait_for(asyncio.shield(state.task), timeout=15.0)
        except TimeoutError:
            state.task.cancel()
            await asyncio.gather(state.task, return_exceptions=True)
        except asyncio.CancelledError:
            # The transfer task finishing cancelled is the expected outcome
            # here — it must not cancel this request handler with it.
            if state.task.cancelled():
                pass
            else:
                raise
        if state.status in {"cancelled", "error"}:
            await _reconcile_terminal_state_with_receiver(state, body)
    return state.public()


async def _reconcile_terminal_state_with_receiver(
    state: TransferState, body: TransferBody | None
) -> None:
    """A cancel or error is only truthful if the destination did not commit.

    The best-effort DELETE can fail (or arrive too late) while the receiver
    commits and starts the project. Before reporting a terminal ``cancelled`` /
    ``error``, ask the destination's authoritative durable status and upgrade to
    ``complete`` when it proves the install was committed.
    """
    if body is None:
        return
    try:
        peer = await _peer_endpoint(body.peerHost, body.peerPort, body.peerScheme)
        async with peer.client(httpx.Timeout(10.0)) as client:
            response = await client.get(
                f"{peer.base_url}/api/manager/peer/transfers/{state.transferId}/status",
                headers={**peer.headers, "Authorization": f"Bearer {body.token}"},
            )
    except (httpx.HTTPError, ValidationError):
        return
    if response.status_code >= 400:
        return
    remote = response.json()
    if remote.get("status") not in {"complete", "applied_pending_start"}:
        return
    result = remote.get("result")
    state.status = "complete"
    state.phase = "complete"
    state.message = "Destination committed before cancellation; reported as complete"
    if isinstance(result, dict):
        state.result = result
        state.bytesDone = state.bytesTotal
    _sender_update(
        state.transferId,
        status="complete",
        phase="complete",
        message=state.message,
        result=state.result,
    )


# ── pull direction: puller is both requester and installer ──────────────────
#
# Push splits cleanly into a sender (pack + upload) and a receiver (stage +
# install), two different processes talking HTTP. Pull collapses both roles
# into one local task: this manager downloads the archive itself, then calls
# the exact same `_stage_and_install` a push receiver uses. Only the download
# leg is genuinely new code below; everything after the archive is on disk
# reuses the shared install core and its safety rails unchanged.


class PullBody(BaseModel):
    sourceProjectId: str = Field(min_length=1)
    destinationProjectId: str = Field(min_length=1)
    destinationFolder: str = Field(min_length=1, max_length=255)
    peerHost: str = Field(min_length=1, max_length=255)
    peerPort: int = Field(default=8000, ge=1, le=65535)
    peerScheme: PeerScheme = "http"
    token: str = Field(min_length=1)
    collisionPolicy: Literal["reject", "replace", "copy"] = "reject"
    confirmReplace: bool = False
    start: bool = False
    transferId: str | None = None

    _validate_project_ids = field_validator("sourceProjectId", "destinationProjectId")(
        validate_project_id
    )


_pulls: dict[str, TransferState] = {}
_pull_requests: dict[str, PullBody] = {}
_pull_cancellations: dict[str, threading.Event] = {}


def _prune_finished_pulls() -> None:
    """Bound the in-memory history; the pull journal remains the durable record."""
    finished = [
        transfer_id for transfer_id, state in _pulls.items() if state.status != "active"
    ]
    for transfer_id in finished[: max(0, len(finished) - _FINISHED_TRANSFERS_KEPT)]:
        _pulls.pop(transfer_id, None)


def _pull_fingerprint(body: PullBody) -> str:
    canonical = body.model_dump(exclude={"transferId", "token"}, mode="json")
    return hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()


@manager_router.post("/pulls", status_code=202)
async def begin_pull(body: PullBody) -> dict[str, Any]:
    transfer_id = body.transferId or f"pull-{uuid.uuid4().hex}"
    if not _TRANSFER_ID.fullmatch(transfer_id):
        raise ValidationError(
            "transferId must contain only letters, digits, '.', '_' or '-'"
        )
    fingerprint = _pull_fingerprint(body)
    durable = _load_pull_journal()["pulls"].get(transfer_id)
    if isinstance(durable, dict) and durable.get("fingerprint") != fingerprint:
        raise ConflictError(
            "transferId was already used with different transfer parameters"
        )
    if isinstance(durable, dict):
        result = durable.get("result")
        if durable.get("status") == "complete" and isinstance(result, dict):
            return {"transferId": transfer_id, **durable}
        if durable.get("status") == "recovery_required":
            raise ConflictError(
                "Transfer requires explicit administrator recovery; its claim is immutable"
            )
        if durable.get("status") == "applied_pending_start":
            # The install already committed on an earlier attempt; only starting
            # it remains. Handled inline rather than via a background task —
            # this is a single fast local check, the same shape as
            # receive_transfer's own pending-start retry.
            target = _target_in_root(body.destinationFolder)
            current = load_manifest()
            entry = find_project(current, body.destinationProjectId)
            if (
                not body.start
                or entry is None
                or Path(entry.path).expanduser().absolute() != target.absolute()
                or not target.is_dir()
            ):
                raise ConflictError("Applied transfer is not eligible for pending start")
            target_binding = _bind_staging_directory(target)
            try:
                metadata = read_project_metadata(target)
                if (
                    not _identity_matches(
                        target_binding, durable.get("installedIdentity")
                    )
                    or metadata is None
                    or metadata.id != body.destinationProjectId
                ):
                    raise ConflictError(
                        "Applied transfer target identity changed before start"
                    )
            finally:
                target_binding.close()
            start_result = await asyncio.to_thread(
                supervisor.start, body.destinationProjectId
            )
            if start_result.get("status") not in {"starting", "running"}:
                _pull_journal_update(
                    transfer_id,
                    status="applied_pending_start",
                    phase="applied_pending_start",
                    message=start_result.get("lastError") or "Project did not start",
                )
                raise ConflictError(
                    start_result.get("lastError") or "Project did not start"
                )
            result = dict(durable.get("result") or {})
            result.update(started=True, startError=None)
            _save_pull_receipt(transfer_id, fingerprint, result)
            return {
                "transferId": transfer_id,
                "status": "complete",
                "phase": "receipt",
                "result": result,
            }

    previous = _pulls.get(transfer_id)
    if previous is not None:
        if previous.fingerprint != fingerprint:
            raise ConflictError(
                "transferId was already used with different transfer parameters"
            )
        if previous.status in {"active", "complete"}:
            return previous.public()

    target = _target_in_root(body.destinationFolder)
    manifest = load_manifest()
    existing_by_id = find_project(manifest, body.destinationProjectId)
    source_collision = find_project(manifest, body.sourceProjectId)
    if body.collisionPolicy == "reject":
        if existing_by_id is not None or source_collision is not None or target.exists():
            raise ConflictError("Destination project id or folder already exists")
    elif body.collisionPolicy == "copy":
        if existing_by_id is not None or target.exists():
            raise ConflictError("Copy destination project id or folder already exists")
        if body.destinationProjectId == body.sourceProjectId:
            raise ValidationError("Copy-with-new-ID requires a new destinationProjectId")
    else:
        if not body.confirmReplace:
            raise ValidationError("Replacement requires explicit admin confirmation")
        if existing_by_id is None:
            raise NotFoundError(
                f"Destination project '{body.destinationProjectId}' not found"
            )
        if running_entry(manifest, body.destinationProjectId) is not None:
            raise ConflictError(
                "Destination project must be stopped before replacement"
            )
        existing_target = Path(existing_by_id.path).expanduser().absolute()
        if existing_target != target.absolute():
            raise ValidationError(
                "Replacement folder must match the registered destination project"
            )

    state = TransferState(
        transferId=transfer_id,
        fingerprint=fingerprint,
        sourceProjectId=body.sourceProjectId,
        destinationProjectId=body.destinationProjectId,
    )
    _pulls[transfer_id] = state
    _pull_requests[transfer_id] = body
    _pull_cancellations[transfer_id] = threading.Event()
    _pull_journal_update(
        transfer_id,
        fingerprint=fingerprint,
        sourceProjectId=body.sourceProjectId,
        destinationProjectId=body.destinationProjectId,
        destinationFolder=body.destinationFolder,
        targetPath=str(target),
        collisionPolicy=body.collisionPolicy,
        startRequested=body.start,
        status="active",
        phase="queued",
        bytesDone=0,
        bytesTotal=0,
    )
    state.task = asyncio.create_task(_run_pull(state, body, target))
    return state.public()


async def _run_pull(state: TransferState, body: PullBody, target: Path) -> None:
    tmp_dir = Path(tempfile.mkdtemp(prefix="nexthmi-manager-pull-"))
    zip_path = tmp_dir / "incoming.zip"
    cancel = _pull_cancellations[state.transferId]
    staged = False
    try:
        state.phase = "downloading"
        _pull_journal_update(state.transferId, status="active", phase="downloading")
        peer = await _peer_endpoint(body.peerHost, body.peerPort, body.peerScheme)
        last_persisted_at = 0.0
        try:
            async with peer.client(_HTTP_TIMEOUT) as client:  # noqa: SIM117 -- no autofix offered; inner context expr depends on `client`, and combining `async with` clauses is left as-is per the mechanical-only policy for this family
                async with client.stream(
                    "GET",
                    f"{peer.base_url}/api/manager/peer/projects/{body.sourceProjectId}/archive",
                    headers={**peer.headers, "Authorization": f"Bearer {body.token}"},
                ) as response:
                    if response.status_code >= 400:
                        detail = (await response.aread()).decode("utf-8", "replace")
                        with suppress(ValueError):
                            detail = json.loads(detail).get("detail", detail)
                        raise ConflictError(f"Peer rejected archive request: {detail}")
                    state.bytesTotal = int(response.headers.get("content-length") or 0)
                    with zip_path.open("wb") as output:
                        async for chunk in response.aiter_bytes(64 * 1024):
                            if cancel.is_set():
                                raise RuntimeError("Transfer cancelled")
                            output.write(chunk)
                            state.bytesDone += len(chunk)
                            now = time.monotonic()
                            if now - last_persisted_at >= _PROGRESS_PERSIST_INTERVAL_SECONDS:
                                _pull_journal_update(
                                    state.transferId,
                                    phase="downloading",
                                    bytesDone=state.bytesDone,
                                    bytesTotal=state.bytesTotal,
                                )
                                last_persisted_at = now
        except httpx.HTTPError as exc:
            # The peer was reached, so "could not reach" would be wrong here;
            # only a changed pin earns a rewritten message.
            mismatch = await peer.certificate_mismatch()
            if mismatch is not None:
                raise ConflictError(mismatch) from exc
            raise

        archive_sha256 = await asyncio.to_thread(_file_sha256, zip_path)
        durable = _load_pull_journal()["pulls"].get(state.transferId, {})
        previous_archive = durable.get("archiveSha256")
        if previous_archive is not None and previous_archive != archive_sha256:
            raise ConflictError(
                "Source project changed since this transferId was first attempted; use a new id"
            )
        state.phase = "extracting"
        # `bytesTotal` is 0 when the peer omitted Content-Length; snapping
        # `bytesDone` down to it would erase the download progress already
        # accumulated in the loop above.
        state.bytesDone = max(state.bytesDone, state.bytesTotal)
        _pull_journal_update(
            state.transferId,
            phase="extracting",
            archiveSha256=archive_sha256,
            archiveSize=zip_path.stat().st_size,
            bytesDone=state.bytesDone,
            bytesTotal=state.bytesTotal,
        )

        def unpack_into_stage(stage: Path) -> ProjectMetadata:
            def progress(_done: int, _total: int) -> None:
                if cancel.is_set():
                    raise RuntimeError("Transfer cancelled")

            with zip_path.open("rb") as archive:
                return unpack_project(archive, stage, progress=progress)

        def journal_update(**updates: Any) -> None:
            _pull_journal_update(state.transferId, **updates)

        def journal_committed_outcome(backup: Path | None, reason: str) -> None:
            _pull_journal_committed_outcome(
                state.transferId,
                state.fingerprint,
                sourceProjectId=body.sourceProjectId,
                destinationProjectId=body.destinationProjectId,
                target=target,
                collisionPolicy=body.collisionPolicy,
                backup=backup,
                start=body.start,
                reason=reason,
            )

        def save_receipt(result: dict[str, Any]) -> None:
            _save_pull_receipt(state.transferId, state.fingerprint, result)

        staged = True
        result = await _stage_and_install(
            transfer_id=state.transferId,
            fingerprint=state.fingerprint,
            source_project_id=body.sourceProjectId,
            destination_project_id=body.destinationProjectId,
            collision_policy=body.collisionPolicy,
            target=target,
            unpack_into_stage=unpack_into_stage,
            start=body.start,
            cancel=cancel,
            bearer_still_valid=lambda: True,
            journal_update=journal_update,
            journal_committed_outcome=journal_committed_outcome,
            save_receipt=save_receipt,
        )
        state.phase = "complete"
        state.status = "complete"
        state.bytesDone = max(state.bytesDone, state.bytesTotal)
        state.result = result
        state.message = "Pulled successfully"
    except (asyncio.CancelledError, RuntimeError) as exc:
        cancelled = isinstance(exc, asyncio.CancelledError) or (
            "cancelled" in str(exc).lower()
        )
        # `_stage_and_install` already journaled its own outcome once entered
        # (`staged`); only the download leg's failures are this function's to
        # journal.
        if cancelled:
            state.phase = "cancelled"
            state.status = "cancelled"
            state.message = "Transfer cancelled"
            if not staged:
                _pull_journal_update(
                    state.transferId,
                    status="cancelled",
                    phase="cancelled",
                    message=state.message,
                )
        else:
            state.phase = "error"
            state.status = "error"
            state.message = str(exc)
            if not staged:
                _pull_journal_update(
                    state.transferId, status="error", phase="error", message=state.message
                )
        if isinstance(exc, asyncio.CancelledError):
            raise
    except Exception as exc:
        state.phase = "error"
        state.status = "error"
        state.message = str(exc)
        if not staged:
            _pull_journal_update(
                state.transferId, status="error", phase="error", message=state.message
            )
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        if _pulls.get(state.transferId) is state:
            _pull_requests.pop(state.transferId, None)
            _pull_cancellations.pop(state.transferId, None)
        _prune_finished_pulls()


@manager_router.get("/pulls/{transfer_id}")
async def pull_status(transfer_id: str) -> dict[str, Any]:
    state = _pulls.get(transfer_id)
    if state is None:
        durable = _load_pull_journal()["pulls"].get(transfer_id)
        if not isinstance(durable, dict):
            raise NotFoundError(f"Pull '{transfer_id}' not found")
        return {"transferId": transfer_id, **durable}
    return state.public()


@manager_router.delete("/pulls/{transfer_id}")
async def cancel_pull(transfer_id: str) -> dict[str, Any]:
    state = _pulls.get(transfer_id)
    if state is None:
        durable = _load_pull_journal()["pulls"].get(transfer_id)
        if not isinstance(durable, dict):
            raise NotFoundError(f"Pull '{transfer_id}' not found")
        return {"transferId": transfer_id, **durable}
    if state.status == "active" and state.task is not None:
        _pull_cancellations.setdefault(transfer_id, threading.Event()).set()
        try:
            await asyncio.wait_for(asyncio.shield(state.task), timeout=15.0)
        except TimeoutError:
            state.task.cancel()
            await asyncio.gather(state.task, return_exceptions=True)
        except asyncio.CancelledError:
            if state.task.cancelled():
                pass
            else:
                raise
    return state.public()


def _receipt_fingerprint(**values: str) -> str:
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def _receipts_path() -> Path:
    return runtime_home.runtime_home_path() / ".peer-transfer-receipts.json"


def _load_receipts() -> dict[str, Any]:
    with _receipt_lock:
        try:
            data = json.loads(_receipts_path().read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"version": 1, "receipts": {}}
        except (OSError, ValueError) as exc:
            raise ConflictError(
                "Peer transfer journal is unreadable; refusing transfer"
            ) from exc
        if not isinstance(data, dict) or not isinstance(data.get("receipts"), dict):
            raise ConflictError("Peer transfer journal is corrupt; refusing transfer")
        return data


def _write_journal(data: dict[str, Any]) -> None:
    write_text_atomic(_receipts_path(), json.dumps(data, indent=2))


def _pull_journal_path() -> Path:
    return runtime_home.runtime_home_path() / ".peer-transfer-pull.json"


def _load_pull_journal() -> dict[str, Any]:
    """Same shape as ``_load_receipts``, for the pull direction's own journal."""
    with _pull_journal_lock:
        try:
            data = json.loads(_pull_journal_path().read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"version": 1, "pulls": {}}
        except (OSError, ValueError) as exc:
            raise ConflictError(
                "Pull transfer journal is unreadable; refusing transfer"
            ) from exc
        if not isinstance(data, dict) or not isinstance(data.get("pulls"), dict):
            raise ConflictError("Pull transfer journal is corrupt; refusing transfer")
        return data


def _write_pull_journal(data: dict[str, Any]) -> None:
    write_text_atomic(_pull_journal_path(), json.dumps(data, indent=2))


def _journal_update(transfer_id: str, **updates: Any) -> None:
    with _receipt_lock:
        data = _load_receipts()
        _prune_journal_entries(data["receipts"], transfer_id)
        entry = data["receipts"].setdefault(transfer_id, {})
        # recovery_required is terminal and admin-owned: a later generic error
        # handler must never downgrade it into something a retry would accept.
        if entry.get("status") == "recovery_required":
            return
        entry.update(updates)
        entry["updatedAt"] = iso_now()
        _write_journal(data)


def _journal_committed_outcome(
    transfer_id: str,
    fingerprint: str,
    *,
    sourceProjectId: str,
    destinationProjectId: str,
    target: Path,
    collisionPolicy: str,
    backup: Path | None,
    start: bool,
    reason: str,
) -> None:
    """Record the terminal state of a transfer whose manifest commit succeeded.

    Anything that goes wrong after the commit is a reporting failure, not an
    install failure — the destination project exists. Mirrors what the crash
    reconciler concludes for the same on-disk state so a retry can settle it.
    """
    result = {
        "transferId": transfer_id,
        "sourceProjectId": sourceProjectId,
        "destinationProjectId": destinationProjectId,
        "destinationFolder": target.name,
        "replaced": collisionPolicy == "replace",
        "backupPath": str(backup) if backup is not None else None,
        "startRequested": start,
        "started": False,
        "startError": f"{reason}; authenticated retry is required to start"
        if start
        else None,
    }
    if start:
        _journal_update(
            transfer_id,
            status="applied_pending_start",
            phase="applied_pending_start",
            result=result,
            message=f"{reason}; retry to start",
        )
    else:
        _save_receipt(transfer_id, fingerprint, result)


def _archive_fingerprint(file: UploadFile) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    file.file.seek(0)
    while True:
        chunk = file.file.read(64 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_zip_bytes():
            raise HTTPException(
                status_code=413, detail="Project archive exceeds configured limit"
            )
        digest.update(chunk)
    file.file.seek(0)
    return digest.hexdigest(), total


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(64 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _save_receipt(transfer_id: str, fingerprint: str, result: dict[str, Any]) -> None:
    with _receipt_lock:
        data = _load_receipts()
        data["receipts"][transfer_id] = {
            "fingerprint": fingerprint,
            "status": "complete",
            "phase": "receipt",
            "result": result,
            "completedAt": iso_now(),
        }
        _write_journal(data)


def _pull_journal_update(transfer_id: str, **updates: Any) -> None:
    with _pull_journal_lock:
        data = _load_pull_journal()
        _prune_journal_entries(data["pulls"], transfer_id)
        entry = data["pulls"].setdefault(transfer_id, {})
        if entry.get("status") == "recovery_required":
            return
        entry.update(updates)
        entry["updatedAt"] = iso_now()
        _write_pull_journal(data)


def _save_pull_receipt(transfer_id: str, fingerprint: str, result: dict[str, Any]) -> None:
    with _pull_journal_lock:
        data = _load_pull_journal()
        data["pulls"][transfer_id] = {
            "fingerprint": fingerprint,
            "status": "complete",
            "phase": "receipt",
            "result": result,
            "completedAt": iso_now(),
        }
        _write_pull_journal(data)


def _pull_journal_committed_outcome(
    transfer_id: str,
    fingerprint: str,
    *,
    sourceProjectId: str,
    destinationProjectId: str,
    target: Path,
    collisionPolicy: str,
    backup: Path | None,
    start: bool,
    reason: str,
) -> None:
    """Pull-journal counterpart to ``_journal_committed_outcome``."""
    result = {
        "transferId": transfer_id,
        "sourceProjectId": sourceProjectId,
        "destinationProjectId": destinationProjectId,
        "destinationFolder": target.name,
        "replaced": collisionPolicy == "replace",
        "backupPath": str(backup) if backup is not None else None,
        "startRequested": start,
        "started": False,
        "startError": f"{reason}; authenticated retry is required to start"
        if start
        else None,
    }
    if start:
        _pull_journal_update(
            transfer_id,
            status="applied_pending_start",
            phase="applied_pending_start",
            result=result,
            message=f"{reason}; retry to start",
        )
    else:
        _save_pull_receipt(transfer_id, fingerprint, result)


async def _stage_and_install(
    *,
    transfer_id: str,
    fingerprint: str,
    source_project_id: str,
    destination_project_id: str,
    collision_policy: Literal["reject", "replace", "copy"],
    target: Path,
    unpack_into_stage: Callable[[Path], ProjectMetadata],
    start: bool,
    cancel: threading.Event,
    bearer_still_valid: Callable[[], bool],
    journal_update: Callable[..., None],
    journal_committed_outcome: Callable[[Path | None, str], None],
    save_receipt: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    """Stage a validated archive into ``target`` and commit it to the manifest.

    Shared by both transfer directions. The caller has already authenticated,
    resolved collisions against the manifest, and claimed ``transfer_id`` in its
    own durable journal (``journal_update``/``journal_committed_outcome``/
    ``save_receipt`` are pre-bound to that journal). This function only knows
    how to get bytes into the staging directory (``unpack_into_stage``) —
    everything about staged install, backup, rollback, and manifest commit is
    identical whether the archive arrived via an incoming POST (push) or an
    outgoing download (pull).
    """
    root = target.parent
    root_binding = None
    container = root / f".nexthmi-transfer-{transfer_id}-uncreated"
    container_binding = None
    stage = container / "payload"
    stage_binding = None
    target_binding = None
    backup_binding = None
    backup: Path | None = None
    installed = False
    backed_up = False
    manifest_committed = False
    staging_worker: asyncio.Future | None = None
    staging_future: Future | None = None
    staging_thread_done = threading.Event()
    operation_lock = supervisor.project_operation_lock(destination_project_id)
    # Pinned for the whole call so the lock map cannot evict this folder's
    # lock while the transfer is still using it.
    target_lock_pin = ExitStack()
    path_lock = target_lock_pin.enter_context(_target_path_lock(target))
    operation_locked = False
    path_locked = False
    try:
        root_binding = _bind_staging_directory(root)
        container = Path(
            tempfile.mkdtemp(prefix=f".nexthmi-transfer-{transfer_id}-", dir=root)
        )
        container_binding = _bind_staging_directory(container)
        stage = container / "payload"
        journal_update(
            phase="extracting",
            containerPath=str(container),
            containerIdentity=_binding_identity(container_binding),
        )

        def unpack() -> ProjectMetadata:
            try:
                return unpack_into_stage(stage)
            finally:
                staging_thread_done.set()

        # Submitted to an explicit executor so the concurrent future is in
        # hand: its `cancelled()` is authoritative (true only if the job was
        # dropped before running), whereas an asyncio Task wrapping
        # `to_thread` reports cancelled even while its thread keeps extracting.
        staging_future = _staging_executor.submit(unpack)
        staging_worker = asyncio.wrap_future(staging_future)
        try:
            metadata = await staging_worker
        except (UnsafeArchiveError, zipfile.BadZipFile) as exc:
            raise ValidationError(str(exc)) from exc
        if metadata.id != source_project_id:
            raise ValidationError("Archive project id does not match sourceProjectId")
        if collision_policy == "copy":
            metadata = ProjectMetadata(
                id=destination_project_id, name=metadata.name, createdAt=iso_now()
            )
            write_project_metadata(stage, metadata)
        elif collision_policy == "replace":
            metadata = ProjectMetadata(
                id=destination_project_id,
                name=metadata.name,
                createdAt=metadata.createdAt,
            )
            write_project_metadata(stage, metadata)
        elif destination_project_id != source_project_id:
            raise ValidationError(
                "Destination id must match source id unless copying or replacing"
            )

        stage_binding = _bind_staging_directory(stage)
        journal_update(phase="validated")
        _cancel_check(cancel, "cancelled after validation")
        if not bearer_still_valid():
            raise HTTPException(
                status_code=401, detail="Peer token was revoked during transfer"
            )
        if not await _acquire_lock_cancel_safe(operation_lock):
            raise ConflictError(
                "Timed out waiting for the destination project's operation lock"
            )
        operation_locked = True
        try:
            if not await _acquire_lock_cancel_safe(path_lock):
                raise ConflictError(
                    "Timed out waiting for the destination folder lock"
                )
            path_locked = True
            display_name = metadata.name or target.name
            # Probed before the manifest transaction: the supervisor takes its
            # own lock and then loads the manifest, so asking it anything while
            # holding the manifest lock inverts that order and deadlocks the
            # manager. The answer stays true because `supervisor.start`/`stop`
            # take this same per-project operation lock, and the crash monitor —
            # which restarts *without* it — only ever selects instances whose
            # status is already "running", which this check rejects anyway.
            if collision_policy == "replace" and not supervisor.is_fully_stopped(
                destination_project_id
            ):
                raise ConflictError("Destination process is not fully stopped")
            with manifest_transaction() as current:
                _validate_staging_binding(root, root_binding)
                _validate_staging_binding(stage, stage_binding)
                _cancel_check(cancel, "cancelled before commit")
                if collision_policy == "replace":
                    entry = find_project(current, destination_project_id)
                    if (
                        entry is None
                        or running_entry(current, destination_project_id) is not None
                    ):
                        raise ConflictError("Destination changed during replacement")
                    if Path(entry.path).expanduser().absolute() != target.absolute():
                        raise ConflictError(
                            "Destination path changed during replacement"
                        )
                    target_binding = _bind_staging_directory(target)
                    backup = root / f"{target.name}.bak-{transfer_id}"
                    if backup.exists() or backup.is_symlink():
                        raise ConflictError(f"Backup path already exists: {backup}")
                    _cancel_check(cancel, "cancelled before backup")
                    journal_update(
                        phase="backing_up",
                        backupPath=str(backup),
                        backupIdentity={
                            "device": target_binding.identity.device,
                            "inode": target_binding.identity.inode,
                        },
                    )
                    _rename_bound(target, backup, target_binding)
                    backed_up = True
                    _validate_staging_binding(backup, target_binding)
                    backup_binding = target_binding
                    journal_update(
                        phase="backup_created",
                        backupIdentity={
                            "device": backup_binding.identity.device,
                            "inode": backup_binding.identity.inode,
                        },
                    )
                    _cancel_check(cancel, "cancelled after backup")
                    journal_update(
                        phase="installing",
                        installedIdentity={
                            "device": stage_binding.identity.device,
                            "inode": stage_binding.identity.inode,
                        },
                    )
                    _rename_bound(stage, target, stage_binding)
                    installed = True
                    _validate_staging_binding(target, stage_binding)
                    journal_update(
                        phase="installed",
                        installedIdentity={
                            "device": stage_binding.identity.device,
                            "inode": stage_binding.identity.inode,
                        },
                    )
                    _cancel_check(cancel, "cancelled after install")
                    entry.path = str(target)
                    entry.name = display_name
                    entry.lastOpenedAt = iso_now()
                else:
                    if find_project(current, destination_project_id) is not None:
                        raise ConflictError(
                            "Destination project appeared during transfer"
                        )
                    # A folder deleted outside the app leaves its manifest entry
                    # behind as `missing`. Installing there anyway would give two
                    # entries the same path, and starting the stale one would
                    # serve this project under the wrong id and base path.
                    claimed = next(
                        (
                            other
                            for other in current.projects
                            if Path(other.path).expanduser().absolute()
                            == target.absolute()
                        ),
                        None,
                    )
                    if claimed is not None:
                        raise ConflictError(
                            f"Destination folder is already registered to project "
                            f"'{claimed.id}'"
                        )
                    _cancel_check(cancel, "cancelled before install")
                    journal_update(
                        phase="installing",
                        installedIdentity={
                            "device": stage_binding.identity.device,
                            "inode": stage_binding.identity.inode,
                        },
                    )
                    _rename_bound(stage, target, stage_binding)
                    installed = True
                    _validate_staging_binding(target, stage_binding)
                    journal_update(
                        phase="installed",
                        installedIdentity={
                            "device": stage_binding.identity.device,
                            "inode": stage_binding.identity.inode,
                        },
                    )
                    _cancel_check(cancel, "cancelled after install")
                    entry = ProjectEntry(
                        id=destination_project_id,
                        name=display_name,
                        path=str(target),
                        addedAt=iso_now(),
                    )
                    current.projects.append(entry)
                if not bearer_still_valid():
                    raise HTTPException(
                        status_code=401, detail="Peer token was revoked before commit"
                    )
                journal_update(phase="committing_manifest")
                save_manifest(current)
                manifest_committed = True
            journal_update(phase="manifest_committed")
        except BaseException:
            # Unwinding the install must not skip restoring the backup: if the
            # first rename fails we would otherwise leave the *new* project
            # installed as the destination while the manifest was never
            # committed, and journal it as a clean rollback.
            rollback_error: BaseException | None = None
            if not manifest_committed and installed and stage_binding is not None:
                rejected = container / "rejected-install"
                try:
                    _rename_bound(target, rejected, stage_binding)
                    installed = False
                except BaseException as exc:
                    rollback_error = exc
            if (
                not manifest_committed
                and backed_up
                and backup is not None
                and backup_binding is not None
                and not installed
            ):
                try:
                    _rename_bound(backup, target, backup_binding)
                    backed_up = False
                except BaseException as exc:
                    rollback_error = rollback_error or exc
            if rollback_error is not None:
                journal_update(
                    status="recovery_required",
                    phase="recovery_required",
                    message=f"Rollback failed and the destination is inconsistent: {rollback_error}",
                )
            raise
        finally:
            if path_locked:
                path_lock.release()
            if operation_locked:
                operation_lock.release()

        started = False
        start_error: str | None = None
        if start:
            try:
                journal_update(phase="starting")
                if not bearer_still_valid():
                    raise HTTPException(
                        status_code=401, detail="Peer token was revoked before start"
                    )
                result = await asyncio.to_thread(supervisor.start, destination_project_id)
                started = result.get("status") in {"starting", "running"}
                if not started:
                    start_error = result.get("lastError") or "Project did not start"
            except Exception as exc:
                start_error = str(exc)
        result = {
            "transferId": transfer_id,
            "sourceProjectId": source_project_id,
            "destinationProjectId": destination_project_id,
            "destinationFolder": target.name,
            "replaced": collision_policy == "replace",
            "backupPath": str(backup) if backup is not None else None,
            "startRequested": start,
            "started": started,
            "startError": start_error,
        }
        save_receipt(result)
        return result
    except asyncio.CancelledError:
        # A request deadline or client disconnect cancels the coroutine but not
        # the worker threads it started; this is what actually stops an
        # in-flight unpack instead of letting it run past the timeout.
        cancel.set()
        try:
            if manifest_committed:
                journal_committed_outcome(backup, "Cancelled after commit")
            else:
                journal_update(
                    status="cancelled",
                    phase="cancelled_after_rollback",
                    message="Transfer cancelled",
                )
        except Exception:
            pass
        raise
    except Exception as exc:
        try:
            if manifest_committed:
                # The install is already the destination project. Journaling a
                # bare error would strand it exactly as a bare "cancelled"
                # would: the retry hits the collision preflight and can never
                # reach a receipt, and reconcile only walks active entries.
                journal_committed_outcome(backup, f"Failed after commit: {exc}")
            else:
                journal_update(
                    status="error",
                    phase="error_after_rollback",
                    message=str(exc),
                )
        except Exception:
            pass
        raise
    finally:
        target_lock_pin.close()
        # Clearing the container while the extracting thread is still writing
        # into it races it into ENOTEMPTY and leaves the tree behind. A
        # cancelled `to_thread` does not stop that thread, so hand the removal
        # to a task that waits for it (and retrieves its exception) instead.
        if staging_future is not None and not staging_thread_done.is_set():
            cancel.set()
            if staging_worker is not None:
                _swallow_future_exception(staging_worker)
            _defer_container_cleanup(
                transfer_id, container, staging_thread_done, staging_future
            )
        elif container_binding is not None:
            try:
                _clear_bound_directory(container, container_binding)
            except (OSError, ValidationError) as exc:
                logger.warning(
                    "peer transfer %s: staging container %s could not be removed "
                    "and is left on disk: %s",
                    transfer_id,
                    container,
                    exc,
                )
        for binding in (stage_binding, target_binding, container_binding, root_binding):
            if binding is not None:
                with suppress(OSError):
                    binding.close()
        try:
            if (
                (staging_future is None or staging_thread_done.is_set())
                and container.exists()
                and not container.is_symlink()
                and not any(container.iterdir())
            ):
                container.rmdir()
        except OSError:
            pass


@public_router.post("/transfers", status_code=201)
async def receive_transfer(
    request: Request,
    file: UploadFile = File(...),
    transferId: str = Form(...),
    sourceProjectId: str = Form(...),
    destinationProjectId: str = Form(...),
    destinationFolder: str = Form(...),
    collisionPolicy: Literal["reject", "replace", "copy"] = Form("reject"),
    confirmReplace: bool = Form(False),
    start: bool = Form(False),
) -> dict[str, Any]:
    _require_peer(request)
    try:
        sourceProjectId = validate_project_id(sourceProjectId)
        destinationProjectId = validate_project_id(destinationProjectId)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    if not _TRANSFER_ID.fullmatch(transferId):
        raise ValidationError(
            "transferId must contain only letters, digits, '.', '_' or '-'"
        )
    request_fingerprint = _receipt_fingerprint(
        sourceProjectId=sourceProjectId,
        destinationProjectId=destinationProjectId,
        destinationFolder=destinationFolder,
        collisionPolicy=collisionPolicy,
        confirmReplace=str(confirmReplace),
        start=str(start),
    )
    archive_sha256, archive_size = await asyncio.to_thread(_archive_fingerprint, file)
    fingerprint = hashlib.sha256(
        f"{request_fingerprint}:{archive_sha256}".encode()
    ).hexdigest()
    pending_start: dict[str, Any] | None = None
    with _receipt_lock:
        journal = _load_receipts()
        prior = journal["receipts"].get(transferId)
        if isinstance(prior, dict):
            if prior.get("fingerprint") != fingerprint:
                raise ConflictError(
                    "transferId was already used with different parameters or archive"
                )
            result = prior.get("result")
            if prior.get("status") == "complete" and isinstance(result, dict):
                return result
            if prior.get("status") == "applied_pending_start":
                pending_start = dict(prior)
            if prior.get("status") == "active":
                raise ConflictError("Transfer with this id is already in progress")
            if prior.get("status") == "recovery_required":
                raise ConflictError(
                    "Transfer requires explicit administrator recovery; its claim is immutable"
                )

    if pending_start is not None:
        target = _target_in_root(destinationFolder)
        current = load_manifest()
        entry = find_project(current, destinationProjectId)
        if (
            not start
            or entry is None
            or Path(entry.path).expanduser().absolute() != target.absolute()
            or not target.is_dir()
        ):
            raise ConflictError("Applied transfer is not eligible for pending start")
        target_binding = _bind_staging_directory(target)
        try:
            metadata = read_project_metadata(target)
            if (
                not _identity_matches(
                    target_binding, pending_start.get("installedIdentity")
                )
                or metadata is None
                or metadata.id != destinationProjectId
            ):
                raise ConflictError(
                    "Applied transfer target identity changed before start"
                )
        finally:
            target_binding.close()
        if not peer_tokens.verify(_bearer(request)):
            raise HTTPException(
                status_code=401, detail="Peer token was revoked before start"
            )
        start_result = await asyncio.to_thread(supervisor.start, destinationProjectId)
        if start_result.get("status") not in {"starting", "running"}:
            _journal_update(
                transferId,
                status="applied_pending_start",
                phase="applied_pending_start",
                message=start_result.get("lastError") or "Project did not start",
            )
            raise ConflictError(
                start_result.get("lastError") or "Project did not start"
            )
        result = dict(pending_start.get("result") or {})
        result.update(started=True, startError=None)
        _save_receipt(transferId, fingerprint, result)
        return result

    target = _target_in_root(destinationFolder)
    manifest = load_manifest()
    existing_by_id = find_project(manifest, destinationProjectId)
    source_collision = find_project(manifest, sourceProjectId)
    if collisionPolicy == "reject":
        if (
            existing_by_id is not None
            or source_collision is not None
            or target.exists()
        ):
            raise ConflictError("Destination project id or folder already exists")
    elif collisionPolicy == "copy":
        if existing_by_id is not None or target.exists():
            raise ConflictError("Copy destination project id or folder already exists")
        if destinationProjectId == sourceProjectId:
            raise ValidationError(
                "Copy-with-new-ID requires a new destinationProjectId"
            )
    else:
        if not confirmReplace:
            raise ValidationError("Replacement requires explicit admin confirmation")
        if existing_by_id is None:
            raise NotFoundError(
                f"Destination project '{destinationProjectId}' not found"
            )
        if running_entry(manifest, destinationProjectId) is not None:
            raise ConflictError(
                "Destination project must be stopped before replacement"
            )
        existing_target = Path(existing_by_id.path).expanduser().absolute()
        if existing_target != target.absolute():
            raise ValidationError(
                "Replacement folder must match the registered destination project"
            )

    with _receipt_lock:
        journal = _load_receipts()
        concurrent = journal["receipts"].get(transferId)
        if isinstance(concurrent, dict) and concurrent.get("status") == "active":
            raise ConflictError("Transfer with this id is already in progress")
        journal["receipts"][transferId] = {
            "fingerprint": fingerprint,
            "requestFingerprint": request_fingerprint,
            "archiveSha256": archive_sha256,
            "archiveSize": archive_size,
            "status": "active",
            "phase": "claimed",
            "sourceProjectId": sourceProjectId,
            "destinationProjectId": destinationProjectId,
            "destinationFolder": destinationFolder,
            "targetPath": str(target),
            "collisionPolicy": collisionPolicy,
            "startRequested": start,
            "updatedAt": iso_now(),
        }
        _write_journal(journal)

    bearer = _bearer(request)
    cancel = threading.Event()

    def unpack_into_stage(stage: Path) -> ProjectMetadata:
        file.file.seek(0)

        def progress(_done: int, _total: int) -> None:
            if cancel.is_set():
                raise RuntimeError("Transfer cancelled")

        return unpack_project(file.file, stage, progress=progress)

    def journal_update(**updates: Any) -> None:
        _journal_update(transferId, **updates)

    def journal_committed_outcome(backup: Path | None, reason: str) -> None:
        _journal_committed_outcome(
            transferId,
            fingerprint,
            sourceProjectId=sourceProjectId,
            destinationProjectId=destinationProjectId,
            target=target,
            collisionPolicy=collisionPolicy,
            backup=backup,
            start=start,
            reason=reason,
        )

    def save_receipt(result: dict[str, Any]) -> None:
        _save_receipt(transferId, fingerprint, result)

    _receive_cancellations[transferId] = cancel
    try:
        return await _stage_and_install(
            transfer_id=transferId,
            fingerprint=fingerprint,
            source_project_id=sourceProjectId,
            destination_project_id=destinationProjectId,
            collision_policy=collisionPolicy,
            target=target,
            unpack_into_stage=unpack_into_stage,
            start=start,
            cancel=cancel,
            bearer_still_valid=lambda: peer_tokens.verify(bearer),
            journal_update=journal_update,
            journal_committed_outcome=journal_committed_outcome,
            save_receipt=save_receipt,
        )
    finally:
        _receive_cancellations.pop(transferId, None)


@public_router.delete("/transfers/{transfer_id}")
async def cancel_incoming(request: Request, transfer_id: str) -> dict[str, Any]:
    _require_peer(request)
    entry = _load_receipts()["receipts"].get(transfer_id)
    if not isinstance(entry, dict):
        raise NotFoundError(f"Transfer '{transfer_id}' not found")
    if entry.get("status") == "recovery_required":
        raise ConflictError(
            "Transfer requires explicit administrator recovery and cannot be cancelled"
        )
    if (
        entry.get("phase")
        in {
            "committing_manifest",
            "manifest_committed",
            "starting",
            "receipt",
        }
        or entry.get("status") == "complete"
    ):
        return {"transferId": transfer_id, "cancelRequested": False, "tooLate": True}
    cancel = _receive_cancellations.get(transfer_id)
    if cancel is not None:
        cancel.set()
        _journal_update(transfer_id, cancelRequested=True)
    return {"transferId": transfer_id, "cancelRequested": cancel is not None}


@public_router.get("/transfers/{transfer_id}/status")
async def incoming_status(request: Request, transfer_id: str) -> dict[str, Any]:
    _require_peer(request)
    entry = _load_receipts()["receipts"].get(transfer_id)
    if not isinstance(entry, dict):
        raise NotFoundError(f"Transfer '{transfer_id}' not found")
    return {"transferId": transfer_id, **entry}
