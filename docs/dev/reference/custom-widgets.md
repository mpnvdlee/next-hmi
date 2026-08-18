# NEXT HMI Custom Widgets

User-authored components ("custom widgets" in the file system) live under `<project>/custom-widgets/`. They use the same component model as built-in widgets but compile through a dedicated backend service and consume a minimal SDK injected on `window.__nextHMI__` instead of importing app modules directly.

## Security: editor access is code execution

This is the feature, not a flaw — but state it plainly so nobody treats editor
access as a low-privilege role.

Authoring a widget means writing TSX that the **backend compiles** (via esbuild)
and the **browser executes**. Anyone with editor access can therefore:

- cause **file writes on the server** — the compiler writes generated JS into
  the runtime home's widget-build cache, and the source is saved into the
  project folder;
- run **arbitrary JavaScript in every operator's browser** when that widget is
  placed on a page.

There is no sandbox that makes editor access safe for an untrusted user. Treat
the editor as a privileged, code-execution surface: gate `/editor/*` behind the
device-admin password (its default), give editor access only to people you
would trust to run code on the server and in operators' browsers, and keep the
whole deployment on a trusted network (see
[deploy.md](../operations/deploy.md#network-placement-and-threat-model)).

## Folder contract

Layout choices:

- Flat: `<project>/custom-widgets/<Name>/index.tsx`
- Grouped: `<project>/custom-widgets/<Group>/<Name>/index.tsx`
  - `<Group>` is reported as the `group` field in `GET /api/widgets`; flat components return `group: null`.

The canonical widget identity is the normalized `/`-separated path relative to
`custom-widgets/`: `<Name>` for a flat widget and `<Group>/<Name>` for a grouped
widget. Build status, schema-manifest keys, `GET /api/widgets`'s `key` field,
recompile routes, and `widget_updated.key` all use this identity. `name` remains
the leaf label and `group` remains available for catalog grouping; neither is a
unique build-status key.

Each `<Group>` and `<Name>` segment starts with an ASCII letter or digit and may
then contain ASCII letters, digits, `_`, or `-`. Other filesystem names are not
discovered as widgets. This URL-unreserved contract prevents platform-specific
backslashes, dot segments, encoded separators, query/fragment characters, and
lookalike slash glyphs from producing alternate identities.
Windows reserved device names such as `NUL`, `CON`, `COM1`, and `LPT1` are also
excluded. Keys are case-preserving but case-fold unique: if two discovered
paths differ only by letter case, neither is compiled or exposed. Recompile
lookup requires the exact discovered case, keeping the same identity on
case-sensitive and case-insensitive filesystems. Symlinks at the
`custom-widgets/` root, widget directories, group directories, or `index.tsx`
file are not followed.

This identity applies to compiler metadata and routing. It does not rewrite
persisted page widget `type` values (custom types remain their leaf name),
built-in widget types, or `$component:` references, and it does not change
custom-widget SDK exports, compiled module URLs, or browser import-map specifier
resolution.

Files in a component folder:

- `index.tsx` — authoring source. Exports the default React component and optionally `schema`, `exportedProperties`, `displayName`, `description`, `category`, `icon`, and `hostsChildren`.
- `style.css` — optional stylesheet, served from `/widgets/<Name>/style.css`.
- `fonts/` — optional font assets, served from `/widgets/<Name>/fonts/...`.

Compiled `index.js` files are generated outside the project under
`<runtime_home>/.widget-build/`; they are disposable runtime cache, not
authoring files.

Folders or files whose name starts with `.` or `_` are ignored by both the compiler scan and `GET /api/widgets`. Use `_template/` to keep a scaffold sibling without it being picked up.

## Build pipeline

The compiler lives in `backend/services/widget_compiler.py` and runs in both dev and packaged installs. Behaviour:

- Scans `<project>/custom-widgets/*/index.tsx` (and `*/<Group>/<Name>/index.tsx`) at backend startup.
- Recompiles individual files on `add` / `change` events via `watchfiles`; emits a `widget_updated` message over the `/ws` WebSocket so the running app re-imports without a full reload.
- Writes the compiled `index.js` to `<runtime_home>/.widget-build/<Name>/index.js` (or `…/<Group>/<Name>/index.js`).
- Tracks success/error by canonical widget identity in `<runtime_home>/.widget-build/.build-status.json`. The version-2 file is `{ "version": 2, "widgets": { "<Group>/<Name>": { ... } } }`; `/api/widgets` surfaces each matching entry as `buildOk`, `buildError`, and `buildTs`.
- Regenerates `<runtime_home>/.widget-build/widget-schemas.json` — the catalog manifest built from the built-in registry plus every custom widget's `schema`, `exportedProperties`, `category`, `description` and `icon`, extracted from the source with tree-sitter (`backend/services/widget_schemas.py`).

A failed compile leaves the previous `index.js` in place, which is deliberate
for a project widget: a broken edit keeps the last good module serving to the
live HMI instead of blanking the operator's screen. The stdlib half does not
get that latitude — `publish_stdlib_assets` reads `.build-status.json` from
disk and skips any widget whose row is not `ok`, so a broken build never
publishes yesterday's artifact under a source that no longer matches it. One
broken widget does not stop the rest of the tree publishing, and the run still
exits non-zero.

### When extraction fails

A widget whose exports cannot be reduced to literals does **not** fail the run.
Its manifest entry gets `schemaError` (the extractor's message) and an empty
`schema`; every other widget keeps its own. Only a broken registry or an I/O
error aborts the regeneration and leaves the previous manifest on disk.

The consequence is visible rather than silent: the widget still compiles and
renders, but the editor offers no property fields and no `$widgetProp` exports
for it. `GET /api/widgets` returns `schemaError`, the Admin area's **Custom
Widgets** table shows a **No schema** badge with the message, and
`registerCustomWidget()` logs a console warning naming the widget.

### Registration is manifest-driven

`loadCustomWidgets()` registers from `GET /api/widgets` alone: the schema,
catalog metadata and exported properties all ride on the manifest, so the editor
can list, offer and validate a widget without its module being fetched. Each
entry's compiled module is a `lazy()` that imports on first render
(cache-busted by `buildTs`, which also gives the build its identity — a
recompile mints a fresh `lazy()` rather than reusing the resolved old module).
A project holding a widget that pulls a heavy dependency therefore costs nothing
until such a widget is actually on screen.

A custom widget whose leaf name collides with a built-in still wins — projects
may override one on purpose — but registration now logs a warning naming both,
because the swap is otherwise invisible in a page that reads as `"type":
"PageTitle"` and renders something else.

Readers accept only version 2. A status file this build cannot decode — a
corrupt one, or the leaf-keyed map written before version 2 — is discarded
rather than migrated, so every widget rebuilds once and the version-2 file is
written atomically before normal compilation continues. The cache is
regenerable, which is why no migration is carried for it.

esbuild settings (defaults the compiler uses):

- `format: 'esm'`, `bundle: true`, `target: 'es2020'`
- `jsxFactory: 'React.createElement'`, `jsxFragment: 'React.Fragment'`

The compiler prepends a per-component banner that destructures only the SDK names the component actually references:

```js
const { useState, useEffect, usePropString /* ... */ } = window.__nextHMI__;
```

The whitelist is whole-word matched against `frontend/src/shared/utils/nextHmiSdkNames.ts`. Practical consequences:

- Do not import React or application modules — use the injected globals instead.
- Bare imports registered by the project's `external-libraries/` import map are
  preserved for the browser to resolve.
- Reference SDK names directly (e.g. `useState(...)`); the compiler picks them up by literal name.
- Identifiers behind aliases or computed access (`const u = window.__nextHMI__.useState`) are not detected by the scanner.

## Authoring rules

- Write components in `index.tsx`.
- Do not import React, hooks, or internal app helpers — use the SDK globals listed below.
- Use `selfLayoutStyle(layout)` on the outermost wrapper so the editor's layout fields (basis/grow/min-size/etc.) take effect.
- Use `widgetColorStyle(color)` when a schema `color` field should override a default theme color.
- Type declarations for the SDK live in `frontend/custom-widgets-sdk.d.ts`; copy or reference it from your project's `tsconfig` to get editor completion.

Minimal example:

```tsx
export default function MyWidget({ properties, layout }: HmiWidgetProps) {
  const label = usePropString(properties, 'label', 'My Widget');

  return (
    <div className="hmi-my-widget" style={selfLayoutStyle(layout)}>
      <span>{label}</span>
    </div>
  );
}
```

## Runtime SDK

The canonical list of names exposed on `window.__nextHMI__` lives in `frontend/src/shared/utils/nextHmiSdkNames.ts`. Type signatures are in `frontend/custom-widgets-sdk.d.ts`.

**SDK version:** `SDK_VERSION` in `nextHmiSdkNames.ts` (currently `1`) is versioned independently of the app itself. Bump it whenever an existing name is removed or renamed, or an existing function's signature or return shape changes incompatibly; a purely additive change (a new name) doesn't require a bump. Nothing reads this at runtime today — it exists so this doc, commit messages, and widget authors have one unambiguous number to reference for compatibility.

### React primitives

- `React` — needed for class names, fragments, and forwarded refs.
- `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef` — the standard hooks.
- `createPortal` — for floating UIs (popovers, dialogs) that need to escape the component subtree.

### Variable bindings and writes

- `useVariable(key)` — subscribe to a single composite-key scalar variable.
- `useBindingValue(binding)` — same, but takes a `VariableBinding` (or `undefined`).
- `useStructVariable(key)` — subscribe to a struct (returns `Record<string, unknown>`) or an array-of-struct (returns `unknown[]`).
- `useVariableMeta(key)` — subscribe to `{ type, min?, max?, fieldRanges? }`. `type` is the canonical scalar/struct `VarType` with `array: boolean` and an optional fixed `length`; `min`/`max` apply to scalar numeric variables and `fieldRanges` carries per-field struct ranges. Returns `undefined` if the key isn't known.
- `useEvalContext()` — returns the active `EvaluationContext` used to resolve `$var` / `$loc` / `$urlParam` / `$user` / `$device` / `$time` / `$pageIsActive` / `$random` / `$if` / `$compare` / `$switch` / `$widgetProp` / `$componentProp` / `$stringExpr` / `$alarmCount` / `$page` / `$viewport` / `$result` property sources. The full source/type model is in [../architecture/value-types.md](../architecture/value-types.md).
- `bindingKey(binding)` — composes a `"datasource:path"` key from a `VariableBinding`.
- `parseVarKey(key)` — splits `"datasource:path"` back into `{ datasource, path }`.
- `useWriteVariable(properties, propKey, options?)` — returns `(value, opts?) => void`, the supported way to write a bound variable. See [Writing values](#writing-values).
- `sendWsMessage(msg)` — sends a raw frame on the shared WebSocket; supports `type: 'write_field'`; the older `'write'` type was removed and is now dropped as an unknown message. For variable writes use `useWriteVariable` instead — it correlates the response, which a hand-built frame does not.
- `useHmiScope()` — returns the active runtime scope id (e.g. `runtime:main`), useful as the `scope` field on `write_field`.

### Property resolvers

Hook variants (call internally `useEvalContext()`; safe to use inside a component body):

- `usePropString(props, key, fallback?)`
- `usePropNumber(props, key, fallback?)`
- `usePropBoolean(props, key, fallback?)`
- `usePropVar(props, key)` — resolves either a `$var` binding (including array-element bindings with an `index`) or a static / expression value; returns `unknown`.
- `usePropStruct(props, key)` — for struct properties; returns the live struct (or array for an array struct `type` like `'struct[]'`).
- `useRecordListProp(props, key)` — for a `record-list` property (array of records); resolves a `$var` struct-array binding, the `$recipeList` value source, a `$widgetProp` export, or a static array, and returns `unknown[]`.

Non-hook variants (safe in event handlers, action callbacks, utilities — accept an optional `evalCtx`):

- `getPropString`, `getPropNumber`, `getPropBoolean`
- `getPropBinding(props, key)` — returns the underlying `VariableBinding | undefined` (no resolution).
- `getPropBindingOrStatic(value)` — returns `{ binding, staticValue }` from a property value.

### Cross-widget props (`$widgetProp`)

- `usePublishWidgetProp(componentId, key, value)` — publish a value from this component so sibling components can read it via `$widgetProp`. Declare what you publish via `exportedProperties` on the default export.

### Workspace data

- `useUsersData()` → `Array<{ id, username }>` — used by `option-list` fields with `$user / field: 'userList'`.
- `useUserGroupsData()` → `Array<{ id, label }>` — all configured groups, used by `option-list` fields with `$user / field: 'groups'`.
- `useLanguagesData()` → `Array<{ code }>` — used by `option-list` fields with `$languages`.
- `useLanguageSelection()` → `{ activeLanguage, setActiveLanguage }` — the active interface language and the setter that changes it. The other half of `useLanguagesData`, for shipping your own language picker; calling the setter re-runs every `$loc` source in the app. The stdlib `Language Switcher` is the two combined.
- `useVisiblePages()` → `PageNode[]` — the currently visible page index tree (respects `hidden` and role filters).

### Recipes

- `useRecipeConfig()` → `RecipeConfig` — reactive dataset types (parameters + saved datasets), fed by `recipe_snapshot` / `recipe_update`.
- `useRecipeState()` → `{ loaded: { [typeId]: { datasetId, loadedAt } } }` — the dataset loaded per type.
- `recipeDownload(datasetId, { verify? })` → `Promise<DownloadResult>` — write a dataset's values to their variables.
- `recipeUpload(datasetId)` → `Promise<RecipeConfig>` — overwrite a dataset from current live values.

To list saved recipes in a widget, bind a `record-list` property to the
`$recipeList` value source (`useRecordListProp`).

### Alarms

Active alarms and their counts are pushed over the WebSocket; acknowledgement
and history go over REST. The stdlib `Alarm List` and `Alarm History` widgets
(`frontend/widgets/Content/AlarmListManaged`, `…/AlarmHistoryList`) are the
worked examples.

- `useActiveAlarms()` → `AlarmInstance[]` — the live active-alarm list.
- `useAlarmSummary()` → `AlarmSummary` (`{ total, unacked, error_count, warning_count, info_count }`) — the counts pushed alongside that list, so a badge doesn't re-derive them. For a single count in a plain property, the `$alarmCount` property source is simpler than this hook.
- `useAlarmText()` — returns a `(text: string) => string` resolver for an instance's `title` and `description`. Those arrive already flattened to a bare `$loc` key: one instance is broadcast to every client and stored in history, so it stays language-agnostic and the operator's language is applied at render. A literal string passes through unchanged. Calling the hook also subscribes the component, so alarm text follows a language switch.
- `useAlarmUsername()` → `string` — the signed-in user of the current scope, falling back to `'operator'`. This is the `username` the ack calls and `AlarmDetailDialog` expect.
- `ackAlarm(instanceId, username, options?)` → `Promise<boolean>` — acknowledge one instance.
- `ackAllAlarms(username, options?)` → `Promise<boolean>` — acknowledge every active alarm.
- `alarmLevelClass(level)` — the class that publishes a severity as `--hmi-alarm-level` on an alarm surface. Every severity-driven rule in the app's shared alarm stylesheet reads that one custom property, so putting this on the row, toast or card is what drives its stripe, tint and dot — a level maps to a colour in exactly one place.
- `levelDotClass(level)` — the composed class string for a level indicator dot (`hmi-pill__dot hmi-alarm-dot` plus the level class).
- `formatAlarmTimeShort(iso)` — an ISO timestamp as a short local time (`HH:MM:SS`); `''` for an empty string.
- `formatAlarmDateTime(iso)` — an ISO timestamp as a full local date and time; `'—'` for an empty string.
- `AlarmDetailDialog` — the product's alarm detail dialog, driven by `{ alarm, username, onClose }`. It draws its own modal overlay, resolves the instance's `resolutions` through the evaluation context, and offers an acknowledge button when the alarm isn't acked yet. Render it conditionally on your own selection state rather than mounting it always.

Both ack calls carry `useWriteVariable`'s error contract: neither ever rejects.
They resolve `true` when the backend accepted the acknowledgement and `false`
when it refused, and a refusal shows the operator one error toast — so awaiting
one bare, with no `try`, is safe and still tells the operator what happened.
Pass `options` to change that: `{ onError: 'silent' }` swallows the failure,
`{ onError: (reason) => … }` hands you the reason string instead of toasting.
The toast lives inside the call because `showToast` is not on the SDK; its id is
per ack target and deduped, so hammering an ACK button reuses one toast rather
than stacking one per press. A widget that already wrapped an ack in its own
`try` still compiles — its `catch` simply never fires now, so move that handling
into `onError`.

Sequence anything that must only happen on success on the returned value —
`if (await ackAlarm(alarm.id, username)) close()`, as `AlarmDetailDialog` does,
so a refused ack leaves the dialog open behind its toast instead of closing as
if it had worked.

`AlarmLevel`, `AlarmInstance` and `AlarmSummary` are declared in
`custom-widgets-sdk.d.ts` and mirror the backend's model. Alarm history has no
SDK hook: fetch `/api/alarms/history` with `apiJson`, as `Alarm History` does.

### Page-group navigation

- `usePageGroup(groupId?)` — returns the active `PageGroupStackEntry` (`{ group, activePage, onNavigate }`) for the given group, or the innermost group when `groupId` is omitted; `null` when no group is in scope.
- `usePageTitle(title)` — resolves a `PageTitle` (`string | { $static } | { $loc }`) to a plain string, subscribing to translation-store changes so locale switches re-render.
- `resolvePageTitle(title)` — the non-hook form of the same resolution, for titles you resolve where a hook can't be called: inside a `.map()` over `group.children`, a comparator, an event handler. It reads the same translations but subscribes to nothing, so a component whose labels come only from this will keep the language it mounted with. Call `usePageTitle` once in the same component (or on the page title) when the labels have to follow a locale switch. The stdlib `Tab Bar` uses it per child; `NavigationMenu` does the same for its tree.
- `useNavigateToPage()` — returns a `(pageId: string) => void` that navigates to `/pages/<pageId>`.

### Actions and other helpers

- `executeWidgetActions(actions, ctx?)` — runs an action array through the shared action pipeline. Optional `ctx` accepts `{ scope?, evalCtx? }` so you can run actions in a non-default scope or with a custom evaluation context.
- `selfLayoutStyle(layout)` — converts the editor's layout config into a `style` object for the wrapper.
- `containerLayoutStyle(layout)` — the `--container-*` half of the same layout, for a widget that declares `hostsChildren` and places its children itself. Pair it with a stylesheet resetting every `--container-*` it reads to `initial` — see the `hostsChildren` note under [Schema](#schema).
- `widgetColorStyle(color)` — converts a hex / theme-token / `var(--…)` color string into a `style` object that sets the element's `backgroundColor`. Returns `{}` when the color is unset, so the element falls through to its CSS theme token (e.g. `background: var(--hmi-accent)`) and re-skins with the theme.
- `useCssVar(name, fallback)` — reads a CSS custom property from the document root, subscribing to theme changes.
- `withBase(path)` — prefixes a root-relative app path with the instance base, so the URL still resolves when the project is proxied under `/runtime/<slug>/` or `/editor/<slug>/`. Idempotent, and a no-op at the root base. Apply it to any URL you hand to `fetch`, an `<img src>` or an `<a href>` — the stdlib `Trend Chart` wraps its `/api/historian/query` fetch in it.
- `apiJson(url, options?)` → `Promise<T | undefined>` — the JSON API client: applies `withBase`, sets the JSON content type and serialises `options.body`, returns the parsed body, and throws on any non-2xx. `options` is `{ method?, body?, signal? }`. A `204 No Content` resolves `undefined`, which is why the declared type is `T | undefined` and not `T` — guard or default it (`?? []`) as the stdlib `Alarm History` widget does around its `/api/alarms/history` poll.
- `isApiError(value)` — narrows a caught value to `ApiError`: `message` is the backend's `detail` (or `HTTP <status>`), plus `status` and the body's `code` when it carried one. Use it rather than reading `status` off whatever you caught — a request that never reached the backend rejects with a plain `TypeError`, which carries neither field.

### Icons

An `icon` property holds either a built-in id or a workspace SVG path, so a
widget that renders one branches on both pairs below — as the stdlib `Icon`,
`Button` and `Menu Toggle` widgets do.

- `isBuiltinIconId(value)` — `true` if the string is a built-in Phosphor icon id (allowlisted).
- `getBuiltinIconComponent(iconId)` — returns the `PhosphorIconComponent` for that id, or `null`. It is not a plain component: the icon set is fetched on first render, so rendering one outside a `React.Suspense` boundary throws a promise instead of drawing anything. Wrap the tag — `<React.Suspense fallback={null}><IconComp size={20} weight="regular" /></React.Suspense>` — as every stdlib widget that draws an icon does.
- `isCustomIconAssetPath(value)` — `true` if the string points at a workspace SVG (`/assets/icons/…`) instead. Base-prefix aware, so it still matches under a proxied `/runtime/<slug>/` mount.
- `useInlineSvg(url)` → `string` — fetches that SVG and returns its markup *rewritten for tinting*: every hardcoded `fill` / `stroke` / `color` attribute is stripped and `currentColor` forced, so the icon inherits the CSS `color` of its parent instead of shipping its own. That is a one-way trip — a multi-colour asset comes back monochrome and stroke-drawn artwork comes back unstroked, so fetch the file yourself (through `withBase`) when it has to keep its own palette. Returns `''` for a null/empty url, while the fetch is in flight, and when the fetch fails; the three are indistinguishable, so treat `''` as "nothing to draw" rather than as a loading state. Render the result with `dangerouslySetInnerHTML` — the markup comes from the project's own asset folder, which is already a trusted, editor-writable surface.

### Virtual input

- `VirtualKeyboard` / `VirtualNumpad` — modal soft input components driven by `{ isOpen, value, onChange, onClose, anchorRef?, title?, dockPosition? }`. `VirtualKeyboard` also takes optional `password?` to mask its value preview. `VirtualNumpad` also takes optional `min?`, `max?`, `unit?` — shown as a range/unit hint under the title and used to redden the value preview when the entered value is out of bounds.
- `CloseButton` — the standard themed close/dismiss control, driven by `{ onClick?, label?, tone?, className? }`.

### Charts

- `Recharts` — the [Recharts](https://recharts.org) module, exposed as `Recharts.LineChart`, `Recharts.XAxis`, etc.

## Using external libraries

Drop ESM files into `<project>/external-libraries/` — the dev server picks them up automatically and triggers a full reload.

**Convention:** put each library in its own folder, and name the entry file the same as the folder. `external-libraries/<name>/<name>.js` (or `.mjs`) becomes the bare import specifier `<name>`. Any other file in the folder is reachable via `<name>/...`.

```
<project>/external-libraries/three/
  three.js                                          ← bundled ESM (bare entry)
  examples/jsm/controls/OrbitControls.js            ← optional, for subpath imports
<project>/external-libraries/uplot/
  uplot.js
```

```tsx
import * as THREE from 'three';
import uPlot from 'uplot';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
```

A loose `<name>.js` at the root of `external-libraries/` also works for single-file libraries and produces the same bare specifier — useful if the library has no companion files. A folder with no matching `<name>.js` still gets the trailing-slash subpath mapping (`<name>/`).

**Override (rare):** if you need an import specifier that doesn't match a filename — e.g. mapping `lodash-es` to a deeply nested file — add `<project>/external-modules.json`:

```json
{ "imports": { "weird-lib": "/external-libraries/weird/dist/esm/main.bundle.js" } }
```

Override entries win over auto-derived ones.

**Which project the dev server scans.** The import map is built by a Vite plugin
(`frontend/dev-plugins/externalModules.ts`), which has to find the live project
without the backend's help. It resolves it the same way the backend does —
`NEXTHMI_ACTIVE_PROJECT_PATH`, else the runtime home
(`NEXTHMI_DATA_DIR` → bootstrap config → `<repo>/.dev-runtime-home/` → platform
default) and that manifest's default project, else its only project, else
`<repo>/project-testbench/`. The startup banner prints the resolved path:

```
[NEXTHMI] live project: /path/to/project
[NEXTHMI] external modules: 4 import-map entries (startup)
```

If a bare specifier fails with `Failed to resolve module specifier "x"` while
the file plainly exists, check that line first — it used to be hardcoded to
`<repo>/project-testbench/`, so a live project anywhere else produced an empty
map while the backend served `/external-libraries/` perfectly well.

**TypeScript completion** is opt-in. Add a `paths` entry to your project's `tsconfig.json` pointing at the library's `.d.ts` files (typically downloaded alongside the JS bundle).

Libraries loaded this way run **outside** the SDK banner — they are not destructured from `window.__nextHMI__`.

**Caveats** (browser limits, not fixable by config):

- The library must ship as ESM. CommonJS-only packages won't load in the browser.
- The library must run in the browser — no Node-only APIs (`fs`, `process`, etc.).
- Peer dependencies must also be placed in `external-libraries/`; they will resolve via the same import map.
- Libraries that internally `import './styles.css'` are not supported here — CSS imports aren't part of the import-map mechanism.
- Folder mappings expose every file under that folder over HTTP. **Don't put anything secret in an external-libraries folder** — it's served as static assets.

## Variable access

### Scalar variable bindings

For scalar value properties (e.g. `float` / `integer`), use `usePropVar` — it handles
both the `$var`-wrapped binding (including array-element bindings with an `index`) and a plain
static value in one call:

```tsx
export default function MyWidget({ properties, layout }: HmiWidgetProps) {
  const value = usePropVar(properties, 'variable');
  const num   = typeof value === 'number' ? value : 0;

  return <div style={selfLayoutStyle(layout)}>{num.toFixed(2)}</div>;
}
```

Schema:
```ts
variable: { type: 'float', label: 'Value' }
```

If you also need the composite key for write-back, use `getPropBinding` to extract it:

```tsx
const varKey = bindingKey(getPropBinding(properties, 'variable'));
const value  = usePropVar(properties, 'variable');
```

### Struct variable bindings

For `type: 'struct'` properties, use `usePropStruct`:

```tsx
export default function MyWidget({ properties, layout }: HmiWidgetProps) {
  const fields   = usePropStruct(properties, 'variable');
  const bVisible = fields?.bVisible !== false;
  const fValue   = fields?.fValue as number | undefined;

  if (!bVisible) return null;

  return <div style={selfLayoutStyle(layout)}>{fValue?.toFixed(2) ?? '---'}</div>;
}
```

To **write back** to one field, pair `usePropStruct` with a writer on the same
property and name the field per call — no manual key extraction:

```tsx
const fields = usePropStruct(properties, 'variable');
const write  = useWriteVariable(properties, 'variable');
write(parsed, { field: 'fValue' });
```

Extract the key manually only for the hooks that take one directly, such as
`useVariableMeta`:

```tsx
const meta = useVariableMeta(bindingKey(getPropBinding(properties, 'variable')));
```

Schema:
```ts
variable: {
  type: 'struct',
  label: 'Variable',
  requiredFields: ['bVisible', { name: 'bEnabled', write: true }, 'fValue']
}
```

#### Nested structs

When a struct contains a sub-struct (a child folder), use `requiredFields` on the entry object to describe the expected sub-folder shape:

```ts
io: {
  type: 'struct',
  label: 'IO',
  requiredFields: [
    'bVisible',
    { name: 'limits', requiredFields: ['fMin', 'fMax'] }
  ]
}
```

At runtime, the backend returns the nested shape as a nested object:

```json
{ "bVisible": true, "limits": { "fMin": 0.0, "fMax": 100.0 } }
```

Nesting is recursive — sub-struct entries can themselves contain `requiredFields`.

The binding picker matches the nested shape: it verifies that the selected struct folder contains a child folder named `limits` with the required scalar children `fMin` and `fMax`.

#### Array-of-struct bindings

When the target OPC-UA variable is an array of structs — represented as a folder containing indexed sub-folders `[0]`, `[1]`, `[2]`, … — use an array struct `type` (`'struct[]'`, or a named array struct like `'Alarms[]'`):

```ts
motors: {
  type: 'struct[]',
  label: 'Motors',
  requiredFields: ['bEnabled', 'fSpeed']
}
```

The `requiredFields` describe the shape of each array element. The binding picker shows only folders whose children are all `[N]`-indexed sub-folders, and validates that the first element `[0]` contains the required fields.

At runtime, the backend returns a JSON array:

```json
[
  { "bEnabled": true, "fSpeed": 50.0 },
  { "bEnabled": false, "fSpeed": 0.0 }
]
```

Access array elements in a component:

```tsx
const varKey = bindingKey(getPropBinding(properties, 'motors'));
const data = useStructVariable(varKey); // list of dicts
const motors = Array.isArray(data) ? data : [];
```

## Reading plain properties

For string, number, and boolean properties (including property sources like `$loc`, `$time`, `$user`, etc.) use the hook variants — they call `useEvalContext()` internally so you don't need to wire it up yourself:

```tsx
export default function MyWidget({ properties, layout }: HmiWidgetProps) {
  const label    = usePropString(properties, 'label', 'Default');
  const decimals = usePropNumber(properties, 'decimals', 1);
  const inverted = usePropBoolean(properties, 'inverted', false);
  // ...
}
```

The non-hook equivalents (`getPropString`, `getPropNumber`, `getPropBoolean`, plus `getPropBinding` / `getPropBindingOrStatic`) still exist for use outside component render (event handlers, action callbacks, utilities). Inside a component body prefer the hook variants — they participate in React re-renders correctly when bindings or eval-context changes.

## Writing values

Use `useWriteVariable`. It takes the widget's `properties` and the schema key holding the `$var` binding, and returns a writer you call from an event handler:

```tsx
export default function StartButton({ properties, layout }: HmiWidgetProps) {
  const write = useWriteVariable(properties, 'variable');

  // Scalar variable:            write(true)
  // One field of a struct:      write(true, { field: 'bValue' })
  return (
    <button style={selfLayoutStyle(layout)} onClick={() => write(true, { field: 'bValue' })}>
      Start
    </button>
  );
}
```

The writer is a no-op when the property holds no binding, so you can call it unconditionally. It resolves the composite key, coerces and range-checks the value against the variable's metadata (`min` / `max`, or `fieldRanges[field]` for a struct field), attaches a `requestId`, and sends the `write_field` frame on the current `useHmiScope()`.

**Gate your control on `write.canWrite`.** Only a `$var` binding can be written back. A property typed `boolean` or `float` also accepts `$static`, `$if`, `$widgetProp` and friends — those resolve to a value your widget can *display*, but the writer no-ops on them. `canWrite` on the returned writer is true exactly when a `$var` binding resolved, so gate `disabled` on it rather than on `properties.x == null`; otherwise the control looks live and swallows the interaction:

```tsx
const write = useWriteVariable(properties, 'variable');
<button disabled={!write.canWrite} onClick={() => write(true)}>Start</button>;
```

**Why the requestId matters.** The backend only replies with `write_response` / `write_error` when the frame carries a `requestId`. A hand-built `sendWsMessage({ type: 'write_field', … })` has none, so a rejected write — a value out of range, or a variable whose `interactableByGroups` excludes the logged-in user's group — is dropped silently and the operator sees nothing. Nothing in the widget's metadata exposes `interactableByGroups`, so a widget cannot pre-disable itself on permission; the correlated `write_error` is the only signal there is.

By default a rejection shows one error toast, reusing a single toast id per widget so a held-down control can't stack them. Change that with the third argument:

```tsx
const write = useWriteVariable(properties, 'setpoint', { onError: 'silent' });
const write = useWriteVariable(properties, 'setpoint', {
  onError: (reason) => setLastError(reason), // 'permission_denied', 'value_out_of_range', 'timeout', …
});
```

The reason vocabulary is the one documented in [../architecture/websocket.md](../architecture/websocket.md), plus the client-side coercion reasons and the dispatcher's `timeout` / `disconnected`.

**Continuous writers opt out of tracking.** Each tracked write costs a pending-request entry, a 10 s timer and a response frame; a control that writes on every pointer move — a slider drag — puts hundreds of those on the wire per second. Pass `{ tracked: false }` and the frame goes out without a `requestId`, so the backend sends no response and nothing is registered. Local coercion and range checks still report; only backend rejections go unseen, which is why discrete controls (buttons, switches, numpad commits) stay on the default.

```tsx
const write = useWriteVariable(properties, 'setpoint', { tracked: false });
```

For array-element writes, bind with an `index` — the writer appends the `[N]` path suffix (e.g. `"Motors[3]"`) that the backend uses to patch element `N` of the cached array.

`sendWsMessage` remains available for frames that aren't variable writes.

## Triggering actions

Custom components can run the same action pipeline as built-in components through `executeWidgetActions`.

```tsx
export default function MyActionButton({ properties, layout }: HmiWidgetProps) {
  const actions = properties?.actions as { onPress?: ComponentAction[] } | undefined;

  return (
    <button style={selfLayoutStyle(layout)} onClick={() => executeWidgetActions(actions?.onPress)}>
      Run Actions
    </button>
  );
}
```

Supported action types (see `frontend/src/config/components/editor/PropertiesPanel/actionsPreview.ts` for the canonical list):

- `openDialog` / `closeDialog`
- `openPageOverlay` / `closePageOverlay`
- `writeDataVariable` — `{ datasource, path, value }`; value may be a literal or a `$var` / `$static` source resolved at run time.
- `setLanguage` — switches the active HMI language; the `language` property is resolved from component properties at runtime.
- `loginUser` / `logoutUser` — scope-based authentication (the scope defaults to the current `useHmiScope()`).
- `showAlert` — modal alert with `onCancel` / `onOk` nested action lists.
- `showToast` — transient toast (`info` | `warning` | `error`); `discard: 'auto' | 'manual'` with optional `duration`.

If you accept multiple events (e.g. `onPress` and `onLongPress`), declare them via separate `actions` fields on the schema with distinct `event` keys — see the schema reference below.

## Schema

Custom component schema is exported inline from `index.tsx`. The `SchemaField` type is defined in `frontend/src/shared/types/widgetSchema.ts`.

```ts
export const schema: Record<string, SchemaField> = {
  label: {
    type: 'string',
    label: 'Label',
  },
  decimals: { type: 'integer', label: 'Decimals', min: 0, max: 6, step: 1, defaultValue: 1 },
  inverted: {
    type: 'boolean',
    label: 'Invert logic',
    description: 'Treat a falsy value as the active state.',
  },
  color:    { type: 'color',   label: 'Color' },
  variable: {
    type: ['float', 'integer'],
    label: 'Value',
  },
  io: {
    type: 'struct',
    label: 'Variable',
    requiredFields: ['bVisible', { name: 'bEnabled', write: true }],
  },
  mode: {
    type: 'string',
    format: 'select',
    label: 'Mode',
    display: 'button-text',
    visibleWhen: { property: 'inverted', equals: false },
    options: [
      { label: 'Auto',   value: 'auto' },
      { label: 'Manual', value: 'manual' },
    ],
  },
};
```

`description` is one line explaining what the property does. The editor renders it
between the field's label and its box, so it is the place for behaviour a label
cannot carry — keep units in the label (`Size (px)`) and put the explanation here
rather than in a parenthetical.

`group` files a property under a named section in the properties panel. Fields
with no `group` share one **Properties** section, in declaration order — so a
schema that declares none looks exactly as it always has. Group a schema once it
grows past a handful of properties:

```ts
export const schema: Record<string, SchemaField> = {
  label:  { type: 'string',  label: 'Label' },
  color:  { type: 'color',   label: 'Color',   group: 'Appearance' },
  radius: { type: 'integer', label: 'Radius',  group: 'Appearance' },
};
```

Every widget — built-in and custom — is automatically given two standard boolean properties, `visible` and `interactable` (both default `true`), surfaced under a **Visibility** section in the editor. Do not declare them in your schema. `WidgetRenderer` gates rendering and pointer interaction on them, so they accept any boolean source, including `$userGroups` to gate by user group. See [../architecture/value-types.md](../architecture/value-types.md).

Optional sibling exports:

- `exportedProperties: ExportedProperty[]` — declares which runtime values this component publishes for sibling components to consume via `$widgetProp`. Extracted into the schema manifest like `schema`, so the editor's `$widgetProp` picker lists them without loading the module; it must be an array of objects each with a non-empty `key`, or the widget lands in the manifest with a `schemaError`.
- `displayName: string` — the label shown in the palette, the widget tree and the properties panel header. The folder name stays the widget *type* that page files reference; export this when that type reads badly as a label, since a folder name cannot carry spaces (`StretchSpacer` → `Stretch Spacer`). Defaults to the folder name.
- `hostsChildren: boolean` — declares that nodes of this type carry a `children` array. The editor then treats the widget as a container (drop target, collapse toggle, tree recursion, move target) and the renderer hands the already-rendered children in as the component's `children` prop. Read them with `React.Children`, and place them with `containerLayoutStyle(layout)` — pair that with a stylesheet resetting every `--container-*` it reads to `initial`, or a nested host inherits its parent's direction and gap. The stdlib `Container` is the worked example.
- `category: string` — the card category. Defaults to the widget's source folder, or `Other` for a flat widget.
- `description: string` — a one-line summary shown on the widget's card in the editor's widget selector (the drawer opened via **Add Widget/Component…** on the tree context menu).
- `icon: IconValue` — a structured built-in or custom icon, using the same value produced by the editor's icon picker. A built-in icon is `{ type: 'builtin', name: '<allowlist-id>' }`; a workspace SVG is `{ type: 'custom', path: 'icons/<file>.svg' }`. When omitted, custom widgets fall back to a generic puzzle-piece icon.

```tsx
export const displayName = 'Analog Gauge';
export const hostsChildren = false; // omit unless the widget hosts children
export const category = 'Process';
export const description = 'A round analog gauge with min/max and a value binding.';
export const icon = { type: 'builtin', name: 'gauge' } as const;
```

### Field-type reference

A field's `type` is a **simple datatype** (`boolean`, `integer`, `float`, `string`, `datetime`, `date`, `time`, `duration`), one of their arrays (`'float[]'`, `'string[]'`, …), a **named struct** (`'struct'`, `'Alarms[]'`, …), or an **editor-only kind** (`color`, `icon`, `image`, `option-list`, `actions`, …). It may also be a **list** — the first entry drives the editor control, the rest form the variable-binding filter (e.g. `['float','integer','boolean']`, or `['option-list','string[]','integer[]']`). The types themselves, their bindable sources, and the full source model are specified in [../architecture/value-types.md](../architecture/value-types.md); the table below maps each `type` to the hook a custom component reads it with.

| `type`              | Read with                                  |
|---------------------|--------------------------------------------|
| `string`            | `usePropString`                            |
| `integer` / `float` | `usePropNumber`                            |
| `boolean`           | `usePropBoolean`                           |
| `datetime`          | `usePropString`                            |
| `date`              | `usePropString`                            |
| `time`              | `usePropString`                            |
| `duration`          | `usePropString` / `usePropNumber`          |
| `color`             | `usePropString` (CSS color string)         |
| `icon`              | `usePropString` + icon helpers             |
| `image`             | `usePropString`                            |
| `struct`            | `usePropStruct` (or `useStructVariable`)   |
| `option-list`       | inspect `properties.<key>` directly        |
| `actions`           | `executeWidgetActions(props[key][event])`  |
| `groups`            | read `properties.<key>` as `string[]`      |
| `image-indicators`  | consumed by `ImageIndicators` widget       |
| `page-group`        | read `properties.<key>` as `string`        |

### Field options

All optional unless marked **required**.

- `format` — refines a base type to upgrade its editor without changing the value; source rules still follow the **base type**. The full per-type format catalog (`string`: `url`/`multiline`/`password`/`select`/`length`/`spacing`/`direction`/`align`/`justify`/`page`; `float`: `percentage`; `boolean`: `toggle`/`visibility`/`enablement`/`wrap`) is in [../architecture/value-types.md](../architecture/value-types.md).
- `defaultValue` — value the editor inserts when the field is added or reset.
- `placeholder` — empty-state hint (used by `string`, `integer`/`float`, `icon`, `image` inputs).
- `min`, `max`, `step` — numeric input constraints (`integer` / `float`).
- The variable picker filter is the `type` itself: list non-editor entries (e.g. `['float','integer']`, `'string[]'`) restrict which variables can be bound. There is no separate `dataType` field.

The value types and the full source model are specified in [../architecture/value-types.md](../architecture/value-types.md).
- `write: true` — restrict the picker to writable variables.
- The set of property **sources** offered for a field is determined entirely by its `type` — there is no per-field source allowlist. A source appears wherever its produced type matches the field.
- `visibleWhen` — conditional visibility. A `VisibilityCondition` or an `AND`-joined array; conditions reference sibling property keys in the same schema.
- `event` — only for `actions`: the key used to store the action array within the property value (default `'onPress'`).
- `options` — **required** for `format: 'select'`; array of `{ label, value, icon? }`.
- `display` — only with `format: 'select'`: `'auto' | 'dropdown' | 'button-text' | 'button-icon'`. `'auto'` picks button-icon when every option has an icon, otherwise dropdown.
- `requiredFields` — only for `struct`. See below.

### Struct details

`requiredFields` describes the shape that the binding picker must match. Each entry is either:

- a plain string — the child field must exist (read-only).
- an object — `{ name, write?, type?, requiredFields? }`.
  - `write: true` requires that the picked field be writable.
  - `type` restricts the simple datatype of that child (e.g. `'float'`).
  - Nested `requiredFields` recursively constrain sub-folders, enabling nested-struct matching.

Set an array struct `type` (`'struct[]'`, or a named array struct like `'Alarms[]'`) on the field itself to require an array-of-struct folder (children must be `[0]`, `[1]`, …). The `requiredFields` then describe the shape of each element. At runtime the value is a JSON array (`unknown[]`), accessed via `usePropStruct` or the explicit `useStructVariable(key)` for write-back.

### `option-list` source types

| Source       | Editor                                       | Runtime resolution                                                  |
|--------------|----------------------------------------------|---------------------------------------------------------------------|
| `$static`    | inline list editor                           | `properties.<key].$static` → `[{label, value}, ...]`                |
| `$var`       | binding picker (list array `type`s, e.g. `'string[]'`, to restrict to array variables) | live array variable value via `useStructVariable` / `useVariable`   |
| `$user`      | field selector (`userList` or `groups`)      | `userList`: `useUsersData()` → `{ label: username, value: userId }`; `groups`: `useUserGroupsData()` → `{ label, value: groupId }` list |
| `$languages` | no parameters                                | `useLanguagesData()` → `{ label: code, value: code }` list          |

All four sources are offered automatically for an `option-list` field. At runtime, branch on which source key is present in `properties.<key>`.

### Property sources

The full catalog of canonical `$`-keyed property sources — each source's shape, produced type, and resolution rules — is in [../architecture/value-types.md](../architecture/value-types.md). Custom-component code never parses these source objects directly: it resolves them through `useEvalContext()` and the `useProp*` hooks, and for `option-list` fields branches on which source key is present in `properties.<key>`.

## Styling conventions

- prefer `hmi-<name>` class prefixes
- keep component-specific CSS in `style.css`
- use HMI theme tokens (see table below) for all colors, typography, spacing, and state styling
- to explore all tokens interactively: open **Config → Admin → Theme Tokens** — searchable, with copy button and current computed value
- the authoritative token source is `frontend/src/shared/themeDefaults.json` (default values) and `frontend/src/shared/utils/themeTokens.ts` (`THEME_TOKENS` registry: CSS var, JSON path, label, description, sample usage)
- in addition to the editable primaries, custom components can use derived secondary tokens (`--hmi-surface-2/3`, `--hmi-text-2/3/4`, `--hmi-border-strong`, `--hmi-accent-soft/ink/on`, `--hmi-{ok,warn,fault}-soft`) and shared primitive utility classes (`.hmi-pill`, `.hmi-kicker`, `.hmi-readout`, `.hmi-live-dot`, `.hmi-bar`); see [theming.md](theming.md)

> **Discovering tokens:** In the running app, navigate to **Config → Admin → Theme Tokens**. Every token shows its CSS variable, what it controls, and where in the theme JSON it comes from.

### Copy-paste quickstart

A minimal component that respects the active theme:

```css
/* style.css */
.hmi-my-widget {
  background: var(--hmi-surface);
  border: 1px solid var(--hmi-border);
  border-radius: var(--hmi-radius);
  color: var(--hmi-text);
  font-family: var(--hmi-type-body-font);
  font-size: var(--hmi-type-body-size);
  padding: var(--hmi-space-md) var(--hmi-space-lg);
}

.hmi-my-widget--active {
  border-color: var(--hmi-accent);
}

.hmi-my-widget--ok    { color: var(--hmi-ok); }
.hmi-my-widget--warn  { color: var(--hmi-warn); }
.hmi-my-widget--fault { color: var(--hmi-fault); }
```

### "If I want … use token …" lookup

| Goal | Token |
|------|-------|
| Background of the app/page | `--hmi-bg` |
| Card or panel background | `--hmi-surface` |
| Elevated/raised surface | `--hmi-surface-raised` |
| Primary text | `--hmi-text` |
| Dimmed/secondary text | `--hmi-text-muted` |
| Brand/action highlight | `--hmi-accent` |
| Dividers and borders | `--hmi-border` |
| OK / success state | `--hmi-ok` |
| Warning state | `--hmi-warn` |
| Fault / error state | `--hmi-fault` |
| Body font / size / weight | `--hmi-type-body-font` / `--hmi-type-body-size` / `--hmi-type-body-weight` |
| Heading combo | `--hmi-type-heading-font` / `--hmi-type-heading-size` / `--hmi-type-heading-weight` |
| Subheading combo | `--hmi-type-subheading-font` / `--hmi-type-subheading-size` / `--hmi-type-subheading-weight` |
| Caption / small text combo | `--hmi-type-caption-font` / `--hmi-type-caption-size` / `--hmi-type-caption-weight` |
| Fixed-width / numeric (code) combo | `--hmi-type-code-font` / `--hmi-type-code-size` / `--hmi-type-code-weight` |
| Big readout (value) combo | `--hmi-type-value-font` / `--hmi-type-value-size` / `--hmi-type-value-weight` |
| Gap inside a value+unit pair | `--hmi-space-hair` / `--hmi-space-tight` / `--hmi-space-snug` (¼, ½, ¾ of `--hmi-space-sm`) |
| Tight inline gap | `--hmi-space-sm` |
| Standard element padding | `--hmi-space-md` |
| Large section padding | `--hmi-space-lg` |
| Chart series colour | `--hmi-series-1` … `--hmi-series-8` (fixed categorical palette) |
| A popup that escapes its scroll container | `z-index: var(--hmi-z-popup)` |
| Corner radius (default) | `--hmi-radius` |
| Elevation shadow | `--hmi-shadow` |
| Default transition | `--hmi-motion-base` (static, not editable) |

> The colors, typography and spacing/radius/shadow tokens above are **editable in
> Config → Theme Editor**. Motion (`--hmi-motion-*`) is a static constant.
>
> **The back-compat aliases were removed.** `--hmi-font`, `--hmi-text-sm`,
> `--hmi-space-3`, `--hmi-shadow-md` and the rest of that set no longer resolve —
> a widget still using one silently loses the declaration. See the mapping table
> in [theming.md](theming.md#removed-the-back-compat-aliases).

### Full token reference

The complete colors / typography / spacing token catalog (with theme JSON paths
and sample usage), the derived secondary tokens, and the shared `hmi-*`
primitive classes are documented once in
[theming.md](theming.md).

## Existing examples

The repository ships several reference components under `<project>/custom-widgets/`; browse the directory tree (or `GET /api/widgets`) for the up-to-date list. Common groups today include `Inputs/` (Dropdown, NumberInput, NumericStepper, StringInput, Switch), `Other/` (Gauge, HeaderTime, LedIndicator, LogoTitle, Trend, UserBadge, ValueDisplay, and more), and `Navigation/` (PageHeader, PageMenu, SidebarMenu).

Start from `_template/` if you need a new component scaffold.

## Testing

Each component folder may contain `*.test.ts(x)` files.

Tests run in the frontend `vitest` environment (jsdom). They cannot import app modules — same SDK constraint as production. For unit tests of pure helpers, prefer extracting them next to `index.tsx` and importing the file under test directly.
