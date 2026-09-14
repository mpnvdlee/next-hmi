# Changelog

All notable changes to NEXT HMI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project is pre-1.0, minor versions may include breaking changes; these
are always called out under a **Changed** or **Removed** heading.

## [Unreleased]

### Added

- **The manager dashboard now says when it is serving without HTTPS.** Binding
  every interface by default made plain HTTP a network exposure rather than a
  local one, and the switch that fixes it sat in Settings with nothing pointing
  at it. A notice now stands above the project list, on the settings page, and
  on the sign-in screen — the one that matters most, since the device-admin
  password typed into it is part of what crosses the wire in the clear. The
  browser decides when it appears: a page served over HTTPS, or reached at
  `localhost` / `127.0.0.1`, is a secure context and sees nothing; the same
  install opened at `http://192.168.1.10:8000` is not, and gets the notice with
  a link to **Settings → HTTPS**. It states the exposure instead of acting on
  it — the same setup is routine on a sealed machine network and wrong on an
  office LAN, and only the operator knows which one this is — and it cannot be
  dismissed, because nothing has changed until HTTPS is on. The operator
  runtime and the editor do not carry it; someone at a wall panel cannot act on
  it. See [HTTPS](docs/user/install.md#https).

### Removed

- **The per-project operator password prompt.** A project copied from the
  bundled seed used to show **Set operator password** instead of Start, and
  refused its runtime and editor until a device admin had minted that project's
  `admin` account. The device-admin password already gates every `/runtime/` and
  `/editor/` route, so the second credential locked a door that was locked, once
  per project created. A new project now carries only the anonymous `guest` user
  and opens as soon as it starts; add real accounts from the editor's **Users**
  area when you want them. No template has ever shipped a usable credential, and
  none does now.

- **The "Config access — allowed groups" setting.** Users → Settings carried a
  group picker documented as deciding who may open the editor. Nothing ever
  read it: the editor has always been gated by the device-admin password alone,
  so the setting promised a fence that did not exist — and the troubleshooting
  guide sent you to it when the editor would not open. A project in the field
  that still carries the key keeps opening; the key is ignored, and dropped the
  next time users are saved.

### Changed

- **NEXT HMI is reachable on the network by default.** The manager used to bind
  `127.0.0.1` and answer nobody but the machine it ran on, so a panel PC that
  pinged fine was still a refused connection from every other machine until
  someone found `NEXTHMI_HOST=0.0.0.0` — a variable with no UI and no flag
  behind it. It now binds every interface, which is what the Docker image has
  always done, and the startup banner prints the machine's name and its address
  on the network instead of a loopback URL that only worked where you were
  already standing. The dev server (`start-dev.py`) binds the same way.

  **This changes an existing install on upgrade.** A deployment that relied on
  the old default was unreachable from the network and is now reachable from it.
  On an install that already has a device-admin password, nothing about who may
  do what changed — that password gates the dashboard and every editor exactly
  as before, `/mcp` still demands a session cookie or a bearer token, and a
  running project's live screens were already open to anyone who could reach
  the host. What changes is who can reach the host, and what that costs on
  plain HTTP: the device-admin password, every operator sign-in and every MCP
  token now cross the wire in the clear where they previously never left the
  machine. Turn on [HTTPS](docs/user/install.md#https) if the network is not
  one you trust, or set `NEXTHMI_HOST=127.0.0.1` to keep the old behaviour.

  A **first boot with no password set yet** is the one case where reach and
  authority are the same thing: the first-run page has nothing to authenticate
  against and accepts whoever arrives first, and the manager advertises itself
  over mDNS while it waits. Claim a fresh install right after starting it, or
  start it with `NEXTHMI_HOST=127.0.0.1` until the password is in place.

- **A running project's live screens need no password.** `/runtime/<slug>/` is
  now reachable without the device-admin session — an operator walks up to the
  panel and works, which is what an HMI is for. The editor
  (`/editor/<slug>/`), the dashboard and every manager API stay behind that
  password, and it remains the only gate: there is no second credential.
  Under `/runtime/` the manager serves a deny-by-default allowlist of exactly
  what a live screen needs; every write verb, `api/datasources`,
  `api/system/*`, `api/projects/*` and the instance's `openapi.json` still
  require the session. Operating is open too — restrict a tag with
  `interactableByGroups` on the variable if it should not be.
- **`$http` may only reach servers the project itself configures.** The
  outbound proxy behind an `$http` property source used to perform any http(s)
  URL a caller named. It now refuses any origin that no `$http` source in the
  project names, and re-runs that check on every redirect hop (capped at five,
  caller headers dropped cross-origin). The allowlist can only be widened by
  editing the project, so the device-admin password is what decides which
  servers are reachable. Configure `http://localhost:9000` as a source and it
  works; what nobody configured does not.
- **`GET /api/projects` reports credential state as `credentialsStatus` /
  `credentialsError`** (`ok` or `error`), replacing `operatorSetupRequired`,
  `operatorSetupStatus` and `operatorSetupError`. A project whose `users.json`
  is missing, unreadable, corrupt or structurally invalid still shows
  **Credentials unavailable** and will not start.
- **`POST /api/manager/projects/{id}/operator-setup` is gone.** Nothing consumes
  a setup marker, and the `operatorSetup` key is ignored wherever an existing
  project still carries one — it is dropped the next time users are saved.

### Fixed

- **`http://localhost:8000` answers again.** Binding every interface was
  spelled `0.0.0.0`, which is the *IPv4* wildcard — one AF_INET socket and
  nothing on `::1`. Browsers resolve `localhost` to `::1` first, so the one URL
  everyone types was refused while `127.0.0.1` worked, which reads as a broken
  install rather than a bind that named a family. The default is the empty host
  now, the one spelling that binds the AF_INET + AF_INET6 pair; `NEXTHMI_HOST`
  still pins an install to a single interface, and the Docker image no longer
  pins itself to IPv4 by setting the old default explicitly. The dev server
  needed both halves separately: Vite binds dual-stack via `server.host: true`,
  and `start-dev.py` passes uvicorn `::` because its `--reload` path binds
  through `Config.bind_socket`, which opens an AF_INET socket unless the host
  string carries a colon — the opposite spelling from the one the launcher's
  non-reload path needs. Windows keeps its IPv4 bind there, where `::` would
  trade one half of localhost for the other.

- **A peer now advertises the address the banner told you to use.** mDNS
  advertised whatever the machine's own name resolved to, which on a stock
  Debian /etc/hosts is `127.0.1.1` and on a host with wired, wifi and a VPN
  adapter is whichever interface the name happens to point at — not the
  address the runtime is actually reachable at. A discovered peer could
  therefore be dialled at an address the runtime never answered on. The
  advertisement and the startup banner now both start from the bind host, so
  they cannot disagree: pin `NEXTHMI_HOST` and both follow the pin, leave it
  unset and both name the address the kernel routes off-box.

- **A generated HTTPS certificate covers the device's network address.** The
  banner prints an address URL next to the hostname one, but the self-signed
  certificate only carried that address when the hostname happened to resolve
  to it — so opening the address URL over HTTPS gave an avoidable certificate
  warning. New certificates name it. An existing certificate is not rewritten:
  use **Regenerate** under **Settings → HTTPS → Certificate**, which is also
  what to do after the device's address changes.

## [0.0.1-rc2] - 2026-08-29

Second release candidate toward **1.0.0**. Fixes only — everything in rc1 still
applies.

### Fixed

- **Blank Live View on a plain-HTTP install.** The runtime called
  `crypto.randomUUID()`, which browsers expose only in a secure context, so
  reaching the app over plain HTTP on a LAN address (`http://192.168.1.10:8000`,
  the default Docker setup) threw on first render and left a white page. ID
  generation now falls back to `crypto.getRandomValues` where `randomUUID` is
  absent. ([#3](https://github.com/mpnvdlee/next-hmi/issues/3))
- **Clipboard errors name the real cause.** `navigator.clipboard` is
  secure-context-only too, so on a plain-HTTP install the editor's copy and
  paste reported "Clipboard write blocked" — which reads as a permission the
  operator could grant, and none of them can. Those toasts now say the
  clipboard needs HTTPS or localhost when the API is absent entirely, and keep
  "blocked" for a genuine denial.

## [0.0.1-rc1] - 2026-08-18

Release candidate toward **1.0.0** — the first public release. Everything
below ships in the initial open-source build.

### Added

- **Browser-based HMI runtime.** Self-hosted operator panels that run in any
  modern browser — no per-seat client install. Connects to PLCs over OPC-UA.
- **Manager + per-project instance model.** A single manager front door
  supervises independent project instances behind a reverse proxy, each with its
  own runtime state and lifecycle.
- **In-browser page editor.** Build and lay out dashboards from the runtime
  itself — widgets, bindings, and pages are authored without leaving the app.
- **Widget system.** Built-in widget library plus a custom-widget SDK with a
  build pipeline, authoring rules, and a schema contract for third-party widgets.
- **Property value model.** Typed property values with `$`-wrapped sources
  (`$var`, and friends), an OPC-UA type-collapse layer, and consistent
  resolution/coercion across components.
- **OPC-UA connectivity.** Client pool with a self-signed client certificate
  generated on first secured connect; secure-config datasources.
- **Alarms, recipes, and historian.** Alarm handling, recipe management, and
  historical data — all in the single open-source build, with no feature paywall.
- **Widget visibility model.** Per-widget `visible`/`interactable` controls
  driven by a `$userGroups` source.
- **Theming.** Theme token catalog and pipeline with `hmi-*` / `cfg-*`
  conventions and shared UI primitives; unset values fall through to theme
  tokens, set values override.
- **WebSocket protocol.** `/ws` runtime channel with a defined handshake,
  server/client message set, async-action result correlation, and
  `config_changed` propagation.
- **Manager-to-manager LAN transfer.** Peer transfer of projects between
  managers on a local network, with a trust model and collision policies.
- **REST API** for the manager and project-instance apps.
- **MCP server** exposing a workspace tool catalog with per-project gating.
- **Runtime performance tooling.** Performance HUD (Ctrl+Alt+P), list windowing,
  and granular per-variable subscriptions.
- **HMI boot screen**, carrying the product logo, version, load progress and the
  AGPL-3.0 attribution notice on every load of the runtime, held for a minimum
  of two seconds. The notice is edition-bound — no project setting hides it; the
  commercial build drops it and adds a `shell.bootLogo` setting for white-label
  branding, which the open-source build ignores. Neither is a runtime licence
  check.
- **Deployment targets.** Multi-arch Docker image (linux/amd64 + linux/arm64)
  published to GHCR, and portable macOS / Windows binaries — all attached to
  each tagged release by CI.
- **Documentation set** covering architecture, data formats, the value model,
  the WebSocket protocol, theming, custom widgets, the REST API, peer transfer,
  MCP, deployment, and a threat model.

### Security

- No CORS middleware ships by design; the runtime is same-origin and intended to
  sit behind a reverse proxy on an OT network or VPN, never on the public
  Internet. See [SECURITY.md](.github/SECURITY.md) and the threat model in
  `docs/dev/operations/deploy.md`.
- Session cookies set the `Secure` flag when served over HTTPS.
- The page/widget editor is a privileged, code-execution-capable role
  (server-side file writes and arbitrary browser JS); documented in
  `docs/dev/reference/custom-widgets.md`.

### Licensing

- Released under **AGPL-3.0**. See [LICENSING.md](LICENSING.md),
  [LICENSE](LICENSE), and [COMMERCIAL.md](COMMERCIAL.md).
- The `asyncua` (LGPL-3.0) and `zeroconf` (LGPL-2.1) runtime dependencies are
  shipped loose (replaceable) in binary builds, with the LGPL texts and a
  written source offer bundled alongside.

[0.0.1-rc2]: https://github.com/mpnvdlee/next-hmi/releases/tag/v0.0.1-rc2
[0.0.1-rc1]: https://github.com/mpnvdlee/next-hmi/releases/tag/v0.0.1-rc1
