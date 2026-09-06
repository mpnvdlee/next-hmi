# NEXT HMI Frontend Architecture

Back to architecture hub: [overview.md](overview.md).

## Scope

The frontend is a React 19 + TypeScript + Vite application split into explicit runtime, config, and shared domains.

## Source Layout

- `frontend/src/hmi/`
  - runtime/operator view
- `frontend/src/config/`
  - editor, variables, translations, admin, preview
- `frontend/src/manager/`
  - the **manager dashboard** — a separate top-level app (`ManagerApp.tsx`, `managerStore.ts`, `manager.css`) rendered from the *same bundle* when the runtime is in manager mode. It owns device-admin login and the project list with per-project start/stop. The `@enterprise` alias (`src/enterprise/registry.ts`, an empty stub in this repository) is the seam through which an enterprise build contributes its own surfaces: `enterpriseSettingsPanels` appends Settings sections, `enterpriseSessionResets` clears its state on sign-out, and `enterpriseAppGates` wraps the whole dashboard — the `ee` build uses that last one to replace it with an activation screen until the installation is licensed. Every array is spread unconditionally and is empty here, so the call sites tree-shake away. Gates are applied *after* the device-admin password gate, so nothing one of them renders is reachable anonymously.
- `frontend/src/shared/`
  - types, hooks, stores, and shared context. `shared/utils/runtimeBase.ts` reads the injected `window.__NEXTHMI_BASE__` / `__NEXTHMI_MODE__` globals and exposes `getBasePath()`, `getMode()`, `routerBasename()`, and `withBase(url)` — the single source of truth for the URL prefix the SPA runs under.
  - **Lost manager session** — when the device-admin session is missing or expired every gated call 401s at once, and individual stores only log the failure, so the app would otherwise render an empty project with no explanation. `shared/utils/api.ts` recognises the manager's `manager_session_required` code in `apiErrorFrom` and calls the single handler registered through `setSessionExpiredHandler`; `AppInner.tsx` (project documents only — the manager dashboard owns its own login screen) points that at `sessionStore`, and `SessionExpiredOverlay` blocks the view with a "Signed out" dialog whose action returns through `/?signIn=<this URL>`. It is built from the shared modal card (`name-modal` + `Button`) but not from `ModalShell` — it is not dismissable, and it renders over the operator runtime too, so like `BootSplash` it imports only `config.tokens.css` instead of all of `config.css`. A project-user 401 (a bad write credential) carries no such code and is left to its caller.

Key subfolders:

- `frontend/src/hmi/components/`
  - runtime components and renderer
- `frontend/src/hmi/hooks/`
  - runtime variable and WebSocket hooks
- `frontend/src/hmi/store/`
  - runtime Zustand stores
- `frontend/src/hmi/registry/`
  - built-in and custom component registry
- `frontend/src/config/components/`
  - config UI components, grouped by area (`admin/`, `alarms/`, `componentProperties/`, `compositions/`, `editor/`, `historian/`, `projects/`, `recipes/`, `shared/`, `shell/`, `themes/`, `translations/`, `ui/`, `users/`, `variables/`); each component lives in its own subfolder with a `style.css`
- `frontend/src/config/pages/`
  - route-level config pages (no CSS files — pages are composed entirely from components)
- `frontend/src/config/store/`
  - config-view state slices
- `frontend/src/config/styles/`
  - `config.tokens.css` (the `--cfg-*` design tokens) and `config.css` (layout primitives, tables, trees, buttons)
- `frontend/src/shared/store/`
  - config, project, and translation global stores

## Routing

`frontend/src/App.tsx` lazy-loads all route views. It first reads the runtime mode (`runtimeBase.getMode()`): when `mode === 'manager'` it renders `ManagerApp` (the dashboard) and the routes below never mount. Otherwise it renders the HMI/config app for whichever project this instance serves.

Both apps wrap their routes in `<BrowserRouter basename={routerBasename()}>` — the basename is `/` for the manager (origin root) and `/runtime/<slug>` or `/editor/<slug>` for a proxied project instance, so the same bundle routes correctly under either prefix. There is no longer an in-app `/projects` route or `NoLiveProjectCard` CTA to it; project selection lives in the manager dashboard. The `LiveProjectGate` short-circuits to "online" whenever the base path is not `/` (a managed instance is always pinned to its project).

Project (non-manager) routes:

- `/` -> `HmiView`
- `/pages/:id` -> `HmiView`
- `/config/editor` -> `EditorView`
- `/config/datasources` -> `VariablesView`
- `/config/translations` -> `TranslationsView`
- `/config/theme` -> `ThemesView`
- `/config/alarms` -> `AlarmsView`
- `/config/historian` -> `HistorianView`
- `/config/recipes` -> `RecipesView`
- `/config/components` -> `ComponentsView`
- `/config/admin` -> `AdminView`
- `/config/users` -> `UsersView`
- `/preview/:pageId` -> `PreviewView`
- `/config` redirects to `/config/editor`

The `/config` prefix above is the **legacy mount**. Under a managed instance the
same routes hang off the area base instead — `/editor/<slug>/editor`,
`/editor/<slug>/datasources`, … — which is what `editorPath()` in
`shared/utils/runtimeBase.ts` returns: `''` in the `editor` area, `/config`
otherwise. `ConfigRoutes.tsx` declares the segments relatively, so one
declaration serves both mounts.

`ConfigShell` wraps the `/config/*` routes. Every nav entry is unconditional — there is no feature gate. When the project is clean, the header's `SaveWarningsPill` fetches `/api/config/validate` and surfaces any project-wide diagnostics. A dirty users/groups security draft adds separate **Save users** and **Discard users** controls to this persistent shell, so the controls remain available after navigating away from `UsersView`.

## App Bootstrap

The manager dashboard (`mode === 'manager'`) bypasses `AppInner` entirely — it has no WebSocket, widget registry, or feature gating; it talks to the manager APIs (`/api/manager/*`) through `managerStore`.

For a project instance, `AppInner()` does three important things before rendering routes:

1. starts the shared WebSocket connection with `useWebSocket()`
2. registers custom widgets via `loadCustomWidgets()` — a single `/api/widgets` fetch; the compiled modules themselves are imported lazily on first render
3. loads reusable components via `loadComponents()`, registering each as a virtual component type `$component:<id>`; subsequent component-store changes re-run `registerComponents()`

Route rendering is gated by `ComponentsReadyGate` until both load promises (custom widgets, components) settle.

## Shared Types

- `frontend/src/shared/types/config.ts` — `PageConfig`, `WidgetConfig`, `LayoutConfig`, `HmiWidgetProps`, `VisibilityCondition`, and related types
- `frontend/src/shared/types/widgetSchema.ts` — canonical location for `SchemaField`, `RequiredFieldEntry`, `ExportedProperty`, `RegistryEntry`, and `CustomWidgetManifestEntry` (one row of `GET /api/widgets`, mirroring `backend/api/widgets_api.py::_entry`); `RequiredFieldEntry` is a recursive type supporting nested struct field specifications
- `frontend/src/shared/types/datasource.ts` — datasource config and variable types

## State Management

The frontend uses Zustand.

Shared stores:

- `frontend/src/shared/store/configStore.ts`
  - pages, header, footer, dialogs
  - tree mutation helpers
  - persistence through `saveConfigToBackend()`
- `frontend/src/shared/store/projectStore.ts`
  - dirty state, save orchestration, undo/redo snapshots
  - aggregates save callbacks registered by feature modules (for example datasource variable tables)
  - `saveAll()` marks global save failure when any registered callback throws
- `frontend/src/config/store/domains/usersDomainStore.ts`
  - globally owns the loaded users document and its security draft; views only request lazy loading and never own its lifetime
  - users/groups edits set the store's isolated `dirty` state, not `projectStore.dirty`, and are excluded from generic snapshots, Undo/Redo, global Save, and Ctrl+S
  - the persistent `ConfigShell` owns the explicit security controls: **Save users** atomically replaces the complete users document, while **Discard users** restores the last successfully loaded/saved document without writing
  - navigation and route unmounts retain the draft; a failed save retains it with an error, and the shared before-unload warning covers both project and security dirty state
- `frontend/src/shared/store/translationStore.ts`
  - dictionaries, active language, active dictionary, translation rows

Runtime stores:

- `frontend/src/hmi/store/hmiStore.ts`
  - dialog/UI runtime state
- `frontend/src/hmi/store/variableStore.ts`
  - scalar and struct live values
  - WebSocket connection flags
- `frontend/src/hmi/store/alarmStore.ts`
  - active alarms, history, and computed summary; updated by `alarm_snapshot` / `alarm_update` WS messages
- `frontend/src/hmi/store/widgetPropStore.ts`
  - exported component property values resolved by `$widgetProp`
- `frontend/src/shared/store/componentStore.ts`
  - reusable component definitions + per-component drafts; the editor uses drafts to render unsaved component edits inside `LivePreview`

Config-domain stores (`frontend/src/config/store/`):

- `domains/editorDomainStore.ts`, `domains/variablesDomainStore.ts`, `domains/usersDomainStore.ts`
- `translationsViewStore.ts`, `themeViewStore.ts`, `panelExpansionStore.ts`
- `alarmConfigStore.ts`, `recipeConfigStore.ts`, `historianConfigStore.ts`, `componentEditorStore.ts`
- `adminViewStore.ts`
  - Live subscriptions (polled every 2 s), alarm triggers, historian paths, custom-widget build status + recompile, and connected runtimes — i.e. exactly what `AdminView` renders. **System info, runtime home, logs, HTTPS and the device-admin password are not here**: those sections live on the manager's `/settings` page and are fed by `managerStore` / `projectsStore`.

Manager store:

- `manager/managerStore.ts`
  - device-admin auth (`auth/status`, `setup`, `login`, `logout`) and the running-instance list (`GET /api/manager/running`, per-project `start`/`stop`). Drives the dashboard; no project pipeline state.
- `config/store/projectsStore.ts`
  - the project list (`GET /api/projects`), create/import/export/locate/delete, and the manager peer-transfer flow: `loadPeers` (mDNS + manual), `pairPeer`/`listPeerProjects` (session-proxied `POST /api/manager/peer-pair` and `/peer-projects`), and `beginPeerTransfer`/`beginPeerPull` plus their `get*`/`cancel*` counterparts (`/api/manager/transfers` and `/api/manager/pulls`). Used for generic project CRUD from both the manager dashboard and the config app; the peer-transfer slice specifically is manager-only — `PeerTransferModal` (`config/components/projects/ProjectsView/PeerTransferModal.tsx`) is mounted from `manager/ManagerApp.tsx` and drives both the push and pull direction off this store. The bearer token from pairing lives only in the modal's component state, never in the store or web storage.
- `themeViewStore.ts` (config)
  - multi-theme editor state: theme ids, default-theme id, selected theme, last-saved configs + dirty per-id drafts; `create`/`delete`/`setDefaultTheme` over `/api/themes` + `/api/default-theme`
  - imports `applyThemeTokens`, `defaultTheme`, `LS_THEME_PREVIEW`/`LS_THEME_SAVED` from `themeTokens.ts`
  - registers a persistent save callback via `projectStore.registerSave('theme', ...)` (persists every dirty draft) and a snapshot extension so theme edits ride the shared undo/redo history
- `hmi/store/themeRuntimeStore.ts` (runtime)
  - ephemeral, session-only active-theme selection: tracks `activeThemeId` and re-applies a cached theme's `--hmi-*` tokens at runtime (e.g. day/night). Not persisted — a reload returns to the project's default theme

Error handling notes:

- `adminViewStore` sets an `error` string when loading component/subscription data fails.
- datasource action/reconnect UI handlers log request failures instead of swallowing them silently.
- datasource variable save registration re-throws failed save requests so `projectStore.saveAll()` can surface global save errors.

## Config Loading

### Index Bootstrap

`useConfig()` boots the config by fetching `/api/config/config` into `configStore`.

The backend returns a v2 **page index** — page metadata and structure with no component children for pages. On success, `configStore` populates `pages` (with empty `children: []` arrays), `header`, `footer`, and `dialogs`.

New state after bootstrap:

- `loadedPageIds: Set<string>` — pages whose component children have been fetched; starts empty
- `dirtyPageIds: Set<string>` — pages with unsaved component changes; starts empty

### Lazy Page Hydration

Component trees for individual pages are fetched on demand via `GET /api/config/pages/{id}`.

`usePage(pageId)` (from `frontend/src/shared/hooks/useConfig.ts`) is the primary consumer. It:

1. Checks whether `pageId` is already in `loadedPageIds`
2. If not, calls `loadPageContent(pageId)` which fetches the page file and merges `children` into the page in the store
3. Marks the page as loaded in `loadedPageIds`

Call sites:

- `HmiView` — calls `usePage(page?.id)` after resolving the active page
- `EditorView` — calls `usePage(previewAreaId)` for the currently previewed page
- `LivePreview/index.tsx` — builds a `pageContent` map from all loaded pages and includes it in the `pages_update` postMessage to the preview iframe
- `PreviewView.tsx` — receives `pageContent` in `pages_update` and merges loaded children into the page list before calling `setPages`

### Incremental Save

`saveConfigToBackend()` performs two operations:

1. `PUT /api/config/config` — saves the page index (page metadata only, no component children)
2. For each `pageId` in `dirtyPageIds`: `PUT /api/config/pages/{pageId}` — saves the page's component tree

`dirtyPageIds` is cleared on success.

### Dirty Tracking Rules

| Action | Effect on dirty state |
|---|---|
| Page metadata change (title, icon, reorder) | No per-page dirty — index is always saved |
| `addPage`, `addPageToPageGroup` | New page marked loaded + dirty |
| `deletePage` | Removed from `loadedPageIds` and `dirtyPageIds` |
| `addPageGroupToPage`, `reorderPageChildren`, `addComponentToPage` | Specific page marked dirty |
| `addComponentToContainer`, `addComponentToWidgetSlot`, `deleteComponent`, `duplicateComponent`, `moveNodeToPage/Container`, container `reorderChildren` | All currently loaded pages marked dirty |
| `updateComponent` | Only the owning page marked dirty (uses `findOwningPage()`) |

`useTranslations()` delegates loading to `translationStore`.

## Runtime Data Flow

The app opens one WebSocket per browser tab.

`useWebSocket()` currently handles these inbound messages:

- `var_snapshot`
- `var_update`
- `var_removed`
- `opcua_status`
- `alarm_snapshot`, `alarm_update` — applied to `alarmStore`
- `user_identity`, `auth_error`
- `write_response`, `write_error` — routed to the async action dispatcher by `requestId`

The full wire protocol these messages belong to is specified in [websocket.md](websocket.md).

It updates `variableStore` through:

- `applyBatch`
- `markSnapshotReceived`
- `removeVars`
- connection status setters

## Priority Subscription Flow

The frontend actively tells the backend which variables matter right now.

Current producers:

- `HmiView`
  - sends `set_context` with `currentPageIds` and `openDialogIds`
- `PreviewView`
  - sends `set_context` with preview page/dialog context
- `DatasourceVariableTable`
  - sends `set_context` with `priorityKeys` for currently visible rows after scroll settle

`HmiView` keeps two independent runtime overlay stacks:

- dialog stack via `openDialogIds`
- page overlay stack via `openPageOverlayIds`

Backdrop close behavior is stack-aware:

- closes top-most closeable dialog first
- otherwise closes the top-most page overlay

## Component Registry

Every product widget is a **built-in** widget: sources under
`frontend/widgets/`, authored against the same SDK contract as a project's
custom widgets — same folder shape (`<Group>/<Name>/index.tsx` plus an
optional `style.css`), same rules, same rulebook in
[../reference/custom-widgets.md](../reference/custom-widgets.md) — and compiled
at build time by `npm run build:builtin-widgets`.

`frontend/src/hmi/registry/widgetRegistry.tsx` therefore starts empty and is
filled at runtime: the built-in-widgets manifest at module eval, then a
project's custom widgets and reusable components on top. A widget that renders
other widgets itself — `NavigationMenu` (a page-tree menu with a footer slot),
`ImageContainer` (children placed absolutely over a background image) and
`ComponentSlot` (the component system's own machinery) — is authored against
the SDK's [composition primitives](../reference/custom-widgets.md#composition)
like any other built-in widget. Like any built-in widget it arrives as a lazy
module, so a shell region holding one paints a beat after the page around it.

`build:builtin-widgets` runs the backend's own compiler
(`services.widget_compiler`) once, on the build machine, and ships two
artifacts: the per-widget modules under `frontend/public/builtin-widgets-js/<key>/`
(`index.js`, plus `style.css` and `fonts/` when the source has them) and the
baked manifest — `frontend/src/generated/builtinWidgetsManifest.json` plus its
`.editor.json` half. Compiling here rather than on project load is what lets a
deployment without esbuild degrade exactly as it always did — a project's own
widgets go uncompiled while the product's widgets still render.

The baked manifest is tracked, and `npm run dev` and `npm run build` both
regenerate it first, so its rows carry no wall-clock stamp: each row's `buildTs`
is a content hash of the bytes that widget serves. Rebuilding unchanged sources
therefore leaves the file — and `git status` — untouched, while an actual change
still mints a new `?t=` value. The runtime endpoint's `buildTs` stays a
timestamp; that one is a compile *time* the admin panel displays.

A built-in widget is registered synchronously at module eval from that
manifest, which the registry imports statically — so schemas and categories
are present before first render and only the component modules load lazily,
from `/builtin-widgets-js/`. A project custom widget still shadows either shape
(`registerCustomWidget`), so a customer can pin a previous version without a
product rollback.

The manifest is split in two because its readers are. `widgetRegistry.tsx` is on
every route, so what it imports lands in the shared entry chunk an HMI page
loads: that half holds the registration fields plus each schema field's `type`
and `requiredFields` — all `useBindingStatus` needs to raise the
disconnected/disabled overlay. Labels, options, defaults, `visibleWhen`,
descriptions and icons go in `builtinWidgetsManifest.editor.json`, which only
`hmi/registry/builtinWidgetsEditorMetadata.ts` imports, and which only
`src/config/` imports in turn — so an operator running an HMI page never
fetches them. `applyBuiltinWidgetsEditorMetadata` folds that half onto the
registry entries at module eval, synchronously: the palette and the properties
panel still see whole entries on their first paint. Backend readers see no
split at all — `core.builtin_widgets_manifest` merges the pair back before
config validation and the MCP tools ever look at a schema.

Three manifest fields carry what a folder name and a schema cannot: `displayName`
is the palette/tree label when the type reads badly as one (`StretchSpacer` →
`Stretch Spacer`), `hostsChildren` declares that nodes of the type carry a
`children` array, and `flowsChildren` that those children are arranged with
flexbox. All three are plain exports on the source, so they are open to project
widgets on the same terms — together they are what lets a project ship its own
container, which the product could not do before.

`flowsChildren` is the narrower of the two container flags and the one the
sizing model turns on: a child of a type that declares it has a resolvable main
axis, so the Layout panel offers it Hug/Fill/Fixed (`usesFlexLayout` in
`shared/utils/parentFlow.ts`), the runtime resolves its modes against that axis
at render — `hmi.css`'s flow-translation block, reading the parent's own
`data-flow-direction`/`data-flow-align` (see the Width/Height entry below) —
and the 4 → 5 migration reads its stored keys against it (`_child_axis`). An
`ImageContainer` hosts children but pins them to image slots, so it declares
only `hostsChildren` and its children get no axis.

The backend overlays the same manifest onto its `builtin` schema map, so page
validation and the MCP tools know a product widget's properties. The overlay
happens in `core.validation.structure.load_widget_manifest` — the one place
every consumer reads through — rather than being baked into
`widget-schemas.json`, so product widgets resolve even in a runtime home that
has never compiled, and that file keeps describing only what its own compile
produced. Reading and caching the manifest is `core.builtin_widgets_manifest`;
it comes from `frontend/src/generated/` in a checkout and from
`dist/builtin-widgets-js/manifest.json` in a packaged runtime.

The `builtin` half `widget-schemas.json` itself carries is therefore always
empty, and the extractor reads no frontend source: a compile only ever
describes a project's own widgets. The key survives for the readers that merge
onto it, and a stale row in it loses to the built-in catalog on a name clash:
the runtime home survives product upgrades, so it can still carry a row for a
widget that has since moved.

The rendered catalog with every property is generated from this registry into
[../../user/catalog.md](../../user/catalog.md) and `docs/user/generated/widgets.json`
— run `npm run docs:widgets` after adding or changing either shape.

`AlarmListManaged` and `AlarmHistoryList` take a `chrome` boolean (default
`true`): turned off, the widget drops its own border/background so it can sit
inside a card that already draws one. An empty `title` additionally drops the
header band rather than rendering a blank strip with a stray count chip.

Everything else is a **custom component** — authored per project under `<project>/custom-widgets/` and compiled on save, not registered here. Input and display components (Dropdown, NumberInput, NumericStepper, StringInput, Switch, Gauge, HeaderTime, LedIndicator, LogoTitle, Trend, UserBadge, ValueDisplay, and the like) are built this way rather than as built-ins. Worked examples of each live in the private dev/test project (`project-testbench/custom-widgets/`, cloned in during development); `project-seed/` ships with an empty `custom-widgets/`, so a fresh project starts with the built-in registry above and whatever you author.

Custom widgets are **registered from the manifest**, not from their modules.
`loadCustomWidgets()` fetches `/api/widgets` — whose rows carry `schema`,
`exportedProperties`, `category`, `description` and `icon` straight from the
compiled `widget-schemas.json` (`CustomWidgetManifestEntry`) — and
`registerCustomWidget()` builds one registry entry per row whose `component` is a
`lazy()` that imports `/widget-js/<Name>/index.js` on first render (cache-busted
by `buildTs`, which also identifies the build, so a recompile mints a fresh
`lazy()`). The editor can therefore list, offer and validate a widget whose
module has never been fetched, and a heavy widget costs nothing until it is on
screen. Per-widget CSS is served from `/widgets/<Name>/style.css` and
reference-counted via `useStylesheet()`.

Two conditions are logged rather than left silent: an entry carrying
`schemaError` (it renders, but the editor has no property fields or
`$widgetProp`s for it) and a custom widget shadowing a built-in name.

Reusable **components** are registered as virtual entries `$component:<id>` whose
component is `ComponentRenderer` and whose schema is derived from the
definition's `componentProperties` via `componentPropertyToSchemaField()`. Each
entry also carries `slots` — the slot names collected from the definition's tree
by `collectSlotKeys()` (see [Component slots](#component-slots)). `slots` being
present (even empty) is what marks an entry as a component instance, which three
registry helpers read:

- `isContainerHostType(type)` — anything whose manifest row declares `hostsChildren` (the built-in `Container` and `ImageContainer`, and any project widget that opts in), or any component with at least one slot; these host children in the editor tree
- `usesFlexLayout(type)` (in `shared/utils/parentFlow.ts`, not the registry — `WidgetRenderer` and the properties panel both read it from there) — anything whose manifest row declares `flowsChildren`; these give their children a main axis to size against
- `hasSlotSections(type)` — more than one slot, so the editor addresses each slot separately (tree sections, Move dialog, preview insert target)
- `placesOwnChildren(type)` — a `$component:` entry; `WidgetRenderer` skips building JSX children for it, because the instance places its children itself, per slot, from `childConfigs`

`ComponentRenderer` (`frontend/src/hmi/components/ComponentRenderer.tsx`) reads
the saved definition from `componentStore` (or the draft when inside a preview
iframe) and renders its tree, with three behaviours worth knowing:

- **Declared defaults are filled in.** Every property the instance leaves `undefined` takes its `componentProperties[*].defaultValue` before the tree is rendered, so the panel's `· default` hint matches what `$componentProp` resolves to at runtime. An explicit `null` counts as set.
- **Instance sizing folds onto the first root.** The self-sizing half of the instance's layout (`SELF_LAYOUT_KEYS` in `layoutUtils.ts` — `grow`, min/max sizes, `width`, `height`, `widthMode`, `heightMode`) is merged onto the definition's *first* root node rather than applied to a wrapper: a wrapper would re-parent the roots and break flex values authored against the real parent, and folding onto every root would multiply the sizing by their count. Direction, gap and padding describe the component's insides and stay with the definition — an instance never reads them, and the panel renders an instance in `leaf` mode, which has no row for one, so the 4 → 5 migration drops the container half of its stored layout outright. It does the same for every other non-`Container` node, on the same grounds: `containerLayoutProps` has exactly one caller, so an `ImageContainer` — which hosts children but pins them to image slots — reads those keys no more than an instance or a leaf does.
- **Slot content is published on context.** The instance's `childConfigs` are grouped by slot and provided on `ComponentSlotContext`; `DefinitionScopeContext` is set to `true` around the definition's own widgets.

Children referencing `$componentProp` resolve against `InputScopeContext`,
preserving `$var` binding identity so OPC-UA writes/reads target the wiring at
the instance.

### Component slots

A definition declares a slot by placing a `ComponentSlot` widget anywhere in its
tree; the widget's `slot` property names it (blank → `content`). Helpers live in
`frontend/src/shared/utils/componentSlots.ts` (`slotKeyOf`,
`collectSlotKeys`, `resolveChildSlot`, `groupChildrenBySlot`, `slotLabel`,
`slotTargetLabel`); the on-disk shape is in
[data-formats.md](data-formats.md#component-slots). The name comes from a
`componentProperties` entry of type `widgets`, which the `ComponentSlot` picks and
which gives the slot its properties-panel row on every instance; the
`ComponentSlot` widget stays the structural declaration of *where* it renders.

Runtime:

- `ComponentRenderer` groups the instance's children by their `slot` tag and provides the map on `ComponentSlotContext`. An untagged child — or one naming a slot the definition no longer has — falls into the first slot, so trimming a definition never makes content vanish.
- `ComponentSlot` reads its own key back out and renders those widgets. Empty, it renders nothing in the operator runtime; in a preview it draws a labelled outline so the author can see the hole they are authoring.
- `DefinitionScopeContext` marks the widgets a definition draws. `WidgetRenderer` turns it into `data-widget-source="definition"` on the preview wrapper, and `ComponentSlot` flips it back off around slot content — which is authored by the caller and must stay selectable even though it renders deeper. Ids alone cannot separate the two: they are per-tree slugs, so a definition and a page mint `container` / `body` / `label` independently and collide.

Editor:

- The widget tree renders one `TreeSection` per slot on an instance with more than one; a single-slot instance reads as a plain container.
- A slot named by a `widgets` component property gets **no** row in the instance's properties panel: nothing is stored under `properties[key]`, so the slot's content is edited where the widgets themselves live — the widget tree and the preview. `groupSchemaKeys` (`frontend/src/config/utils/schemaGroups.ts`) drops `widgets` fields for every panel, and a section left empty by that drop is dropped with them. `registerComponents` still keeps such a property in the entry's `schema` only when a `ComponentSlot` names it — the schema entry feeds `SlotNameField` and the runtime, not a panel row.
- Slot targets are addressed by the composite id `makeWidgetSlotId(widgetId, slot)` (`editorSentinels.ts`), used by the Move dialog, the preview's insert target, drag-and-drop drop ids, and `configStore.addComponentToWidgetSlot()` / `moveNodeToContainer(nodeId, targetId, slot)`. Moving a node *out* of a slot clears its tag rather than leaving a stale slot name behind.
- Pasting next to a widget inside an instance inherits that widget's slot, since siblings from every slot share one flat `children` array.

## Property Types and Sources

The complete property-value model — the value types, optional formats, every property source, `$var` tree shapes, OPC-UA type collapse, and resolution/coercion rules — is specified in [value-types.md](value-types.md). This section covers the frontend editor/runtime wiring.

Schema fields support extended metadata used by the editor and runtime:

- `format?: string` — refines a base type to upgrade its editor without changing the stored value; source rules still follow the **base type** (format catalog in [value-types.md](value-types.md))
- `visibleWhen?: VisibilityCondition | VisibilityCondition[]`
- `display?: 'auto' | 'dropdown' | 'button-text' | 'button-icon'`
- `placeholder?: string` — hint text for `string`, numeric, and `icon` inputs
- `min?`, `max?`, `step?` — numeric field constraints

The property **sources** offered for a field are derived entirely from its `type` via `getAllowedPropertySources(fieldType)` — there is no per-field source allowlist (the old `valueSourceTypes` schema field is removed).

Source-capable field types are the value types plus the editor-only `option-list` kind:

- `option-list` — stores `{ label, value }[]`; supports `$static` (inline list editor), `$user` with `field: 'userList'` (all system users), `$var` (array variable binding filtered by listing array `type`s, e.g. `['option-list','string[]','integer[]']`), and `$languages` (resolves to all configured HMI languages as `{ label: code, value: code }` pairs)

Editor implementation:

- `PropertySourceSelector` controls the property source per field; the offered sources come from `getAllowedPropertySources(fieldType)` (derived from each source's `produces` metadata in `propertySourceRegistry.ts`), plus scope-injected sources (`$componentProp` inside a widget/dialog, `$result` inside an async-action handler)
- `PropertySourceEditor` renders source-specific editors
- `visibilityEvaluator` controls conditional field visibility via `visibleWhen`
- `TranslationInput` uses `{ "$loc": "key" }` for translation references
- `renderSchemaField` (`frontend/src/config/utils/renderSchemaField.tsx`) — shared static field renderer used by both `PropertiesPanel` (component properties) and `LayoutFields` (layout panel); also applies the per-format editors (`select`/`direction`/`align`/`justify` button-groups, `multiline`/`password`/`length`/`spacing` inputs, `percentage` suffix, and the `visibility`/`enablement`/`wrap` boolean relabels)
- `LayoutFields` (`frontend/src/config/components/ui/LayoutFields/index.tsx`) — all layout fields are declared as `SchemaField` definitions; the enum fields render as button groups — text labels (`display: 'button-text'`) except Direction, Align and Distribute, whose arrangements read better as glyphs (`display: 'button-icon'`). `containerDefaultTokens.ts` beside it exports `CONTAINER_DEFAULT_TOKENS` for panels that need the token list without the component
- **The Layout section is three bespoke controls**, not one row per `LayoutConfig` key. Storage is unchanged throughout — every one of them writes the same keys the old rows did:
  - **Width/Height.** One mode row per axis (Hug/Fill/Fixed), and under it the row for whichever key that mode actually sizes the axis by: the axis's own length under `Fixed`, the `grow` weight under `Fill` on either axis (it is one shared key — both axes' Fill rows read and write it, though only whichever axis its parent actually treats as main ever renders by it), or a disabled dash under `Hug`, which sizes from neither. `sizeValueRows` picks between them. The panel needs no parent flow at all any more to decide this — it never learns which axis is main, so `schemaFor` gives both mode rows one neutral default hint (`hug`) instead of a main-axis-flavoured one and a cross-axis-flavoured one
    - A mode no read resolves — unset, a `$var`, a `$switch`, a mixed selection — shows the length *and* the weight, on either axis: either key may be the live one once it resolves, or once this axis turns out to be the one its parent treats as main, so `sizeModePatch` clears neither. Every other pick clears what it puts out of reach, since a key the runtime drops is one the panel has no row to show, revert or explain
    - **The runtime resolution is axis-neutral, not flow-aware.** `selfLayoutStyle` (`hmi/components/layoutUtils.ts`) reads a widget's own `widthMode`/`heightMode` — nothing about its parent — and emits `--w-*`/`--h-*` custom properties: a main-role triple (`--{w,h}-grow`/`-basis`/`-shrink`) and a cross-role pair (`--{w,h}-alignself-stretch`/`-notstretch`), written unconditionally under both possible roles since the widget itself has no idea which one applies. One CSS block in `hmi.css` ("Flow translation") picks the half that's actually live, off the flex *parent*'s own `data-flow-direction`/`data-flow-align` attributes (written by `containerLayoutProps`, same file) — so a `$var`/`$switch`-bound `direction` just works: the runtime resolves it like any other property source and writes the plain result into the attribute, and the CSS rule sees the same DOM state a literal `row`/`column` would have produced. No React context, no parent-flow resolution step, and no `· default` marking distinguishing main from cross — the panel genuinely does not know. `lengthSuppressed` (same file) is the one place `width`/`height` still depend on this axis's own mode: a literal Hug or Fill owns the length role instead, so a stored length is withheld from the style object rather than left to out-rank the `--w-*`/`--h-*` role CSS assigns it once this axis resolves to main — the one case this catches that the panel's own clear-on-pick (`sizeModePatch`) cannot is a `$var`/`$switch`-bound mode resolving to Fill over a length typed before the binding existed, since that never runs through the panel at all
    - `grow` is the one layout key with no axis of its own — it is reachable from either axis's own literal `Fill` (`reachableSizeKeys`, now axis-blind: the panel doesn't know which is main either), so it gets one row of its own *below* both axis blocks rather than one inside each — a row per axis renders the same key, label and value twice and reads as two independent per-axis weights, which is what the panel showed until the row moved out. An axis whose own mode derives its length instead of storing one (`Hug` and `Fill` alike) shows the read-only dash naming that mode. `sizeModePatch` clears the weight only once *neither* axis's mode still reaches it, not the moment either one's own pick stops being `Fill`. An unresolvable other-axis mode (`$var`, a mixed selection) is read the same conservative way: `sizeModePatch` keeps `grow` rather than clear one that mode might still turn out to need. At render, `grow` only ever reaches CSS through `--w-grow`/`--h-grow` on the axis whose own mode is literally `Fill` — an axis left unset emits neither, so flipping a `Container`'s `direction` can put a live weight to sleep (its axis stops being main) but can never wake a dormant one on the *other* axis, since that axis's own mode decides its own vars independently of which one is main now. One shared key, no per-axis leak — the store itself does no flow-aware pruning any more; see `_drop_stale_grow` in the migration for the one place that still drops a stray `grow` outright, during the 4 → 5 format upgrade that first introduced the size modes
  - **Align / Distribute.** Two `display: 'button-icon'` rows, one per property: `align` (`align-items`, the cross axis) and `justify` (`justify-content`, the main axis). Both are plain `SchemaFieldRow`s — so the source pill, the mixed state, the default marking and the revert `×` all come for free — and only their *presentation* depends on `direction`: `schemaFor` rebuilds the options per render so each label names the position an author can see (Top/Middle/Bottom against Left/Center/Right) and each glyph is transposed to the axis in play. `alignIcons.ts` authors every glyph once along the horizontal and swaps x/y for the vertical. `stretch` is not cosmetic — it is the `align-items` default that makes a child's cross-axis `Fill` work with no `alignSelf`, which is why the cross-axis mode reads it, and why the unset Align row marks it rather than reading blank
  - **Padding.** Four plain length rows, one per side (`PADDING_FIELDS` in `LayoutFields/index.tsx`). Storage is the four `padding<Side>` keys and nothing else — there is no `padding` shorthand key in `LayoutConfig` any more (retired by the 5 → 6 migration, `core/migration_padding.py`) and no merged "all sides" control over the four either. Each side is an ordinary `SchemaFieldRow`, so it carries the same source pill, `$var` picker, Mixed state, themed default hint and revert `×` as every other layout row, and binds on its own rather than four-at-a-time
  - **No sub-groups.** Every row renders into one flat list in `FIELDS` declaration order — `wrap` beside the other flow rows, each bound under the axis it bounds. No nested `Advanced` section and no `advanced` flag on the field def: what is left once the raw flex rows went reads at a glance, and a bound behind a disclosure is one the author forgets is set
  - **The raw flex four are gone.** `basis`, `shrink` and `alignSelf` have no panel row, no `LayoutConfig` field (`shared/types/config.ts`) and no `SELF_DIRECT_PROPS` entry, so nothing reads one: the 4 → 5 migration drops all three from every node — including the ones it can read no axis for (`_drop_retired_keys`) — and `run_baseline_migration` brings a project to the current format before it is ever served, so a stray one can only come from a hand-edited file and emits nothing, exactly like `margin`. `grow` is the one of the four still authored, as the Fill weight, and it is also the one raw key a node with no mode fields keeps: `selfLayoutStyle` passes that one through as literal `flexGrow`. The panel offers what a design tool offers, and the size modes plus the container's own `Align` write the rest
  - **Old projects are rewritten by two registered steps.** 4 → 5 (`core/migration_size_modes.py`) runs in three passes: normalise the raw flex keys, write the stored mode fields, then retire what the first two had to leave bound. 5 → 6 (`core/migration_padding.py`) collapses the `padding` shorthand into the four sides it overlapped with, parsing a literal or `$switch` value by the CSS box-shorthand rule rather than copying it whole (a longhand can't take a multi-value string). Both enforce the same rule: **a project file holds only what the panel can edit** — a key with no row is translated wherever the translation is faithful, dropped where it is not, never left in place. Each module's own docstring carries its per-pass/per-case detail
    - A `$switch` of lengths is read as a `$switch` of modes; a `$var`-bound length becomes `Fixed` over that same binding; a `$component:` instance's own sizing migrates like any other node's
    - A `grow` over a non-zero `basis` grows *from* the content size, which no mode spells, so it becomes Fill plus `min-<axis>: auto` — exact wherever the node is its parent's only growing child, and the closest the vocabulary comes where it is not
    - A definition's roots have no local axis, so the last pass reads one off the instances that place them (`_definition_flows`, keyed by the `$component:` id): the fold puts a root where its instance sat, so where every instance agrees, that flow *is* the root's
    - Where no axis resolves — a definition under two flows or none, an image-slot child, a bound container direction — the three raw keys are dropped rather than guessed at (`_drop_retired_keys`), since which axis they act on is exactly what is unknown. Each axis is guarded on its own stored mode, so a node pass 2 could only half-read does not keep the `alignSelf` it never got to
    - `_drop_stale_grow` retires a weight the *main* axis's own mode cannot read, mirroring `reachableSizeKeys(mode, main=True)` as it stood at the 4 → 5 migration — frozen history, not re-run. It is stricter than the live panel is today: `sizeModePatch` also keeps `grow` when the *cross* axis alone still reaches it through its own literal Fill, so a fresh edit can leave a weight in place that this one-time migration step would have dropped. `_drop_container_keys` retires the container half of any non-`Container`
  - **No margin.** The panel offers no `margin*` row; a Container carries no default margin either, and spacing between widgets comes from the parent's `gap` and `padding`. The keys are gone from `LayoutConfig` and `SELF_DIRECT_KEYS` both, so nothing emits a margin at all — one an older project still stores is simply not read
  - **A `$`-sourced value always falls back to the plain rows.** The box can render a literal only, so a click on it would flatten a binding into whatever the control happened to show. `PADDING_FALLBACK_FIELDS` holds the five rows it stands in for, and the box renders only while every key it owns is literal — the same rule the Width/Height rows apply per axis. Creating a binding on the box is a `✎` row action (`paddingBindAction`), because the source pill that normally offers `$var` belongs to `SchemaFieldRow`, which the box does not use; the size rows, Align and Distribute are all `SchemaFieldRow`s, so they carry the pill themselves
  - Direction, Align and Distribute are the repo's `display: 'button-icon'` schemas. `options[].icon` is a raw SVG **string** (`renderIcon` injects it), not a component, so `directionIcons.ts` and `alignIcons.ts` hold hand-authored markup following the `glyphIcon.tsx` conventions
- `WidgetPropPicker` — tree picker overlay for selecting a component + exported property when using the `$widgetProp` source
- `ItemsInput` — inline list editor for `option-list` schema fields on the `$static` source
- the `slot` field kind (the `ComponentSlot` widget's slot name) is **sourceless**: `SchemaFieldRow` renders it without a source pill, because the editor reads the literal straight off the definition to build an instance's slot groups. `SlotNameField` picks it from the definition's declared `widgets` properties — there is no free-typed name, so the declaration and the slot cannot drift; with nothing declared yet the field says what to add
- the `widgets` field kind (a declared slot on a `$component:` instance) names tree children, not a property value — it never reaches a panel row at all, because `groupSchemaKeys` filters it out before the panel renders

Runtime implementation:

- `frontend/src/hmi/utils/propertySourceEval.ts` evaluates all core property sources (`$static`, `$var`, `$loc`, `$urlParam`, `$pageIsActive`, `$if`, `$compare`, `$random`, `$switch`, `$user`, `$device`, `$time`, `$widgetProp`, `$componentProp`, `$stringExpr`, `$alarmCount`, `$page`, `$viewport`, `$result`); icon and image values are plain `$static` payloads (`{ type, name }` / `{ path }`) resolved by the `$static` handler
- `$result` is only meaningful inside async-action result handlers (`onSuccess` / `onFailed` / `onSettled` on `loginUser`, `logoutUser`, `writeDataVariable`); `{ $result: 'field' }` reads the named field off the response payload (e.g. `reason`, `username`); outside that context, or for an unknown field, it resolves to `null`
- `$stringExpr` parses `{N}` placeholders inside a template, where `N` is a wildcard key. Placeholders may wrap the wildcard with chained transforms — `ToLower`, `ToUpper`, `Trim`, `Capitalize`, `Round`, `Round1`, `Round2` — applied inside-out
- `$user` with `field: 'userList'` is component-resolved (only valid for `option-list` fields); `$languages` is also component-resolved
- `$widgetProp` is resolved at component-tree render time by reading the current `WidgetContext`; it is never evaluated by `propertySourceEval.ts` and is forbidden outside a widget's internal tree
- bad-quality and disconnected `$var` reads resolve to the field's fallback (not a crash); coercion between mismatched base types follows the rules in [value-types.md](value-types.md) (`frontend/src/hmi/utils/coercion.ts`)
- `frontend/src/hmi/hooks/useEvalContext.ts` wires a reactive `EvaluationContext` (variable store, translation store, URL params, active page ID) for use in HMI components. The index route renders a page without naming it in the URL, so the active page id falls back to `resolvePageContext(pages)` — the same page `HmiView` picks. `$page` and `$pageIsActive` share that one id, so neither reports "no page" on the landing screen
- Variable shape metadata and the binding-picker tree speak **value types** (`boolean`/`integer`/`float`/`string`/`datetime`, plus `[]` arrays and named structs); real OPC-UA types are converted to these at the two HMI boundaries (`DatasourceManager.variable_metadata` and `GET /api/datasources/{name}/variables`). The classifier and conversion live in `frontend/src/shared/utils/valueTypes.ts` (and `backend/core/value_types.py`).
- `nodeVarType` and the array-shape helpers in `frontend/src/shared/types/` derive array types from `is_array`; an optional positive `array_length` records only a fixed size.
- `layoutUtils` getters (`getPropString`, `getPropNumber`, `getPropBoolean`) accept an optional `EvaluationContext` to resolve property sources at render time
- `layoutUtils` hooks (`usePropVar`, `usePropString`, `usePropNumber`, `usePropBoolean`, `usePropStruct`, `useCssVar`) call `useEvalContext()` internally and simplify the most common per-component patterns; prefer these over the plain getters inside component render functions
- `frontend/src/hmi/utils/widgetActions.ts` centralizes action execution so components define actions and delegate runtime behavior to one executor; supported action types: `openDialog`, `closeDialog`, `openPageOverlay`, `closePageOverlay`, `writeDataVariable`, `setLanguage`, `loginUser`, `logoutUser`, `showAlert`, `showToast`; `ActionsConfig` supports both `onPress` and `onChange` event keys; schema fields of type `actions` carry an optional `event` string to indicate which key is used
- `loginUser`, `logoutUser`, and `writeDataVariable` are async — each generates a `requestId` per invocation, registers a pending entry with `frontend/src/hmi/utils/actionDispatcher.ts`, and the backend echoes the `requestId` on its response. On response, the dispatcher invokes the authored `onSuccess` or `onFailed` followed by `onSettled`, replaying the original firing site's `inputScopeProps` so nested `$widgetProp` references still resolve. Pending entries expire after 10 s as `reason: 'timeout'`, and flush as `reason: 'disconnected'` when the WebSocket closes (`useWebSocket.ts` → `flushAllAsDisconnected`). The outer action list is still fire-and-forget — sequencing across an async action must use its `onSuccess` slot, not list ordering
- `frontend/src/hmi/hooks/useGlobalEvents.ts` runs the configured `globalEvents` action arrays on app/page/locale/auth lifecycle (`onHmiLoaded`, `onPageLoaded`, `onLocaleChanged`, `onUserLoggedIn`, `onUserLoggedOut`)

## Runtime Views

### HmiView

`HmiView`:

- loads config and translations
- renders `TopBar`, `NavigationMenu`, header, page body, footer, and active dialog
- sends visible binding keys to the backend

### PreviewView

`PreviewView` runs inside the editor iframe and differs from `HmiView` in two ways:

- it does not call `useConfig()`; data comes from `postMessage`
- it reports clicks back to the parent editor and highlights selected components

It supports these special `pageId` values:

- `__header__`
- `__footer__`
- dialog IDs

## Styling Model

Two styling systems — `hmi-*` for the operator runtime, `cfg-*` for the config
UI — both specified in **[../reference/theming.md](../reference/theming.md)**:
the token catalogs and which file defines each, the naming conventions, the
defaults-→module-load-→`/api/themes` apply flow, the `THEME_TOKENS` registry,
derived secondaries, cross-tab sync, the shared primitives, and the
per-component CSS rules.

That document is the single home for all of it. Nothing about tokens or style
conventions is restated here — an earlier copy in this file drifted until it
claimed `config.css` was the only file in `config/styles/`, while theming.md
correctly documented `config.tokens.css` sitting beside it.

## Runtime SDK For Custom Components

`frontend/src/nextHmiSdk.ts` builds `window.__nextHMI__` (installed at boot by
`main.tsx`) so compiled custom components can reuse the app's React instance and
helper functions instead of importing app modules. The canonical name list and every hook signature are
documented in [../reference/custom-widgets.md](../reference/custom-widgets.md)
(source of truth: `frontend/src/shared/utils/nextHmiSdkNames.ts` and
`frontend/custom-widgets-sdk.d.ts`).
