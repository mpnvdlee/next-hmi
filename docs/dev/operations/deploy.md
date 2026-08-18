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
- **Serve over HTTPS the moment it leaves loopback.** On plain HTTP the
  device-admin password, operator passwords, and every project edit cross the
  wire in the clear. See [HTTPS](../../user/install.md#https).
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

## MCP

MCP is a single **workspace** endpoint hosted by the manager at the origin
`/mcp` (child instances no longer serve it). One AI client connects there and
addresses any project by id; see [../reference/mcp.md](../reference/mcp.md) for the tool catalog.

Two independent controls:

1. **Transport** — `/mcp` is behind the manager front door. Browsers use the
   manager session cookie; headless AI clients send a **bearer token**
   (`Authorization: Bearer <token>`), paired at `POST /api/manager/mcp/pair`
   by presenting the device-admin password, and revoked at
   `DELETE /api/manager/mcp-tokens/{id}`. The plaintext is returned once; only
   its digest is stored. **A token is scoped to one project and to `read` or
   `write`** — a session cookie spans the workspace, a token never does. This
   is the narrower credential to hand an external agent.
2. **Per-project authorization** — each project has an `mcpEnabled` flag (off
   by default), toggled from the manager dashboard's projects list. Reads are
   always allowed; **writes are refused** for a project with the flag off. The
   flag persists in that project's `config.json` and works whether or not the
   project is running.

Editing is file-based, so a stopped project is still editable; when a project
*is* running, the manager notifies its child over a loopback reload hook so
open browsers and the OPC-UA pipeline update.

Adding OAuth 2.1 (the spec-canonical auth for MCP HTTP transports) is a
follow-up item.

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
