# Changelog

All notable changes to NEXT HMI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project is pre-1.0, minor versions may include breaking changes; these
are always called out under a **Changed** or **Removed** heading.

## [Unreleased]

### Added

- **Every project row shows a picture of its main page.** The dashboard listed
  projects as name, id, folder and status, which tells you nothing about which
  screen set a row actually is — on an installation carrying five of them, the
  only way to tell was to open each one. The editor now renders the project's
  main page off-screen after each save and stores it as a thumbnail, and the row
  shows it; a project that has never been saved gets a plain placeholder. The
  capture runs after the save rather than inside it, so it can never delay or
  fail one, and it drives the preview surface rather than the runtime — which
  means a save does not fire `onHmiLoaded` and cannot write to a datasource as a
  side effect. The picture is installation-local: it never travels with an
  export, a zip, or a transfer. See
  [Managing projects](docs/user/projects.md#the-manager-dashboard).

- **Creating a project starts from a template.** **+ New project** now asks what
  to start from before it asks where to put it. **Empty project** is the
  previous behaviour, one blank page. **NEXT BREW example** installs a working
  demo machine — three pages, a static datasource, alarms, recipes, two themes
  and two languages — which is the shortest path from installed to something to
  read. See [How to create a project](docs/user/projects.md#how-to-create-a-project).

- **The User Badge signs operators in and out.** The badge showed who was
  signed in and nothing more, so every project rebuilt the same pair of Log in /
  Log out buttons beside it, each gated on its own `$compare` against `guest`.
  It now carries the affordance itself: a **Log in** button while the session is
  the anonymous `guest`, the identity plus a sign-out button once it is not, and
  an optional **On Press** for the identity. Each half appears only when you
  give it actions to run, so a panel that never signs anyone out is unchanged.
  The NEXT BREW example drops its own two buttons and wires the badge instead.
  See [Sign in and out on a screen](docs/user/users.md#sign-in-and-out-on-a-screen).

- **A secured OPC-UA connection can be set up without leaving the editor.**
  Certificates had to exist before the connection did — generated with `openssl`
  somewhere else and uploaded. **Generate certificate…** now writes a
  self-signed RSA-2048 pair into the project's `certs/` folder and fills the
  path fields in, and **Certificate info** reads one back: subject, fingerprint,
  issue and expiry dates, subject alt names, self-signed or not, and whether it
  is valid, inside the 90-day warning window, or already expired. Generating
  again under the same name overwrites in place, so renewal is one click rather
  than a folder of accumulating files. See
  [Secure the connection with certificates](docs/user/datasources.md#secure-the-connection-with-certificates).

- **Connect and Disconnect are explicit on an OPC-UA datasource**, replacing a
  single **Reconnect**. A connection stays down until you ask for it and stays
  down after you disconnect, instead of retrying underneath you, and a failed
  attempt prints the server's own reason under the status rather than leaving
  you to read the log. See
  [Connect, disconnect, and see why it failed](docs/user/datasources.md#connect-disconnect-and-see-why-it-failed).

- **The editor's top bar can transfer the open project.** Sending a project to
  another device meant leaving the editor for the dashboard and finding the row
  again. The bar now carries **Transfer**, opening the same dialog. What travels
  is the project on disk, so the button stays disabled while there are unsaved
  edits rather than silently sending the previous state. See
  [Push & pull between devices](docs/user/projects.md#push--pull-between-devices).

- **A transfer dialog that explains itself.** A refusal used to surface as the
  backend's raw sentence. The dialog now names the cause and the fix — the
  peer's device-admin password rather than this one's, a pairing lockout with
  the countdown to wait out, a host name that did not resolve, an address
  outside the trusted LAN, a port with nothing listening, a failed TLS
  handshake, a peer certificate that no longer matches the pinned one — and
  detects an id or folder collision *before* sending, offering the resolution
  choices in place. Progress is named as it runs rather than shown as a bar.

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

- **New projects default to your Documents folder.** The runtime picked a
  projects root for you on first launch — `<runtime_home>/Projects` — and
  created the folder to go with it, so an installation that kept its projects
  on a plant share still grew an empty `Projects` directory nobody asked for,
  and the create dialog opened somewhere buried under the runtime's own
  bookkeeping. The default is now your **Documents** folder: a place that
  already exists, so nothing is created for it, and one you can find without
  being told where to look. An existing install that still carries the
  auto-written root is unpinned on the next start — the folder itself is left
  alone, projects inside it stay registered where they are — while a root you
  set yourself is untouched. Every create / import / pull dialog still lets you
  type or browse anywhere. See
  [Changing the default projects root](docs/user/install.md#changing-the-default-projects-root).

- **Layout sizing is Hug / Fill / Fixed, and the raw flex rows are gone.** The
  Layout panel offered Basis, Grow, Shrink and Align self *alongside* a width
  and a height, so the same question could be answered twice, in two
  vocabularies, and the two could disagree — and the panel gave no hint which
  one won. Width and Height are each one row now: a mode and, under **Fixed**, a
  length. **Hug** is the content's own size, **Fill** takes what the parent has
  left, and **Fill weight** — one number per widget, below both rows — splits
  that leftover space between Fill siblings. Min/Max bounds sit under the axis
  they bound, all rows visible rather than folded behind a disclosure. Authored
  projects carrying the old keys keep working. See
  [Layout](docs/user/layout.md#the-layout-fields).

- **A Navigation Menu is sized from the Layout panel like every other widget.**
  Its stylesheet pinned `width: 100%` plus fixed pixel widths for a menu placed
  straight in a shell region, which outranked every Width the panel offered —
  including the Hug it displayed as the default — so a menu in a container wider
  than its labels kept the leftover space inside itself. The pins are gone and
  the widget honours its layout properties.

- **A page reveals when its widgets are ready, not when its data is.** A page
  used to wait on config hydration and then paint as an empty shell while widget
  modules loaded, and a slow OPC-UA read stalled every navigation. The reveal
  now waits on the page's own widget modules, with a 5-second safety valve, and
  the boot splash warms the built-ins so later navigations find them in memory.
  Variables no longer gate it at all. Because data can now arrive after the
  reveal, the binding overlay splits in two: **red** still means a binding that
  does not resolve, and a new **amber** mark means a sound binding that no value
  reached — shown only once the server has said it sent everything it could, so
  a value still in flight is never flagged. See
  [The marks on a widget](docs/user/subscribing.md#the-marks-on-a-widget).

- **A new widget arrives with Interactable already on `$userGroups`.** `visible`
  came pre-wired to that source with an empty group list; `interactable` came
  with nothing, so locking a control to a group meant switching its source by
  hand first — the half an operator-facing project reaches for most. Both are
  seeded now. Behaviour is unchanged: an empty group list is true for everyone.

- **An unavailable project explains itself at the URL you typed.** Opening
  `/runtime/<id>/` or `/editor/<id>/` for an instance that is not running
  redirected to the dashboard with the reason in a query string, so the URL was
  lost along with the answer. The app now boots at that address and says which
  it is — not running, crashed, folder missing, or no such project registered —
  with the way back on the overlay.

- **An import refuses an archive that carries no `users.json`.** A metadata
  block alone does not prove an archive holds a project: a content-less folder
  packed into a well-formed archive unpacked clean, registered, and then refused
  to start, surfacing the failure well away from the transfer that caused it.
  Unpack now also requires the one document the manager and the supervisor both
  demand. Export is unchanged, so a damaged project can still be carried
  elsewhere and repaired.

- **The dev runner serves the app on `:8000`, the port a release install uses.**
  `start-dev.py` ran Vite on `:5173` with the API on `:8000`, so every URL a
  contributor held — a bookmark, a screenshot in an issue, a tablet's
  home-screen shortcut, the address in a bug report — pointed at a different
  port depending on whether it came from a checkout or an install, and the two
  could not be compared without editing the address bar. Vite now owns `:8000`
  and proxies to the API server next door on `:8001`, which is the same origin
  split a release install resolves internally. Nothing about the packaged
  runtime changed; this is the dev workflow catching up to it. A tool of your
  own that pointed at `:5173` needs repointing, and `python start-dev.py --stop`
  now frees `:8000`/`:8001` rather than `:8000`/`:5173`.


- **NEXT HMI is reachable on the network by default.** The manager used to bind
  `127.0.0.1` and answer nobody but the machine it ran on, so a panel PC that
  pinged fine was still a refused connection from every other machine until
  someone found `NEXTHMI_HOST=0.0.0.0` — a variable with no UI and no flag
  behind it. It now binds every interface, which is what the Docker image has
  always done, and the startup banner prints the addresses to reach it at from
  elsewhere — this machine's name and its address, under **On the network** —
  beside the `localhost` rows for the browser sitting in front of it. The dev
  server (`start-dev.py`) binds the same way, prints the same block, and
  accepts any host name that resolves to it, so every adapter on a multi-homed
  dev box reaches it.

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

- **A stroke-outline SVG icon stays an outline.** Custom icon rendering deleted
  every fill and stroke attribute and forced `fill: currentColor`, which assumed
  an icon is a filled silhouette — so an outline asset (`fill="none"` plus a
  stroke) lost its strokes and had its geometry filled in. Icon, Button and Menu
  Toggle all share that path, so every outline asset broke the same way.
  Concrete paint values are repointed at the widget's colour now, across
  attributes, inline styles and `<style>` blocks, and `none` is left alone. See
  [Files & assets](docs/user/files.md).

- **Browser keychains stay out of a password field.** A String Input with
  **Password field** ticked offered to save and auto-fill on a panel PC, where
  the browser profile is shared by everyone who walks up to it.

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
  banner prints that address under **On the network**, but the self-signed
  certificate only carried it when the hostname happened to resolve to it — so
  opening it over HTTPS gave an avoidable certificate warning. New certificates name it. An existing certificate is not rewritten:
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
