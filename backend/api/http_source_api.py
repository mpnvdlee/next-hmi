"""Outbound HTTP proxy for the ``$http`` property source.

The browser cannot call a plant REST service directly — it is a cross-origin
request the service almost never allows — so the runtime hands the resolved
request here and the backend performs it. Responses are decoded as JSON when
the endpoint says so, otherwise returned as text.

Failures are reported *in the 200 body* (``ok: false``), not as HTTP errors:
an unreachable endpoint is a normal runtime state for a bound property, and the
frontend cache distinguishes it from a broken proxy call.

Scope note: the runtime is public, so this endpoint is too — but it is not a
general proxy. A request is performed only when its **origin** (scheme + host +
port) is one an ``$http`` property source somewhere in this project names. The
allowlist is derived in ``core/http_origins.py``; path, query, headers and body
stay unrestricted, because the author's template interpolates live values into
them. The set can only change by editing the project, and the project can only
be edited through the editor, which is behind the device-admin session — so the
servers this endpoint can reach are exactly the ones the device admin chose.

Redirects are therefore walked by hand, one hop at a time, with the same check
on every hop. Letting httpx follow them checks hop 0 only: a configured host
answering ``302`` — or an open redirect on one — would reach anything, including
this backend's own authenticated API. The caller's headers are dropped the
moment a hop leaves its origin for the same reason: httpx strips only
``Authorization`` and ``Cookie``, while an ``$http`` source's key usually rides
in neither (``X-Api-Key`` and friends).
"""
from __future__ import annotations

import logging
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from core.http_origins import http_origin_policy, normalize_origin
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
# Plant endpoints redirect once or twice at most — to a canonical host, to
# https. Anything longer is a loop or someone walking us somewhere, and every
# extra hop is another origin check and another round trip inside the timeout.
_MAX_REDIRECTS = 5
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})


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


def _refuse(url: str) -> HttpSourceResponse | None:
    """The refusal to return for *url*, or ``None`` when it may be requested.

    Run per hop, not once per call — see the module docstring.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return HttpSourceResponse(
            ok=False, status=0, error=f"unsupported URL scheme '{parsed.scheme or ''}'",
        )
    if not parsed.hostname:
        return HttpSourceResponse(ok=False, status=0, error="URL has no host")
    origin = normalize_origin(url)
    if origin is None:
        return HttpSourceResponse(ok=False, status=0, error="URL has no usable origin")
    if not http_origin_policy().permits(url):
        # Refusals ride in the 200 body like every other failure here (see the
        # module docstring) — the frontend renders it as the source's error.
        logger.warning("$http request to %s refused: origin %s is not configured", url, origin)
        return HttpSourceResponse(
            ok=False,
            status=0,
            error=f"origin '{origin}' is not configured by an $http source in this project",
        )
    return None


@router.post("/api/http-request", response_model=HttpSourceResponse)
async def perform_http_request(req: HttpSourceRequest) -> HttpSourceResponse:
    """Perform one outbound request on behalf of an ``$http`` property source."""
    refusal = _refuse(req.url)
    if refusal is not None:
        return refusal

    url = req.url
    method: str = req.method
    headers = req.headers or None
    content = req.body if req.method == "POST" else None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS, follow_redirects=False) as client:
            for _ in range(_MAX_REDIRECTS + 1):
                resp = await client.request(method, url, headers=headers, content=content)
                location = resp.headers.get("location")
                if resp.status_code not in _REDIRECT_STATUSES or not location:
                    break
                target = str(httpx.URL(url).join(location))
                refusal = _refuse(target)
                if refusal is not None:
                    logger.warning(
                        "$http request to %s refused at its redirect to %s", req.url, target
                    )
                    return refusal
                if normalize_origin(target) != normalize_origin(url):
                    headers = None  # the caller's key must not follow the hop
                if resp.status_code == 303 or (
                    resp.status_code in (301, 302) and method == "POST"
                ):
                    # What every client does with these: the redirect points at a
                    # result to read, not at somewhere to repost the body.
                    method, content = "GET", None
                url = target
            else:
                return HttpSourceResponse(
                    ok=False, status=0, error=f"more than {_MAX_REDIRECTS} redirects",
                )
    except (httpx.HTTPError, httpx.InvalidURL, UnicodeError) as exc:
        # InvalidURL (a hostname httpx rejects but urlsplit accepted, a garbage
        # Location) and UnicodeEncodeError (a header value httpx cannot encode as
        # ASCII) both sit outside the HTTPError tree. This endpoint is public, so
        # an escape is a 500 anyone can trigger — it belongs in the ok:false body
        # with every other failure.
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
