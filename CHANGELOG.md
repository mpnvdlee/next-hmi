# Changelog

All notable changes to NEXT HMI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
From 1.0.0 on, a patch release never makes a project unopenable: a change to the
project file format ships only in a release whose minor or major number moves.
Breaking changes are always called out under a **Changed** or **Removed**
heading.

## [Unreleased]

### Added

- **Navigate To Page goes to a page chosen at runtime.** The new action
  closes every open dialog and overlay, then goes to a page from the Pages
  section, firing the page events a menu press would. The page is fixed, or
  — inside a dialog — an input parameter switched to **Holds a page**, which
  the Open Dialog action fills in with a page picker: one station popup's
  *Open station page* button then leads to each caller's own station. The
  warnings pill flags a page that does not exist, one in the Dialogs folder,
  and an input that is not declared as a page.

- **Alarm text can show live values.** An alarm gets a **Values** list of
  variables, numbered `{1}`, `{2}` …, and those placeholders in its title and
  description show them, with the same functions a String Expression takes
  (`{Round1(1)}`, `{Signed(2)}`). While the alarm is active the text follows
  the live value; once it has cleared, and in the alarm history, it shows the
  value from the moment the alarm went off. History rows from before this
  release show `—`.

- **Exo 2 is a bundled font.** The theme settings offer **Exo 2** next to
  Inter, Manrope and Lexend for every font token, in weights 400 to 700,
  served from the HMI itself so it looks the same without internet access.

- **A dialog can drop its header bar.** A new **Show header bar** switch in a
  page's or group's **Overlay** section hides the title and the × of the
  card it opens in, so a keypad or an access panel can be a real dialog
  without a title strip. The page then closes through a **Close
  Dialog/Overlay** button of its own, or through the backdrop when **Close
  on backdrop** is on. For a group, the group's switch counts, not the page
  inside it. It is on by default, so existing projects look the same.

- **Toasts take their place, shape and colours from the theme.** A new
  **Toasts** section in the theme settings puts Show Toast notifications in
  one of six places — top or bottom, left, center or right — makes them
  rounded or a pill, and sets a background and text colour per severity
  (info, success, warning, error). The default is today's look: top center,
  rounded, and an empty colour keeps the severity tint, so existing projects
  look the same.

- **Buttons can be icon-only, stacked, and sized.** The Button gets five
  properties: **Show label** (off makes an icon-only button that keeps its
  label as the name a screen reader announces and as a hover tooltip),
  **Icon position** (left, or on top with the text below), **Icon size** and
  **Border width** in pixels, and a **Fill** colour for the outline style.
  Each one left at its default keeps today's look.

- **All Of (`$and`) and Any Of (`$or`) combine conditions.** Two new Boolean
  sources take a list of conditions — a variable, a comparison, an Invert, a
  group check, another All Of / Any Of — and are true when every one, or any
  one, is. A button can then be interactable only while the machine is ready
  *and* the door is shut, without a helper tag in the PLC. They fit every
  Boolean field, an `$if` condition and the If action's condition; the editor
  lists one card per condition with **+ Add condition**, and the backend
  flags a list with no conditions as an error.

- **The numpad takes its look from the theme.** A new **Numpad** section in
  the theme settings sets the key size, the gap between keys, the key font
  and the Enter key colour, and picks one of two layouts: 3 columns, with
  Back, Clear and Enter under the digits, or 4, with them in a column on the
  right. Every numeric input gets it — Number Input, Numeric Stepper, Edit
  Value and custom widgets that open the SDK numpad. A field left empty
  follows the rest of the theme, so existing projects look the same.

- **Edit Value opens the numpad on a tag without a Number Input.** The new
  action puts the numpad over the screen for a numeric variable — a setpoint
  behind a machine tile, a value in a table row, the element a dialog's input
  names. **Apply** writes, **Cancel** writes nothing and runs no handler.
  Min, max and decimals default to what the variable itself is configured
  with, and `onSuccess` / `onFailed` / `onSettled` read the entered value and
  the one it replaced as `$result` `value` and `previous`.

- **A variable's array index can come from another value.** A binding such
  as `Safety/Open` with its index bound to a dialog's input parameter reads,
  writes and toggles the element of whichever device opened the dialog — one
  popup instead of a 27-case **Switch**, and no hand-off variable for a
  toggle. **+ Bind index** under a variable path turns a fixed index into a
  source; any whole-number source works, including another variable. The
  same control sits under the **Variable** row of a **Write Data Variable**,
  **Toggle Boolean Variable** or **Edit Value** action on an array tag, whose
  summary then reads `path[…]`; picking the tag again sets a fixed element. An
  index that is empty or past the end reads nothing and a write fails with
  `array_index_out_of_bounds`, never the whole array.

- **Open Dialog Input (`$overlay`) lights what a popover belongs to.** The new
  source reads an input parameter of a dialog while it is open and is empty
  once it closes, from anywhere on the screen. Bind a machine symbol's
  selection ring to a comparison of `$overlay` (dialog *device*, input
  *device*) with the symbol's own number, and it lights exactly while its
  popover shows, moves along when the popover swaps to the next symbol and
  clears when it closes — with no extra variable to set and reset. The
  editor picks the dialog and then one of the inputs it declares; the
  diagnostics flag a page outside the Dialogs folder or an input it does not
  declare.

- **Browse PLC shows its progress.** Browsing a whole server could run for
  minutes on a large PLC with only a disabled button to show for it. A bar now
  fills as the walk goes, with the number of nodes found and how deep it has
  reached. Leaving the datasource stops the browse on the server too, instead
  of letting it finish for nobody.

- **`usePropNumber` can report "no value".** Custom widgets can pass `null` as
  the fallback — `usePropNumber(properties, 'variable', null)` — to get `null`
  instead of `0` when a bound variable has no numeric value yet, and show
  `---`. The hook now also subscribes to a bound variable itself, so it stays
  live outside a page as well; `readNumberValue(usePropVar(...))` is no longer
  needed for a numeric binding.

- **`usePropString` and `usePropBoolean` work the same way.** Both follow a
  bound variable live and take a `null` fallback to tell "no value yet" apart
  from `''` or `false`; `usePropBoolean`'s `null` form also reads an empty text
  or `NaN` as no value. A property with no variable bound no longer costs a
  variable-store listener.

### Changed

- **Number Input binds a plain Float or Integer variable (breaking).** Like
  the Button and the Numeric Stepper, it no longer takes a
  `bVisible` / `bEnabled` / `fValue` struct: bind the setpoint itself, and use
  the widget's own **Visible** and **Interactable** properties to hide or lock
  it. An Integer variable turns the numpad's point off, and with no min/max on
  the widget the variable's own range applies. A Number Input still bound to a
  struct shows `---` until it is rebound; there is no migration.

- **A tap outside a popover reaches what is under it.** With the backdrop set
  to *none*, a tap outside a dialog used to close it and stop there, so moving
  from one machine symbol's popover to the next took two taps. Now that tap
  closes the popover *and* lands on what lies under it, so the next symbol's
  popover opens at once. A new **Tap through** switch in a dialog's **Overlay**
  section turns it off; a dimmed backdrop only ever closes, and a dialog that
  does not close on a backdrop press still ignores it. Opening the dialog that
  is already on top now swaps in the new input parameters and moves it to the
  new anchor, where it used to do nothing. Projects with backdrop-less dialogs
  change behaviour without a migration.

- **The numpad never writes when the operator backs out.** ×, a press outside
  the numpad and Escape now cancel the entry; only Enter writes, and only a
  value inside min/max. Number Input and Numeric Stepper used to save the typed
  value on × and on a press outside, and silently clamped an out-of-range entry
  — a typed 5000 reached the machine as the max, 200. Now the numpad refuses
  it and says why ("Enter a value between 80 and 200 ms"). An entry starts
  empty, with the current value as placeholder and a "Current setpoint" line,
  so a key replaces the value instead of appending to it. Both widgets get
  **Allow negative values** (minus is off anyway when min is 0 or more) and
  **Numpad position** (bottom right or center); Number Input also gets
  **Decimal places**. Numeric Stepper's **Decimal places** now also limits what
  can be typed, and an Integer variable never takes a point. The ± buttons
  still stop at min/max. **Custom widgets:** `VirtualNumpad` replaces
  `onClose(value)` with `onApply(value)` and `onCancel()`; a widget that passes
  `onClose` must switch.

- **Usage reporting says more, and still nothing about your projects.** The
  report now goes out every hour instead of once a day, and adds how NEXT HMI
  was installed, how long it has been running, whether the last run stopped
  cleanly, whether this installation has ever connected to a PLC, saved a page
  or been used over MCP, and the rough size of all projects together (0, 1–10,
  11–100 or more pages, tags and OPC-UA connections). No names, values or
  addresses are sent. [Usage reporting](docs/user/install.md#usage-reporting)
  lists every field; the switch and `NEXTHMI_TELEMETRY=off` work as before.
  An installation that has connected and saved a page is asked once, on the
  Projects page, whether it is used in a machine or product.

- **On/off widgets show "unknown" instead of "off" before a value arrives.**
  An **LED Indicator** shows an empty ring, a **Switch** a hollow track with its
  thumb midway — and it can't be pressed until it knows its state — and a
  **Menu Toggle** is dimmed with a dashed outline; pressing it still runs its
  actions but writes nothing. An empty text or an invalid number from a tag
  counts as no value too.

- **DateTime tags read as ISO 8601 UTC.** A Text widget bound to a DateTime tag
  showed `2026-01-02 03:04:05+00:00`. It now shows `2026-01-02T03:04:05.678Z`:
  the same form a write accepts and a recipe stores. The time is kept to the
  millisecond, so a recipe that captures a DateTime writes it back without its
  microseconds.

- **Very large 64-bit integers arrive as text.** An `Int64`/`UInt64` beyond
  ±9,007,199,254,740,991 reached the browser as a number and lost its last
  digits. It now arrives as its exact decimal text. Number fields still read
  it, and a recipe that captures it downloads it back instead of refusing it as
  lossy.

- **Browse PLC skips the server's own `Server` object.** A browse from the
  default Objects root no longer walks `Server` (`i=2253`): its capabilities,
  diagnostics and namespace table, hundreds of nodes with no PLC tags. Set
  **Browse Root Node** to `i=2253`, or to a node inside it, to browse it. A tag
  imported earlier from under `Server` stays as it is, enabled and bound.

- **`readNumberValue` is a reserved SDK name.** A custom widget that declares
  its own `readNumberValue` at module level no longer compiles until the
  helper is renamed. One declared inside a component or function is
  unaffected.

- **The test server refuses a type it cannot simulate.** It used to publish a
  Float for any type name it did not know. It now refuses to start, with the
  variable and type named; pick a supported type for that variable in the
  test-server editor, which marks the old one unsupported.

### Fixed

- **A user-group check works in page and global events.** An **If** in a
  page's `onOpen` or `onClose`, or in a global event such as `onPageLoaded`,
  saw no signed-in user, so `$userGroups` was always false: a "is this an
  admin?" guard turned the admin away too. Event actions now see the same
  signed-in user, translations and variables as a button's actions.

- **Counters beyond 2^53 drive numeric widgets.** Gauge, Progress Bar, Ring
  Gauge, Trend, Trend Chart, Numeric Stepper and Number Input read an
  `Int64`/`UInt64` value that arrives as text instead of showing `---` or 0,
  and Numeric Stepper shows, steps and accepts it exactly, across the full
  `UInt64` range, against a min/max given as exact digits too.
  Custom widgets get the same reading from the new SDK helper
  `readNumberValue`.

- **Unsupported test-server types are shown, not hidden.** A variable whose
  stored type the test server cannot simulate — a legacy `Integer`,
  `Duration`, or none — shows that type, marked unsupported, instead of
  **Float**; picking any supported type changes it.

- **Range checks agree on very large integers.** A write of an integer beyond
  2^53 is checked against the variable's min/max exactly in the runtime as
  well as on the server, for a struct field too, which the runtime now also
  checks against the member's own type.

- **A timestamp beyond year 1 or 9999 in UTC is refused.** A DateTime whose
  time zone pushes it past the first or last representable moment
  (`9999-12-31T23:59:59-01:00`) has no UTC form, which OPC-UA requires. It is
  now refused as an invalid value, in the runtime as well as on the server, and
  a recipe download containing one carries on with the rest.

## [1.0.1] - 2026-10-24

Fixes for OPC-UA browse and writes, most of them reported against CODESYS
Control and SIMATIC S7-1500. The project file format is unchanged.

### Changed

- **Single-precision tags accept ordinary setpoints.** A write to an OPC-UA
  `Float` tag — an S7 `Real`, a CODESYS `REAL` — was refused whenever the value
  was not exactly representable, so 19.9 or 48.2 could not be written at all.
  The value is now rounded to the nearest single-precision number, as the PLC
  itself does. A configured min/max is checked against the value as entered,
  before rounding. Values beyond the single-precision range and non-finite
  values are still refused.

- **Read-only comes first.** A write to a read-only variable now always reports
  *Variable is read-only*, even when the value would also have been rejected.
  The runtime's local pre-check reports it the same way.

### Fixed

- **A re-browse no longer marks tags it did not walk as removed.** A saved
  variable that the browse did not reach but that the server still has — one
  imported from outside the current **Browse Root Node** — is no longer listed
  under *Removed from server* or marked stale. If an earlier browse had marked
  it stale, it is reactivated.

- **On/off widgets read `"false"` as off.** An **LED Indicator**, **Switch** or
  **Menu Toggle** bound to a text tag lit up or switched on for any non-empty
  text, `"false"` and `"0"` included. They now read `"false"`, `"0"`, `"no"`
  and `"off"` as off, as the rest of NEXT HMI already did. An empty text stays
  off.

- **The test server matches type names regardless of case.** A test-server
  variable typed `int32` or `BOOLEAN` — hand-edited, or from an older
  configuration — was published as a Float. It now gets the type it names, and
  `Single` is accepted as a Float.

- **A read-only variable without a type reports read-only.** A write or toggle
  to a variable that has no data type and is not writable reported *invalid
  value*; it now reports *Variable is read-only*, as the runtime's local
  pre-check already did.

- **Static datasources accept DateTime, Date and Time.** Picking one of these
  types for a static variable made the datasource impossible to save
  (*Unknown data_type 'DateTime'*). They are accepted now, along with every
  other type a write can target. A DateTime starts at
  `1970-01-01T00:00:00.000Z`, a Date at `1970-01-01`, a Time at `00:00:00`.

- **Decimal tags are no longer imported as Double.** Browse PLC labelled a tag
  of the standard `Decimal` type as **Double**, and every write to it was
  refused by the server. It now imports as **Decimal**, as does a server type
  derived from it.

- **Duration and timestamp tags import as values, not folders.** A tag typed
  with one of the standard's derived types — `Duration` (a CODESYS `TIME`),
  `UtcTime`, `Counter` — was reported as a struct by Browse PLC, so it arrived
  as a folder or as a String. It now gets the type it derives from: **Double**,
  **DateTime**, **UInt32**.

- **A tag typed `Int` shows as a number.** It was written as an integer but
  shown and bound as a String.

- **Writing one element of a DateTime array no longer fails.** The other
  elements were sent back to the PLC as text, and the PLC refused the whole
  array.

- **A custom widget may name a local helper after an SDK function.** A helper
  declared inside a component or function with the name of an SDK global —
  `getPropNumber`, say — made the widget fail to compile, although it only
  shadows the global there. Only a module-level declaration with such a name
  is refused now.

- **Writes use the type the PLC actually has.** A tag imported with the wrong
  type — **Unknown** after a failed browse, **String** for an enum, **Float**
  where the PLC declares **Double** — was refused on every write, or never
  attempted at all. Writes now follow the type the server sends, while a type
  you chose that only refines it, such as **Date** on a string tag, keeps its
  own validation.

- **Browse PLC no longer lists methods as folders.** A method a PLC publishes —
  a TwinCAT POU method, the `Reset` on a device object — appeared in the
  variable table as an empty folder, and one with arguments added its
  `InputArguments` and `OutputArguments` as bindable tags. Browse now walks
  objects and variables only.

- **Text-typed tags show their text.** A localized text — the type of many
  status messages and of the manufacturer and model a PLC publishes about
  itself — showed on screen as `LocalizedText(Locale='de', Text='Tür offen')`
  rather than `Tür offen`. Node ids and qualified names had the same problem.

- **A verified write to a DateTime tag no longer always fails.** Verification
  compared the written date with the form the cache stores it in and never
  found them equal, so a recipe downloaded with verification reported every
  DateTime parameter as mismatched even when the PLC held the right value.

- **The connection wizard no longer offers endpoints it cannot use.** Many PLCs
  still advertise the deprecated `Basic128Rsa15` and `Basic256` security
  policies. Discover listed them as ordinary choices, and picking one failed
  only at the connection test. They are now shown greyed out and never
  pre-selected, and a server that offers nothing else says so.

- **Browse PLC now finds the members of a struct.** A struct tag stopped the
  browse: the struct showed up as a single row typed **String**, with nothing
  inside it to bind, so a tag like `Battery.SOC` could only be added by typing
  its node ID by hand. Every member is now walked — nested structs included —
  and the struct arrives as a folder holding them. Tag metadata the server
  publishes alongside the members (`EURange`, `EngineeringUnits`) stays out of
  the variable table. Reported against SIMATIC S7-1500 and CODESYS, and it
  affected every server that publishes structs this way.

- **PLC enums and derived types import with their real type.** A CODESYS
  `ENUM`, or any tag whose type the PLC derives from a builtin, showed up as
  **String**. Browse now follows the type back to the builtin it derives from,
  so an enum imports as **Integer** and a derived string as **String** — and
  only a genuine struct is opened up into a folder.

- **Browse PLC now reads types from servers that limit a read request.** A
  server may cap how many operations one request may carry, and refuses a
  larger one outright — CODESYS Control Win V3 caps it at 100. Browse reads
  four attributes per variable, so from 26 variables on a level it asked for
  more than CODESYS allows and got nothing back: every variable on that level
  imported as **String** with an **Unknown** badge, read-only, and structs were
  listed flat with no members to bind. NEXT HMI now reads each server's limits
  when it connects and keeps every browse, value read and subscription inside
  them, and splits a request a server refuses anyway rather than losing the
  types. Affects any server that advertises `OperationLimits`; CODESYS symbol
  configurations were hit hardest.

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
