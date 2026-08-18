# Installing and running NEXT HMI

NEXT HMI ships in two distributable forms:

1. **Docker image** — single container; runtime home (and any projects
   under it) mounted as a volume.
2. **Portable Mac/Windows binary** — unzip + double-click. No installer,
   no admin rights, no Python or Node toolchain on the host.

Both formats run the same backend over the same on-disk layout. Move a
project from one runtime to another with a zip export/import, a LAN push,
or by copying its folder and pointing the destination runtime at it.

> [!IMPORTANT]
> Before putting NEXT HMI on any network, read [Network placement and threat
> model](../dev/operations/deploy.md#network-placement-and-threat-model). A
> running project writes to PLCs, and editor access runs authored code.

## On-disk model

There are two distinct kinds of state:

- **Runtime home** — per-installation bookkeeping (manifest, logs, widget
  build cache). One per runtime.
- **Project folder** — self-contained per-project state (page tree,
  datasources, widgets, assets, custom components, …). The operator can
  keep as many as they want, anywhere on disk, and run several at once —
  each running project is a separate backend instance behind the manager.

The process you launch is the **manager** (front door, default port
`8000`). It serves a password-gated dashboard, starts one child backend
per *running* project, and reverse-proxies each project to a browser
under `/runtime/<slug>/` or `/editor/<slug>/`. The dashboard is at the
origin root; an individual project's HMI is at
`http://<host>:8000/runtime/<slug>/` and its editor at
`http://<host>:8000/editor/<slug>/`.

### Runtime home

```
<runtime_home>/
  projects.json           manifest: running[], projects[], peers[], defaultProjectId, defaultProjectsRoot
  .manager-auth.json      device-admin password digest + session secret
  .logs/                  rotating application logs
  .widget-build/          compiled custom-widget JS (regenerated)
  .restart-pending        sentinel for /api/system/restart
  .peer-tokens.json       hashed manager peer tokens (no bearer plaintext)
  .mcp-tokens.json        hashed MCP bearer tokens, each scoped to one project
  .peer-trust.json        pinned peer TLS certificates (trust on first use)
  .install-id.json        random installation ID used by usage reporting
  .telemetry.json         usage-reporting on/off (absent means on)
  tls/                    HTTPS setting + generated and uploaded certificates
  .peer-transfer-sender.json    outgoing push transfer phases/progress (no bearer plaintext)
  .peer-transfer-receipts.json  incoming push claims, recovery phases, and receipts
  .peer-transfer-pull.json      outgoing pull phases and receipts
```

Resolution order (highest precedence first):

1. `NEXTHMI_DATA_DIR` env var — used by Docker and any explicit override.
2. Bootstrap config file:
   - macOS / Linux: `~/.config/nexthmi/runtime.json`
   - Windows: `%APPDATA%\NextHMI\runtime.json`
3. Dev fallback — `<repo>/.dev-runtime-home/`, used only when running from a
   source checkout with neither of the above set, so dev state stays inside
   the repo tree.
4. Platform default — `~/Documents/NextHMI/` (or
   `%USERPROFILE%\Documents\NextHMI\` on Windows).

The bootstrap config file is written on first run when nothing was found,
so subsequent launches are explicit about which path is active. Because it
outranks the dev fallback, a machine where a binary has ever started uses
that path from a source checkout too — read the startup banner's
`Runtime home` line rather than assuming `.dev-runtime-home/`.

The runtime home path is read-only from the UI — to move it, edit the env
var or the bootstrap file and restart. `defaultProjectsRoot` (where new,
imported and pulled projects land by default) is seeded to
`<runtime_home>/Projects` on first run and is likewise not editable from the
UI; every dialog that creates a project lets you type or browse to a
different folder, and a permanent change means editing `projects.json` while
the manager is stopped.

### Project folder

```
<project>/
  config.json             page tree + project metadata + global settings (incl. mcpEnabled)
  pages/                  one JSON per page
  datasources/            one JSON per datasource
  components/             reusable composite components
  translations/           semicolon-separated CSVs, one per group
  themes/                 one JSON per theme (colors / typography / spacing)
  alarms.json             alarm definitions
  alarm_state.json        runtime alarm state (shipped with push/pull)
  recipes.json            recipe definitions and datasets
  recipe_state.json       loaded dataset per recipe type
  users.json              users + groups + access settings
  custom-widgets/         user-authored TSX widgets (compiled on save)
  external-libraries/     JS modules exposed via the import map
  assets/
    icons/                SVGs available to icon fields
    images/               images available to image fields
  certs/                  per-project OPC-UA client certs
  historian/              historian config + installation-local database
```

The backend creates any missing folders on startup. Everything in this
tree is treated as user state — schema migrations are handled in code,
but project folders are never overwritten by an upgrade.

## Managing projects

The **manager dashboard** (the origin root, behind the device-admin
password) is the operator surface:

- **First-run setup** — on first launch the dashboard asks you to set a
  device-admin password. It is stored hashed in
  `<runtime_home>/.manager-auth.json` and gates every subsequent visit.
- **Fresh-project operator setup** — every project copied from the bundled seed
  is marked **Set operator password**. An authenticated device manager must
  choose the password for that project's `admin` HMI account before the manager
  opens its runtime or editor. This project credential is separate from the
  device-admin password; the seed contains no reusable operator password.
- **Start / Stop** — bring a project up or down. A running project gets
  its own backend instance and becomes reachable at `/runtime/<slug>/`
  (and `/editor/<slug>/`); the set of running projects is remembered and
  auto-resumed after a restart.
  This replaces the old single "make live" switch — multiple projects run
  side by side with no global downtime.
- **+ New project** — create at an absolute path, seeded from the bundled
  template.
- **⊕ Add existing** — register a project folder that is already on disk (a
  Git clone, a folder copied off another machine).
- **↑ Import zip** — upload a zip exported elsewhere into a new folder.
- **⇩ Pull from peer** — fetch a project from another manager on the LAN.
- **Transfer** — send that explicit source project to another manager. Pair
  once with the destination's existing device-admin password; subsequent
  transfers use a revocable peer token. The destination path is always a
  folder directly below its configured projects root. Collisions reject by
  default; an administrator may instead copy with a new ID or replace a
  stopped project with backup/rollback. Starting the received project is an
  explicit opt-in.
- **Export** — download the project as `<name>.nexthmi.zip`.
- **Set as default** — mark the project the origin root redirects to, and keep
  it running.
- **MCP enabled / disabled** — per-project switch for whether the workspace
  MCP endpoint may *write* to this project. See [AI agents over
  MCP](mcp.md).
- **Locate…** — re-point a manifest entry whose folder has been moved. Shown
  only on a **missing** row, which is the only state where it applies. The
  destination must carry the same project id, so it can re-point the entry but
  never adopt a different project.
- **Remove** — drop the manifest entry (optionally delete the folder too).
  A project that is running must be stopped first.

Manager transfer defaults to plain HTTP and is intended only for a trusted LAN:
the bearer token prevents unauthenticated mutation but does not stop a network
observer from intercepting the pairing password, token, or project data. Serve
the peer over HTTPS to close that (see [Peer transfer over
HTTPS](#peer-transfer-over-https)), keep peers on a private network either way,
and do not expose the peer endpoints to the public Internet. Changing the
device-admin password revokes every paired peer token. Outgoing connections
resolve once and are pinned to a private unicast address; public, mixed,
link-local, multicast, and unspecified results are rejected. Loopback peers
require the explicit `NEXTHMI_ALLOW_LOOPBACK_PEERS=1` deployment override.

## Usage reporting

The runtime reports that it started to `https://next-hmi.com/ping` — once at
start-up, then once every 24 hours while it keeps running. It is the only
outgoing connection NEXT HMI makes on its own, and it exists to answer one
question: how many installations are active.

Each report carries exactly:

| Field | Example | Where it comes from |
| --- | --- | --- |
| `installId` | `f1c74a5c…` | random ID generated on first run, kept in `<runtime_home>/.install-id.json` |
| `version` | `1.4.0` | the build |
| `edition` | `oss` / `ee` | the build |
| `os` / `osRelease` | `Darwin` / `25.6.0` | the host platform |
| `python` | `3.14.6` | the bundled interpreter |
| `event` | `start` / `heartbeat` | which of the two moments this is |

Nothing else is sent: no project names, variables, addresses, tag values, user
names, or licence data. The receiving end stores no IP address. The
installation ID is a random number tied to the runtime home, not to the
machine — copy the runtime home and both copies report as the same
installation; delete `.install-id.json` and the next start counts as a new one.

A report is best-effort. On a plant network with no route to the Internet it
fails silently and the app carries on; nothing waits on it, nothing is queued,
and no error is shown.

To turn it off, either:

- **Settings → Usage reporting** in the manager dashboard (takes effect
  immediately, no restart), or
- set `NEXTHMI_TELEMETRY=off` in the environment — this wins over the setting
  and makes the switch read-only, which is the form to use in Docker or a
  managed deployment. `NEXTHMI_TELEMETRY=on` forces the opposite the same way.

## HTTPS

The manager serves plain HTTP by default, which is fine while it stays on
loopback. The moment `NEXTHMI_HOST=0.0.0.0` puts the dashboard on a network,
the device-admin password, the operator password, and every project edit
cross the wire in the clear.

Only the manager terminates TLS. Project children are spawned on loopback and
reached over plain HTTP by the in-process proxy, so nothing else needs
configuring; the SPA already switches its WebSocket to `wss://` whenever the
page itself was loaded over `https://`. One certificate therefore covers the
dashboard, every project's HMI, and every project's editor.

### Ports

Enabling HTTPS moves the app to a second port and leaves the first one
redirecting, so links made before the switch keep working:

| Setting | `8000` (`NEXTHMI_PORT`) | `8443` (`NEXTHMI_HTTPS_PORT`) |
| --- | --- | --- |
| HTTPS off (default) | the app, over HTTP | not bound |
| HTTPS on | `307` to the HTTPS port, path and query intact | the app, over TLS |

The redirect is deliberately temporary, not a `301`: browsers cache a permanent
redirect hard enough that turning HTTPS back off would strand the operator on a
port nothing listens on. Turning it off unbinds `8443` rather than redirecting
downward — a redirect from HTTPS to HTTP is what an attacker wants, and it
would need a certificate warning to deliver.

WebSocket handshakes cannot follow a redirect, so the HTTP port closes them.
Nothing in the SPA reaches that path: its document is redirected first, and it
derives `ws:`/`wss:` from the origin it was actually loaded from.

An MCP client is the one caller that has to be re-pointed by hand: most do not
follow redirects, so a connector configured against `:8000/mcp` stops working
the moment HTTPS goes on. See [AI agents over MCP](mcp.md).

Both ports are published by `docker-compose.yml`. Override either with
`NEXTHMI_PORT` / `NEXTHMI_HTTPS_PORT`, or `--port` / `--https-port`.

This split applies only to HTTPS turned on in **Settings → HTTPS**. A
deployment that pins its certificate through `NEXTHMI_SSL_CERTFILE` /
`NEXTHMI_SSL_KEYFILE` keeps serving TLS on `NEXTHMI_PORT` and binds nothing
else: it has been HTTPS since its first boot, so there is no earlier
plain-HTTP link to preserve and no toggle that could strand a page — and
moving it would break the port mapping the operator already published.

### From the manager UI

**Settings → HTTPS** is the normal route and needs no shell access:

1. Pick **HTTPS** on the protocol switch.
2. Under **Certificate**, keep *Generated for this device* — the manager
   creates a self-signed certificate covering `localhost`, this host's name,
   and its addresses — or choose *My own certificate* and upload a PEM
   certificate and unencrypted PEM private key. Mismatched or passphrase-
   protected keys are rejected at upload, not at the next startup.
3. The manager stops running projects, restarts, and the page reopens itself
   on the new protocol — on port 8443, see [Ports](#ports) above. Projects
   resume on their own.

Both certificates are kept side by side under `<runtime_home>/tls/`, so
switching between generated and uploaded needs no re-upload. The private keys
are written `0600`.

A generated certificate is not signed by any authority, so browsers warn once
per machine until someone accepts it. That warning is the cost of not needing a
CA; the connection is encrypted either way, which a plain-HTTP one is not.

Upload your own key only over an HTTPS page — the UI warns when the page is on
HTTP, since the key would otherwise cross the network in the clear. Turn on
HTTPS with the generated certificate first, then upload over that.

### Built-in TLS from the environment

`NEXTHMI_SSL_*` overrides the UI setting entirely, and the HTTPS section then
reports itself read-only. Use it for Docker, or wherever configuration is owned
by the deployment rather than the operator. Both variables are required
together, and both files must exist at startup or the launcher refuses to
bind:

| Variable | Purpose |
| --- | --- |
| `NEXTHMI_SSL_CERTFILE` | PEM certificate chain (leaf first). |
| `NEXTHMI_SSL_KEYFILE` | PEM private key. |
| `NEXTHMI_SSL_KEYFILE_PASSWORD` | Passphrase, only if the key is encrypted. |

```bash
export NEXTHMI_SSL_CERTFILE=/etc/nexthmi/tls/fullchain.pem
export NEXTHMI_SSL_KEYFILE=/etc/nexthmi/tls/privkey.pem
export NEXTHMI_HOST=0.0.0.0
./nexthmi
```

The banner then prints an `https://` URL. In Docker, bind-mount the cert
directory read-only and set the same variables.

Certificate renewal is not automated in either route — the process reads its
certificate once at startup, so restart the manager after a renewal (for an
uploaded certificate, re-upload it and pick the protocol again).

### Behind a terminating proxy

Caddy, nginx, or Traefik in front of a loopback-bound manager is the better
option where one already exists: it handles renewal, and the manager keeps
its default `127.0.0.1` binding. Leave `NEXTHMI_SSL_*` unset and have the
proxy send `X-Forwarded-Proto`. A proxy on the same host is trusted out of
the box; one on another host needs its address allow-listed:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXTHMI_FORWARDED_ALLOW_IPS` | `127.0.0.1` | Comma-separated proxy addresses whose `X-Forwarded-*` headers are trusted. |

Set this to the proxy's address, never `*` on an untrusted network — any
client that can reach the manager directly could then dictate the scheme and
client IP the backend believes it is seeing.

### Peer transfer over HTTPS

Manager-to-manager transfer speaks whichever protocol the peer is configured
with — pick **HTTPS** in the transfer dialog, or store it on a manual peer
entry. A runtime serving TLS advertises `scheme=https` in its mDNS record, so
picking a discovered peer fills the protocol in for you.

Peer certificates are trusted on first use rather than through a CA, because a
plant LAN rarely has one:

1. On the first HTTPS contact with a `host:port`, the manager records that
   peer's certificate (SHA-256 digest and PEM) in
   `<runtime_home>/.peer-trust.json`.
2. Every later connection to that peer must present the same certificate. It
   is the sole trust anchor, so a mismatch aborts the TLS handshake before the
   bearer token or any project bytes reach the socket.
3. Pairing returns the pinned fingerprint. Compare it once against the peer's
   own certificate to close the first-contact gap, which is the one thing
   trust-on-first-use cannot verify for you.

A peer that has ever been reached over HTTPS is never contacted over plain HTTP
again, even if it later advertises otherwise — mDNS records are unauthenticated
and would otherwise be a downgrade path.

Renewing a peer's certificate breaks transfers to it on purpose: a certificate
that changed without warning looks exactly like an interception. Confirm the
new certificate is genuine, then drop the pin — **Forget pinned certificate**
in the transfer dialog, or:

```bash
curl -X DELETE "https://<manager>/api/manager/peers/trust?host=<peer>&port=8000"
```

`GET /api/manager/peers/trust` lists the current pins and their fingerprints.

Peer discovery itself (mDNS) is unauthenticated regardless of protocol — it
advertises which runtimes exist, nothing more. Transfers to a discovered peer
still require the device-admin password once and a bearer token thereafter.

### What TLS covers

The manager session cookie is marked `Secure` automatically on requests that
arrive over HTTPS (directly or via a trusted proxy), and stays unmarked on
plain HTTP so local installs keep working.

## Docker

### Quick start

```bash
# from a clone of the repo
docker build -t nexthmi .
docker run --rm -p 8000:8000 -v "$PWD/project-data:/data" nexthmi
```

Open <http://localhost:8000> and set the device-admin password when the
manager dashboard prompts. On first boot the bundled seed project is
registered but remains stopped. Choose **Set operator password** on that project,
then start and open its HMI or editor. If the browser or container stops before
that save succeeds, setup remains incomplete and is offered again after restart;
the password is not partially installed.

Using compose:

```bash
docker compose up -d
```

`docker-compose.yml` at the repo root binds `./project-data` to `/data`.
That bind-mount carries both the runtime home (`projects.json`, `.logs/`,
`.widget-build/`) AND any project folders the operator places under it.
Projects with absolute paths outside `/data` need their own bind-mounts.

Discovery note: mDNS requires host networking. Without it (default bridge
mode) the runtime won't appear on peer pickers — operators can still use
manual `host:port` entries.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXTHMI_DATA_DIR` | `/data` (in image) | Runtime home. Pins the path; the Admin UI shows it read-only when this is set. |
| `NEXTHMI_FRONTEND_DIST` | `/app/frontend/dist` | Compiled SPA. Triggers the templated `index.html` route. |
| `NEXTHMI_WIDGET_BUILD_DIR` | `<runtime_home>/.widget-build` | Compiled custom-widget output. |
| `NEXTHMI_VALIDATION_SWEEP` | `on` | Set to `off` to skip the startup page-validation sweep. |
| `NEXTHMI_TELEMETRY` | `on` | Set to `off` to stop the install-count ping and make the Settings switch read-only. See [Usage reporting](#usage-reporting). |
| `NEXTHMI_SSL_CERTFILE` / `NEXTHMI_SSL_KEYFILE` | unset | Serve HTTPS from the manager itself, overriding Settings → HTTPS. See [HTTPS](#https). |
| `NEXTHMI_FORWARDED_ALLOW_IPS` | `127.0.0.1` | Proxy addresses whose `X-Forwarded-*` headers are trusted. |
| `NEXTHMI_MAX_PROJECT_ZIP_MB` | `500` | Cap for zip uploads (export / import / push / pull). Oversize archives are rejected before any bytes hit disk. |
| `WATCHFILES_FORCE_POLLING` | `1` (in image) | Required when a project folder is a bind-mount; native inotify doesn't see host edits. |
| `ESBUILD_BINARY_PATH` | `/usr/local/bin/esbuild` | Path to the esbuild executable used to compile custom widgets. |

### Upgrading

```bash
docker pull nexthmi:latest         # or rebuild from source
docker compose up -d               # picks up the new image
```

The data volume is untouched. The backend checks each project's stamped
format version on activation and refuses to open one written by a newer
build.

### Re-seeding

If you delete `./project-data/` (or point the volume at a fresh
directory), the manager reseeds from the image's bundled seed project on
the next start and registers it. A fresh device-admin password
and a separate operator password for the seeded project are required again.
Existing volumes retain their current project credentials unchanged.

## Mac / Windows portable binaries

### Installing

1. Download `nexthmi-<os>-<arch>-<version>.zip` from the release.
2. Unzip anywhere you have write access (Downloads, Desktop, anywhere
   under your home directory).
3. Launch:
   - macOS: double-click `nexthmi.command`.
   - Windows: double-click `nexthmi.exe`.

A terminal window opens, prints the banner, and stays in the foreground:

The banner shows the version, runtime-home path, browser URL, and log path.

Open the printed URL in any browser. Portable installs bind to loopback by
default; set `NEXTHMI_HOST=0.0.0.0` explicitly when LAN access is intended.

On the first launch, set the device-admin password, then choose **Set operator
password** on the seeded project. The latter creates that project's `admin` HMI
account and unlocks its runtime and editor routes. Closing the manager before
completion leaves the project pending for the next launch. Projects from an
older install have no pending marker, so upgrades preserve their existing
users and passwords byte-for-byte.

To stop: focus the terminal window and press Ctrl-C — uvicorn's
lifespan shutdown runs and the OPC-UA pool closes cleanly.

### Documentation

The zip carries the full documentation as a self-contained HTML site in
`docs/` beside the executable — open `docs/index.html` directly, or use the
**Help** button in the editor header, which the manager answers at `/help`.
Builds without a bundled copy (Docker, a source checkout) redirect `/help` to
the public documentation page instead.

### First-run gatekeeper prompts

These are unsigned binaries. The OS will ask you to confirm before it
runs them once.

**macOS** — Gatekeeper shows *"nexthmi cannot be opened because the
developer cannot be verified."* Clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine /path/to/nexthmi-macos-arm64/
```

Then re-launch `nexthmi.command`. (Alternative: right-click the file →
*Open* → confirm. You have to do that for `nexthmi.command` and the
`nexthmi` executable next to it.)

**Windows** — SmartScreen shows *"Windows protected your PC."* Click
*"More info"* → *"Run anyway."*

We skip code signing until distribution demand justifies the Apple
Developer Program + Authenticode cost.

### Changing the runtime home

The runtime home path is read-only from the UI. To move it:

1. Stop the backend.
2. Edit the bootstrap config file (`~/.config/nexthmi/runtime.json` on
   macOS / Linux, `%APPDATA%\NextHMI\runtime.json` on Windows). Set
   `dataDir` to the new path, or delete the file to fall back to the
   platform default (`~/Documents/NextHMI/`).
3. Optionally export `NEXTHMI_DATA_DIR` to pin it without touching the
   file — the env var wins over the bootstrap file.
4. Move the manifest (`projects.json`) and `.logs/` / `.widget-build/`
   into the new location if you want history preserved. Project folders
   referenced by absolute paths in the manifest don't need to move.
5. Relaunch.

The bootstrap file is rewritten on first launch when nothing was found,
so it's always present after the platform default kicks in.

### Changing the default projects root

`defaultProjectsRoot` in `projects.json` governs where new / imported /
pulled projects land by default. It is written once, at first run, as
`<runtime_home>/Projects`, and neither it nor the runtime home is editable
from the UI — **Settings → Runtime home** displays the runtime home path
read-only. Every create / import / pull dialog lets you type or browse to a
different destination, so a one-off elsewhere needs no configuration. To
change the default permanently, stop the manager, edit
`defaultProjectsRoot` in `<runtime_home>/projects.json`, and relaunch.

### Upgrading a binary install

1. Download the new zip.
2. Replace the files inside the existing folder (or unzip into a new
   folder and delete the old one):
   - `nexthmi` (executable)
   - `nexthmi.command` (macOS launcher)
   - `_internal/` (PyInstaller runtime + bundled assets)
   - `version.txt`
3. Re-launch.

The bootstrap config file is outside the binary folder, so it survives
the upgrade. The runtime home (and every project tracked in its manifest)
lives wherever the bootstrap file points.

### Limitations

- macOS x64 builds are not currently produced. The MVP ships
  `nexthmi-macos-arm64-<version>.zip` only.
- No auto-update. Operators check the release page for new versions.
- No process-level service install — the binary runs in the foreground
  of whichever terminal launched it. If you want it persistent, wrap it
  in `launchd` (macOS) or *Task Scheduler* (Windows) yourself.

