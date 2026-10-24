# Visual-check recipes

Selectors, flows and traps confirmed against the running app. Organised by
surface: read the section for what you are about to drive. `h.` is `harness.js`.

## Environment

| Fact | Value |
|---|---|
| App (Vite) | `localhost:8000` — plain **http** by default; **https** only when the device's **Settings → HTTPS** switch is on (it persists in the runtime home) |
| API | `localhost:8001` — `/` answers 404, which is normal |
| Readiness poll | try both: `curl -sk -o /dev/null -w '%{http_code}' http://localhost:8000`, then `https://` |
| LAN address | printed by `start-dev.py` as `Network: <scheme>://<ip>:8000/` |
| Manager password (dev) | `dev` |
| Manager dashboard | `/projects` — **not** `/`, which redirects to the default project's runtime and renders no `.project-row` |
| Editor | `/editor/<projectId>/editor` |
| Runtime page | `/runtime/<projectId>/pages/<pageId>` — `<pageId>` is the `id` in `pages/<name>.json`; page groups are not in the path |
| Playwright | `~/.cache/nexthmi-visual-check`; browser binaries in the shared `ms-playwright` cache |

### Starting and stopping servers

- **Background with the Bash tool's `run_in_background`, never a trailing `&`.**
  A `&`-job dies when the tool call returns: the servers answer the first
  requests, then the drive script fails on `net::ERR_CONNECTION_REFUSED` and
  `chrome-error://chromewebdata/`, which reads like a bad URL. Confirm with
  `lsof -nP -iTCP:8000 -sTCP:LISTEN` before driving.
- **Another developer's server already on 8000.** If it serves *this* repo
  through Vite, HMR has your frontend edits live and you can drive it — but
  skip `bootEditor()` (it clicks **Start**, which can start a project they left
  stopped), sign in on `/projects` yourself, and never click **Save**.
- **`start-dev.py` hard-kills whatever owns 8000/8001.** With someone else's
  server there, run your own pair on other ports against a throwaway runtime home:

```bash
DATA=$SCRATCH/runtime-home              # never ~/Documents/NextHMI or a checkout's .dev-runtime-home
PROJ=$SCRATCH/projects/project-example

NEXTHMI_DATA_DIR=$DATA NEXTHMI_PORT=8011 \
  python -m uvicorn manager:app --host 127.0.0.1 --port 8011     # run_in_background

# Vite resolves "the live project" for the external-libraries import map from
# its OWN env (dev-plugins/externalModules.ts); unset, it silently serves the
# other instance's project.
NEXTHMI_DATA_DIR=$DATA NEXTHMI_ACTIVE_PROJECT_PATH=$PROJ \
  NEXTHMI_DEV_PORT=8010 NEXTHMI_DEV_API_PORT=8011 npx vite --port 8010
```

  Kill by the PID `lsof -tiTCP:<port> -sTCP:LISTEN` reports, never by pattern.

- **Run `manager:app`, not `main:app`, for anything Chromium loads.** Vite injects
  `__NEXTHMI_MODE__ = 'manager'` for every path that is not already
  `/runtime/<slug>/` or `/editor/<slug>/`, and the manager sign-in then calls
  endpoints a standalone `main:app` does not have (the form shows "Not Found"
  forever). `main:app` is fine for non-browser checks.

### Bootstrapping a project into a fresh runtime home

A raw copy (of `project-example/` or anything else) has no metadata block, so
its first activation fails. With `NEXTHMI_DATA_DIR` set to the throwaway home:

```python
from pathlib import Path
from core.manifest import ensure_project_metadata, manifest_transaction, ProjectEntry, find_project, save_manifest, read_project_metadata
from core import manager_auth
from core.time_utils import iso_now

ensure_project_metadata(Path(PROJ), name='project-example')   # else: "project has no metadata block"
manager_auth.set_password('dev')                                # else sign-in silently re-shows the form
meta = read_project_metadata(Path(PROJ))
with manifest_transaction() as manifest:
    if find_project(manifest, meta.id) is None:
        manifest.projects.append(ProjectEntry(id=meta.id, name=meta.name, path=PROJ, addedAt=iso_now()))
        save_manifest(manifest)
```

The first open migrates the project: a wall of `WARNING nexthmi.migration:
Migration note: …` is informational unless a `MigrationFailedError` follows.

**A project below the current format version asks before it starts.** **Start**
opens `"Upgrade '<name>'?"` (**Cancel** / **Upgrade & start**); without the
confirm the row stays `STOPPED`, no request is sent, and the editor URL stays
`/projects` while the runtime answers 503. `bootEditor` confirms it.

### Finding the live project

It is whatever `<runtime_home>/projects.json` registers as default — in dev
usually `next-hmi-testbench` (reached as `project-testbench/`), not necessarily
a folder in this repo:

```bash
python -c "import json,os;m=json.load(open(os.path.expanduser('~/Documents/NextHMI/projects.json')));print([p['path'] for p in m['projects']])"
```

The project id does not tell you which one it is (`default` is whatever is
marked default). Judge by content: page groups `Operate` / `Configure` /
`Monitor` under `Pages` is the testbench; three bare pages is a seeded
`Default-Project`. Grep that project's `pages/*.json` for widget ids and
`$var` bindings before writing a drive script.

## Reaching a surface

### The editor

`h.bootEditor()` signs in, clicks the first enabled **Start** (confirming an
upgrade), then **Open editor**, which opens a **new tab** (`ed`).

- **The first enabled Start may belong to another project.** The running
  project has no Start button, so on a runtime home with several rows
  `bootEditor` starts a stopped one further down. When that matters, sign in
  yourself and pick the row:

```js
const row = page.locator('.project-row', { has: page.locator('button:has-text("Open editor")') }).first();
const [ed] = await Promise.all([
  context.waitForEvent('page', { timeout: 15000 }),
  row.locator('button:has-text("Open editor")').first().click(),
]);
await ed.waitForLoadState('networkidle');
```

  Log every row first — `(await row.innerText()).replace(/\n/g, ' | ')` shows
  name, id, `RUNNING`/`STOPPED` and the buttons in one line.

- **A fresh context cannot open `/editor/<id>/editor` directly** — it lands on
  the *session expired* `.blocking-overlay`, and every later click fails with
  "intercepts pointer events". Sign in on `/projects` first; after that, `goto`
  in the same tab works and skips the new-tab dance:

```js
await page.goto(`${h.BASE}/projects`, { waitUntil: 'networkidle' });
await page.locator('input[type="password"]').fill('dev');
await page.locator('button:has-text("Sign in")').click();
await page.goto(`${h.BASE}/editor/<project-id>/editor`, { waitUntil: 'networkidle' });
```

- **The editor boots with no page open** — the canvas is blank. Open a page row
  (see the tree section) and wait ~6s for widget modules before shooting.

### Manager only

```js
const { browser, context } = await h.launch({ width: 1500, height: 1000 });
const page = await context.newPage();          // launch() returns no page
h.watchErrors(page);
await page.goto(`${h.BASE}/projects`, { waitUntil: 'networkidle' });
const pw = page.locator('input[type="password"]');
if (await pw.count()) {
  await pw.first().fill('dev');
  await page.locator('button:has-text("Sign in")').first().click();
  await page.waitForTimeout(2000);
}
```

`/settings` works the same way: sign in, then `goto` it again (sign-in lands on
`/projects`).

### The operator runtime

Sign in as above, then `goto` the runtime page. A direct `goto` without a
manager session renders the shell while every `/api` call answers 401 and the
WebSocket handshake 403s — an empty page with no obvious cause.

```js
await page.goto(`${h.BASE}/runtime/<projectId>/pages/<pageId>`, { waitUntil: 'networkidle' });
await h.dismissFullscreenPrompt(page);
await page.waitForTimeout(4000);    // per-widget stylesheets land after networkidle
```

- **The fullscreen prompt** (`.fullscreen-prompt-backdrop`, buttons `×` /
  `Not now` / `Fullscreen`) mounts after `networkidle` and again on every
  navigation; its backdrop eats clicks, including `{ force: true }` ones, so
  nothing opens and nothing errors. `dismissFullscreenPrompt` handles it.
- **Every `/runtime/<id>/api/…` answering 503 means the project is not
  running** — the page hangs on `Loading configuration · 2/3`. `POST
  /api/manager/projects/<id>/start` from the signed-in page; the child's
  traceback is in `<runtime_home>/.logs/instances/<id>/process.log`.
- **An unknown `<pageId>` reloads the whole app**, so a fixed wait screenshots
  the boot splash. Wait for `.hmi-no-page` instead.
- **Live values need the runtime.** The editor preview never fires
  `globalEvents.onHmiLoaded`; to get the same values into an editor shot, click
  the editor's **Live View** (opens the runtime in the same authenticated
  context) and **Start** there. A separate `browser.newContext()` has no
  session and renders "Signed out".

### The preview iframe as its own tab

```js
const src = await ed.locator('iframe.editor-preview-iframe').first().getAttribute('src');
const p = await context.newPage();            // same context: the cookie rides along
await p.goto(new URL(src, ed.url()).toString());
```

The only way to instrument the preview document from its first frame.
`/editor/<id>/preview/<pageId>` opened cold renders "No page found": it is fed
by the editor over `postMessage`.

### Signed-out and not-running states

- **Signed out:** a fresh context, no sign-in, `goto` the editor or runtime URL,
  wait ~2.5s. `.session-expired` is the overlay, `.name-modal` its card. Expect
  a wall of 401s and a 403 WebSocket failure in the console.
- **Project not running:** `/runtime/<id>/` and `/editor/<id>/` raise
  `[role="alertdialog"].blocking-overlay` with **Go to projects**, ~2.5s after
  `networkidle`. Use a nonexistent id (`/runtime/ghost/`) for the `unknown`
  variant rather than stopping a project someone is using. No overlay usually
  means the project is running, not that the code is broken.

### An insecure browsing context

`http://localhost` is a secure context by spec; a LAN install over plain HTTP is
not. When the dev server is on HTTP, drive the printed LAN address (sign in per
origin) and `window.isSecureContext` is genuinely false. On HTTPS, stage it by
removing the API before any app code runs, and assert the removal took:

```js
await context.addInitScript(() => {
  delete Crypto.prototype.randomUUID;
  window.__gone = typeof crypto.randomUUID !== 'function';
});
```

Others worth staging: `navigator.clipboard`, `navigator.mediaDevices`,
`crypto.subtle`, `navigator.serviceWorker`; `isSecureContext` itself needs
`Object.defineProperty(window, 'isSecureContext', { value: false })`. A white
page is `#root.innerHTML.length === 0` — log it, a blank PNG looks like a
script that never navigated.

### Enterprise (`ee`) surfaces

`python start-dev.py --edition ee` serves `manager_enterprise:app`.

| Surface | Selector | Where |
|---|---|---|
| Activation screen | `.mgr-activation__card`, title `.mgr-activation__title` | every manager route until activated |
| Device licences panel | `.mgr-licenses` | `/settings` |
| One licence | `.mgr-license-card` | either of the above |

Unactivated, `/projects` has no `.project-row` and no **New project** — that is
the gate working. The runtime home is real, and may already hold a licence:
check `<runtime_home>/licenses/` and `GET /api/admin/activation` before
deciding which branch you are looking at.

## Manager

| Surface | Selector |
|---|---|
| Project row | `.project-row` (`--live` running, `--missing` folder gone); by id: `.project-row:has-text("[myproject]")` |
| Name / id / path / status | `.project-row__name` · `__id` · `__path` · `.mgr-status` |
| Row buttons / toggles | `.project-row__actions` · `.project-row__toggles` (`.mgr-default-toggle`, `.mgr-mcp-toggle`) |
| Thumbnail | `img.project-thumb` / `.project-thumb--empty` |
| Rename dialog | `.cfg-modal` after **Rename** — disabled while running: **Stop**, wait ~4s, and **Start** again before quitting |
| Template chooser | `button:has-text("+ New project")` → `.cfg-modal.name-modal.template-modal`, cards `.template-card` (`__name`) |
| Create-form name | `input[placeholder="Plant A"]` |
| Sign-in gate | `form.name-modal` in `.mgr-center`; brand row `.mgr-auth-card__brand` |
| Insecure-connection strip | `.cfg-insecure-notice` (link `__link`, absent on `/settings` itself) |
| Settings block | `section.cfg-admin-section` titled `h2.cfg-admin-section__title` — target by title: `section:has(h2:text("Usage reporting"))` |
| Yes/No setting | `.cfg-seg-btn` (`--active`); the section re-renders from the PUT response, give it ~800ms |

- **`.name-modal__title` is not unique** — the template chooser and blocking
  overlays use it too. Scope it.
- **The create form takes a parent folder**, not the project path, and
  **Create** stays disabled until the name is filled. The parent must exist
  (`422 Parent directory does not exist`); ids are slugs of the name.
- **Reload between two creates.** `.cfg-modal-overlay` outlives a successful
  create, and a second **New project** click hits "intercepts pointer events".
- **Seeding a project list:** `POST /api/projects {name, path}` from the
  signed-in page, `DELETE /api/projects/<id>?deleteFolder=true` to clean up.
- `shotEl` on `.project-row` at a 1400px viewport is a clean ~1024px strip; a
  full `/projects` shot is mostly whitespace — clip `{ x: 250, y: 40, width:
  1120, height: 200 }` at 1500×1000 for toolbar plus row.

### Peer transfer modal

Opened from a row's **Transfer**. The modal locks host/port/protocol once
paired, so each scenario needs a fresh modal (**Close**, then **Transfer**).

| Field | Selector |
|---|---|
| Host / port / password | `input[placeholder="192.168.1.20"]` · `input[type="number"]` · `input[type="password"]` |
| Pair | `button:has-text("Pair")` |
| Submit (Transfer / Pull / Retry / Start a new transfer) | `.name-modal__actions button` `.last()` — its label is the assertion |
| Clash radios | `.cfg-modal label:has-text("<label>") input[type="radio"]` |
| Whole modal, one line | `(await page.locator('.cfg-modal').first().innerText()).replace(/\n+/g,' | ')` |

`.cfg-modal button:has-text("Transfer")` also matches the title `Transfer
"<name>" to a peer`. Scope to `.name-modal__actions`.

Pairing refuses loopback (`_require_private_client`), so `localhost` only
yields the refusal. Pair with the machine's own LAN address on `:8001` for a
**clash** (its own project is already on the "peer"), or run a second manager
for the no-clash case:

```bash
NEXTHMI_DATA_DIR=$SCRATCH/peer2home python -c \
  "from core import manager_auth; manager_auth.set_password('dev')"   # pairing fails without one
NEXTHMI_DATA_DIR=$SCRATCH/peer2home NEXTHMI_PORT=8002 \
  python -m uvicorn manager:app --host "$LAN_IP" --port 8002           # the IPv4 LAN address
```

- **Bind the IPv4 address, not `::`.** asyncio leaves `IPV6_V6ONLY` on, so an
  IPv4 peer is refused with an empty peer log while the UI says "Nothing is
  listening on that address and port".
- **A failing transfer on demand:** pair with the second manager, kill it,
  submit.
- Two managers on one LAN log `Encountered two children with the same key`
  (a peer both discovered and added manually). Known noise.

## Config editor

### Top bar and saving

| Surface | Selector |
|---|---|
| The bar | `.cfg-header` — `shotEl` gives a clean strip |
| Actions | `.cfg-header__actions` — in order `↶ | ↷ | Save | ↗ Live View | Transfer | ? Help | Sign out` |
| Save | `.cfg-header__save-btn` |
| Unsaved marker | `.cfg-header__unsaved` (`● Unsaved changes`) |
| Undo / Redo | `button[aria-label="Undo"]` / `"Redo"` — `isDisabled()` mirrors history depth |

**Nothing reaches disk without Save.** Edits, drags, pastes and undo live in
the tab's store and die with the browser context, so a drive script can
exercise anything without touching the project; `.cfg-header__unsaved` at the
end of a run is expected. Confirm with `git -C <live-project> diff -- <file>`
(the testbench is often already dirty, so diff the key you touched). `ed.reload()`
without saving is the cheapest revert.

To dirty the project on purpose, edit the first input of any selected node and
blur — commit is on blur, the marker appears ~1s later. `Settings` in the tree
has two plain text inputs (title, logo path).

```js
await h.selectTreeNode(ed, 'Left sidebar');
const input = h.propsPanel(ed).locator('input.cfg-prop-input').first();
await input.fill('9');
await input.blur();
```

A multi-select write is one undo entry; undoing a step that removed the
selected widget leaves `.cfg-panel-empty` ("Widget not found.") — not a bug.

**Which origin answered a call:** base-prefixed fetches go to the instance,
origin-absolute ones to the manager. `200 /api/manager/…` is the manager;
`/editor/<slug>/api/manager/…` went to the instance, which has no manager API.
Expect every call twice in dev (StrictMode). `window.__NEXTHMI_BASE__` is set in
dev too (`/editor/default/`), so `withBase()` is never a no-op.

### Widget tree

| Surface | Selector |
|---|---|
| Tree | `.cfg-tree` (page editor: `.cfg-tree.cfg-editor-tree`) |
| Row / label | `.cfg-tree-item` / `.cfg-tree-item__label` — match labels with `:text-is()` or a `^…$` regex |
| Page row / group row / selected | `.cfg-tree-item--page` · `--group` · `--selected` |
| Disclosure | `.cfg-tree-toggle` (arrow `.cfg-tree-toggle__arrow` in `.cfg-tree-item__toggle-slot`) |
| Drag handle | `.cfg-tree-item__handle` (widget rows only) |
| Depth | the row's `--tree-depth` custom property |
| Empty slot / area | `.cfg-tree-section-empty` ("Empty — drop a component here or right-click") |
| Search / clear / collapse-all | `.cfg-tree__search-input` (`/` focuses) · `.cfg-tree__search-clear` · `.cfg-tree__searchbar-btn` |
| Search highlight | `mark.cfg-tree-search-match` |

Top level, in order: `Settings`, `Global Events`, `Header`, `Left sidebar`,
`Right sidebar`, `Footer`, `Pages`, `Dialogs`. Shell rows select reliably by
text (`h.selectTreeNode`); container *widget* rows can open the Add menu instead.

- **`h.selectWidgetByName(ed, name)` is the reliable way to one widget.** It
  searches, which force-expands the tree wherever the row lives, then clicks the
  exact label. Pass the widget's `name` from `pages/*.json`, not its id.
- **Pages are two levels deep in the testbench:** `Pages` → groups (`Operate`,
  `Configure`, `Monitor`, `Widgets`) → pages. A page row does not exist until
  its group is open. Expand one level at a time by the toggle, not the label:

```js
const open = async (text) => {
  await ed.locator('.cfg-tree-item', { has: ed.locator(`.cfg-tree-item__label:text-is("${text}")`) })
    .first().locator('.cfg-tree-toggle').first().click();
  await ed.waitForTimeout(700);
};
```

- **`.cfg-tree-toggle` has no open/closed class.** An "expand all" loop
  re-closes what it opened. Walk a known path instead.
- **Clicking a page row selects the page**, not its root widget (panel sections
  `Page / Layout / Metadata / Main / Events`). A page *group* row shows
  `Page Group / Metadata / Main / Events`.
- **A search force-expands; collapse-all clears the search first.** Row counts
  while searching ignore the collapse state, and on alarms/recipes the `+ Add …`
  rows hide during a search. Give either ~400ms.
- **`text=Dashboard` also matches the open editor tab.** Scope to `.cfg-tree`.
- **A `$component:` instance's slot groups are plain rows** named after the slot
  (`Action`, `Body`); an empty one renders `.cfg-tree-section-empty` — include it
  when dumping rows, or empty slots read as missing.
- **`Dialogs` holds ordinary pages** (`{"id", "type": "page"}`), expanded like
  any page group.
- Expanding a page group also opens its empty `Header`/`Footer` slots — collapse
  them before a docs shot.

**A docs-shaped tree shot:** `.cfg-tree` is stretched to the sidebar's full
height, so `shotEl` on it is mostly blank. `h.shotTreeClipped` crops to the
last row; shoot at `dpr: 2` to match the existing doc images. To widen the tree
first, drag `.cfg-resize-handle` `nth(0)` — `mouse.move(x)` sets the handle's
page x, so aim at `width + 55` (the icon rail).

#### Dragging in the tree

The whole tree is one dnd-kit context. Grab the **handle** — `mouse.down()` on
the row body never starts a drag:

```js
const a = await from.locator('.cfg-tree-item__handle').boundingBox();
const b = await to.boundingBox();
await ed.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
await ed.mouse.down();
await ed.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 10, { steps: 4 });   // past the 5px threshold
await ed.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 });
await ed.mouse.up();
```

| Feedback mid-drag | Class |
|---|---|
| Drop inside | `.cfg-tree-item--section-over` |
| Above / below | `.cfg-tree-item--drop-top` / `--drop-bottom` |
| Empty placeholder lit | `.cfg-tree-section-empty--over` |

- Rows do not translate during a drag, so mid-drag boxes are real positions.
- `Escape` then `mouse.up()` cancels with the tree byte-identical — cheap for
  probing hover feedback.
- Pointer fractions do not address the top/middle/bottom band reliably. Assert
  on a dump of the result instead:
  `[...document.querySelectorAll('.cfg-tree-item')].map(el => `${el.style.getPropertyValue('--tree-depth') || 0}|${el.textContent.trim()}`)`.
- A collapsed shell area still takes a drop (its row and its placeholder are
  different droppables).
- A leaf row is `handle && !toggle`. Every empty area renders an identical
  `.cfg-tree-section-empty`, so `.first()` is rarely the one you meant.

### Properties panel

| Surface | Selector |
|---|---|
| Scroll container | `.cfg-props-panel__scroll` (`h.propsPanel`) |
| Header / type / name | `.cfg-panel-header` · `__type` · `__name`; a `$component:` instance's type is a `.cfg-panel-header__type-link` button |
| Group | `.cfg-section`, titled `.cfg-section__title` |
| Row | `.cfg-field-group`, label `.cfg-field-group__label`, collapsed summary `__preview-text` |
| Number / text input | `input.cfg-prop-input` (`--hint` for a disabled `—` hint) |
| Select | `.cfg-select` — a `button[role="combobox"]` with a portalled `.cfg-select-popup`, options `.cfg-select-popup__option` / `[role="option"]` |
| Segmented buttons | `.cfg-seg-btn` (`--active`) |
| Row trailing buttons | `.cfg-row-action-btn` (`--unit` px/rem toggle, `--chevron`) |
| Unset hint | `.cfg-unset-hint` (`· default`) |
| Source pill / badge | `.cfg-source-pill-wrapper button` · `.cfg-property-source-badge` (`aria-label` = source label) |
| Source menu | `.cfg-source-pill__popup`, labels `.cfg-source-pill__option-label`; **Browse property sources…** opens `.cfg-selection-drawer` |
| Context menu (tree and canvas) | `.cfg-context-menu`, items `__item`, submenu parents `__item--has-sub`, header `__label` |

**Verify the selection before trusting a shot:**
`(await h.panelHeader(ed).innerText()).replace(/\n/g, ' / ')` reads
`"<name> / <type>"`. A `$component:` instance shows its definition's name as
type ("Tanks & CIP / Card").

Locator traps, each of which picks the wrong field without erroring:

- **`hasText` is a substring and matches ancestors.** `'Width'` matches `Width
  mode`; `'Page'` matches `Show child pages in menu`; `'Default value'` matches
  the drawer that contains the row. Anchor on the label node:

```js
const row = (ed, label) => h.propsPanel(ed).locator('.cfg-field-group')
  .filter({ has: ed.locator(`.cfg-field-group__label:text-is("${label}")`) }).last();
```

- **`Select` is not a `<select>`.** `selectOption` times out; click the
  combobox, then the option. The first `button` in a select row is the source
  pill.
- **A closed `.cfg-select-popup` stays in the DOM.** Narrow with `:visible`.
- **Popups portal outside the panel** (source menus open to its left), so
  `shotEl` on the panel crops them — use `shot`, or `shotEl` on the popup.
  `Select` sizes its popup from the trigger and clips long options silently;
  check `scrollWidth > clientWidth + 1` per option.
- **Escape does not close the source-pill popup**; the next pill then fails with
  "subtree intercepts pointer events". Click `.cfg-panel-header` to dismiss.
- **A tier-3 source opens collapsed.** After `setSource(ed, row, 'Formula' |
  'HTTP Request' | 'If Condition' | …)` only a `formula(…)` summary exists;
  inner inputs appear after the row's `>` chevron. That chevron is the first
  `.cfg-row-action-btn` **only on a collapsed tier-3 row** — on other rows
  `.first()` can be **Remove** (the Trend Chart's Variables row silently loses
  an entry). Dump `button` titles before clicking; for action rows use
  `button[title="Expand"]`.
- **Labels are not unique text.** A collapsed row prints its label and the bound
  path (`Temp` ↔ `plc:Boiler/Temp`); `getByText` then throws "Found multiple
  elements".
- **`.cfg-field-group:has(> * >> text="X")` is a parse error** (nested `>>`).
- **`:hover` does not survive into a screenshot.** Assert an open state
  (`.cfg-select--open`) instead.
- **`shotEl(propsPanel(ed))` clips to the viewport**; raise the window with
  `bootEditor({ height: 1500 })`, or `shotEl` one `.cfg-section`.
- Dump before assuming a row exists:
  `h.propsPanel(ed).locator('.cfg-field-group').allInnerTexts()`.

**Shell area rows** (`Header` / sidebars / `Footer`, section `Region`): Enabled,
Default state, Expanded size, Collapsed size, Full height (sidebars only),
Background, Expanded, Overlay (drawer). All carry a source pill except Default
state. Shell nodes have no Layout rows.

**Source counts per field type** (a cheap assertion):

| Type | Offered |
|---|---|
| Boolean | 9 + Browse — Comparison, If Condition, Page Active, Recipe, Switch / Case, User Groups, Variable, Exported Property, Static Value |
| String | 18 + Browse — adds Device Info, HTTP Request, Localizable Text, Page Metadata, String Expression, Current Time, URL Parameter, User Data, Viewport |
| Color | 5 + Browse — If Condition, Switch / Case, Variable, Exported Property, Static Value |

#### Layout section

- **Width/Height mode** is a segmented row labelled `Width mode` / `Height
  mode`: `row.locator('.cfg-seg-btn', { hasText: 'Fill' })`. Clicking the active
  button again does not unset it — the row's trailing `×` does.
- **Fill weight** is its own row, shown when either axis is `Fill`
  (`<input type="number">`; `2` takes twice a weight-1 sibling's leftover).
- The **length** row is labelled `Width` / `Height` — match it exactly, or the
  `Width mode` row wins. Under Fixed, or Hug on its own axis, the length shows a
  disabled `—` hint.
- `format:'length'` rows commit `fill('4')` as `4px`; read the unit back off
  `.cfg-row-action-btn--unit`.
- **Padding** is four plain rows, `Padding top` / `right` / `bottom` / `left`,
  each with its own source pill.
- Container rows (Direction, Gap, Wrap, Align, Distribute, Padding, Radius) only
  render for a type with `flowsChildren` — in practice `Container`.

Testbench subjects: `Tanks` on the dashboard (a Container with 14px top / 22px
other padding — the whole Layout group); `OEE ring` (a leaf, self-only subset);
`Availability` / `Performance` / `Quality` (three weighted siblings in a column).

#### Events and actions

A page or page group's last section is **Events** (`Page Open` / `Page Close`,
`Group Open` / `Group Close`). Locate with `.last()` — the scroll container can
match `hasText: 'Events'` too. Each list's title sits in
`.cfg-editor-actions__title-row`, not in a `.cfg-field-group__label`.

| Surface | Selector |
|---|---|
| Add trigger | `.cfg-editor-actions__add` ("Add" is the placeholder) |
| Add popup | `.cfg-editor-actions__add-popup`; option 0 `? Browse actions…`, then the action types |
| Browse drawer | `.cfg-selection-drawer`, title `<list> › Add action`, rail `Screens` / `Machine` / `Session` / `Interface` |
| Variables list (Trend Chart) | `.cfg-editor-actions` filtered by title `Variables`; one unlabelled row per entry |

| Screens action | Field | Lists |
|---|---|---|
| Open Dialog | `Dialog` | the Dialogs folder, plus `— select dialog —` |
| Open Page As Overlay | `Page` | navigable pages; groups suffixed ` (page group)` |
| Close Dialog/Overlay | `Page` | both, under `Dialogs` / `Pages`, plus `Top-most overlay` |

An action row's buttons are the source badge, `Expand`, `Expand in drawer`,
`Remove action`. Nested `On Success` / `On Failed` / `On Settled` lists exist
only once expanded — expand until no `button[title="Expand"]` is left,
re-querying each round (the title flips to `Collapse`).

#### NavigationMenu manual items

Testbench: `[data-widget-id="sb-nav"]` in the Left sidebar — select it from the
canvas; the `Left sidebar` tree row does not expand to it.

| Surface | Selector |
|---|---|
| List (one per nesting level) | `.cfg-menu-items`; rows `> .cfg-field-group` |
| Row buttons | `button[title="Expand"]` / `"Collapse"` / `"Remove item"` |
| Add menu | `.cfg-editor-actions__add` → `.cfg-menu-items__add-popup` |
| Empty | `.cfg-menu-items__empty` |

Gated `visibleWhen: mode === 'manual'`: switching **Mode** to auto drops the
list to 0 without a save.

### Canvas

- **It is an iframe** (`h.canvas(ed)`), and an editor overlay sits on top:
  canvas clicks need `{ force: true }`. A right-click opens the menu in the
  **parent** document — locate it on `ed`.
- **A forced click hits the deepest widget under the element's centre**, not
  the one you located. Use `selectWidgetByName` for a specific widget;
  `selectCanvasWidget` only for a leaf you can locate precisely. To select a
  Container from the canvas, click a child at `position: { x: 2, y: 2 }`.
- **A placed `$component:` instance selects its slot content** on a centre
  click. Aim at a small definition-owned element by its definition-local id —
  the testbench `Card` draws `card`, `card-h`, `card-h-t` (title), `card-h-a`,
  `card-body`: `[data-widget-id="db-oee"] [data-widget-id="card-h-t"]`.
- **`[data-widget-id]` has no box** — it sits on `.hmi-preview-node`
  (`display: contents`), so `boundingBox()` is null and `shotEl` fails with
  "Node is either not visible or not an HTMLElement". `h.widgetEl(ed, id)`
  returns the real element.
- **Anchor every in-canvas query on the widget id.** A bare
  `querySelector('.hmi-status-pill')` returns the first one on the page.
- **`boundingBox()` inside `frameLocator` is already in page coordinates**; the
  in-frame `getBoundingClientRect()` is frame-relative. They differ by the
  iframe origin.
- **The selection outline is not a measurement.** Measure through the iframe:
  `ed.frameLocator('iframe').first().locator('body').evaluate(…)`.
- **Hit-test a wrong selection:** `document.elementFromPoint(x, y).closest('[data-widget-id]')`
  in the frame names who receives the click (an overlapping later sibling wins).

**Canvas right-click on a Container** lists `Add Widget/Component…`, `Add
Container`, `Cut`, `Copy`, `Paste`, `Delete`. Right-clicking a leaf gives no add
item — aim at a known container id from `pages/<id>.json` (testbench:
`db-oee-list`). The menu header (`.cfg-context-menu__label`) names the target:

```js
await h.canvas(ed).locator('[data-widget-id="db-oee-list"]').first().click({ button: 'right', force: true });
await ed.locator('.cfg-context-menu__item', { hasText: 'Add Widget/Component' }).first().click({ force: true });
```

#### Multi-selection

| Surface | Selector |
|---|---|
| Selected rows / canvas nodes | `.cfg-tree-item--selected` (count) / `.hmi-preview-node--selected` |
| Panel header | `"<n> components"`, type `Mixed types` or the shared type |
| A row they disagree on | per row: input `placeholder="Mixed"`, empty value, no `.cfg-unset-hint`, no `[title^="Revert to"]` |

Ctrl-click in the canvas extends (`modifiers: ['Control']`, still `force`);
Shift-click is a tree-only range. A mixed struct/`$var` row has no input, so
counting `[placeholder="Mixed"]` undercounts.

Testbench subject: `db-tank-1` / `-2` / `-3` on the dashboard — three
`TankLevel` siblings. `Level` is `$var` on each (badge `Variable`), `Tank name`
`$loc`, `Low-level limit` a shared `40` (`Static Value`, not mixed); set one
tank's Level to Static Value for `Mixed sources`. Read `aria-label`, not the glyph.

### Preview toolbar

`.editor-preview-toolbar__seg-btn` by `title`: `Fit to screen`, `Laptop`,
`Tablet`, `Phone`, `Decrease scaling`, `Increase scaling`, `Config mode…`,
`Test mode…`. Lower zoom does not widen the logical canvas. A page that never
branches on `$viewport` renders the desktop layout crushed under `Phone`; the
testbench dashboard and shell do branch.

### Build diagnostics

| Surface | Selector |
|---|---|
| Header pill / stale while dirty | `.cfg-save-warnings__pill` / `--stale` |
| List / one finding (clickable) / its artifact | `.cfg-save-warnings__panel` / `__item` / `__page` |
| Property badge dots | `.cfg-field-group__badge--invalid` / `--warning` |
| Tree row dot | `.cfg-tree-item__diag` (`--error` / `--warning`) — rolled up, so the count depends on what is expanded |

Badges come from `POST /api/config/validate` on the live draft, debounced —
wait ~2s after selecting. The pill sweeps the whole project via `GET` on mount
and after each save. Dump all findings in one go:

```js
await ed.locator('.cfg-save-warnings__pill').first().click();
await ed.waitForTimeout(1500);
console.log(await ed.locator('.cfg-save-warnings__item').allTextContents());
```

The count is project state that drifts; compare before/after, not against a
number. Clicking a finding navigates to its node — an end-to-end check that its
`widgetId` is real. To seed a `var-unknown`, patch the live `config.json`
(back it up first) and reload: validation re-reads files per request.

Known false positive: a digit-suffixed function in a `$stringExpr` template
(`Round2(1)`) reports `placeholder {2} is unbound`.

### Components editor

`ed.goto(ed.url().replace(/\/editor$/, '/components'))`.

| Surface | Selector |
|---|---|
| Canvas | `.widget-preview-canvas` — rendered **inline**, no iframe, no `force` (`h.canvas` finds nothing) |
| A widget in it | `.widget-preview-canvas [data-widget-id]:visible` (unfilled Labels render zero-size) |
| Slot box / unfilled outline / its name | `.hmi-slot` / `.hmi-slot--empty` / `.hmi-slot__empty-label` |
| Preview size inputs | `.component-preview-size__input` |
| Slot picker of a `ComponentSlot` | the **Slot name** row's `.cfg-select` — one option per declared `widgets` property |
| Add property | definition row selected → `button[title="Add component property"]` → `.property-dialog`; key `getByPlaceholder('e.g. motorVar')` |

- The dashed `.hmi-slot--empty` outline renders **only here**; a placed
  instance's unfilled slot renders nothing in the page preview or the runtime.
  Counting both is cheaper than comparing screenshots. Page subject:
  `db-tanks` on the testbench dashboard (a `$component:card` with
  `showTitle: true` and no `action` child).
- A definition's subtree starts expanded — clicking its toggle collapses it.
  Collapse-all also hides the folder rows, so later lookups by definition name
  time out.
- Row names repeat across definitions: select the definition first, then
  `.last()`.
- The add drawer from a definition lists no components: a component nested in a
  definition cannot be built through the UI.
- Clipboard flows: `context.grantPermissions(['clipboard-read',
  'clipboard-write'], { origin: h.BASE })` after boot.
- Add Container on a definition row is the cheapest visible undoable edit
  (`.cfg-tree-item` count +1).

### Config areas

Routes under `/editor/<projectId>/`: `editor`, `datasources` (not `variables`),
`translations`, `theme` (singular), `alarms`, `historian`, `recipes`,
`components`, `admin`, `users`. A wrong segment renders an empty shell that
times out 30s later.

- **Historian:** `.cfg-admin-section` cards (`Storage`, `Tracked variables`), a
  `.cfg-field-group` per variable, `button[title="Add variable to log"]` opens
  the binding picker.
- **Users:** clicking a user row shows Credentials + Group Membership;
  otherwise the panel is the global Settings.
- **Alarms:** the centre previews the selected alarm with the runtime's own
  cards, so `.hmi-toast` / `.hmi-modal` apply there too.
- **The shared `+ Add`** (`.cfg-add-btn`) is the same control on Historian,
  Recipes and component properties — locate it by `title`.

**Recipes** — the panels are centre cards with a data table, not field rows:

| Surface | Selector |
|---|---|
| Dataset type / dataset rows | `.cfg-tree-item--group` / `.cfg-tree-item`, count in `__count` |
| Schema / values table | `.cfg-recipe-table` / `--values` |
| Label cell / bound variable | `.cfg-recipe-label-cell input` / `.cfg-recipe-var-btn` (path `.cfg-recipe-var-path`) |
| Unbound row | `tr.cfg-recipe-row--unbound` |
| Reorder / delete | `[title="Move up"]` · `[title="Move down"]` · `[title="Remove parameter"]` |
| Search / live toggle / live cell | `.cfg-workspace__actions input` · `.cfg-var-live-btn` · `.cfg-recipe-td--live` |

The search matches label, bound path and type. A cell's text matches three
nested elements — pass `{ selector: '.cfg-recipe-var-path' }`.

**Datasources** — rows carry `data-row-path` / `data-row-kind`
(`folder`/`variable`/`array-element`), and the table is virtualised: filter
first, or the row is not in the DOM.

| Surface | Selector |
|---|---|
| Datasource list | `.cfg-ds-tree .cfg-tree-item__label` (`.cfg-tree-item` alone matches nothing there) |
| Filter | `input[aria-label="Filter datasource variables"]` |
| Min / Max | `[aria-label="Minimum value"]` / `"Maximum value"`, refused input `aria-invalid="true"` |
| Live column / write | `.cfg-var-live-btn` (off by default); `.cfg-vtable-cell--live` → `.cfg-var-write-input`, Enter |
| Expand all folders | `.cfg-var-collapse-btn` `.last()` |
| Rename | double-click `.cfg-var-inline-name`, fill `-input`, Enter |

Right-click empty table area to add at root, a folder row to add inside it.
Min/Max show on numeric rows of every datasource type and stay empty for
Boolean/String/date. The page **auto-selects the first datasource** on load, so
read the panel back to know which one is active.

**OPC-UA certificates** (`CertificateControls`): **Generate certificate**
(disabled under `No Security`) and **Certificate info** (disabled until a client
certificate path is set). Flip **Security Policy** to `Basic256Sha256` to enable
both — draft-only. The generate modal (`.name-modal`) writes nothing until
**Generate**; a real generate writes `<project>/certs/<base>-cert.der` +
`<base>-key.pem` immediately — delete them afterwards.

### Pickers, wizards and dialogs

| Surface | Open with | Selector |
|---|---|---|
| Image library | an image row's **last** row button | header `… › Select image` |
| Icon library | `button[title="Pick icon"]` | `Built-in` / `Custom` tabs |
| Variable binding | `button[title="Change variable binding"]` (`[title="Change variable"]` on recipes) | `.editor-binding-overlay` / `.editor-binding-dialog`, rows `.editor-binding-item` (`__name`, `__toggle`), **Show all** `.editor-binding-showall input`, commit with **Confirm** |
| Widget catalog | canvas right-click → **Add Widget/Component…** | left rail of categories, one card per entry with a `Built-in` / `Custom` / `Component` badge |
| Add datasource | `button[title="Add datasource"]` → `OPC-UA Client` | 3-step `Add OPC-UA connection` |
| Manual endpoint | `text=Enter URL manually instead` → `input[placeholder="opc.tcp://192.168.1.10:4840"]` + `input[placeholder="e.g. LinePLC"]`, **Next** twice | reaches **Test connection** without discovery |
| Address-space import | `button:has-text("Browse PLC")` | pending-diff panel, `Discard` / `Apply` |

Binding picker:

- **The drawer prints what the slot accepts** in its **Required** row (`String`,
  `Float`, `Float / Integer`, `Any`); after selecting a row, ✓/✗ appears and
  `getByRole('button', { name: 'Confirm' }).isDisabled()` is the gate.
- **Numeric slots hide non-matching tags** — "No compatible variables found"
  until **Show all** is ticked (absent when the slot accepts `Any`).
- **Search expands matching folders**, which makes leaf rows clickable;
  clicking a folder's label does not expand it. Clicking a leaf only selects.
- Nested slot of a tier-3 source: `setSource(ed, 'Value', 'If Condition')`,
  expand with `>`, and the condition is then the only `[title="Change variable
  binding"]` in the panel. A `$formula` input has no label:
  `input[placeholder*="{1}"]`.
- Trend's live-value row is labelled `Value`, not `Variable`.

Widget catalog: a category named after a project folder does not prove a custom
widget exists there — a folder can hold only components. Read the badge. A
`Custom` badge on a name the built-ins also ship means a project widget is
shadowing one. `/config/components` is not a catalog shot: it renders a
definition small and unthemed.

A fast, deterministic "Test connection" failure: `opc.tcp://127.0.0.1:1`
(refused at once, where an unknown host waits out the 10s timeout).

### Panel resize handles

`.cfg-resize-handle` `nth(0)` (tree | centre) and `nth(1)` (centre | panel).
Widths are custom properties on `.cfg-layout` (`--cfg-right-panel-w`; computed
`gridTemplateColumns` like `"260px 3px 938px 3px 340px"`) and persist in
`localStorage['cfg-layout:<view>:<side>']` — clear them, or double-click the
handle, before a baseline shot.

## Runtime

| Surface | Selector |
|---|---|
| Region | `[data-region="header"|"leftSidebar"|"rightSidebar"|"footer"]` |
| Widget roots | `.hmi-component`, `.hmi-container` (content in `.hmi-container__content`) — `data-widget-id` exists only in the editor preview |
| Button / NumericStepper | `.hmi-button__btn` (icon-only has empty `innerText`) / `.hmi-numeric-stepper` (`__btn` first/last) |
| Nav link | `.hmi-navmenu__link:has-text("<title>")` |
| Dialog / alarm detail | `.hmi-modal` |
| Alarm auto-popup | a separate corner card with `ACK`, not `.hmi-modal` |
| Toast | `.hmi-toast` (`--error` / `--warning` / `--info`) |
| Locked widget | `.hmi-lock-wrapper`, overlay `.hmi-lock-overlay` (click `force`), flash `.hmi-lock-flash` (fades over 700ms — shoot ~40ms after the click) |
| Number input / virtual numpad range | `.hmi-number-input__field` / `.hmi-virtual-input__range` |
| Binding overlay | `.hmi-binding-wrapper` > `.hmi-binding-overlay--{disabled,disconnected,nodata}` |
| Language switcher | a native `<select>` — `selectOption` works here |
| Unknown widget type | `.hmi-unknown-widget` |

- **A Container's flow settings live on `.hmi-container__content`.** The outer
  `.hmi-container` is always a column (title above content); measure the inner
  box for `direction`/`gap`/`wrap`.
- **Unset `align-items` computes to `"normal"`** where a declared
  `var(--x, stretch)` computes to `"stretch"` — same behaviour, different
  strings.
- **CSS-module roots hash their class**; filter by a child
  (`.hmi-component` `{ has: '[class*="rowTitle"]' }`) rather than
  `[class*="wrapper"]`.
- **Per-widget stylesheets land after `networkidle`.** An early shot shows bare
  HTML (`Cap torque1.43Nm`) and looks like a CSS regression. Count the
  stylesheets, or assert a widget root computes a real rule.
- **Top-level page children use `content-visibility: auto` with a 48px
  intrinsic size**, so cards frozen at 48px tall are either a too-early shot or
  a real collapse — re-shoot later to tell which.
- **A runtime Dropdown inside a modal:** `.hmi-modal button:has-text("<value>")`,
  options `[role=option]`; a generic `button[aria-haspopup=listbox]` hits one
  behind the modal.
- StringInput with `isPassword` renders `type="text"`.
- A project SVG icon is inlined (`.hmi-icon__svg`, `.hmi-button__icon-svg`); a
  built-in icon is a Phosphor component; the *editor* renders project icons as
  `<img>`.

**Layout chain** — probe computed values, a single-Container region hides a gap
regression from screenshots:

| Element | Expected |
|---|---|
| `.hmi-main` | `display: flex`, column, `overflow: auto` |
| `.hmi-page__content` | `overflow: auto` (the one scrollport), `gap: --hmi-space-lg` |
| `.hmi-page__header` / `__footer` | `gap: --hmi-space-lg` |
| `[class*="region-header"]`, `region-leftSidebar` | `gap: --hmi-space-sm` |
| `.hmi-container` | `margin: 0px` |

### Forcing states

- **Binding-unavailable overlay:** `await context.setOffline(true)` and wait
  ~4s — every bound widget wraps in `.hmi-binding-overlay--disconnected`.
- **A widget whose struct binding lacks `requiredFields`** renders a red ✕
  placeholder. No built-in widget has a struct field any more; use a custom
  widget that declares `requiredFields`.
- **State that is not live** (an alarm popup, any server push): collect sockets
  in an init script and dispatch the frame the backend would send. The runtime
  opens three sockets; the next real update overwrites the injection.

```js
await page.addInitScript(() => {
  const Native = window.WebSocket;
  window.__sockets = [];
  window.WebSocket = function (...a) { const ws = new Native(...a); window.__sockets.push(ws); return ws; };
  window.WebSocket.prototype = Native.prototype;
  Object.assign(window.WebSocket, Native);
});
await page.evaluate((msg) => {
  for (const ws of window.__sockets) ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }));
}, { type: 'alarm_update', active: [/* instance with auto_popup: true */], summary: {} });
```

  Tap the same socket to count `var_update` keys when a chart looks idle —
  only a few testbench tags actually tick.

- **Values through the write API** (same story in editor and runtime shots):

```bash
curl -s -u <user>:<password> -X POST http://localhost:<project-port>/api/datasources/write \
  -H 'Content-Type: application/json' -d '{"datasource":"Machine","path":"Kpi/Oee","value":89.2}'
```

  The **project** port from `/api/manager/running` over plain http, a *project*
  user, writable nodes only (the sim drives the read-only ones), and within the
  variable's `min`/`max` (else `value_out_of_range`). Writes live in the test
  server's RAM until `--stop`.
- **A static datasource silently drops a struct-field write** (`{ field:
  'fValue' }`) while reporting success. Use the test-server datasource or a leaf
  path when the value is what you are checking.

## Built-in widgets and project content

### Where widget code is served from

| Kind | Module | Stylesheet |
|---|---|---|
| Built-in (`frontend/widgets/`) | `<base>/builtin-widgets-js/<Group>/<Name>/index.js` | same folder, `style.css` |
| Project custom | `<base>/widget-js/<Group>/<Name>/index.js` | `<base>/widgets/<Group>/<Name>/style.css` |

`<base>` is `/runtime/<slug>/` or `/editor/<slug>/`. Log responses on those
paths to prove a widget loaded; a failed lazy load leaves no DOM node at all
(the Suspense fallback is `null`), so assert on counts. `.hmi-unknown-widget`
above 0 means a type never registered — a different bug from a failed fetch.
`h.watchErrors` keeps only errors; attach your own `console` listener when a
warning (`… shadows the built-in …`) is the assertion.

**`frontend/dist` wins.** When it exists, project instances serve built-ins from
`frontend/dist/builtin-widgets-js`, not the `public/` copy that `npm run dev` and
`npm run build:builtin-widgets` write — and the backend validates against the
`dist` manifest pair too. An edited widget then looks unchanged, survives a
restart, and reads like a caching bug. `start-dev.py` warns when `dist` is older
than the widget sources. For a before/after on one widget, rebuild and copy the
widget (and, if its schema changed, the manifest pair) across:

```bash
(cd frontend && npm run build:builtin-widgets)
cp frontend/{public,dist}/builtin-widgets-js/<G>/<W>/index.js
cp frontend/{public,dist}/builtin-widgets-js/<G>/<W>/style.css
cp frontend/public/builtin-widgets-js/manifest{,.editor}.json frontend/dist/builtin-widgets-js/
```

Or run the full `npm run build` per state, or delete `frontend/dist`. Keep the
"after" source in the scratchpad rather than `git stash` — a throwing run can
leave the tree stashed, and stashing source does not touch `dist`. Prove what
is served by fetching it from the page (`cache: 'no-store'`) and diffing it
against the file on disk.

### Editing the live project on disk

| Edit | Picked up by |
|---|---|
| `pages/*.json`, `config.json` (page tree, shell, theme) | a browser reload — validation and page loads re-read per request |
| `components/*.json` | a backend restart; until then an instance renders as a red `$component:<id>` placeholder |
| Service config (`historian/config.json`, alarms, …) | a backend restart — the managers serve an in-memory copy |
| `custom-widgets/<Name>/*` | the backend watcher recompiles on save |

Back up a file to the scratchpad before the first edit and copy it back after;
`.bak` files already in the testbench are from earlier sessions. To check a
component definition the backend may be rejecting:

```bash
python -c "import json,sys; sys.path.insert(0,'backend'); from models.component import ComponentDefinition; ComponentDefinition(**json.load(open('<live-project>/components/<Group>/<name>.json')))"
```

The theme is `project.defaultTheme` in `config.json` — patch, reload, and the
whole runtime re-skins.

### Authoring project JSON by hand: silent failures

All of these render something plausible, log nothing, and pass
`GET /api/config/validate`:

| Symptom | Cause |
|---|---|
| A Button does nothing | `actions` is keyed by event — `{"onPress": [...]}` (Dropdown/ButtonRow: `onChange`); a bare array is no actions |
| Empty chrome where a glyph should be | `iconName` is not on the allowlist in `shared/config/iconAllowlist.ts`; a project SVG works: `{"$static": {"type": "custom", "path": "icons/x.svg"}}` |
| A TabBar in a shell region renders nothing | it needs the page-group context, which only the content region provides — use `NavigationMenu` there |
| A NavigationMenu pushes header siblings off-screen | it never applies its own Layout keys and `--horizontal` is `width: 100%` — constrain it from a fixed-width parent |
| A Label wraps although set to `"nowrap"` | only `"wrap"` and `"truncate"` exist; anything else falls back to wrap |

A manual NavigationMenu item shows its `label` or the raw `pageId`, never the
page's title. A `$stringExpr` template is literal — pass words to translate as a
`$loc` wildcard (`"{1} {Round1(2)} °C"` with `"1": {"$loc": "target"}`).

Whole-project sweep without clicking:
`fetch('/editor/<projectId>/api/config/validate')` → `.diagnostics`.

## Measuring instead of eyeballing

**Live values make pixel diffs useless** — two runs with identical CSS differ by
thousands of pixels on a testbench page. Diff computed geometry as text:

```js
const geom = await page.evaluate(() =>
  [...document.querySelectorAll('.hmi-container, .hmi-component')].map((el, i) => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return [i, el.className, ...[r.x, r.y, r.width, r.height].map(Math.round),
      cs.flexBasis, cs.flexGrow, cs.flexShrink, cs.alignSelf,
      cs.minWidth, cs.maxWidth, cs.minHeight, cs.maxHeight].join('|');
  }));
```

`diff <(sort before.txt) <(sort after.txt)`; take a second same-CSS run as the
noise baseline. For a CSS-neutral refactor, also record the inner
`.hmi-container__content` flex properties and ignore width/height-only diffs.

- **Tokens:** read resolved values off the document root —
  `getComputedStyle(document.documentElement).getPropertyValue('--hmi-space-sm')`.
  An unknown token returns `''`, which is how a renamed one hides. The testbench
  theme is not `themeDefaults.json` (`--hmi-space-sm` is `0.6875rem`), so a
  hardcoded px value stands out there.
- **`var()` works in SVG presentation attributes** (`stroke="var(--hmi-series-1)"`),
  so a chart palette can follow the theme.
- **Ink width:** `scrollWidth` never drops below `clientWidth`; use a Range over
  the text node (`range.selectNodeContents(el); range.getBoundingClientRect().width`).
- **Overflow:** list elements with `r.right > document.documentElement.clientWidth + 1`.
- **Hidden boxes read as zero** — require a non-zero width before comparing
  (`.cfg-field-group__actions` is hidden when empty); detect clipped text with
  `scrollWidth > clientWidth + 1`.
- **Scrollbars measure 0px by default** (`--hide-scrollbars`, overlay bars on
  macOS). Launch with `h.launch({ showScrollbars: true })` and compare against a
  bare control div.
- **Small glyphs:** shoot at `dpr: 3` and `shotEl` the glyph; upscaling a 1x crop
  only blurs it.
- **Boot sequences** (flashes, palette flips) live in a ~600ms window: sample in
  an `addInitScript` every 4ms, `goto` with `waitUntil: 'commit'`, and collapse
  identical samples. Do not throttle bandwidth against the dev server — Vite's
  unbundled modules never finish loading.
- **Prove an after-save action left the runtime alone:** record requests after
  the edit and count `/runtime/` and `/preview/` URLs.
- **Wrap the drive script's top-level IIFE in `.catch()`** — an uncaught failure
  exits with no output at all.

## Shooting for docs

- **One page at three viewports:** drive the runtime with `setViewportSize` +
  `goto` per size (`1440x900`, `900x1200`, `390x844`); the editor presets only
  scale a fixed canvas. Use `dpr: 2` for anything going into a device frame.
  Branch `basis`/`grow` per viewport alongside `direction`, and a collapsed
  sidebar's `NavigationMenu` needs its own `collapsed` too.
- **Narrow laptop:** launch at `width: 1750` on Fit to screen — the iframe is
  ~1064px wide, still `laptop` for `$viewport`.
- **Chrome-free content:** `shotEl(page.locator('main .hmi-container').first())`,
  with the root Container set to `width: fit-content`.
- **Trends:** a live TrendChart or Trend starts empty on every page entry —
  wait ~60s. Recorded history includes the `0` sample a restart writes.
- **Fit the viewport height** to the page instead of clipping; the shell
  re-flows. Shoot the translations table unscrolled (its header is translucent).
- **One properties group:** `shotEl` on its `.cfg-section`.

Clips at a 1500×1000 viewport (`y: 40` skips the top bar):

| Route | Clip |
|---|---|
| `historian` | `{ x: 55, y: 40, width: 1445, height: 460 }` |
| `users` | `{ x: 0, y: 40, width: 1500, height: 460 }` |
| `translations` | `{ x: 0, y: 40, width: 1500, height: 620 }` |
| `alarms` | `{ x: 0, y: 40, width: 1500, height: 720 }` |
| `admin` | `{ x: 55, y: 40, width: 1445, height: 290 }` |
