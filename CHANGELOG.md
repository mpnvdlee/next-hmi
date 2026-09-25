# Changelog

All notable changes to NEXT HMI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project is pre-1.0, minor versions may include breaking changes; these
are always called out under a **Changed** or **Removed** heading.

## [1.0.0] - Unreleased

### Added

- **A Video widget plays recorded footage on a screen.** Putting a changeover
  clip or a line-clearance procedure on a panel meant a Web Frame pointed at
  something else that hosted the file. **Video** is a widget now: it takes a
  file from the project or a URL, with the settings you would expect — autoplay
  (muted, as every browser insists), loop, controls, fit, poster image, preload,
  playback rate and volume — plus a **Play when** binding that starts and stops
  it from a variable, **State** and **Current time** write-backs, and On Play /
  Pause / Ended / Error actions. It plays recorded files: HLS playlists and RTSP
  camera feeds are not streams it can open. A **Codec** setting and a second,
  fallback source are there because H.265 does not decode everywhere — which
  file to ship, and what the widget shows when the panel cannot play one, is in
  [Files & assets](docs/user/files.md#video-files).

- **Projects have an `assets/videos/` folder.** It sits beside `icons/` and
  `images/` and works the same way: drop a `.mp4`, `.webm`, `.m4v` or `.mov` in
  it — subfolders included — reload the editor tab, and pick the file. `.mkv` is
  deliberately not offered; no browser plays it in a `<video>` element. The
  folder is served read-only like the rest of `/assets/` and answers range
  requests, so the operator can drag the scrub bar without waiting for the whole
  clip. Over MCP `assets_list` reports videos and the delete guard protects
  them, but `assets_upload` still takes icons and images only: its 5 MB payload
  cap means nothing to a video, so clips are copied in or arrive with a project
  import. See
  [Files & assets](docs/user/files.md#where-each-kind-of-file-lives).

- **A `video` property type.** A schema field typed `video` — on a built-in
  widget, a custom widget, or a component input — opens the video picker and
  stores the same small `{ path }` payload an `image` field does, from the same
  sources.

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
  demo machine — eight pages plus two dialogs, a static datasource, alarms,
  recipes, two themes, two languages and a five-step guided setup wizard —
  which is the shortest path from installed to something to read. See
  [How to create a project](docs/user/projects.md#how-to-create-a-project).

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

- **Catalog polish.** Trend Chart's Variables field picks a live variable
  through a picker instead of a typed path; Page Navigator's Previous and Next
  controls each gate on their own enabled condition; Button and Status Pill
  both gained a corner-radius control; Value Display now accepts `Float` and
  `Integer` only, the two types it actually renders; and a Navigation Menu with
  no page in the tree naming it is no longer rendered as an empty shell. See
  [Built-in widget catalog](docs/user/catalog.md).

### Removed

- **Dialogs, as a separate kind of document.** A dialog was built like a page,
  but was not one: it stored its widgets inline in `config.json`, carried its
  own title and close settings, and only the **Open Dialog** action could show
  it — so a screen authored as a page could not become a popup, and a popup
  could not grow tabs, a header, or sub-pages without being rebuilt. The
  **Dialogs** section of the page tree now holds ordinary **pages and page
  groups**, and **Open Page Overlay** opens them. Everything a page has comes
  with them: sections, page events, group chrome, the same canvas.
  **Open Dialog** and **Close Dialog** are gone, along with the `DialogConfig`
  shape and the `openDialogIds` field of the `set_context` / `context_ready`
  websocket messages.

  On disk, a Dialogs-folder page keeps its document in the project's own
  `dialogs/` directory beside `pages/`, so the two kinds of screen stay
  separable; the upgrade moves them there, and dragging a page between the
  two sections moves its document with it.

  Existing projects are converted on first open, at project format 8: every
  dialog becomes a page in the Dialogs folder with its widgets, its input
  parameters and its close behaviour intact. A project is backed up before it
  is migrated, as always. **Open Dialog** keeps its name and now names a page
  rather than a dialog, so a hand-written custom widget that hard-codes one
  only has to rename its `dialogId` field to `pageId`; **Close Dialog** becomes
  **Close Dialog/Overlay** (`closePageOverlay`), the one action that closes
  either kind.

  Opening a screen over another is two actions, by which section it comes from.
  **Open Dialog** lists the Dialogs folder and fills the target's input
  parameters in. **Open Page As Overlay** lists the navigable pages and takes
  none. Each picker therefore offers exactly the screens it can reach, and
  moving a screen between the two sections is flagged by the warnings pill,
  which names the action to switch to.

  What is new rather than carried over: **input parameters** and the **Overlay**
  settings (close button, close on backdrop) are declared on any page or page
  group in the Dialogs folder, so a parameterised popup can now be a whole
  tabbed page group. A page in the **Pages** section is a navigation
  destination, so it declares neither — it can still be opened as an overlay,
  taking no parameters and using the default close behaviour. See
  [Pages & navigation](docs/user/pages.md#overlays-a-page-shown-on-top-of-the-current-screen).

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

- **A widget with no size of its own now hugs its content, not stretches to
  fill.** Leaving a widget's Width or Height unset used to stretch it across
  its parent's cross axis by default; it now hugs the size of its content
  instead, matching the **Hug** / **Fill** / **Fixed** model everywhere else in
  the Layout panel. This is a deliberate change, not a bug. **It changes how an
  existing project renders:** a widget that relied on that stretch — because
  its Width or Height was never explicitly set to **Fill** — can look smaller
  or different the first time you open the project on this build. Open the
  widget's **Layout** panel and set the affected axis to **Fill** to put it
  back the way it was. See [Layout](docs/user/layout.md#the-layout-fields).

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

- **Windows is a supported platform, not just an advertised one.** rc1 already
  claimed a Windows binary, but neither the packaged build nor the test suite
  worked on Windows itself, and the binary that did come out carried no app
  icon. All three work now — the build, the test suite, and the icon on the
  packaged `.exe` — which is what makes rc1's claim true.

- **A component definition is covered by undo.** Editing a component's own
  widgets and inputs used to sit outside the editor's undo stack, so a mistake
  made while inside a component definition could not be undone the way every
  other edit can — it now can. A `select` property can also declare options
  beyond plain strings, a property can be given a default value at the moment
  it is added instead of only afterward, that default is what an unset field
  shows instead of a blank, and the outline marking an unfilled slot no longer
  appears in the widget's UI preview. See
  [Passing values into components](docs/user/properties.md#passing-values-into-components).

- **An absolute URL typed into an asset field stays one.** An image field read
  anything that did not begin with `images/` as a filename inside that folder,
  so pasting `https://example.com/logo.png` into one produced
  `/assets/images/https://example.com/logo.png` and a broken image. `http(s):`,
  `data:` and `blob:` values are passed through untouched now, in image and
  video fields alike, and the diagnostics pill no longer reports one as a
  missing asset. A path already rooted at `icons/` or `videos/` is likewise left
  alone rather than being prefixed into `images/icons/…`; only a bare filename
  still resolves inside `assets/images/`, which is what values stored before the
  folder became part of the path look like.

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

[1.0.0]: https://github.com/mpnvdlee/next-hmi/releases/tag/v1.0.0
[0.0.1-rc2]: https://github.com/mpnvdlee/next-hmi/releases/tag/v0.0.1-rc2
[0.0.1-rc1]: https://github.com/mpnvdlee/next-hmi/releases/tag/v0.0.1-rc1
