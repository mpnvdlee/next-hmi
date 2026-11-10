# Deployment reference

Operator-facing installation — Docker, portable binaries, HTTPS setup, the
on-disk layout, and managing projects — lives in the user guide:
[Installing and running NEXT HMI](../../user/install.md).

This page keeps the parts a maintainer or network owner needs: where the
product may safely sit, the MCP surface, and the edition seam.

## Network placement and threat model

Read this before exposing NEXT HMI on any network.

NEXT HMI is an operator-technology (OT) tool. A running project **writes** to
PLCs over OPC-UA, and editor access runs authored code (see [Custom
widgets](../reference/custom-widgets.md#security-editor-access-is-code-execution)).
Its security model assumes it sits on a **trusted OT/plant network**.

- **Keep it on the OT network, behind a VPN. Never expose the manager or a
  project instance directly to the public Internet.** Anyone who reaches the
  device-admin surface can, once past the password, drive the connected PLCs.
  Perimeter isolation is the primary control; the application's own passwords
  are the second layer, not the first.
- **Serve over HTTPS.** The manager binds every interface by default, and on
  plain HTTP the device-admin password, project users' passwords, and every
  project edit cross the wire in the clear. See
  [HTTPS](../../user/install.md#https); `NEXTHMI_HOST=127.0.0.1` is the other
  way out, for an install that is only ever reached through a proxy.
- **Reach it through a reverse proxy or VPN, not by widening the app.** If the
  UI must be reachable from another origin, put a reverse proxy in front that
  serves the app on a single origin — do not reconfigure the backend for
  cross-origin access (see below).

### Same-origin by design (no CORS)

The backend ships **no CORS middleware** and is same-origin only: the SPA, the
REST API, and the WebSocket are all served from the manager's own origin. This
is deliberate — an HMI that writes to PLCs should not accept authenticated
cross-origin requests from arbitrary sites.

Do **not** reach for `CORSMiddleware(allow_origins=["*"])` to put the frontend
on a separate host. That would let any web page a logged-in operator visits
drive the API with their session. If a different origin genuinely needs the UI,
front it with a reverse proxy (Caddy/nginx/Traefik) that presents everything on
one origin — the same proxy you would use for TLS termination (see [Behind a
terminating proxy](../../user/install.md#behind-a-terminating-proxy)).

### No framing by other sites

Every HTML document — the dashboard, the editor, a project's screens, `/help`,
and an HTML file one of the static mounts serves — carries
`Content-Security-Policy: frame-ancestors 'self'` plus each site listed under
**Settings › Sites that may embed NEXT HMI**, and `X-Frame-Options: SAMEORIGIN`
while that list is empty, since that header cannot name another site
(`core/security_headers.py`). Without it any web page could frame
`/runtime/<slug>/`: the framed document is the device's own origin, so its
socket passes the origin check above, and a click the page disguises writes a
setpoint. Same-origin frames — the editor's live preview, thumbnail capture, a
WebFrame widget pointing at the device itself — are unaffected.

The manager and every project instance both set the policy, from the list in
the runtime home they share (`<runtime_home>/.embedding.json`,
`core/embed_settings.py`). The manager adds it only to a document that does not
carry it yet, so a proxied document carries it exactly once, and an instance
opened on its own loopback port is covered as well. A change applies from the
next page load: each process keeps the parsed list until the file's inode,
mtime or size changes. An entry is a bare origin, `scheme://host[:port]` with
no path and no wildcard and a host of at most 253 characters; anything else is
refused, which also keeps an entry from smuggling another directive into the
header. The list holds at most 32 sites (`MAX_ORIGINS`), past which a save is
refused and a hand-edited file is cut: every HTML document carries it, and a
header past the browser's limit would fail every page, Settings included. Under `start-dev.py` Vite serves
the documents itself, so dev documents carry no framing policy.

There is no `script-src` or `default-src` policy yet. Every `index.html` gets an
inline globals script injected by the backend (`services/frontend_serve.py`),
which would need a per-response nonce, and external libraries loaded from a CDN
and the WebFrame widget's URLs would each need their sources listed.

### Project files served on the origin

The project's `assets/`, `custom-widgets/` and `external-libraries/` folders and
the compiled custom widgets are served on the device's origin (`main.py`, the
static mounts), and every file there carries `X-Content-Type-Options: nosniff`.
`/assets` and `/widgets` also carry `Content-Security-Policy: sandbox`: an HTML
or SVG file placed there and opened directly renders without script and
without the device's origin, so it cannot act with the device-admin session.
The policy binds only a document made from the response, so the app's own
`<img>`, CSS mask, `<video>` and `fetch` of the same file are unaffected.
`/widget-js` and `/external-libraries` are code by design, run as module
scripts, so they get no sandbox; `.js` and `.mjs` there are always served as
`text/javascript`, whatever the platform's MIME table says (see [Custom
widgets](../reference/custom-widgets.md#security-editor-access-is-code-execution)).

## MCP

MCP is a single **workspace** endpoint hosted by the manager at the origin
`/mcp` — child instances serve none. One AI client connects there and
addresses any project by id; see [../reference/mcp.md](../reference/mcp.md) for the tool catalog.

Two independent controls:

1. **Transport** — `/mcp` is behind the manager front door. Browsers use the
   manager session cookie; headless AI clients send a **bearer token**
   (`Authorization: Bearer <token>`), created under **Settings › Tokens**
   on the manager (`POST /api/manager/mcp-tokens` with the session) or, from a
   script, at `POST /api/manager/mcp/pair` by presenting the device-admin
   password, and revoked at `DELETE /api/manager/mcp-tokens/{id}`. The
   plaintext is returned once; only its digest is stored. **A token is scoped to `read` or `write`**
   and covers every project. It is the narrower credential to hand an external agent: a read token cannot write,
   and it is revocable without changing the password.
2. **Per-project authorization** — each project has an `mcpEnabled` flag (off
   by default), toggled from the manager dashboard's projects list as
   **MCP write enabled**. Reads are
   always allowed; **writes are refused** for a project with the flag off. The
   flag persists in that project's `config.json` and works whether or not the
   project is running.

Editing is file-based, so a stopped project is still editable; when a project
*is* running, the manager notifies its child over a loopback reload hook so
open browsers and the OPC-UA pipeline update.

## Features and editions

Every feature in this build ships unconditionally. Historian
(`/api/historian`), Alarms (`/api/alarms`), and Recipes (`/api/recipes`) mount
on every install — there is no feature gate, no license check, and no
`GET /api/system/features` endpoint.

A separate `ee` build, produced from a private repository, adds licensed
enterprise modules on top of this same core. Licensing and activation are
documented with that build, not here — see [backend.md](../architecture/backend.md#edition-seam)
for the seam this build exposes.

### Exports and features

Project exports (zip / push / pull) include the Historian `config.json`
under `<project>/historian/` so the receiver can resume logging with
the same per-variable settings. They **strip** installation-local
database files (`*.db`, `*.db-wal`, `*.db-shm`, `*.sqlite`,
`*.sqlite-journal`) so trend history doesn't travel between sites.
