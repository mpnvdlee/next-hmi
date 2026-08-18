"""Manager-owned HTTPS settings (Admin → HTTPS).

Enabling HTTPS is a device-level decision — one listener serves the dashboard
and every project's HMI and editor — so it lives on the manager, behind the
device-admin session like the rest of ``/api/system``.

Rebinding a listening socket needs a fresh process, so this module exposes a
restart of its own on top of the supervisor's sentinel contract. The manager
deliberately exposes no general ``/api/system/restart``: it would SIGTERM the
supervisor on any caller's whim. The one here is admissible because it refuses
unless the stored setting and the running listener actually disagree, so it can
only ever finish a change the operator just asked for.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Literal

from core import runtime_home, tls_settings
from core.exceptions import ConflictError, NextHmiError, ValidationError
from fastapi import APIRouter, File, UploadFile
from pydantic import BaseModel

from api.system_api import shutdown_after_response, write_restart_sentinel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/system/tls", tags=["system"])

_deferred_tasks: set[asyncio.Task] = set()


class TlsBody(BaseModel):
    enabled: bool
    mode: Literal["generated", "custom"] | None = None


def _port(name: str) -> int | None:
    raw = os.environ.get(name)
    try:
        return int(raw) if raw else None
    except ValueError:
        return None


def _status() -> dict:
    status = tls_settings.status()
    served_enabled, served_fingerprint = tls_settings.served()

    # Enabling HTTPS moves the app to a second port and leaves the first one
    # redirecting, so the page cannot just swap its own scheme and stay put —
    # it would land on the redirector and fail the handshake. Only the launcher
    # splits the two; under start-dev.py both are absent, which is the signal
    # that the listener is rebound in place.
    status["httpPort"] = _port("NEXTHMI_PORT")
    status["httpsPort"] = _port("NEXTHMI_HTTPS_PORT")

    current_fingerprint = None
    if status["enabled"] and status["source"] == "managed":
        current = (
            status["customCertificate"]
            if status["mode"] == "custom"
            else status["generatedCertificate"]
        )
        current_fingerprint = (current or {}).get("fingerprint")

    # Compares against what the launcher recorded at bind time (see
    # ``tls_settings.mark_served``), not the request's scheme — which a
    # terminating proxy controls via ``X-Forwarded-Proto``, not the listener
    # this restart would rebind. A certificate swap while already enabled
    # (upload, mode switch, regenerate) also needs a restart even though the
    # protocol itself is unchanged, hence the fingerprint comparison.
    status["restartRequired"] = status["enabled"] != served_enabled or (
        status["enabled"] and current_fingerprint != served_fingerprint
    )
    return status


@router.get("")
async def get_tls_status() -> dict:
    return _status()


def _require_editable() -> None:
    if tls_settings.env_override() is not None:
        raise ConflictError(
            "HTTPS is pinned by NEXTHMI_SSL_CERTFILE / NEXTHMI_SSL_KEYFILE "
            "and cannot be changed here."
        )


@router.post("")
async def set_tls(body: TlsBody) -> dict:
    """Choose the protocol and which certificate serves it.

    Takes effect on the next start; the caller follows with ``/restart``.
    """
    _require_editable()
    target_mode = body.mode or tls_settings.mode()
    if body.enabled and target_mode == "custom" and not tls_settings.has_custom():
        raise ValidationError(
            "Upload a certificate and private key before switching to a custom certificate."
        )
    if body.enabled and target_mode == "generated":
        try:
            missing = tls_settings.describe() is None
        except tls_settings.TlsError:
            # Present but unreadable is as unusable as absent — regenerating
            # is the same self-heal either way.
            missing = True
        if missing:
            try:
                await asyncio.to_thread(tls_settings.generate_self_signed)
            except (tls_settings.TlsError, OSError) as exc:
                raise ValidationError(f"Could not generate a certificate: {exc}") from exc
    tls_settings.set_config(enabled=body.enabled, mode=target_mode)
    return _status()


@router.put("/certificate/custom")
async def upload_custom_certificate(
    certificate: UploadFile = File(...),
    privateKey: UploadFile = File(...),
) -> dict:
    """Store an operator-supplied certificate pair (PEM, unencrypted key)."""
    _require_editable()
    cert_bytes = await certificate.read(tls_settings.MAX_PEM_BYTES + 1)
    key_bytes = await privateKey.read(tls_settings.MAX_PEM_BYTES + 1)
    try:
        await asyncio.to_thread(tls_settings.install_custom, cert_bytes, key_bytes)
    except tls_settings.TlsError as exc:
        raise ValidationError(str(exc)) from exc
    except OSError as exc:
        raise ValidationError(f"Could not store the certificate: {exc}") from exc
    tls_settings.set_config(mode="custom")
    return _status()


@router.post("/certificate")
async def regenerate_certificate() -> dict:
    """Replace the self-signed certificate — for expiry, or a changed hostname."""
    _require_editable()
    try:
        await asyncio.to_thread(tls_settings.generate_self_signed)
    except (tls_settings.TlsError, OSError) as exc:
        raise ValidationError(f"Could not generate a certificate: {exc}") from exc
    return _status()


@router.post("/restart", status_code=202)
async def restart_for_tls() -> dict:
    """Restart the manager so the listener picks up the new protocol.

    Goes through the supervisor's sentinel contract rather than re-execing here:
    the graceful SIGTERM lets the manager's lifespan ``finally`` stop the running
    projects, the peer-discovery advertisement, and the proxy client before the
    socket is rebound. Running projects come back on their own — the replacement
    process resumes the persisted running set on startup.
    """
    if not _status()["restartRequired"]:
        raise ConflictError("The manager is already serving the configured protocol.")
    try:
        write_restart_sentinel("tls")
    except OSError as exc:
        raise NextHmiError("Could not write the restart marker; the protocol is unchanged.") from exc
    logger.info("tls: restarting manager to apply protocol change")
    task = asyncio.create_task(shutdown_after_response("tls"))
    _deferred_tasks.add(task)
    task.add_done_callback(_deferred_tasks.discard)
    return {
        "status": "restarting",
        "runtimeHome": str(runtime_home.runtime_home_path()),
    }
