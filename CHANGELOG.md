# Changelog

All notable changes to NEXT HMI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
From 1.0.0 on, a patch release never makes a project unopenable: a change to the
project file format ships only in a release whose minor or major number moves.
Breaking changes are always called out under a **Changed** or **Removed**
heading.

## [1.0.0] - 2026-09-27

The first stable release. Projects saved by a 0.0.1 release candidate are
upgraded to file format 9 on first start, after you confirm it and a backup is
taken — see **Changed** for what that rewrites.

### Added

- **Repeater widget.** Draws its children once per element of an array — an
  array tag, a typed-in list, an `$http` response, the saved recipes, or the
  users or groups. A new **Repeat Item** source (`$repeatItem`) reads the
  copy's element, a member of it, or its index; the variable picker's
  **[#] this copy** row reads a second array at the same position. With a tag
  as Items, a copy's inputs and write actions write back to their own element.
  **Start at**, **Max items** and **Empty text** cover the rest. See
  [Repeating widgets over an array](docs/user/properties.md#repeating-widgets-over-an-array-repeater).

- **Video widget and an `assets/videos/` folder.** Plays `.mp4`, `.webm`,
  `.m4v` and `.mov` files from the project or a URL, with autoplay, loop,
  controls, fit, poster, playback rate and volume, a **Play when** binding,
  **State** / **Current time** write-backs, On Play / Pause / Ended / Error
  actions, and a fallback source for panels that cannot decode H.265. The
  folder answers range requests, so scrubbing does not wait for the whole clip.
  A `video` property type opens the same picker in custom widgets and
  component inputs. Recorded files only — no HLS or RTSP streams — and MCP's
  `assets_upload` still takes icons and images only. See
  [Files & assets](docs/user/files.md#video-files).

- **New actions.** **If / Else** runs one of two action lists on a condition
  ([Logic](docs/user/actions.md#logic)). **Toggle Boolean Variable** flips a
  tag from its server-side value over a new `toggle_field` message, failing
  with `value_unavailable` while no value is known
  ([Machine actions](docs/user/actions.md#machine)). **Show Toast** gains a
  `success` severity.

- **Page, page group and dialog events.** Page Open / Page Close (Group Open /
  Group Close) run as the operator arrives and leaves. A dialog's events run
  with its input parameters in scope, and **Write Data Variable** can take its
  value from one. See [Page events](docs/user/actions.md#page-events).

- **`$not` and `$formula` sources.** `$not` inverts a boolean; `$formula`
  computes a number with `+ - * /` and parentheses, such as `({1} - 32) / 1.8`,
  and is empty when an input is missing or it divides by zero. See
  [The sources](docs/user/properties.md#the-sources).

- **Project templates.** **+ New project** asks what to start from: an empty
  project, or the **NEXT BREW** demo machine — three pages, a Dialogs folder
  with a sign-in dialog and a five-step setup wizard, a static datasource,
  alarms, recipes, two themes and two languages. It ships the demo accounts
  `brewer` and `barista`, whose passwords its sign-in dialog prints; change or
  delete them before a project built from it leaves the test bench. See
  [How to create a project](docs/user/projects.md#how-to-create-a-project).

- **Project thumbnails on the dashboard.** The editor renders the main page
  after each save — through the preview surface, so a save never fires
  `onHmiLoaded` or writes to a datasource — and the project row shows it. The
  picture never travels with an export or a transfer. See
  [Managing projects](docs/user/projects.md#the-manager-dashboard).

- **OPC-UA certificates from the editor.** **Generate certificate…** writes a
  self-signed RSA-2048 pair into the project's `certs/` folder and fills in
  the paths; **Certificate info** shows subject, fingerprint, validity and
  whether it expires within 90 days. Regenerating under the same name renews
  in place. See
  [Secure the connection with certificates](docs/user/datasources.md#secure-the-connection-with-certificates).

- **Explicit Connect and Disconnect on an OPC-UA datasource**, replacing
  **Reconnect**. A connection stays down until you connect it, and a failed
  attempt shows the server's reason under the status. See
  [Connect, disconnect, and see why it failed](docs/user/datasources.md#connect-disconnect-and-see-why-it-failed).

- **Sign in and out from the User Badge.** It shows **Log in** for the
  anonymous `guest` and a sign-out button once someone is signed in, each only
  when you give it actions. See
  [Sign in and out on a screen](docs/user/users.md#sign-in-and-out-on-a-screen).

- **Transfer from the editor, with a dialog that explains itself.** The top
  bar carries **Transfer** (disabled while edits are unsaved). A refusal names
  its cause and fix — wrong peer password, pairing lockout, unresolved host,
  closed port, TLS or pinned-certificate mismatch — and an id or folder
  collision is detected before sending. A failed transfer can be retried and
  resumes rather than starting over. See
  [Push & pull between devices](docs/user/projects.md#push--pull-between-devices).

- **A plain-HTTP notice on the dashboard.** Above the project list, on the
  settings page and on the sign-in screen, whenever the browser is not in a
  secure context, with a link to **Settings → HTTPS**. It cannot be dismissed;
  the operator runtime and the editor do not show it. See
  [HTTPS](docs/user/install.md#https).

- **Container Overflow.** Visible (the default), Clip or Scroll for children
  that do not fit; Clip and Scroll need a Fixed or Fill size. See
  [Container](docs/user/catalog.md#container).

- **Dropdown options from the user list or user groups**, through the **User**
  source's **All users** and **All user groups**. See
  [Dropdown](docs/user/catalog.md#dropdown).

- **Operator sign-in throttling.** Five wrong passwords for one username lock
  it for a minute, and the login fails with `rate_limited`. An account with no
  password can never be signed in as. See
  [Add users and groups](docs/user/users.md#add-users-and-groups).

- **Upgrades ask first.** **Start** on a project saved by an older build asks
  for confirmation, zips the project into `.backups/` before rewriting
  anything, and reports what changed. A project saved by a newer build shows
  **Requires update** with the version it needs. See
  [The Manager dashboard](docs/user/projects.md#the-manager-dashboard).

- **A startup banner that says what to do next** — numbered getting-started
  steps, the running project, and clickable URLs, LAN addresses included. See
  [Installing](docs/user/install.md#installing).

- **Composition primitives in the custom-widget SDK**: `renderWidget`,
  `renderSlotWidgets`, `childConfigs`, `useComponentSlot`, `useIsPreview`,
  `useActivePage`, `useAnchoredStyle` and `useCurrentUserGroups`. See
  [Composition](docs/dev/reference/custom-widgets.md#composition).

- **Catalog polish.** Trend Chart picks its variables through the picker; Page
  Navigator's Previous and Next can each be relabelled, gated or hidden; Button
  and Status Pill have a corner radius; Value Display accepts `Float` and
  `Integer` only; a Navigation Menu no page names is not drawn as an empty
  shell. See [Built-in widget catalog](docs/user/catalog.md).

### Changed

- **Types match exactly.** A variable or source fits a field only when its type
  is the field's type — an Integer tag no longer fills a Float field — except a
  number filling a `Duration`. A field that takes several types lists them all,
  and each slot inside a source has its own type. The backend applies the same
  rules to saved projects, component inputs, `$componentProp` / `$widgetProp`
  reads and every action field; a binding that no longer fits is flagged, not
  rewritten. `getPropNumber` / `usePropNumber` accept a numeric string and no
  longer round. See [The sources](docs/user/properties.md#the-sources) and
  [The warnings pill](docs/user/diagnostics.md#the-warnings-pill).

- **Read-only variables refuse writes.** A variable not marked writable — or
  stating no access at all — rejects every write with a new `read_only` reason
  before it reaches the PLC: control writes, write and toggle actions, recipe
  downloads and `POST /api/datasources/write`. `var_metadata` carries
  `writable`. See
  [Write back to the machine](docs/user/subscribing.md#write-back-to-the-machine).

- **Layout is Hug / Fill / Fixed.** Width and Height are one mode each, with a
  length under Fixed and a **Fill weight** for sharing leftover space; Basis,
  Grow, Shrink and Align self are gone and old keys are rewritten on first
  open. **A widget with no size set now hugs its content instead of
  stretching** — a widget that relied on the stretch needs its axis set to
  **Fill**. A Navigation Menu sizes from the Layout panel like every other
  widget. See [Layout](docs/user/layout.md#the-layout-fields).

- **The Button binds a plain boolean**, written `true` on press, instead of a
  `bVisible` / `bEnabled` / `bValue` struct. A Button still bound to a struct is
  flagged: rebind **Variable** to `bValue`, and **Visible** / **Interactable**
  to the other two if you used them. See [Button](docs/user/catalog.md#button).

- **Write and toggle actions name their variable with one `target`** — a
  `$var`, or a `$repeatItem` inside a Repeater — instead of `datasource` /
  `path`. Projects are rewritten on first open; a custom widget that fires
  either action must send `target`. See
  [Machine actions](docs/user/actions.md#machine).

- **Reachable on the network by default.** The manager binds every interface,
  IPv4 and IPv6, and the banner prints the addresses to use under **On the
  network**; the dev server does the same. On plain HTTP the device-admin
  password, operator sign-ins and MCP tokens now cross the network — turn on
  [HTTPS](docs/user/install.md#https) on a network you do not trust, or set
  `NEXTHMI_HOST=127.0.0.1` for the old behaviour. Claim a fresh install right
  away: until a device-admin password is set, whoever reaches the first-run
  page sets it.

- **Live screens need no password.** `/runtime/<slug>/` serves a deny-by-default
  allowlist of what a live screen needs without the device-admin session; the
  editor, dashboard, manager APIs and every write verb stay behind it. Restrict
  a tag with `interactableByGroups`.

- **`$http` reaches only the servers the project configures**, checked again on
  every redirect (at most five, caller headers dropped cross-origin).

- **Page reveal waits for the page's widgets, not its data**, with a 5-second
  safety valve; the rest of the project's widget code loads after the first
  page settles. The binding overlay adds an **amber** mark for a sound binding
  no value has reached yet, and judges only the `$if` / `$switch` branch on
  screen. See
  [The marks on a widget](docs/user/subscribing.md#the-marks-on-a-widget).

- **Faster boot.** Preloaded views, widgets and icons render in one pass: first
  page on a LAN in about 230 ms cold and 140 ms cached, down from 800 and 700.

- **New projects default to your Documents folder**, and an auto-written
  `<runtime_home>/Projects` root is unpinned on upgrade. See
  [Changing the default projects root](docs/user/install.md#changing-the-default-projects-root).

- **Smaller changes.** A new widget arrives with Interactable on `$userGroups`,
  like Visible. An unavailable project explains itself at the URL you opened. An
  import refuses an archive without `users.json`. A Dropdown filled from the
  user list is valued by username. `$page` inside an overlay answers for the
  overlay's page. The device-admin session lasts 24 hours instead of a week.
  `GET /api/projects` reports `credentialsStatus` / `credentialsError`. The dev
  runner serves the app on `:8000` with the API on `:8001`, like a release
  install. `sendWsMessage` in the SDK types only `write_field`, the one write
  frame the backend accepts.

- **Editor polish.** The properties header says whether the selection is a
  widget or a component and links to the component's editor; **Browse
  actions…** opens a searchable action catalog. See
  [The action catalog](docs/user/actions.md#the-action-catalog).

### Removed

- **Dialogs as a separate kind of document.** The **Dialogs** section of the
  page tree now holds ordinary pages and page groups, stored in the project's
  `dialogs/` folder and served at `/api/config/dialogs/{id}`, with everything a
  page has. **Open Dialog** (`openDialog`) opens one and fills its input
  parameters; **Open Page As Overlay** opens a navigable page;
  **Close Dialog/Overlay** (`closePageOverlay`, formerly `closeDialog`) closes
  either. Input parameters resolve innermost-first and are read with
  `$componentProp`. Existing dialogs and their actions are converted on first
  open; a custom widget that fires `openDialog` renames `dialogId` to `pageId`.
  `DialogConfig` and `set_context`'s `openDialogIds` are gone. See
  [Pages & navigation](docs/user/pages.md#overlays-a-page-shown-on-top-of-the-current-screen).

- **Per-project operator passwords.** The device-admin password already gated
  every runtime and editor, so the second credential and its
  `POST /api/manager/projects/{id}/operator-setup` route are gone; an empty
  project opens with only the `guest` user. The unused **Config access —
  allowed groups** setting is gone too; the key is ignored and dropped on the
  next save.

- **Margin and the `padding` shorthand.** Spacing between widgets comes from the
  parent's **Gap** and **Padding**. The upgrade drops stored margins and logs a
  `Migration note` for each. See [Padding](docs/user/layout.md#padding).

- **The per-page shell override.** Bind a region's **Enabled** to
  `$pageIsActive` instead. See
  [Persistent chrome: shell regions](docs/user/layout.md#persistent-chrome-shell-regions).

- **The Min/Max columns of the variable table**, hidden for this release;
  stored ranges are still enforced.

### Fixed

- **Windows works**: the packaged build, the test suite and the app icon.
- **Component definitions are covered by undo**, and a property's default shows
  in an unset field. See
  [Passing values into components](docs/user/properties.md#passing-values-into-components).
- **A component reading a member of a struct input shows its data** instead of
  staying on *No data*, and a bound intermediate struct stays live.
- **Outline SVG icons keep their strokes**, and a revisited page draws custom
  icons at once. See [Files & assets](docs/user/files.md).
- **An absolute URL in an asset field stays a URL.**
- **A password field stays out of browser keychains.**
- **mDNS advertises the address the banner prints**, and a generated HTTPS
  certificate names that address.
- **Turning HTTPS on or off reopens the page on the new address** once the
  restart is done.
- **A Dropdown lists an array another widget exports**, which the editor
  already offered.
- **An edited datasource's priority batch delay applies** without a restart.
- **Restarting a project instance no longer re-launches the manager** the next
  time it is stopped.
- **MCP `assets_delete` refuses an asset a component still uses.**
- **The Docker image reports its release** instead of `dev`.
- **A datasource node without `kind` binds like a browsed one**, and an alarm
  without a code has no empty brackets.
- **Smaller fixes**: browser zoom on the config pages, the boot splash's first
  frame, widget stylesheets loading with their code, and a superseded websocket
  no longer disturbing the live one.

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
