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

- **Filter a list as the operator types.** `$compare` gains **contains**
  (∋): true when the left text holds the right one, ignoring case, and always
  true for an empty right side. Compare a list row's **Visible** against a
  String Input's value and the list narrows with every keystroke, without a
  custom widget.

### Fixed

- **A Repeater over a PLC array that counts from 1.** Over a struct array
  `A[1..500]`, the first two copies both showed `A[1]` and `A[500]` was never
  drawn. A copy now shows the element at its position, counted from 0 as the
  array value is, so the first copy is `A[1]`. A struct binding's fixed index
  counts the same way: on an array that counts from 1, index `1` is now
  `A[2]`. The warnings pill judges a binding on the same element.

## [1.2.0] - 2026-11-08

Opens the HMI to the systems around it and shuts out the ones that should not
reach it: API v1 for a MES or badge reader, tokens under Settings › Tokens, bit
bindings and a `Byte` type for status words, and an editor that keeps up with
an AI assistant's changes. It also adds a Data Grid, project value maps, page
inputs and dialogs that move. Projects move to file format 12, where every
input is a Value or a Binding. Read **Changed** before you update: a reverse
proxy must pass the browser's `Host` with its port, an `$http` URL that takes
its server from a placeholder needs that server listed, and a formula passed
into a dialog or component is now read once.

### Added

- **Move a dialog, and keep working beside it.** A dialog's Overlay section
  gains **Draggable**: the operator drags it by its header bar, which never
  leaves the screen, and it stays there until it closes. **Background usable**
  keeps the screen under the dialog working — no dim, presses beside it reach
  the screen and do not close it — and keeps the dialog open, where it was
  put, when the operator goes to another page.
- **Restart the HMI from a button.** A new action, **Reload HMI**, reloads
  the HMI in this browser as a page refresh does. Other panels and the server
  keep running.
- **Size a Button's text.** A Button gains the Label's **Typography**
  (Heading to Caption) and **Overflow** (Wrap or Truncate), so a narrow
  button can take a smaller caption or cut its text off with an ellipsis.
  Unset, a Button looks as it did.
- **A live Trend Chart keeps a fixed time base.** With **Data source: Live
  buffer** the time axis always spans the last **Live window (s)** seconds up
  to now, and a line whose value holds still runs on flat to now instead of
  stopping at its last change. A change draws as a step, not as a ramp from
  the change before it.
- **Turn an Icon or an Image.** Both gain **Rotation (°)**, clockwise and
  bindable, so one asset shows in every orientation instead of a rotated copy
  per angle. An Icon turns its glyph inside the chip; an Image turns the
  picture under its indicators.
- **Stack widgets on top of each other.** A Container's **Direction** gains
  **Stack** beside Row and Column: every child sits in the same spot, drawn
  over the one before it, and the Container is as big as its largest child.
  Align and Distribute place the children, a Fill child stretches over the
  whole Container; hide one and the one below shows.
- **Build a tab bar from your own Buttons.** Three actions switch the pages of
  a page group: **Page Group: Next**, **Page Group: Previous** and **Page
  Group: Go To**, whose index is a number, a PLC variable or a dialog input.
  They work on the group the Button sits in, or its parent: in the main screen
  they change the page, in a dialog group the tab, and the dialog stays open.
  Next and Previous do nothing on the last and first page. `$page` gains
  **Page group index** and **Page group last index**, counted from 0, so a tab
  Button lights up with a `$compare` and Next greys out on the last page.
- **Value maps: define a lookup once, use it everywhere.** Under **Value
  Maps** in the editor tree, below Global Events, a map turns a value into a
  colour, a text, a number or a Boolean — alarm severity 2 into the warning
  colour, machine state 3 into the translated word for "Fault" — with a
  default for anything else. A property picks **Value Map** as its source, the
  map and the tag it looks up; only maps of the property's type are offered,
  and one that is gone or of the wrong type shows up in the diagnostics.
  Right-click a map to rename it in the tree, duplicate or delete it; a new
  name, there or in its **Id**, carries over to every property that uses it.
- **A String Input can show and edit a variable.** Bind its **Variable** to a
  String tag, a page input or a dialog input: the field shows that text and
  writes what the operator types back to it, on Enter or on leaving the field,
  or on every key with **Write on** › **Every key** — a search field that
  filters a Data Grid as the operator types. **Value** sets what an unbound
  field starts with.
- **Drag a list's rows by their ⋮⋮ grip.** Every list whose order matters —
  actions, Switch / Case cases, value map cases, Navigation Menu items, Trend
  Chart variables, recipe parameters, Dropdown options and Data Grid columns
  — now has a grip in the margin before each row, so the row itself keeps
  its place and width; in the panel's one-line option and column lists it
  shows on the row under the pointer or with keyboard focus. Drag it, or
  focus it and use Space and the arrow keys. Actions, cases and menu items
  could not be reordered before; the others lose their up and down buttons.
- **A Data Grid shows an array as a table.** Bind **Items** to a struct array
  from the PLC — a recipe list, an event log — and list the **Columns**, one
  line each in the panel and one row each in its drawer: a member picked from
  the struct, a title from any source (text, a translation, a tag, a formula),
  a width that fills or is fixed in px, and an alignment. Only the rows in
  view are drawn, so a list of 500 scrolls smoothly; the header stays put. A
  click on a header sorts on that column. **Filter member** and **Filter
  value** show the rows that contain a text, and **Hide empty** drops the
  unused slots of a fixed array. A picked row is published as **Selected
  Item**, **Index** and **Value** — the Value member as the row holds it, so a
  number id writes to an Integer tag — a bound **Selected value** picks and
  scrolls to its row, and **On Select** reads the picked row through Repeat
  Item.
- **The LED Indicator's colours can be changed.** It was always green when on
  and grey when off. Two new properties, **On color** and **Off color**, take
  a theme colour or any other colour; left unset they follow the theme's OK
  and Muted Text colours. Off used to be the much lighter Border colour, so an
  LED that is off now reads clearly on a white surface.
- **Bind one bit of a status word.** Where a field takes a Boolean, the
  variable picker has a **Bits** box: tick it and every 8-, 16- or 32-bit
  whole-number tag opens onto its bits, `Bit 0` the lowest. A picked bit shows
  as `Plant:Battery/Status.5`, lights an LED, and is written by a button or a
  toggle: the server reads the whole word fresh from the controller, changes
  that one bit and writes the word back.
- **Formulas read bits and mask words.** A formula takes `{1}.3` for one bit,
  `AND`, `OR`, `XOR` and `NOT` on whole numbers, `SHL(x, n)` and `SHR(x, n)`,
  and hex and binary numbers such as `16#0F` and `2#1100`, in Structured Text
  order. A Boolean value counts as 1 or 0. A link under the expression opens
  the new formula reference in the user guide.
- **`Byte` is a type of its own.** An OPC-UA `Byte` tag, and a static
  variable of the new **Byte** data type, show their live value in hex
  (`16#0C`) in the datasource table, and are taken by a formula and a Value
  Display.

- **API v1 for other systems.** A MES, BI tool, HR system or badge reader
  can read historian samples, alarm history and recipes, manage the
  project's users, and sign operators in and out on named panels over a
  versioned HTTP API at `/api/v1/projects/<id>/…`. It answers JSON or CSV,
  works on a stopped project too (except panel sign-in), and keeps its routes
  and field names for as long as v1 exists. Give each system an API token
  with only the scopes it needs, or use the device-admin password over HTTP
  Basic, username `admin`, for your own scripts. A project user's password
  never works as an API key. A user change reaches a running project's
  screens at once, and an open editor is told before it saves over it. See
  *Connecting other systems (API v1)* in the guide.

- **Named panels.** Open a runtime with `?panel=<name>` at the end of its
  address, and another system can sign an operator in or out on it over
  API v1, with that operator's own password. Screens opened with the same
  name are signed in and out together. The name proves nothing about which
  screen it is: anyone who opens the same name receives the same sign-ins,
  so use it only on panels on a trusted network.

- **Tokens under Settings › Tokens.** Create and revoke MCP tokens (read,
  or read and write) and API tokens (per scope) on the dashboard's Settings
  page instead of over `curl`. A new token is shown once, with the server URL
  and client JSON any MCP agent can use, or a `curl` example for an API
  token. `POST /api/manager/mcp/pair` with the device-admin password still
  mints one for a script. Bearer tokens are the MCP sign-in model; no OAuth
  step is planned.

- **Admin › HTTP sources.** The editor's Admin area lists the servers an
  `$http` URL may reach when it takes its server from a placeholder; see
  **Changed**.

- **What is reachable without a password.** A new page in the guide lists
  everything someone on the network can see and do with no password, what
  the device-admin password, API, MCP and peer tokens add, and how to place
  the device on the network.

- **`sendWsMessage` says whether it sent.** The widget SDK's
  `sendWsMessage` returns `true` when the message went out and `false` when
  the live connection is down.
- **Pages have inputs, and Navigate To Page fills them.** A page or page group
  in the Pages section declares **Inputs**, always Values. A **Navigate To
  Page** to it gets one field per input — any source, read once in the screen
  that navigates; one left empty gives the page its default. After that the
  input is the screen's own: a search box can write it and the list below can
  filter on it, and a second panel showing the same page keeps its own.
  Arriving any other way — a menu, a Tab Bar, a Page Group action, the
  browser's back button or a refresh — starts at the defaults; a page group's
  inputs last while the operator moves between its pages. The page's and
  group's Open and Close events read the inputs as the page's widgets do.
  Nothing is stored on the server or in the URL.
- **A component can take an option list.** A new input type, **Options**,
  passes a list of label and value pairs. Set a Dropdown's or Button Row's
  **Options** inside the component to that input, and each instance offers
  its own list. The widget SDK has `useOptionListProp` to read one.
- **A Dropdown can stop at a maximum.** A new **Max index** property shows
  the options up to and including that position, counted from 0. Bind it to
  a controller tag to offer only the choices the machine allows; left empty,
  every option shows.

### Changed

- **Component Property is now Input, Exported Property is Widget Property.**
  Each source says in one line what it reads. The block that declares them is called **Inputs**
  on a component, a dialog and a page alike (it was Component Properties,
  Input Parameters and Page Variables). Both sources open one picker with an
  **Inputs** and a **Widget Properties** group, so a field switches between
  them by picking a row. Project files do not change.
- **A page's Inputs sit under its title.** A page's or page group's
  **Inputs** — a dialog's too — moved from the bottom of the panel to the
  bottom of its **Page** section, under an **Inputs** title; a component's
  sit the same way at the bottom of its **Identity** section. Each line shows
  the input's name, type and default; › opens the rest.
- **A placed component sets its Inputs.** The section of a component
  instance's panel where its inputs get their values is titled **Inputs**, not
  **Properties**, as in an Open Dialog or Navigate To Page action.
- **A source badge opens the source drawer.** Clicking a field's source
  badge slides in the same drawer the action list's **Add** opens, with a
  search and a line on each source; the short menu in between, with its
  **Browse property sources…** row, is gone. A field with one source opens
  nothing.
- **Numbers read with a decimal comma.** Every number the HMI shows — Value
  Display, Gauge, Ring Gauge, Progress Bar, Trend, Trend Chart, Number Input,
  Numeric Stepper, Data Grid cells, `{1}` in a Text Expression, a Localizable
  Text or an alarm text, and any text bound straight to a number, such as a
  Label's or a Stat Tile's — reads `1234,5`, and a Number Input no longer groups
  digits. The numpad has a comma key instead of the point and still writes a
  plain number, and a custom widget's numpad still hands it the entry with a
  point; `Thousands` groups with a point. Saved projects, API requests,
  the values sent to the PLC (a Write Data Variable's Text Expression too),
  the URL or source of a Web Frame, Video or Image, a String Input's text and
  the selection of a Dropdown, Button Row or Data Grid keep the decimal point.
- **Every input is a Value or a Binding (breaking).** An input of a component
  or a dialog has a **Kind**; a page's is always a Value, and the warnings
  pill flags a Binding declared on one. A Value takes anything, is read once
  when the dialog opens or the instance appears, and is then that screen's or
  instance's own: a Write, Toggle or input field changes it there and nothing
  goes back. A Binding takes a variable only, stays live and writes to the
  controller. A Binding given a fixed value or a formula is flagged in the
  warnings pill. Opening a project moves it to file format 12 and works out
  each input's kind: a Binding where every opener or instance passes a
  variable, a Value otherwise. A formula that was passed in and kept computing
  inside a dialog is now read once; the warnings pill flags each case. To keep
  it live, pass the variable as a Binding and compute inside, as the NEXT BREW
  example's Metric Row now does. **Start** asks to upgrade a project the first
  time 1.2.0 opens it, zipping it into `.backups/` first; a 1.1.x build then
  shows **Requires update** and names 1.2.0 as the version it needs.

- **A `Byte` tag no longer fits a field that takes an Integer.** An OPC-UA
  `Byte` — a Siemens `BYTE` or `USINT` — used to arrive as an Integer. It is
  now a `Byte`, which only a formula and a Value Display take, so a Byte tag
  bound to another number widget, an alarm, a recipe parameter, the historian
  or a trend is now flagged in the warnings pill.

- **One MCP token covers every project.** A token used to name one project;
  now it reaches all of them, at the access level it was made with. MCP
  writes still go through only on projects with **MCP write enabled** ticked,
  the dashboard switch that was labelled **MCP enabled**. A token paired with
  1.0 or 1.1 named one project and is refused rather than widened: create a
  new one under **Settings › Tokens**. `POST /api/manager/mcp/pair` no longer
  takes a `projectId`, and answers `422` when a script still sends one.

- **The server no longer limits who may write a variable.**
  Per-variable write groups (`interactableByGroups` on a datasource
  variable) are gone. A write, a toggle and a recipe load are refused only
  when the variable is not writable, and the `permission_denied` write error
  no longer occurs. A project that still carries the key opens unchanged and
  the key is ignored. To stop a group changing a value, block or hide the
  button that writes it (**Interactable** or **Visible** → `$userGroups`),
  and mark the variable read-only in its datasource when no screen needs to
  write it. Anyone who can reach the panel can write the writable variables,
  so keep the runtime on a trusted network.

- **Alarms are acknowledged over the live connection, in the name of who is signed in.**
  `POST /api/alarms/ack/{id}` and `POST /api/alarms/ack-all` are removed.
  An acknowledgement records the user signed in on that screen, or `guest`,
  never a name the caller sends.
  The Alarm List, the alarm pop-up and **Acknowledge All Alarms** work as
  before. A custom widget that called those routes itself uses the SDK's
  `ackAlarm` / `ackAllAlarms` instead; their `username` argument is still
  accepted and ignored.

- **The live view gets the user roster, not the users file.**
  `GET /api/users` now needs the device-admin session, and carries
  `passwordSet` for each user. The live view reads the new public
  `GET /api/users/roster`: usernames and group names, without who is in
  which group. A custom widget or script that read `/runtime/<slug>/api/users`
  reads the roster, or API v1 `GET …/users` with a token, instead.

- **An `$http` URL that takes its server from a placeholder needs that server listed.**
  `http://{1}/api/status` used to reach any server but the HMI's own
  machine. It now reaches only the servers listed
  under **Editor › Admin › HTTP sources** (scheme, server and port), and is
  refused until the list holds its server; the warnings pill flags such a
  URL while the list is empty. A local address is always refused there. A
  URL with a fixed server works as before.

- **Behind a reverse proxy, pass the browser's `Host` with its port (breaking).**
  The device now refuses a change or a live connection whose
  browser page came from another address. A proxy that rewrites `Host`
  makes every request look like that, so nothing can be changed and no
  value arrives. Caddy and Traefik pass it by default; nginx needs
  `proxy_set_header Host $http_host;`, since `$host` drops the port. The
  proxy must also send `X-Forwarded-Proto`, and a proxy on another host
  must be listed in `NEXTHMI_FORWARDED_ALLOW_IPS`.

- **Changes from the editor are recorded as `engineer`.** A value written,
  a recipe loaded or saved, or an alarm acknowledged in the editor's Test
  mode is recorded as `engineer`, whichever project user the preview is
  signed in as: the editor sits behind the device-admin password, not a
  project user.

- **Signing out on a screen returns to the auto-login user.** A **Logout
  User** action, and a sign-in on one monitor of a panel that another
  system signed in over API v1, dropped the screens to `guest`. They now
  return to the project's **Auto-login user**, as a newly opened screen and
  a sign-out over API v1 already did. **onUserLoggedIn** and
  **onUserLoggedOut** now fire on a real sign-in and sign-out instead of on
  a change from or to `guest`, so they also work when the auto-login user
  is a real user, and no longer fire when such a screen opens.

- **Recipe download takes no credentials.** `POST
  /api/recipes/datasets/{id}/download` ignores HTTP Basic credentials; they
  only fed the write groups. Upload still takes them, to record who saved.

### Removed

- **`GET /api/users/credential-state`.** `GET /api/users` carries
  `passwordSet` for each user instead.

- **The alarm setting Allowed groups.** It never limited who could
  acknowledge an alarm: anyone at the screen may, signed in or not. A
  project that still carries it (`ack_groups`) opens unchanged and drops the
  key on the next save, and alarms reach custom widgets without it.

### Fixed

- **Escape closes one drawer at a time.** With a drawer opened from inside
  another — a source picked for an option's label, or for a field of an
  action in its own drawer — one Escape closed both, and with the cursor in
  the drawer's search the first Escape did nothing. Now Escape closes the
  top drawer only; in a search with text it first clears the search.
- **A sidebar shrinks with its menu.** Collapsing a Navigation Menu with
  its « button left a sidebar with a fixed **Expanded size** at that width,
  with the icons in a strip at its edge. The sidebar now fits the collapsed
  menu and takes its size back when the menu opens. Collapsed, the icons keep
  the link's side padding instead of touching the edge.
- **A widget's value in a component reads as bound.** In the components
  editor a working **Widget Property** source, such as a Dropdown's
  Selected Value, showed *Not bound*: the picker knew only a page's widgets,
  not the open definition's. It now names them as on a page.
- **Open Dialog fills a group's inputs.** The action listed only the inputs
  the dialog page declares, and validation warned about any other,
  so an input its page group declares could not be set. Both now include the
  inputs of every group the page sits in.
- **Chart tooltips show on the HMI.** Hovering a Trend Chart showed no
  tooltip at runtime; charts ignored the pointer everywhere, not only on the
  editor canvas, where a click must select the widget.
- **Write Data Variable shows every value.** A value taken from another
  widget, a formula or a variable had no row in the editor, so it could be
  neither seen nor changed there. It now shows in the action like any
  property value.
- **A Button reads what was just typed.** Pressing a Button while a String
  Input still held an unsaved edit ran the Button's actions before the edit
  was written, and a Button that closed the dialog lost the edit. The field
  now writes first.
- **On Change reads the option just picked.** A Dropdown's or Button Row's
  On Change that read the widget's own selection through **Widget property**
  got the one picked before. Dropdown and Button
  Row also publish the option's own value now, so a numbered list writes a
  number to an Integer tag, and the warnings pill no longer says a String
  does not fit it. Their **Selected value** binds an Integer or Float tag
  too, and selects the option holding the tag's value.
- **A translated option label shows its text.** A Dropdown or Button Row
  option whose label was a translation showed `[object Object]`. Every label
  is now read like any other property, so a translation shows in the active
  language. The options list editor showed it as `[object Object]` too, and
  showed a number value as an empty cell. The panel now lists one line per
  option — the value first, then the label — reordered by dragging; a click
  opens the option in the panel's drawer, where the label takes
  Static or Localizable Text from its source badge and the value is typed.
- **An AI assistant on another machine can reach MCP.** `/mcp` answered
  every client that did not address the HMI as `localhost` or `127.0.0.1`
  with `421 Invalid Host header`, so an assistant on a laptop on the plant
  network could not connect. It now answers any address the HMI is reached
  by; a token or the dashboard sign-in is still required.
- **An open editor keeps up with changes made elsewhere.** An editor tab
  heard nothing of what another editor tab saved, and of an AI assistant's or
  API v1's change only through a banner asking for a reload. With nothing
  unsaved it now shows the change straight away, without a reload, on the
  page you have open; with unsaved edits it shows the banner, so you choose.
  Every save in the editor now announces itself, so a second tab finds out
  too. A recompiled custom widget follows the same rule: the editor reloads
  for it, or shows the banner first when you have unsaved edits, where it
  used to reload straight away. The live view shows a change after a browser
  reload — a recompiled widget and a theme saved in the editor no longer
  reload or repaint an operator's screen by themselves, and an icon rewritten
  over MCP is no longer refetched the next time it mounts there, as it was in
  1.1.0.
- **A Localizable Text field no longer shows text it will not save.** Typing
  in it searches the translation keys; a key is set only by picking one or
  adding it with **+ Add**. Clicking away or pressing Escape left the typed
  text in the field, where it read as the new value while nothing was marked
  unsaved and Save wrote nothing. The field now goes back to the key it holds.
- **Saving in the editor no longer overwrites what an AI assistant changed.**
  An editor tab that stayed open while an assistant worked over MCP wrote
  every page back on its next save, so the assistant's widgets disappeared
  again, and a page it had created was deleted. A save now writes only the
  pages you changed, and is refused when the same page or the page list
  changed since you loaded it, so you reload instead of losing the other
  edit.
- **Alarms an AI assistant adds over MCP go off without a restart.** An alarm
  written through the MCP server landed in `alarms.json`, but a running
  project kept evaluating its old alarm list, and the editor and runtime kept
  showing it, until the project was restarted. A running project now picks up
  added, changed and deleted alarms straight away.
- **An alarm acknowledgement says why it failed, at once when offline.** The
  message reads as a sentence for an alarm that is gone, a timeout, alarms
  being unavailable and a lost connection, and an acknowledgement pressed
  while the connection is down fails straight away instead of after 10 s.
  `onError` still gets the raw code.
- **Double-clicking a page group in the editor's tree pins its tab.** A click
  on a group shows its first page in the temporary tab, but a double-click
  left it temporary, while on a page it pins the tab. It now pins that first
  page too.
- **A component or dialog input stays live inside a formula.** An input read
  inside an `$if`, `$compare`, `$not`, `$switch` or string expression, or on a
  Layout field, showed its first value and then stopped following the tag. It
  now updates like an input used as a whole value, so a dialog given one
  device folder can work out its own colours and texts with
  `$componentProp: device/Run`. The warning "`$componentProp` is only
  substituted as a property's whole value" is gone with it.

### Security

- **Other websites can no longer reach the live view.** A web page from
  another site, open in a browser on the panel or on the same network,
  could open a running project's live connection and read and write values,
  or send its public requests. The manager and every project instance now
  refuse a live connection and every change whose browser page came from
  another address. Scripts, which send no page address, are unaffected. A
  site that points a name of its own at a project's internal port (DNS
  rebinding) is refused too; one that points it at the device's own address
  still gets past the check, to the open part only; keep the network trusted. The same check covers `/mcp` and
  API v1: an MCP or API client running inside a web page on another address
  is refused, while desktop and command-line clients are not.

- **An `$http` URL no longer opens the plant network to anyone.** A URL that
  took its server from a placeholder let anyone who reached the live view
  have the HMI call any server on the plant network. See **Changed**.

- **Who belongs to which group stays behind the password.** The public user
  list carried every group membership; the roster carries none.

- **An alarm acknowledgement records who really gave it.** The public
  acknowledgement routes recorded whatever username the caller sent.

- **Recipe loads and REST writes are recorded.** In a build that keeps a
  record of who did what, every recipe load that writes a value is now
  recorded with who loaded it: on the live connection the signed-in user,
  and through `POST /api/recipes/datasets/{id}/download` `guest`, or
  `engineer` from the editor. A variable written through
  `POST /api/datasources/write` is recorded like one written on the live
  connection: as the signed-in user, or `engineer` from the editor. User changes and panel sign-ins over API v1 are recorded under
  the token's name, or `admin` for the device-admin password.

- **`$device` no longer looks up an address the caller picks.** The device
  info route believed an `X-Forwarded-For` header the browser wrote, so
  anyone could make the device reverse-resolve and ARP-look-up any address,
  and a value starting with `-` reached `arp` as an option. It now uses only
  the address the connection came from, refuses anything that is not an IP
  address, and the manager forwards that address itself. This also fixes
  `$device` reporting `127.0.0.1` on every screen behind the manager.

- **A request header can no longer put a script into the page.** The
  manager passed a client's `X-Forwarded-Prefix` header on to the project,
  which wrote it unescaped into the page it returned. The manager now drops
  it, and the page escapes what it writes into its scripts.

- **A deleted user is signed out at once.** A user deleted while signed in
  on a running project's screen stayed signed in, and a regrouped one kept
  the old groups, until the screen signed out. Saving users in the editor or
  over API v1 now signs a deleted user out on every screen, back to the
  auto-login user, and gives a regrouped one the new groups. A changed
  password signs that user out the same way, and a reloaded screen can no
  longer resume a sign-in made with the old one.

## [1.1.0] - 2026-10-31

Built for touch panels at the machine: a numpad that refuses what it should,
richer Buttons and two new widgets, live values in alarm text and translations,
and actions on a variable change. Projects are upgraded to file format 11 on
first start, after you confirm it and a backup is taken, and no longer open in
1.0.x — see **Changed**.

### Added

- **The editor opens each project at its own viewport.** The preview's
  viewport choice and custom width and height are saved in the project with
  **Save**, so everyone who opens it gets the same frame. Scaling stays
  per session.

- **Actions on a variable change.** **Global Events** gets a **Variable
  Changed** list: each trigger names a variable and runs its actions whenever
  that value changes, and once at start-up. Put an **If** on the same
  variable around the actions to react to one value, such as opening a dialog
  when a Boolean goes high. Each open screen runs its triggers itself. MCP
  clients read and write global events with `global_events_get` and
  `global_events_set`.

- **A Number Input says why it refuses a value, and acts on a change.** An
  **Out-of-range message** is what the numpad says when the entry falls
  outside min/max, so a limit that depends on another setting can say "Must
  lie outside the 10 g band". **On Change** runs its actions after each value
  the operator applies, such as a toast that the change is not saved yet.
  Custom widgets get the message through the SDK numpad's new `rangeMessage`
  prop.

- **A Delay action.** **Delay** waits a number of milliseconds, then runs
  the actions after it. A write goes to the PLC and back; a **Show Toast**
  after a short Delay reads the value the PLC confirmed, so it can say *Lower
  limit set to −25 g*.

- **A screen can mark each setting that differs from the saved recipe.**
  `$recipe` gets two per-parameter fields: **Parameter changed**, true while
  that one live value differs from the loaded dataset, and **Saved value of a
  parameter**, the stored value itself. Bind a Number Input's new **Value
  color** to the first to turn an unsaved value amber, or list "saved → live"
  rows that show only while they differ. **Number of changed parameters**
  and **Saved at**, formatted like the clock, give a heading such as *3
  unsaved changes · last saved 08:45*. Each `$recipeList` row now also
  carries the dataset's `values`, so a recipe list shows its target or
  quantity without a custom widget.

- **A translation can hold live values.** Write `{1}`, `{2}` in a phrase,
  `Tank {1} of {2}`, and translate it as a whole sentence, `Tank {1} van
  {2}`. Picking that phrase in a **Localizable Text** field opens one row per
  placeholder, to fill with a fixed value, a tag or another translation; each
  language puts the values where its grammar wants them. An alarm's title and
  description keep filling `{1}`, `{2}` from the alarm's own values.

- **The numpad and keyboard show icons, not English words.** Back, Clear,
  Enter, Shift, Caps Lock, Tab and Space are icons, and an entry outside the
  bounds turns the `Min: 80 · Max: 200` line into a red warning. *Min* and
  *Max* are dictionary keys, English as on any screen, so a project
  translates them by adding those rows.

- **A shell region can float over the page.** A new **Floating** setting on
  the header, footer and both sidebars lays the region over the page instead
  of next to it: the page fills the space underneath, the region is
  transparent unless it has a **Background**, and a click on its empty space
  reaches the page. Widgets in the region, a Button Container included,
  still take their own clicks. Bindable, like the other region
  settings.

- **Show all and value types in the property-source drawer.** Each source card
  now names the type it produces (`Any`, `Boolean`, `Float, Integer`, …). A
  **Show all** checkbox lists the sources the field does not take as well,
  greyed out and marked *Not available on this field*; they cannot be picked.

- **A Linux zip and an offline Docker installer in every release.** Next to the
  Windows and macOS zips, a release now carries `nexthmi-community-linux-x64-<version>.zip`
  and, per architecture, `nexthmi-community-docker-linux-<arch>-<version>.zip`: the image
  as a file, a compose file and `install.sh`, for a machine that cannot reach a
  registry.

- **A guide to shipping it on a machine.** *Shipping it on a machine* in the
  user guide covers which build ships, activation on the commissioning bench,
  locking the installation down and what to hand the customer. The manager's
  System Information names the edition and links to it, and in the community
  build the editor's Branding section and the contact card point at what the
  enterprise build adds and what shipping costs.

- **A Repeater places its copies on an Image Container's image.** With
  **Place copies** set to **At item x / y**, each copy is drawn at the point
  its element names (`x` and `y`, 0 to 1 across and down the image), and an
  optional `side` puts it on one side of that point with its last widget on
  it, so one callout design serves every edge of a machine. The element's
  other fields reach the copy through Repeat Item, also as the index of an
  array tag. Items take a typed-in list of records through **Edit as JSON**,
  and the warnings pill flags an element it cannot place. Positions are
  edited in the list; the copies are not dragged on the canvas.

- **Navigate To Page goes to a page chosen at runtime.** The new action
  closes every open dialog and overlay, then goes to a page from the Pages
  section, firing the page events a menu press would. The page is fixed, or
  — inside a dialog — an input parameter of the new type **Page**, which
  the Open Dialog action fills in with a page picker: one station popup's
  *Open station page* button then leads to each caller's own station. The
  warnings pill flags a page that does not exist, one in the Dialogs folder,
  and an input that is not declared as a page.

- **Alarm text can show live values.** An alarm gets a **Values** list of
  variables, numbered `{1}`, `{2}` …, and those placeholders in its title and
  description show them, with the same functions a String Expression takes
  (`{Round1(1)}`, `{Signed(2)}`). While the alarm is active the text follows
  the live value; once it has cleared, and in the alarm history, it shows the
  value from the moment the alarm went off. A value can be a member of one
  element of a struct array, or one element of an array, also with its index
  bound to another value; the stored value is the element the index named
  when the alarm went off. History rows from before this release show `—`.

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

- **Buttons can be icon-only, stacked, and sized.** A Button with an icon and
  an empty label is icon-only: it takes even padding on every side so it sizes
  to a near-square tile. The Button also gets four properties: **Icon
  position** (left, or on top with the text below), **Icon size** and
  **Border width** in pixels, and a **Fill** colour for the outline style.
  Each one left at its default keeps today's look.

- **AND (`$and`) and OR (`$or`) combine conditions.** Two new Boolean
  sources take a list of conditions — a variable, a comparison, an Invert, a
  group check, another AND / OR — and are true when every one, or any
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
  toggle. A field that takes one value, bound to a whole array — a property,
  a **Toggle Boolean Variable** or **Edit Value** target, a String Expression,
  HTTP Request or alarm placeholder — gets an index box right under the
  variable, headed by a light *Element of the array, 0 to 4* hint, that asks
  for the element: a number, or any whole-number source, including another
  variable. On a **Write Data Variable** target the row is
  optional, and empty writes the whole array. An element picked in the picker
  shows in the path instead, with no row. An index that is empty or past the
  end reads nothing and a write fails with `array_index_out_of_bounds`, never
  the whole array.

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

- **A Badge widget.** It wraps one widget and puts a chip on its top-right
  corner — a text or a count such as an Alarm Count, hidden when empty or 0.
  The chip sits centred on the corner, half outside; **Offset** moves it in or
  further out, and **Color** and **Size** set its look.

- **Buttons act on release too.** A new **On Released** list
  runs when the press ends — on lifting the finger, on a cancelled touch, or
  on the key coming back up — and a Button's new **Momentary** switch writes
  its **Variable** false again then, so it is true only while held, as a jog
  button needs. Keep a watchdog in the PLC for anything that moves: a release
  the panel never sees, such as a dropped connection, leaves the value true.

- **A Button Container.** A Container that is one control around whatever
  it holds — a tile, a list row, a header logo — with the Button's **On
  Pressed** and **On Released**. It takes the keyboard (**Enter** or
  **Space**), shows the focus ring and a pressed look, and dims and blocks
  under **Interactable** like a Button. A press on a Button or an input inside
  it stays with that control.

- **A Run Component Actions action.** Inside a component it runs the actions
  each instance sets on one of the component's **Actions** properties, as one
  item in the list next to the others.

- **A Button sets its alignment and text case.** **Content alignment**
  (center, or start for a menu-style tile) and **Text case** (uppercase). A Label's **Align** is now
  called **Content alignment**, and its new **Text case** follows the
  typography by default or picks *As typed* or *Uppercase*. Each one left at
  its default keeps today's look.

- **The Alarm List fits a touch panel.** Six new options: **Row size** (Touch
  gives tap-sized rows and buttons), **Severity mark** (a stripe, the whole
  row in the level colour, or only the coloured icon), **Show** (the active
  alarms, the cleared ones or both; bind it to switch from elsewhere),
  **Filter chips** (All / Active / History in the header, starting from Show),
  **Acknowledge** (Off leaves it to a Button with the new action below) and
  **Second line** (the alarm's description). Touch rows are cards with a
  severity edge, the alarm's value, its time and whether it is new,
  acknowledged or cleared. Left at their defaults, the list looks as before.

- **An alarm can do without acknowledgement.** A **Needs acknowledgement**
  switch on each alarm, on by default. Off, the alarm fires already
  acknowledged: no ACK, not counted as unacknowledged, skipped by Acknowledge
  All. A cleared alarm in the Alarm List now opens its detail popup too, with
  its description, image and resolutions kept in the history.

- **An action acknowledges every alarm.** **Acknowledge All Alarms**
  acknowledges each unacknowledged alarm in the name of the signed-in user,
  so any Button can be the screen's acknowledge button.

- **A Button sets its border color.** A **Border color** that differs from
  the button color, such as a ring that marks the active page. Left empty, it
  keeps today's look.

- **A String Input can open the numpad.** A new **Keyboard** property set to
  **Numeric** opens the numpad instead of the on-screen keyboard, with
  digits only, so a PIN or a code needs no letters to tap past. With
  **Password field** on, the numpad masks the entry too. Custom widgets get
  the same masking through the SDK numpad's new `password` prop. The default
  stays **Text**. Two more properties make a PIN dialog one tap shorter:
  **Focus when shown** opens the keyboard or numpad as soon as the field
  appears (not in the editor canvas), and **On Submit** runs its actions on
  Enter, on the numpad or a physical keyboard — a Login User there signs in
  without a separate button. The numpad opens centred on screen, over the
  dialog, like Edit Value's. **Keypad** draws that numpad inside the field
  itself instead, so a PIN dialog is one panel rather than a dialog with a
  second panel over it; Enter submits and clears the entry for the next try.

- **A locked widget is out of the keyboard's reach too.** A widget that is
  not **Interactable** already ignored a press, but **Tab** still reached
  the Button or field underneath, and **Enter** or **Space** fired it,
  so a keyboard got past a lock that guards a setpoint. A locked widget
  now takes no focus and no keys. Unlocked widgets behave as before.

- **`Round3` and `Round4` in text templates.** Next to `Round1` and
  `Round2`, a String Expression and alarm text can show a value with three
  or four decimals: `{Round3(1)}`.

- **Runtime widgets carry their id.** Every widget on an operator screen now
  sits in an element with `data-widget-id` and `data-widget-type`, as it
  already did in the editor, so a test or script can find it by its node id:
  `[data-widget-id="pump-start"]`. The element takes no space, so layouts look
  the same; a Navigation Menu placed straight in a shell region now gets its
  sidebar background and border in the editor preview too.

- **An action in a component writes through its input.** Write Data
  Variable, Toggle Boolean Variable and Edit Value inside a component can
  target an input declared with write access, `{ "$componentProp": "value" }`,
  and write whatever variable the instance passed in. A parameter row with an
  Edit Value button is then one component placed once per setpoint. The
  Variable row's source pill offers the input, inside a dialog too, and the
  warnings pill flags an input that is not writable or not of a type the
  action writes.

- **A component input can hold a page.** A component's properties take the
  **Page** type that dialog input parameters already had: the instance picks
  the page from a page picker, and a **Navigate To Page** inside the
  component goes to it. Before, saving such a component was refused, so a
  link card had to be handed a whole action list instead.

### Changed

- **On Pressed runs when the press starts.** A Button's press
  actions used to run on the click, when the finger lifted; they now run the
  moment it lands (or the key goes down), so **On Released** has a moment of
  its own to follow it. A press that slides off the control still runs.

- **A Number Input reads as a value, not a form field.** The number is
  right-aligned in the theme's Value typography, with digit groups (4,920)
  and a typographic minus, on a raised surface with the unit inside it. While
  the numpad is open the field shows the entry as typed.

- **Every download names its edition.** The public zips are now
  `nexthmi-community-<os>-<arch>-<version>.zip` and
  `nexthmi-community-docker-linux-<arch>-<version>.zip`; the folder inside keeps
  its name, so shortcuts to it still work. The terminal splash prints
  *Community Edition* or *Enterprise Edition* under the logo, and the runtime's
  loading screen says *Community Edition* in the public build.

- **A project opened in 1.1.0 no longer opens in 1.0.x (breaking).** The
  project file format moves to 11, because 1.1.0 adds fields to the alarm and
  theme files that a 1.0.x build rejects: it would read the alarm files as
  empty and save over them, and fail to load the themes. **Start** asks to
  upgrade a project the first time 1.1.0 opens it, zipping it into
  `.backups/` first; the upgrade only rebuilds User Badges (see **Removed**).
  A 1.0.x build then shows **Requires update** and names 1.1.0 as the
  version it needs, instead of losing the alarms.

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
  it and shows its bounds in red (`Min: 80 · Max: 200`). An entry starts
  empty, with the current value as placeholder, so a key replaces the value
  instead of appending to it. The entry is a real field: a physical keyboard
  types into it by the same rules as the keys, Enter applies and Escape
  cancels, and a tablet's own keyboard stays shut. Both widgets get
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

- **A disabled tag can no longer be bound.** **Show all** in the variable
  picker listed disabled tags and let one be confirmed. The binding then showed
  a value in the editor while the warnings pill called it *unknown variable*.
  A disabled tag is now left out of the picker, **Show all** included.

- **A Gauge and a Trend take an Integer tag.** Their **Value** took only a
  `Float` variable, so a PLC counter (an S7 `Int` or `DInt`, a CODESYS `INT`)
  needed a formula to reach them. They now take `Float` or `Integer`, as the
  Value Display, Progress Bar and Ring Gauge already did.

- **A field that writes a value back takes only a variable.** A writing field
  (`write: true`, such as a Button Row's value) offered every source its type
  allowed, so a formula, a condition or a fixed value could be put where the
  control writes. The control then had nothing to write to. Such a field now
  offers only a variable binding, a paste of anything else is refused, and the
  warnings pill reports `write-source` for one that already holds something
  else.

- **A formula can fill a whole-number field.** The Formula source was offered
  only on `Float` fields. It now has a **Round to a whole number** switch that
  rounds the result to the nearest integer. A formula on an `Integer` field
  starts with it on, and the warnings pill reports `formula-fraction` for a
  formula there that is not rounded.

### Removed

- **Screen-reader names.** The app and the built-in widgets no longer set
  `aria-label`, `aria-labelledby` or `aria-live`; roles and state attributes
  such as `aria-pressed` stay. The Menu Toggle's **Aria label** property is
  gone. A custom widget gets its node's **Name** under **Identity** as the
  `name` prop.

- **The User Badge.** Opening a project upgrades each one to built-in widgets
  that show the same: a Container holding a user Icon, the username and groups
  as Labels, a sign-in Button for the guest and a sign-out Button for everyone
  else, each kept only where the badge had actions for it. The initials avatar
  becomes the user icon.

- **The Alarm List's Own frame.** The list now always draws without a frame of
  its own, as every example already placed it, so it takes the look of the card
  or page around it. A stored `chrome` key is ignored and the warnings pill
  flags it as an unknown property; delete it there.

- **The Container's Shadow.** A Container now always draws without a shadow.
  A stored `shadow` key is ignored and the warnings pill flags it as an
  unknown property; delete it there.

### Fixed

- **An Image Container with many children stays workable.** Children added
  to an Image Container no longer all sit in the middle of the image until
  **Place children…** is opened: each starts at its own spot in an 8 × 8 grid,
  so 64 children get a spot each where 16 did before. In **Place children…** a
  child that draws nothing, such as an empty Container, can be dragged by its
  marker. **Place children…** and an Image's **Edit indicators…** fit a tall
  image inside the dialog, so its bottom edge can be reached. A child that
  was never placed moves from the middle of the image to its grid spot.

- **A Button's custom SVG icon shows in Safari.** A project SVG on a Button
  rendered at zero size in Safari and other WebKit browsers, so the button
  showed no icon. It now fills the icon size, as it already did in Chrome
  and Firefox.

- **A Button stays inside a narrow fixed tile.** A Button in a fixed size
  narrower than its label plus padding grew past it. It now keeps the size it
  was given.

- **A restart keeps the default project's name.** Each start renamed the
  default project back to *Default*, so a name given in the manager did not
  survive a restart. Writing the project block also escaped characters such
  as `·` and `₂` in `config.json` (`·`); they are now written as they
  are.

- **An input inside a component's actions is not flagged.** The warnings
  pill said a `$componentProp` nested in another source "renders once and
  then stops updating" inside actions too, such as an Edit Value title built
  from the input, although an action reads its fields when it fires. Action
  lists — Actions, On Submit and other events, their If branches and On
  Success / On Failed lists — are no longer flagged; a rendered property
  still is.

- **An icon path taken from the Repeat item is not an unknown asset.** A
  fixed icon or image whose path is a Repeat item member, as in
  `{ "$static": { "type": "custom", "path": { "$repeatItem": { "member": "icon" } } } }`,
  was flagged as an unknown asset although each copy fills it in from its
  item. It no longer is over a list; over a tag array, where it names no
  asset, the pill now says to set the field's own source to Repeat Item.

- **Alarms restored after a restart follow the tags.** An alarm active when
  the project stopped came back active on start even when its tag no longer
  held the condition: a static datasource's tags start at their defaults
  without a change, so seven open-door alarms stayed lit until a door was
  toggled. Every restored alarm is now checked against the tag values as soon
  as they are known, and one whose condition has gone clears into the history.
  The same check runs when a static datasource is saved while the project
  runs, since a new or reshaped variable restarts at its default too.

- **HMI Loaded sees the tag values.** `onHmiLoaded` ran as soon as the
  configuration had loaded, before any tag value had arrived, so a first-start
  guard such as an **If** on `Machine/Initialized` read "no value yet" and
  took the wrong branch. It now waits until the first page's values and those
  of the variables its own actions read are in, up to 3 seconds; the first
  **onPageLoaded** follows it as before.

- **A formula can be written to an Integer tag.** A Write Data Variable
  whose value is a `$formula` was flagged by the warnings pill as not fitting
  an Integer tag, although the write itself goes through. It is no longer
  flagged; a whole result is written, and a result with decimals is refused
  with `invalid_value`, as any other number with decimals is.

- **The alarm guide says what Value Range does.** It said the trigger fires
  outside **Min** / **Max**; it fires while the value lies between them, both
  included, as it always has. The guide now says so, with what one empty
  bound does.

- **`Thousands` keeps the decimals it is given.** `{Thousands(Round1(1))}`
  showed `41,280` for 41280, dropping the `.0` the inner `Round1` wrote. It
  now groups the text it receives, so it shows `41,280.0`.

- **An alarms file the app cannot load is flagged.** An `alarms.json` that
  breaks the alarm format, such as an alarm with a key it does not know, was
  replaced by an empty one at startup, and the warnings pill said nothing, so
  every alarm was gone without a word. The pill now shows an error per field
  the format rejects, and the log says the file was replaced. The same goes
  for `recipes.json`.

- **A popover opened near the bottom of the screen stays on it.** A dialog
  placed `trigger-below` a button low on the screen opened below it anyway,
  partly off the screen, because its size was read before its contents had
  loaded. It now opens on the other side of the button when only that side
  has room, and is pulled inside the screen when neither has; the same for
  `trigger-above`, `trigger-left` and `trigger-right`.

- **The category rail follows a click to its end.** In the Add action,
  Add widget and source drawers, clicking a category near the end of the
  list, such as **Interface**, scrolled to it but left the rail highlighting
  one above it, because that section could not scroll to the top. The
  clicked category now stays highlighted until you scroll yourself.

- **A placeholder typed into a String Expr warns until it is bound.**
  Typing `{2}` into a template added a `{2}` row holding an empty Static
  text, which counts as a value, so the "placeholder {2} is unbound" warning
  never showed. The new row now starts unbound, in an HTTP Request's URL and
  body too. A Static value cleared on purpose still counts as set.

- **An alarm's detail opens on screen from any page.** Tapping a row of an
  Alarm List on a long page dimmed the screen but drew the detail dialog
  off-screen, where it could not be read or acknowledged. The dialog now
  always opens over the middle of the screen, from a custom widget too.

- **A toast no longer covers the numpad.** A toast arriving while the
  numpad or keyboard was open drew over its bottom row of keys. The keypad
  the operator is typing on now sits above toasts, and below a Show Alert
  confirm and an alarm's detail dialog. An open confirm now also dims the
  toasts behind it; alarm popups keep their own layer above it.

- **A custom widget's centred numpad is centred.** A `VirtualNumpad` with
  `dockPosition="center"` sat at the left edge of a keyboard-wide strip
  along the bottom of the screen. It now sits in the middle of the screen,
  across and down; the keyboard stays docked at the bottom.

- **A second tap on a Number Input or String Input opens its numpad or
  keyboard again.** After × (or Enter, on a Number Input) the field kept
  focus, and the keypad opened only when the field gained focus, so tapping
  the same field again did nothing until the operator tapped somewhere else
  first.

- **Bundled fonts now carry their licence.** Inter, JetBrains Mono, Lexend,
  Manrope and Roboto Mono ship their SIL OFL 1.1 text next to the font files
  in `frontend/public/fonts/`, and `NOTICE` lists each family's copyright and
  source, as it already did for Exo 2.

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

- **A bound tag that was disabled afterwards is reported as disabled.** The
  warnings pill said *unknown variable* for it. It now reports a
  `var-disabled` warning, *disabled in its datasource — enable it there*. A
  tag that is also gone from the server is still reported as unknown.

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

[1.2.0]: https://github.com/mpnvdlee/next-hmi/releases/tag/v1.2.0
[1.1.0]: https://github.com/mpnvdlee/next-hmi/releases/tag/v1.1.0
[1.0.1]: https://github.com/mpnvdlee/next-hmi/releases/tag/v1.0.1
[1.0.0]: https://github.com/mpnvdlee/next-hmi/releases/tag/v1.0.0
[0.0.1-rc2]: https://github.com/mpnvdlee/next-hmi/releases/tag/v0.0.1-rc2
[0.0.1-rc1]: https://github.com/mpnvdlee/next-hmi/releases/tag/v0.0.1-rc1
