# NEXT HMI Data And Config Architecture

Back to architecture hub: [overview.md](overview.md).

## Scope

This document describes the user-managed files inside a single project folder and the data formats currently used by the application.

A project is a self-contained folder anywhere on disk, registered in the runtime-home manifest (`<runtime_home>/projects.json`). The manager runs a *set* of projects concurrently — each running project is a separate backend instance pinned to its folder (see [backend.md](backend.md)). In a development checkout that has the private `project-testbench/` cloned in, that folder doubles as the auto-bootstrapped first project — that's why the layout below uses `<project>/` as the root. `project-seed/` is the separate clean template in this repository, used to seed the first project when `project-testbench/` is absent and by binary/Docker builds.

## Directory Layout

```text
<project>/
  assets/
    icons/
    images/
  certs/
  custom-widgets/
    _template/
    <ComponentName>/
  external-libraries/     ← ESM bundles consumable by custom widgets
  datasources/
    <DatasourceName>.json
  config.json             ← page index + globalEvents + embedded project metadata/defaultTheme
  themes/
    <themeId>.json        ← one theme each (colors, typography, spacing)
  pages/
    <pageId>.json         ← per-page component tree
  components/
    <componentId>.json    ← user-defined reusable component
  alarms.json             ← alarm definitions (groups + alarms)
  alarm_state.json        ← runtime alarm state (active + history)
  recipes.json            ← recipe dataset types (parameters + saved datasets)
  recipe_state.json       ← loaded dataset per type
  translations/
    Default.csv
    <DictionaryName>.csv
  users.json
  historian/              ← historian runtime state (SQLite db + config); db files excluded from exports
    config.json           ← travels with the project (push/pull/zip)
    *.db, *.sqlite        ← installation-local; stripped from project zips
```

Outside any project, the runtime keeps its own state:

```text
<runtime_home>/
  projects.json           ← manifest (running[], projects[], peers[], defaultProjectId, defaultProjectsRoot)
  .manager-auth.json      ← device-admin password digest + session secret (PBKDF2 + HMAC)
  licenses/               ← signed Ed25519 license tokens, one file per license (<id>.key)
  .logs/                  ← rotating application logs
  .widget-build/          ← compiled custom-widget JS (shared across all instances)
  .restart-pending        ← sentinel written by /api/system/restart
  .peer-tokens.json       ← hashed manager peer tokens (no bearer plaintext)
  .peer-transfer-sender.json   ← durable outgoing (push) phases, byte counts, and retry fingerprints (no bearer plaintext)
  .peer-transfer-receipts.json ← durable incoming (push-receive) claims, apply phases, identities, and receipts
  .peer-transfer-pull.json     ← durable outgoing-pull phases, identities, and receipts
```

### Manifest schema (`projects.json`)

```jsonc
{
  "version": 1,
  "running": [                 // the supervisor's running set — source of truth for "which projects are up"
    { "id": "<uuid>", "port": 51234, "startedAt": "<ISO-8601>" }
  ],
  "projects": [                // every registered project
    { "id": "<uuid>", "name": "...", "path": "/abs/path", "lastOpenedAt": "...", ... }
  ],
  "peers": [ ... ],            // manually-added manager LAN peers
  "defaultProjectId": "<uuid>",  // the project the origin root ("/") redirects to
  "defaultProjectsRoot": "/abs/path"
}
```

`running[].port` remembers the last bound port so `resume_all()` can re-bind it after a manager restart when it is still free. There is no single "live project" concept — the supervisor keeps a *set* of projects up, and `defaultProjectId` is independent of that set (a project can run without being the default, or be the default while stopped).

## What Lives Where

- `<project>/config.json`
  - Page index: HMI page list, header, footer, dialog metadata, global lifecycle events (v2 — no component children for pages). Also holds `project.defaultTheme` — the id of the default theme
- `<project>/themes/<themeId>.json`
  - One theme per file (colors, typography, and spacing tokens editable in Theme Editor). The id is the file stem
- `<project>/pages/<pageId>.json`
  - Per-page component tree for one page
- `<project>/components/<componentId>.json`
  - User-defined reusable component: input properties + internal component tree
- `<project>/alarms.json`
  - Alarm groups and definitions
- `<project>/alarm_state.json`
  - Persisted runtime alarm state (active alarms + history); written by the backend. Shipped in push/pull/zip transfers — receiving a push overwrites the local ack state.
- `<project>/recipes.json`
  - Recipe dataset types: parameter definitions + saved datasets
- `<project>/recipe_state.json`
  - Loaded dataset per type; written by the backend
- `<project>/datasources/*.json`
  - datasource settings and variable trees
- `<project>/translations/*.csv`
  - translation dictionaries
- `<project>/users.json`
  - users, groups, and access settings. A fresh seed also carries `operatorSetup: { version: 1, required: true }`; authenticated manager setup atomically creates the `admin` operator and changes `required` to `false`
  - new credentials use the server-managed `passwordHash` object `{ version: 1, algorithm: "pbkdf2-sha256", iterations: 200000, salt: "<hex>", digest: "<hex>" }`, while `password` remains `""`. The separate field makes every string in a legacy `password` field literal plaintext, including values beginning with `$nexthmi$`; valid markerless legacy documents are read without migration or rewriting
  - marker-bearing documents must retain the seed `guest` and `admin` groups and canonical passwordless `guest` user. A completed marker additionally requires the canonical `admin` user, a valid `passwordHash`, and valid group references. Missing, unreadable, corrupt, or invariant-breaking user documents are credential errors and keep the project stopped
  - the editor keeps pending security edits in a separate global frontend draft and writes the complete document atomically only through **Save users**. API reads omit `passwordHash`, redact `password` to `""`, and expose only `passwordSet`; a non-empty password edit creates a new hash, and clients cannot submit `passwordHash`. Generic project Save, snapshots, and Undo/Redo never include it
- `<project>/custom-widgets/*/`
  - custom component source and optional assets (compiled `index.js` lives in `<runtime_home>/.widget-build/<Name>/`, not here)
- `<project>/external-libraries/*/`
  - third-party ESM bundles importable from custom-widget source
- `<project>/assets/icons`, `<project>/assets/images`
  - user-supplied SVG icons and images, served at `/assets/*`
- `<project>/certs/`
  - reserved certificate folder created by the backend
- `<project>/config.json` → `project`
  - embedded per-project metadata (stable UUID + display name + creation time); created on first registration and round-tripped through pack/unpack so the same folder always resolves to the same manifest entry
- `<project>/historian/`
  - historian runtime state (SQLite database + `config.json`). `config.json` travels with project pushes/pulls/zips; data files matching `*.db`, `*.db-wal`, `*.db-shm`, `*.sqlite`, `*.sqlite-journal` are stripped by `core.project_packer` so they stay installation-local.

## Config File (v2 — Split-Page Storage)

`config.json` is the **page index**. It stores page metadata and structure but **no component children** for individual pages. Component trees for each page live in separate `pages/<pageId>.json` files.

Top-level shape (`api.config_api._empty_config`):

```json
{
  "version": 2,
  "pages": [],
  "header": [],
  "footer": [],
  "leftSidebar": [],
  "rightSidebar": [],
  "shell": {},
  "dialogs": [],
  "globalEvents": {},
  "mcpEnabled": false
}
```

One further key, `project`, is written by `core.manifest` rather than by the
config API: the embedded metadata block (project id, name, `defaultTheme`) that
makes a folder self-identifying, so an export, a peer transfer, or **Add
existing** can recognise it. A freshly seeded project carries only the keys it
needs; every reader defaults the rest.

`mcpEnabled` is the per-project MCP write gate, toggled from the manager
dashboard via `POST /api/projects/{id}/mcp` and reported by `projects_list`. A
`PUT` of the config that omits the key preserves the stored value.

`globalEvents` is a singleton config of action arrays fired on app/page lifecycle:

- `onHmiLoaded`
- `onPageLoaded`
- `onLocaleChanged`
- `onUserLoggedIn`
- `onUserLoggedOut`

Index page node (no `children` key):

```json
{
  "id": "19ba0ff4-...",
  "title": "Main",
  "type": "page",
  "icon": "home"
}
```

Index page-group node (children are page references only):

```json
{
  "id": "grp-1",
  "title": "Section",
  "type": "page-group",
  "children": [
    { "id": "page-2", "title": "Sub Page", "type": "page" }
  ]
}
```

Per-page file shape (`pages/<pageId>.json`):

```json
{
  "id": "19ba0ff4-...",
  "children": [
    {
      "id": "comp-abc",
      "type": "Button",
      "name": "Start",
      "properties": {},
      "layout": {}
    }
  ]
}
```

A widget node carries `id`, `type`, `name`, `properties`, `layout`, optional
`children`, and — only on a child of a `$component:` instance — an optional
`slot` naming which of the definition's slots it fills (see
[Component slots](#component-slots)).

### Shell

The four shell regions store their component trees **inline** in `config.json`,
one array each: `header`, `footer`, `leftSidebar`, `rightSidebar`. The canonical
region order (`SHELL_REGION_IDS`, top → bottom in the editor tree) is header,
leftSidebar, rightSidebar, footer. In the editor's page tree each region is
addressed by a synthetic section id — `__header__`, `__leftSidebar__`,
`__rightSidebar__`, `__footer__`.

The sibling `shell` object holds the regions' *behaviour*, never their contents:

```json
{
  "shell": {
    "leftSidebar": {
      "enabled": true,
      "expandedSize": "240px",
      "collapsedSize": "48px",
      "defaultState": "expanded",
      "expanded": { "$var": { "path": "HMI:ui/bMenuOpen" } },
      "overlay": false,
      "fullHeight": true,
      "background": "#111827"
    },
    "hmiScale": 1,
    "showScrollbars": false,
    "appTitle": "Line A",
    "appIcon": "images/logo.svg",
    "bootLogo": "images/logo.svg"
  }
}
```

Per region (`ShellRegionConfig`): `enabled` (default `true`), `expandedSize` /
`collapsedSize` (CSS lengths — width for a sidebar, height for header/footer),
`expanded`, `overlay`, `background`, `defaultState` (`expanded` | `collapsed` |
`hidden`) and `fullHeight` (sidebars only). All of them except `defaultState`
are **bindable** — they accept any property source, not just a literal, and
`ShellRegion` re-evaluates them as the bound values change.

Project-wide: `hmiScale` (CSS `zoom` on `.hmi-layout`, default `1`),
`showScrollbars` (paint native scrollbars on scrollable HMI surfaces; unset
keeps them scrollable but chromeless), `lockedFeedback` (what a press on a
non-interactable component produces — `flash`, the default ⊘ marker at the
pointer, `toast` for a warning notification, or `none`; the component is dimmed
and blocked in every mode), `appTitle`
(browser tab), `appIcon` (path under `assets/`, or an absolute URL), and
`bootLogo` (path under `assets/`) — the boot-screen logo, which replaces the
product mark and name. Edition-bound: only the `ee` build offers a setting for
it *and* reads it, so the public build shows the product branding whatever the
key says. The AGPL notice beside it is edition-bound the same way, and no
setting hides it (see `COMMERCIAL.md`).

A page may carry `shellOverride`, a `Partial<ShellConfig>` merged on top of the
project shell for that page only. The page panel offers the same region fields
as the Shell area panel, and the merge is per field — an absent key inherits the
project value, so a page can also turn a project-wide `enabled: false` region
back on.

`dialogs` stores dialog definitions inline:

- `id`
- `title`
- optional `closeOnBackgroundPress`
- optional `showCloseButton`
- `children` — component tree

### Storage behavior

The page index (`config.json`) and per-page trees (`pages/<id>.json`) are read
and written through the `/api/config/*` endpoints documented in
[../reference/rest-api.md](../reference/rest-api.md). Orphaned page files — files
whose IDs are no longer in the index — are automatically removed when the index
is saved.

### Property Values

Every component/layout/alarm property value is either a raw primitive (`"hello"`, `42`, `true`) or a `$`-keyed object naming the **property source** producing the value. The field's `type` decides which value type is needed; the source decides where the value comes from. The full model — the value types, optional formats, every property source and its shape, `$var` tree shapes, OPC-UA type collapse, and resolution/coercion rules — is specified in [value-types.md](value-types.md).

On disk, each source is stored verbatim under its `$`-prefixed key. Variable bindings use the `$var` source:

```json
{
  "$var": {
    "path": "MyPLC:Motor1/Speed"
  }
}
```

Localization references use the `$loc` source:

```json
{
  "$loc": "common.start"
}
```

## Theme Files

A project holds multiple named themes under `<project>/themes/`, one
`<themeId>.json` per theme (the id is the file stem). Each file stores a bare
theme configuration managed by the Theme Editor. The author-chosen default theme
id is recorded in `config.json`'s `project.defaultTheme`; runtime theme switching
is a client-side concern. Defaults come from `frontend/src/shared/themeDefaults.json`,
the single source of truth shared between backend Pydantic models and the frontend
registry.

On first access the backend seeds `themes/default.json` from defaults if no
theme exists yet. A theme file is read as-is — there is no legacy shape and no
read-time normalization.

One theme file has three sections:

- **colors** — `bg`, `surface`, `surface_raised`, `text`, `text_muted`,
  `accent`, `border`, `ok`, `warn`, and `fault`.
- **typography** — seven combos (`heading`, `subheading`, `body`, `caption`,
  `code`, `value`, `label`), each with `<combo>_font`, `_size`, `_weight`,
  `_tracking`, and `_transform`.
- **spacing** — `space_sm`, `space_md`, `space_lg`, `radius_sm`, `radius_md`,
  `radius_lg`, and `shadow`.

That is 52 editable fields: 10 colors, 35 typography values, and 7 spacing
values. `frontend/src/shared/themeDefaults.json` is the exact canonical JSON
shape and `project-seed/themes/light.json` is kept byte-for-byte equivalent.
Extra fields are rejected by the backend (`extra="forbid"`).

The token catalog, the editor metadata, and the defaults-→module-load-→`/api/themes`
apply pipeline are documented in [../reference/theming.md](../reference/theming.md);
the `/api/themes` endpoints in [../reference/rest-api.md](../reference/rest-api.md).

## Alarm Files

`alarms.json` stores configured alarm groups and definitions:

```json
{
  "version": 1,
  "groups": [
    {
      "id": "<uuid>",
      "title": "Group",
      "alarms": [
        {
          "id": "<uuid>",
          "code": "ERR",
          "level": "error",
          "title": { "$loc": "alarm.motor1" },
          "description": "",
          "image": "",
          "auto_popup": true,
          "resolutions": [],
          "trigger": {
            "type": "value_range",
            "source_value": { "$var": { "path": "MyPLC:Motor1/Speed" } },
            "min": 0,
            "max": { "$static": 100 },
            "on_true": true
          },
          "ack_groups": []
        }
      ]
    }
  ]
}
```

Trigger types:

- `bool` — fires when the variable equals `on_true`
- `value_range` — fires when the variable is outside `[min, max]`; both bounds may be plain numbers, `$static`, or `$var`

`source_value` carries the `$var` binding for the monitored variable; `index` selects an array element. Title/description/image fields accept plain strings, `$static` (an image carries a `{ path }` payload), or `$loc` keys.

`alarm_state.json` is owned by the backend and tracks runtime state:

```json
{
  "active": [ /* AlarmInstance entries with triggered_at, acked, acked_by, acked_at */ ],
  "history": [ /* AlarmHistoryEntry entries, newest first; capped at 500 */ ]
}
```

## Recipe Files

`recipes.json` stores **dataset types**
(independent axes). Each type owns **parameters** (definitions only — binding +
data type, no value) and **saved datasets** (named value sets holding one value
per parameter). Persisted in camelCase (models in `models/recipe.py`).

```json
{
  "version": 1,
  "datasetTypes": [
    {
      "id": "coffee",
      "name": "Coffee",
      "parameters": [
        {
          "id": "temp",
          "label": "Brew Temperature",
          "binding": { "$var": { "path": "PLC1:Brew/Temp" } },
          "dataType": "float"
        }
      ],
      "datasets": [
        { "id": "espresso", "name": "Espresso", "description": "",
          "values": { "temp": 92 }, "updatedAt": "", "updatedBy": "", "loadedAt": "" }
      ]
    }
  ]
}
```

A parameter carries exactly `id`, `label`, `binding` and `dataType` — no unit,
range or option metadata, and nothing else (`extra="forbid"`). `dataType` uses
the canonical simple types (`boolean | integer | float | string
| datetime`) plus their `[]` arrays (free length). `recipe_state.json` is owned
by the backend and tracks the loaded dataset **per type** (multiple types can be
loaded at once):

```json
{
  "loaded": { "coffee": { "datasetId": "espresso", "loadedAt": "2026-07-01T…" } }
}
```

## Widget Files

Each reusable component is stored at `<project>/components/<id>.json`:

```json
{
  "id": "<uuid>",
  "name": "MyWidget",
  "componentProperties": {
    "label": { "type": "string", "label": "Label", "defaultValue": "Motor" },
    "value": { "type": "float", "label": "Value", "description": "Speed in rpm" },
    "io":    { "type": "struct", "label": "IO", "structSchema": [/* nodes */] }
  },
  "children": [ /* WidgetConfig nodes; properties may use $componentProp but not $var */ ]
}
```

Each entry of `componentProperties` carries `type` and `label`, plus optional `description` (one line shown under the field in the properties panel), `defaultValue`, `structSchema`, `write`, `options`, `display`, `placeholder`, `min`, `max`, `step` — and nothing else (`extra="forbid"`). `defaultValue` is real at runtime, not editor-only: `ComponentRenderer` fills it in for every property the instance leaves `undefined`, so the value the properties panel prints as the field's `· default` hint is the value `$componentProp` resolves to. An explicit `null` is a set value and does *not* fall back.

The component direct-binding rule is recursive: no `$var` source may appear in any child value or `componentProperties[*].defaultValue`, including inside nested objects, lists, or other property sources. Component writes, diagnostics, persisted reads, and project imports share that rule and report the exact escaped JSON source path ending in `/$var`; diagnostic field paths are unescaped for editor lookup. Startup scans all component files before metadata migration, leaving binding-invalid files byte-for-byte unchanged. A present component file that is malformed JSON, invalid UTF-8, or unreadable fails closed at its root source path (`components/<file>.json#/`) rather than being treated as absent or valid. The component root, nested directories, and JSON files must be real in-project filesystem entries, never symlinks or Windows reparse points. All metadata migration and CRUD/folder mutations remain anchored to retained no-follow POSIX directory descriptors or Windows no-delete-share directory handles; deletion is likewise descriptor/handle based. A root, group, or file swapped after validation therefore cannot redirect the operation to external data. Imports, pushes, and pulls reject and clean up such projects before registration. Nested reusable components are also rejected. A `$componentProp` is only substituted when it is a property's entire value (`"text": {"$componentProp": "label"}`); nested inside another source, or anywhere outside `properties` such as `layout`, it resolves once and then stops updating, so validation reports it as a `componentprop-nested` warning. Compute the derived value on the instance — instances may use `$var` freely — and pass the finished result through a plain `$componentProp`.

### Component slots

A definition declares a **slot** by placing a `ComponentSlot` widget in its tree; the widget's `slot` property is the slot's name (blank means `content`). The set of slots is therefore structural — read straight off the definition's `children`, at any depth.

A slot may also be **named in `componentProperties`**, as an entry of type `widgets`:

```json
"componentProperties": { "body": { "type": "widgets", "label": "Body" } }
```

The property key *is* the slot name — a `ComponentSlot` whose `slot` is `body` renders it — and the entry carries the label, description and panel position. That is all it carries: a `widgets` property holds no value, takes no `defaultValue` or `write` flag, and `$componentProp` cannot read it. What it buys is a row in the instance's properties panel listing the widgets filling that slot.

The two halves are one declaration and validation reports either half alone: a property no `ComponentSlot` names is `slot-property-unmatched` (the editor drops the row rather than offering one whose content would land elsewhere), and a `ComponentSlot` naming no property is `slot-undeclared` (the slot renders, but no caller can see it in the panel). The editor only ever writes the pair — the slot name is picked from the declared properties, never typed.

An instance fills them from the page tree. A `$component:<id>` node carries its own `children`, and each child names the slot it fills:

```json
{ "id": "card-1", "type": "$component:card", "children": [
  { "id": "w1", "type": "Label", "slot": "header" },
  { "id": "w2", "type": "Gauge", "slot": "body" }
] }
```

One flat array holds every slot's content — `slot` is a tag on the child, the way `slot="header"` works in Web Components — so every existing walk over `children` (id collection, delete, duplicate, diagnostics roll-up, search) covers slot content without knowing slots exist. An untagged child, or one naming a slot the definition no longer has, renders in the first slot and raises a `slot-unknown` warning; children on a component that declares no slots raise the same warning and render nowhere.

## Datasource Files

Each datasource is stored in `<project>/datasources/<safeName>.json`.

Supported datasource types:

- `opcua-client`
- `static`
- `opcua-test-server`

Example shape:

```json
{
  "type": "opcua-client",
  "name": "MyPLC",
  "settings": {
    "server_url": "opc.tcp://localhost:4840",
    "username": "",
    "password": "",
    "security_policy": "NoSecurity",
    "security_mode": "SignAndEncrypt",
    "client_certificate": "",
    "client_private_key": "",
    "client_private_key_password": "",
    "server_certificate": "",
    "reconnect_interval_s": 5,
    "bg_publish_interval_ms": 1000,
    "disable_background_sync": false,
    "browse_root_node": ""
  },
  "variables": []
}
```

Filename behavior:

- the REST route key is the datasource name
- the saved filename is sanitized so non-alphanumeric characters outside `-` and `_` become `_`
- relative OPC-UA certificate/key paths resolve from the project root; absolute
  paths remain supported for installation-specific credentials

## Variable Tree Model

Datasource variable trees are nested arrays of folders and variables.

Folders:

```json
{
  "kind": "folder",
  "name": "Motor1",
  "node_id": "ns=2;i=10",
  "children": []
}
```

Leaf variables:

```json
{
  "type": "variable",
  "node_id": "ns=2;s=Motor1.Speed",
  "display_name": "Speed",
  "data_type": "Float",
  "enabled": true,
  "writable": true,
  "value": 123.4,
  "min": 0,
  "max": 100
}
```

Notes:

- `value` is used by static datasources
- `writable` is optional and usually present after browse or manual editing
- `min`/`max` are optional and only meaningful on numeric variables — configured from the datasource variable table (scalars and struct fields alike). Surfaced through `variable_metadata()` (top-level `min`/`max` for scalars, `fieldRanges: { field_name: { min?, max? } }` for structs) and exposed to custom widgets via the `useVariableMeta` SDK hook (see [../reference/custom-widgets.md](../reference/custom-widgets.md)).
- `sim_min`/`sim_max` are optional and read only by the bundled test server (`opcua-test-server`). With **both** set and `sim_min < sim_max`, the simulated wave for that node oscillates inside that band (booleans flip around its midpoint, integers round) instead of the index-derived default range; a missing, inverted or non-numeric bound falls back to the default wave, so a hand-edited file cannot break the simulation loop
- folders with direct variable children become struct-style aggregate values in the live cache
- folders can be nested: a struct folder may contain child folders that are themselves structs (struct-in-struct) or indexed sub-folders `[0]`, `[1]`, … (array-of-struct)
- nested struct folders produce nested objects in the live cache (e.g. `{ bVisible: true, limits: { fMin: 0, fMax: 100 } }`)
- array-of-struct folders produce JSON arrays of objects (e.g. `[{ bEnabled: true, fSpeed: 50 }, ...]`)
- the backend resolves nested structures recursively without a fixed depth limit
- datasource config keeps the **real OPC-UA `data_type`** (e.g. `Float`, `Int16`) and explicit `is_array` flag; a positive optional `array_length` records a fixed size, while an absent/non-positive length means dynamic size. These feed the sim server and write path. The HMI never sees these raw types — they are collapsed to **simple types** at the two HMI boundaries (`variable_metadata` / `GET /api/datasources/{name}/variables`). The full OPC-UA→simple collapse table, the static-datasource reverse synthesis, and how each tree node (scalar / array / struct / struct-array / folder) maps to a `$var` binding are documented in [value-types.md](value-types.md) (`backend/core/value_types.py`).
- a variable with `is_array: true` is array-typed; widget fields restrict to arrays by listing array `type`s (e.g. `'string[]'`)

## Composite Keys

Live values are addressed with composite keys in the form `datasource:path`.

Examples:

- `MyPLC:Motor1/Speed`
- `Constants:MaxSpeed`

Helpers exist in both Python and TypeScript to build and parse these keys.

## Translation Dictionaries

Each dictionary is a semicolon-separated CSV file in `<project>/translations/`.

Current parsing rules:

- row 0 contains language codes
- rows 1+ contain translations
- column 0 is both the primary-language text and the stable translation key
- values are stored by language code
- the first language column cannot be removed, moved, or renamed once a
  dictionary exists
- primary values are immutable and unique after creation; rows can be added or
  deleted, and every secondary language column/value remains editable
- missing secondary cells resolve as empty strings; duplicate/empty primary
  values and cells beyond the declared header are rejected instead of being
  silently collapsed or discarded
- an existing zero-byte CSV is malformed; only an absent dictionary is treated
  as absent

Example:

```text
en-EN;nl-NL
Start;Starten
Stop;Stoppen
```

Backend behavior:

- `Default.csv` is the baseline dictionary
- additional dictionaries are any other `*.csv` files in the same directory
- dictionary filenames are derived from the dictionary name
- dictionary names are validated before file creation
- the CSV shape is unchanged: existing valid files and project import/export
  archives need no migration, and CSV replacement is atomic
- every dictionary mutation holds the same per-file process-local and OS lock
  across read, validation, and atomic replacement, including REST and MCP
  writers
- API documents carry a hash revision of the CSV bytes; full-document saves
  compare their loaded revision inside that transaction and reject stale or
  missing revisions instead of overwriting intervening cell, row, or language
  changes
- full-document saves must retain the existing primary header and key set;
  dedicated row endpoints create and delete identities, while full saves can
  edit or reorder secondary columns and values
- language changes participate in editor undo/redo as draft content, but the
  latest server revision is retained as the concurrency token when a snapshot
  is restored; immediate row add/delete operations are excluded from generic
  undo history because full-document saves cannot recreate or remove row keys

`$loc` stores the primary value and resolves it directly against this key map.
An empty active-language value falls back to the primary value; an unknown key
falls back to the key itself.

Language add/remove operations select a validated dictionary name and change
only that CSV; custom dictionaries do not mutate `Default.csv`.

## Custom Component Folders

Each custom component folder may contain:

- `index.tsx`
  - source component and inline `schema`
- `style.css`
  - optional stylesheet
- `fonts/`
  - optional font assets

Compiled build artifacts are written to `<runtime_home>/.widget-build/` (outside the project folder, anchored at the runtime home so the cache survives a project switch):

- `<Name>/index.js` or `<Group>/<Name>/index.js`
  - bundled ESM output written by the backend widget compiler
- `.build-status.json`
  - versioned per-component build status written atomically by the backend widget compiler
  - `{ "version": 2, "widgets": { "<Name-or-Group/Name>": { "ok": true, "ts": "..." } } }`
  - widget keys are normalized paths relative to the active project's `custom-widgets/` directory
- `widget-schemas.json`
  - `{ "version": 2, "builtin": { … }, "custom": { "<Name-or-Group/Name>": { … } } }` — the catalog manifest the compiler regenerates from the built-in registry plus every custom widget's source (`services/widget_schemas.py`, tree-sitter over `index.tsx`)
  - each entry carries `name`, `category`, `description`, `icon`, `schema` and `exportedProperties`; it is what `GET /api/widget-schemas`, `GET /api/widgets`, the MCP tools and backend validation all read
  - a widget whose exports cannot be reduced to literals gets `schemaError` and an empty `schema` instead of failing the whole run, so one unreadable widget no longer costs every other widget its schema

A sibling source folder such as `custom-widgets/_template/` can hold a starter
template. Folders starting with `_` are ignored by the custom-component listing
API and compiler scan.
