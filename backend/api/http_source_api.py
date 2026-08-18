"""Outbound HTTP proxy for the ``$http`` property source.

The browser cannot call a plant REST service directly — it is a cross-origin
request the service almost never allows — so the runtime hands the resolved
request here and the backend performs it. Responses are decoded as JSON when
the endpoint says so, otherwise returned as text.

Failures are reported *in the 200 body* (``ok: false``), not as HTTP errors:
an unreachable endpoint is a normal runtime state for a bound property, and the
frontend cache distinguishes it from a broken proxy call.

Scope note: this endpoint will issue a request to any http(s) URL the caller
names, so it is as reachable as the rest of the unauthenticated ``/api``
surface. Deployments that expose the HMI beyond the plant network should keep
it behind the same network controls as the rest of the API.
"""
from __future__ import annotations

import logging
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(tags=["http-source"])

logger = logging.getLogger(__name__)

# A bound property refreshes on a timer; a slow endpoint must not pile up
# requests or hold a worker, so the timeout is short and not caller-tunable.
_TIMEOUT_SECONDS = 10.0
# Property values are scalars picked out of the response — a large body is a
# misconfiguration, not a use case. Cap it so one bad URL can't exhaust memory.
_MAX_BODY_BYTES = 1_048_576


class HttpSourceRequest(BaseModel):
    url: str
    method: Literal["GET", "POST"] = "GET"
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | None = None


class HttpSourceResponse(BaseModel):
    ok: bool
    status: int
    #: Parsed JSON when the response is JSON, the raw text otherwise, ``None``
    #: on transport failure.
    body: Any = None
    error: str | None = None


@router.post("/api/http-request", response_model=HttpSourceResponse)
async def perform_http_request(req: HttpSourceRequest) -> HttpSourceResponse:
    """Perform one outbound request on behalf of an ``$http`` property source."""
    parsed = urlparse(req.url)
    if parsed.scheme not in ("http", "https"):
        return HttpSourceResponse(
            ok=False, status=0, error=f"unsupported URL scheme '{parsed.scheme or ''}'",
        )
    if not parsed.hostname:
        return HttpSourceResponse(ok=False, status=0, error="URL has no host")

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS, follow_redirects=True) as client:
            resp = await client.request(
                req.method,
                req.url,
                headers=req.headers or None,
                content=req.body if req.method == "POST" else None,
            )
    except httpx.HTTPError as exc:
        logger.debug("$http request to %s failed: %s", req.url, exc)
        return HttpSourceResponse(ok=False, status=0, error=str(exc) or type(exc).__name__)

    if len(resp.content) > _MAX_BODY_BYTES:
        return HttpSourceResponse(
            ok=False,
            status=resp.status_code,
            error=f"response exceeds {_MAX_BODY_BYTES} bytes",
        )

    if not resp.is_success:
        return HttpSourceResponse(
            ok=False, status=resp.status_code, error=f"HTTP {resp.status_code}",
        )

    return HttpSourceResponse(ok=True, status=resp.status_code, body=_decode(resp))


def _decode(resp: httpx.Response) -> Any:
    """JSON when the body parses as JSON, the raw text otherwise.

    Parsing is attempted regardless of ``content-type``: plenty of embedded
    device endpoints serve JSON as ``text/plain``, and a mislabelled body would
    otherwise arrive as an unindexable string.
    """
    try:
        return resp.json()
    except ValueError:
        return resp.text
