"""Manager auth gate driven by raw HTTP bytes against a real ASGI server.

``TestClient`` cannot express the requests in here. ``httpx`` normalizes a
double-encoded path before the request leaves the client, so ``%252f``
collapses on the way out and the form that actually reaches a deployed server
is never built — a regression test written against ``TestClient`` for these
cases passes while the bypass ships. So these run uvicorn on a loopback port
and hand-write the request line.

What they pin: a percent-escape the front door leaves alone is decoded again by
the child's own server, so ``api%2fdatasources`` is one opaque segment to the
allowlist here and two real ones at the child. The gate has to judge every form
a segment decodes to, not the one it happens to be holding.

Kept out of ``test_manager_app.py`` so the one slow server fixture does not tax
the several dozen fast gate assertions there.
"""
from __future__ import annotations

import socket
import tempfile
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
import uvicorn


@dataclass(frozen=True)
class _Server:
    port: int
    session_cookie: str


def _read_response(sock: socket.socket) -> bytes:
    chunks: list[bytes] = []
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


def _raw_status(server: _Server, method: str, target: str, *, cookie: str | None = None) -> int:
    """Status code for a hand-written request line — *target* is sent verbatim."""
    lines = [
        f"{method} {target} HTTP/1.1",
        f"Host: 127.0.0.1:{server.port}",
        "Connection: close",
    ]
    if cookie is not None:
        lines.append(f"Cookie: {cookie}")
    request = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")
    with socket.create_connection(("127.0.0.1", server.port), timeout=15) as sock:
        sock.sendall(request)
        response = _read_response(sock)
    status_line = response.split(b"\r\n", 1)[0].decode("latin-1")
    parts = status_line.split(" ")
    if len(parts) < 2 or not parts[1].isdigit():
        raise AssertionError(f"no status line in response to {method} {target}: {response[:200]!r}")
    return int(parts[1])


@pytest.fixture(scope="module")
def server() -> Iterator[_Server]:
    with pytest.MonkeyPatch.context() as mp, tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / "runtime-home"
        home.mkdir(parents=True)
        from core import manager_auth, runtime_home

        mp.setattr(runtime_home, "runtime_home_path", lambda: home)
        mp.setenv("NEXTHMI_DATA_DIR", str(home))
        mp.setenv("NEXTHMI_TELEMETRY", "off")

        import manager

        manager_auth.set_password("raw-gate-secret")
        cookie = f"{manager_auth.SESSION_COOKIE}={manager_auth.issue_token()}"

        # ``lifespan="off"``: nothing here reaches a child, and the real
        # lifespan would resume instances, start mDNS discovery and mount the
        # MCP session manager for a test that only reads status lines.
        config = uvicorn.Config(
            manager.app, host="127.0.0.1", port=0, lifespan="off", log_level="error"
        )
        uv = uvicorn.Server(config)
        thread = threading.Thread(target=uv.run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 20
        while not uv.started:
            if time.monotonic() > deadline or not thread.is_alive():
                uv.should_exit = True
                raise AssertionError("uvicorn did not start")
            time.sleep(0.02)
        port = uv.servers[0].sockets[0].getsockname()[1]
        try:
            yield _Server(port=port, session_cookie=cookie)
        finally:
            uv.should_exit = True
            thread.join(timeout=20)


# Every one of these is a single path segment in ``scope["path"]`` — the server
# decoded one layer, the child will decode the next and route what comes out.
_DOUBLE_ENCODED_BYPASSES = [
    "/runtime/ghost/api%252fdatasources",
    "/runtime/ghost/api%252fdatasources%252fMachine",
    "/runtime/ghost/api%252fdatasources%252fMachine%252fvariables",
    "/runtime/ghost/api%252fsystem%252flogs",
    "/runtime/ghost/api%252fsystem%252flogs%252fdownload",
    "/runtime/ghost/api%252fprojects",
    "/runtime/ghost/api%252fassets",
    "/runtime/ghost/%256fpenapi.json",
    "/runtime/ghost/%2564ocs",
    # Upper-case escapes, and the mixed depth of a hand-built URL.
    "/runtime/ghost/api%252Fdatasources",
    "/runtime/ghost/api%25252fdatasources",
    # Backslash, for a child on a stack that folds it into a separator.
    "/runtime/ghost/api%255cdatasources",
    # Dot segments hidden one layer deeper than the plain-path check reads.
    "/runtime/ghost/api/config/pages/%252e%252e/%252e%252e/datasources",
    "/runtime/ghost/assets/%252e%252e%252fusers.json",
]


@pytest.mark.parametrize("target", _DOUBLE_ENCODED_BYPASSES)
def test_double_encoded_separator_does_not_escape_the_runtime_allowlist(
    server: _Server, target: str
) -> None:
    """401 is the gate refusing. 503 means it let the request through to the
    proxy, which is the bypass: the child would have served the route."""
    assert _raw_status(server, "GET", target) == 401


@pytest.mark.parametrize(
    "target",
    [
        # First segment decodes to ``api`` — it must be classified as the API
        # subtree and matched against the table (which holds none of these),
        # not waved through by the "plain GET outside api/" branch.
        "/runtime/ghost/%2561pi/datasources",
        "/runtime/ghost/%2561pi/system/logs",
        # And the docs denylist, one layer down.
        "/runtime/ghost/%256fpenapi.json",
        "/runtime/ghost/%2572edoc",
    ],
)
def test_api_and_docs_classification_survives_double_encoding(
    server: _Server, target: str
) -> None:
    assert _raw_status(server, "GET", target) == 401


# Every one of these reaches the gate as a first segment that is *not* the
# literal ``api`` — but is ``api`` to something downstream, or is dropped
# outright so the segment after it becomes the first one.
_UNTRIMMED_FIRST_SEGMENTS = [
    "/runtime/ghost/api%00/datasources",
    "/runtime/ghost/api./datasources",
    "/runtime/ghost/api;/datasources",
    "/runtime/ghost/api%20/datasources",
    "/runtime/ghost/api%09/datasources",
    "/runtime/ghost/;/api/datasources",
    "/runtime/ghost/openapi.json%00",
]


@pytest.mark.parametrize("target", _UNTRIMMED_FIRST_SEGMENTS)
def test_first_segment_classification_trims_and_truncates(
    server: _Server, target: str
) -> None:
    """503 is the bypass: the request was classified as a plain document GET
    outside ``api/`` and handed to the proxy. A NUL truncates the segment in a
    C string API, ``;`` starts a path parameter on a servlet-style stack, a
    trailing dot goes on Windows, and whitespace is trimmed all over — the
    decode loop's own comment justifies itself with exactly this class of
    stack variance, so classification has to see the name underneath."""
    assert _raw_status(server, "GET", target) == 401


@pytest.mark.parametrize(
    "target",
    [
        "/runtime/ghost/api/datasources",
        "/runtime/ghost/api/system/logs",
        "/runtime/ghost/openapi.json",
        "/runtime/ghost/docs",
        "/runtime/ghost/api%2fdatasources",
    ],
)
def test_plain_and_single_encoded_forms_are_the_control(server: _Server, target: str) -> None:
    """These already 401 before the fix — they are here so a regression that
    breaks the gate outright cannot hide behind the new cases passing."""
    assert _raw_status(server, "GET", target) == 401


@pytest.mark.parametrize(
    ("method", "target"),
    [
        ("GET", "/runtime/ghost/"),
        ("GET", "/runtime/ghost/pages/home"),
        ("GET", "/runtime/ghost/api/config/config"),
        # A literal per-cent sign in an asset name. Banning ``%`` outright
        # would close the bypass above and take this with it.
        ("GET", "/runtime/ghost/assets/50%25%20mix.png"),
        ("GET", "/runtime/ghost/assets/100%25.png"),
        # HEAD is a GET without the body: a conditional fetch of public
        # content must not need a session the GET beside it does not.
        ("HEAD", "/runtime/ghost/"),
        ("HEAD", "/runtime/ghost/assets/logo.png"),
        ("HEAD", "/runtime/ghost/api/config/config"),
    ],
)
def test_public_live_view_stays_public(server: _Server, method: str, target: str) -> None:
    """503 is the proxy answering for a project that is not running — the point
    is that the gate let every one of these through with no session."""
    assert _raw_status(server, method, target) == 503


def test_runtime_prefix_refuses_the_double_encoded_internal_hook(server: _Server) -> None:
    assert _raw_status(server, "GET", "/runtime/ghost/api%252finternal%252freload") == 401


@pytest.mark.parametrize(
    "target",
    [
        "/editor/ghost/api/internal/reload",
        "/editor/ghost/api%2finternal%2freload",
        "/editor/ghost/api%252finternal%252freload",
        "/editor/ghost/api%252Finternal%252Freload",
        "/runtime/ghost/api%252finternal%252freload",
    ],
)
def test_internal_hook_is_refused_through_the_proxy_even_with_a_session(
    server: _Server, target: str
) -> None:
    """The child's loopback reload hook is driven over the instance port, never
    through the browser-facing proxy. A session gets past the gate, so this
    refusal is the only thing standing between an authenticated editor tab and
    the internal API — and it has to read the form the child will route."""
    assert _raw_status(server, "GET", target, cookie=server.session_cookie) == 404
