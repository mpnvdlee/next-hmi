/**
 * Widget registry — maps type id to canonical catalog metadata, renderer, and schema.
 *
 * Nothing is imported eagerly and nothing is registered at module eval: every
 * product widget is a built-in widget, registered lazily from the baked
 * manifest (see `BUILTIN_WIDGETS_MANIFEST` below). Custom components from the
 * live project's custom-widgets/ folder are loaded via loadCustomWidgets(),
 * called once at app startup.
 *
 * Schema field types drive the editor Properties Panel (Phase 12).
 *
 * Style rule: component files contain ZERO inline styles.
 * The only permitted exception is CSS custom property values set via `style={{}}`,
 * as documented in the architecture.
 */

/* This is a registry of data + functions, not a component module — fast
 * refresh rules don't apply. */
/* eslint-disable react-refresh/only-export-components */

import { lazy, Suspense, type ComponentType } from 'react';
import { useComponentSelfSuspense } from '../context/ComponentSuspenseContext';
import type { HmiWidgetProps, IconValue, WidgetConfig } from '@shared/types/config';
import type {
  SchemaField,
  RegistryEntry,
  CustomWidgetManifestEntry,
  BuiltinWidgetEditorEntry,
} from '@shared/types/widgetSchema';

export type { CustomWidgetManifestEntry };
import type { ComponentDefinition } from '@shared/types/componentTypes';
import { getWidgetJsPath, getWidgetStylePath } from '@shared/utils/widgetPaths';
import { ensureStylesheet, releaseStylesheet } from '@shared/hooks/useStylesheet';
import { loadWidgetModule } from '@shared/utils/widgetModuleLoader';
import { componentPropertyToSchemaField } from '@shared/types/componentProperty';
import { useComponentStore, componentChildren } from '@shared/store/componentStore';
import { apiJson } from '@shared/utils/api';
import { isIconValue } from '@shared/utils/iconValue';
import { primaryType } from '@shared/utils/valueTypes';
import { collectSlotKeys } from '@shared/utils/componentSlots';
import { setFlowsChildren } from '@shared/utils/parentFlow';
import { ensureRecharts } from '@shared/utils/rechartsLoader';
// Product built-in widgets: the same SDK contract as a project's custom widgets,
// compiled at build time (`npm run build:builtin-widgets`). Imported statically
// rather than fetched, so schemas and categories are present at module eval and
// only the component modules load lazily from /builtin-widgets-js/.
//
// The manifest's *runtime* half: registration fields plus each schema field's
// `type` and `requiredFields`, all `useBindingStatus` needs. Labels, options,
// defaults, descriptions and icons live in the `.editor.json` sibling, imported
// only from `src/config/`. Every route reaches this module, so a byte here is a
// byte on every page.
import builtinWidgetsManifest from '../../generated/builtinWidgetsManifest.json';

const COMPONENT_TYPE_PREFIX = '$component:';

// What is known about one widget type's module, recorded at registration: the
// memoised load (`lazy()` and every prefetch share the one import), whether it
// has resolved — what lets a page gate its reveal on widget code having landed —
// and whether pulling it drags the chart library in.
//
// One record rather than a map plus two parallel sets: a project widget
// shadowing a built-in must report *its* answers, not the manifest's.
interface WidgetModuleEntry {
  load: () => Promise<ComponentType<HmiWidgetProps>>;
  loaded: boolean;
  /** Module reads `window.__nextHMI__.Recharts`. Kept out of the boot warm-up. */
  usesRecharts: boolean;
}
const widgetModules = new Map<string, WidgetModuleEntry>();

/** Memoise one module load under `type`, clearing the memo on failure so a
 *  dropped fetch does not leave the type permanently "not loaded" — every page
 *  holding it would then sit out the reveal gate's full timeout with no way
 *  back short of a reload. */
function registerWidgetModule(
  type: string,
  load: () => Promise<ComponentType<HmiWidgetProps>>,
  usesRecharts = false,
): void {
  let pending: Promise<ComponentType<HmiWidgetProps>> | null = null;
  const record: WidgetModuleEntry = {
    loaded: false,
    usesRecharts,
    load: () =>
      (pending ??= load().then(
        (comp) => {
          record.loaded = true;
          return comp;
        },
        (err) => {
          pending = null;
          throw err;
        },
      )),
  };
  widgetModules.set(type, record);
}

/** Every `$component:x` instance renders through the one shared chunk, so they
 *  all resolve to a single record keyed by the bare prefix. */
function widgetModuleFor(type: string): WidgetModuleEntry | undefined {
  return widgetModules.get(type.startsWith(COMPONENT_TYPE_PREFIX) ? COMPONENT_TYPE_PREFIX : type);
}

/** A type nothing registered has no module to wait for. */
function moduleLoaded(type: string): boolean {
  return widgetModuleFor(type)?.loaded ?? true;
}

registerWidgetModule(COMPONENT_TYPE_PREFIX, async () => {
  const mod = await import('../components/ComponentRenderer');
  return mod.default as unknown as ComponentType<HmiWidgetProps>;
});

// Deferred to break the circular import:
//   widgetRegistry → ComponentRenderer → WidgetRenderer → widgetRegistry
// React.lazy handles the Promise correctly and re-renders when ready.
//
// Registered in `widgetModules` under the bare `$component:` prefix like
// any other type, so the prefetch shares the one import and `widgetModulesLoaded`
// answers for it out of the same set — every `$component:x` instance draws
// through this one chunk.
const LazyComponentRenderer = lazy(async () => ({
  default: await widgetModuleFor(COMPONENT_TYPE_PREFIX)!.load(),
})) as ComponentType<HmiWidgetProps & { _widgetId: string }>;

// ── Shared schema fragments ───────────────────────────────────────────────────

// Standard visibility gate present on every widget. Both fields are plain
// booleans, expression-capable — switch either to the `$userGroups` source to
// gate by user group (empty group list = everyone), or nest `$if` etc.
//
// The key set is pinned against `UNIVERSAL_PROPERTY_KEYS` (and through it the
// backend's copy) by widgetRegistry.test.ts, so a gate property added here
// reaches every reader of that list rather than only this one.
export const VISIBILITY_SCHEMA: Record<string, SchemaField> = {
  visible: {
    type: 'Boolean',
    format: 'visibility',
    label: 'Visible',
    group: 'Visibility',
    defaultValue: true,
  },
  interactable: {
    type: 'Boolean',
    format: 'enablement',
    label: 'Interactable',
    group: 'Visibility',
    defaultValue: true,
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────
// Empty at module eval and filled at runtime: every product widget arrives from
// the built-in-widgets manifest below, and a project's custom widgets and
// reusable components register on top (`registerCustomWidget`,
// `registerComponents`).
export const widgetRegistry: Record<string, RegistryEntry> = {};

// Through `unknown`: TypeScript infers the JSON as a union of per-widget object
// literals whose `schema` shapes differ, so it never structurally matches the
// entry type. builtinWidgetsManifest.test.ts is the guard that the file really
// has this shape — it is generated by the build, not hand-written.
/** Types that declared `hostsChildren` on their manifest row. Mutable: project
 *  widgets register after boot, and a recompile re-registers. */
const declaredHostTypes = new Set<string>();

const BUILTIN_WIDGETS_MANIFEST = builtinWidgetsManifest as unknown as CustomWidgetManifestEntry[];

// ── Built-in type set (used by editor to separate built-in from custom in menus) ───
// "Built-in" means product-shipped: the built-in widgets compiled at build time.
// A *project's* custom widgets are the ones this set excludes.
export const BUILTIN_WIDGET_TYPES: ReadonlySet<string> = new Set(
  BUILTIN_WIDGETS_MANIFEST.map((entry) => entry.name),
);

export const DEFAULT_COMPONENT_CATEGORY = 'Components';
export const DEFAULT_WIDGET_CATEGORY = 'Other';
const DEFAULT_WIDGET_ICON = {
  type: 'builtin',
  name: 'squares-four',
} as const satisfies IconValue;
export const DEFAULT_CUSTOM_WIDGET_ICON = {
  type: 'builtin',
  name: 'puzzle-piece',
} as const satisfies IconValue;

// Registered here, at module eval, rather than from an async loader: every
// consumer that reads this registry synchronously (WidgetRenderer, buildCatalog,
// makeComponentOfType) must see the built-in widgets on the first render.
// `registerCustomWidget` is a hoisted function declaration, and every const it
// closes over is defined above.
for (const entry of BUILTIN_WIDGETS_MANIFEST) registerCustomWidget(entry);

interface ResolvedWidgetMetadata {
  name: string;
  category: string;
  description?: string;
  icon: IconValue;
}

/** Resolve the complete drawer/tree metadata for a registered widget type. */
export function resolveWidgetMetadata(type: string): ResolvedWidgetMetadata {
  const entry = widgetRegistry[type];
  return {
    name: entry?.name ?? type,
    category: entry?.category ?? DEFAULT_WIDGET_CATEGORY,
    description: entry?.description,
    icon:
      entry?.icon ??
      (BUILTIN_WIDGET_TYPES.has(type) ? DEFAULT_WIDGET_ICON : DEFAULT_CUSTOM_WIDGET_ICON),
  };
}

/** Widget types whose nodes host other widgets as `children` in the WidgetConfig tree.
 *  Drives the editor's container-aware UI: context-menu kind, collapse toggle, tree
 *  recursion, move-target collection, clipboard dispatch. Does NOT imply container
 *  layout fields (flex/grid direction, gap, etc.) — that's still 'Container'-specific.
 *
 *  A widget declares this with `export const hostsChildren = true`, which is
 *  what lets the built-in Container and ImageContainer host children — and is
 *  open to project widgets on the same terms. */
export function isContainerHostType(type: string): boolean {
  return declaredHostTypes.has(type) || widgetSlots(type).length > 0;
}

// Shared so `widgetSlots` is allocation-free for the overwhelming majority of
// types — it is called per widget per render and feeds hook dependency arrays,
// where a fresh `[]` would defeat every memo downstream.
const NO_SLOTS: string[] = [];

/** Slot names a component instance of this type accepts, in definition order.
 *  Empty for every type that isn't a `$component:` with `ComponentSlot`s. */
export function widgetSlots(type: string): string[] {
  return widgetRegistry[type]?.slots ?? NO_SLOTS;
}

/** True when instances of this type address their slots individually — the
 *  editor tree, the Move dialog and the preview's insert target all render one
 *  target per slot. A single slot has nothing to disambiguate, so an instance
 *  with one reads as a plain container. */
export function hasSlotSections(type: string): boolean {
  return widgetSlots(type).length > 1;
}

/** True for a `$component:` entry, whose renderer places the instance's children
 *  itself (per slot, from `childConfigs`) rather than rendering them as JSX
 *  children. `slots` is set — possibly empty — on exactly those entries. */
export function placesOwnChildren(type: string): boolean {
  return widgetRegistry[type]?.slots !== undefined;
}

// ── Custom component loader (Phase 8.9) ───────────────────────────────────────
// Custom component sources and styles live under
// <project>/custom-widgets/{Name}/. Compiled ESM lives in the runtime-home
// widget cache; both surfaces are served as static files by the backend.
//
// Grouped source layout: <project>/custom-widgets/{Group}/{Name}/index.tsx
// The source folder becomes the default catalog category for custom widgets.
//
// Registration is manifest-driven: `/api/widgets` carries the schema, catalog
// metadata and exported properties extracted at compile time, so a widget can
// be registered — and the editor can offer it, validate it and list its
// `$widgetProp`s — without its module being fetched. The module itself is a
// `lazy()` that imports on first render. A project holding a widget that pulls
// three.js therefore costs nothing until such a widget is actually on screen.
//
// The stylesheet loads with the module rather than on first mount, so a surface
// that waits for the module has waited for the CSS too. It then keeps the
// module's lifetime — in <head> for the session, since the module record stays
// `loaded` and a revisited page is revealed at once — and only a recompile
// drops it, once the build replacing it has landed.

/** The build whose stylesheet each widget currently has in `<head>`. */
const widgetStyleHrefs = new Map<string, string>();

/** Pull in this build's stylesheet, then drop the build it supersedes — in that
 *  order, so a recompile never leaves mounted instances unstyled in between. */
async function adoptWidgetStylesheet(entry: CustomWidgetManifestEntry): Promise<void> {
  const href = getWidgetStylePath(entry);
  await ensureStylesheet(href);
  const previous = widgetStyleHrefs.get(entry.name);
  widgetStyleHrefs.set(entry.name, href);
  if (previous !== undefined && previous !== href) releaseStylesheet(previous);
}

/** Build the registry entry for one manifest row, deferring its module. */
export function registerCustomWidget(entry: CustomWidgetManifestEntry): void {
  // A custom widget still wins — projects may override a built-in on purpose —
  // but the swap used to be silent, and a page that reads as
  // `"type": "PageTitle"` then renders something else entirely. Built-in
  // widgets are themselves part of that built-in set, so they never shadow
  // anything.
  if (entry.origin !== 'builtin' && BUILTIN_WIDGET_TYPES.has(entry.name)) {
    console.warn(
      `[NEXTHMI] Custom widget "${entry.key}" shadows the built-in "${entry.name}". ` +
        `Every "${entry.name}" node in this project renders the custom widget. ` +
        `Rename the folder to keep the built-in.`,
    );
  }

  // Registration is manifest-driven, so a widget whose exports the compiler
  // could not read registers with nothing but the visibility fields: it renders
  // fine while the editor shows no properties and no `$widgetProp` exports for
  // it. Say so — the symptom alone reads as "the schema was never written".
  if (entry.schemaError) {
    console.warn(
      `[NEXTHMI] Custom widget "${entry.key}" registered without its schema — ` +
        `the editor offers no property fields for it. ${entry.schemaError}`,
    );
  }

  // buildTs doubles as a cache-buster so the browser picks up a recompiled
  // module, and as the identity of this build: a recompile calls back in here
  // with a new stamp, which mints a fresh lazy() rather than reusing the
  // already-resolved old module.
  // Compiled widget modules read window.__nextHMI__.Recharts synchronously at
  // module-eval time, so it must be populated before the import resolves (see
  // rechartsLoader.ts; a no-op in manager mode, which never gets here). Waiting
  // unconditionally would pull the chart library into first paint for every
  // widget, so skip it when the build told us this module never mentions it.
  // Project widgets carry no such flag and keep waiting, as before.
  const needsRecharts = entry.usesRecharts !== false;
  // One memoised load per registration, shared by the `lazy()` below and by
  // `prefetchWidgetModules`. Re-registering (a recompile, with a new buildTs)
  // mints a fresh one, so the previous build's "already loaded" mark goes with
  // it — `memoiseModuleLoader` clears it.
  registerWidgetModule(
    entry.name,
    async () => {
      if (needsRecharts) await ensureRecharts();
      // Both halves of the widget, under one "loaded". The stylesheet used to
      // be injected by the widget's own mount, i.e. after the gate had
      // revealed the page and the widget had painted — on a slow machine,
      // visibly unstyled first. Folding it in here makes every reader of this
      // record cover it: the page gate, the boot warm-up, and the `lazy()`
      // below, which is what catches the widgets that mount after the reveal
      // (WindowedContent scrolling one in, a `visible` gate opening, a
      // recompile remounting one).
      const [mod] = await Promise.all([
        loadWidgetModule(getWidgetJsPath(entry)),
        entry.hasStyle ? adoptWidgetStylesheet(entry) : undefined,
      ]);
      if (!mod?.default) {
        throw new Error(`custom widget "${entry.key}" has no default export`);
      }
      return mod.default as ComponentType<HmiWidgetProps>;
    },
    needsRecharts,
  );
  const load = widgetModules.get(entry.name)!.load;
  const LazyComp = lazy(async () => ({ default: await load() })) as ComponentType<HmiWidgetProps>;

  if (entry.hostsChildren) declaredHostTypes.add(entry.name);
  else declaredHostTypes.delete(entry.name);
  setFlowsChildren(entry.name, entry.flowsChildren === true);

  function CustomWidgetEntry(props: HmiWidgetProps) {
    // Always its own silent boundary, wherever the widget sits. The page gate
    // (PageGroupPageView) prefetches a page's modules before revealing it, so
    // this normally never shows; what it covers is every load that starts
    // *after* the reveal — a widget the prefetch could not see (a component
    // definition the store had not loaded yet), one whose first load rejected,
    // one mounted later by a `visible` gate opening or WindowedContent
    // scrolling it in, and the fresh `lazy` a `widget_updated` recompile mints
    // under already-mounted instances. Letting any of those escalate to the
    // content-area boundary would blank the whole page body — header, content
    // and footer — to redraw one widget.
    return (
      <Suspense fallback={null}>
        <LazyComp {...props} />
      </Suspense>
    );
  }
  CustomWidgetEntry.displayName = entry.name;

  widgetRegistry[entry.name] = {
    name:
      typeof entry.displayName === 'string' && entry.displayName.trim()
        ? entry.displayName.trim()
        : entry.name,
    component: CustomWidgetEntry,
    schema: { ...(entry.schema ?? {}), ...VISIBILITY_SCHEMA },
    exportedProperties: entry.exportedProperties ?? undefined,
    category:
      typeof entry.category === 'string' && entry.category.trim()
        ? entry.category.trim()
        : (entry.group ?? DEFAULT_WIDGET_CATEGORY),
    description: typeof entry.description === 'string' ? entry.description : undefined,
    icon: isIconValue(entry.icon) ? entry.icon : undefined,
  };
}

// ── Module prefetch ───────────────────────────────────────────────────────────
// Every widget type is a `lazy()` that starts its import on first render, so a
// page revealed the moment its config and variables land still has none of its
// widget code in memory: it paints as an empty shell and grows as N module
// round-trips return. The page gate (PageGroupPageView) therefore waits on the
// modules too, and later navigations find them already there: the operator
// runtime warms every module its project uses once the first page has settled
// (`warmWidgetModules`), the editor preview warms the built-ins.

// Memo for the top-level walk. The page gate asks the same question two or
// three times per visit (a synchronous check, the prefetch, then a re-check on
// each render until it latches) and the walk descends into every referenced
// component definition, so the answer is worth keeping.
//
// Stamped with both component-store slices, not just the tree: a definition
// that arrives after the first walk changes what a `$component:` instance
// draws, and both slices are replaced wholesale on any edit, so an identity
// check is enough to notice.
interface TypeWalkMemo {
  components: unknown;
  draftComponents: unknown;
  types: Set<string>;
}
const typeWalkMemo = new WeakMap<object, TypeWalkMemo>();

/**
 * Widget types this tree renders — descending through `children` AND into the
 * definitions of `$component:` instances, whose widgets live in the component
 * store rather than on the instance node.
 */
export function collectWidgetTypes(roots: WidgetConfig[]): Set<string> {
  const store = useComponentStore.getState();
  const cached = typeWalkMemo.get(roots);
  if (
    cached &&
    cached.components === store.components &&
    cached.draftComponents === store.draftComponents
  ) {
    return cached.types;
  }
  const types = walkWidgetTypes(roots, new Set(), new Set());
  typeWalkMemo.set(roots, {
    components: store.components,
    draftComponents: store.draftComponents,
    types,
  });
  return types;
}

function walkWidgetTypes(
  roots: WidgetConfig[],
  out: Set<string>,
  seenComponents: Set<string>,
): Set<string> {
  for (const node of roots) {
    if (typeof node.type !== 'string') continue;
    out.add(node.type);
    const kids = node.children as WidgetConfig[] | undefined;
    if (kids) walkWidgetTypes(kids, out, seenComponents);
    if (node.type.startsWith(COMPONENT_TYPE_PREFIX)) {
      const name = node.type.slice(COMPONENT_TYPE_PREFIX.length);
      if (seenComponents.has(name)) continue;
      seenComponents.add(name);
      const definition = componentChildren(name);
      if (definition) walkWidgetTypes(definition, out, seenComponents);
    }
  }
  return out;
}

/** True when every module this tree needs is in memory — i.e. rendering it now
 *  suspends nothing. An unregistered type has no module to wait for. */
export function widgetModulesLoaded(roots: WidgetConfig[]): boolean {
  for (const type of collectWidgetTypes(roots)) {
    if (!moduleLoaded(type)) return false;
  }
  return true;
}

/** Start every module this tree needs, resolving once they have all settled. A
 *  module that fails to load resolves too — the caller is a reveal gate, and a
 *  broken widget must not hold the page behind a spinner. */
export function prefetchWidgetModules(roots: WidgetConfig[]): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const type of collectWidgetTypes(roots)) {
    const mod = widgetModuleFor(type);
    if (mod) pending.push(mod.load());
  }
  return Promise.allSettled(pending).then(() => undefined);
}

/**
 * Warm the product's built-in widget modules — small static files served from
 * /builtin-widgets-js/ — during the boot splash, so a navigation later in the
 * session finds them in memory instead of paying a round-trip per type at the
 * page gate.
 *
 * The chart widgets are left out on purpose: their modules pull the chart
 * library (see `needsRecharts`), which is exactly the cost the lazy registry
 * exists to keep off a project that never draws a chart. A page holding one
 * still prefetches it through `prefetchWidgetModules`.
 */
export function prefetchBuiltinWidgetModules(): Promise<void> {
  const pending: Promise<unknown>[] = [widgetModuleFor(COMPONENT_TYPE_PREFIX)!.load()];
  for (const type of BUILTIN_WIDGET_TYPES) {
    const mod = widgetModules.get(type);
    // The registration's own flag, not the manifest's: a project widget may
    // shadow a built-in name, and it is that module we would be fetching.
    if (mod && !mod.usesRecharts) pending.push(mod.load());
  }
  return Promise.allSettled(pending).then(() => undefined);
}

type IdleHandle = { cancel: () => void };

function whenIdle(fn: () => void): IdleHandle {
  if (typeof requestIdleCallback !== 'function') {
    const t = setTimeout(fn, 50);
    return { cancel: () => clearTimeout(t) };
  }
  const h = requestIdleCallback(fn, { timeout: 2000 });
  return { cancel: () => cancelIdleCallback(h) };
}

/**
 * Warm every module these trees need, one per idle period, so the first visit
 * to a page finds its widget code already in memory. Returns a cancel.
 *
 * Unlike `prefetchBuiltinWidgetModules` this covers exactly what the trees
 * render: project widgets (and the external libraries their imports pull in)
 * and chart widgets included, built-ins the project never places left out.
 * One at a time, because it runs while the operator is already using the
 * page, and a burst would queue their own requests behind it.
 */
export function warmWidgetModules(roots: WidgetConfig[]): () => void {
  const queue = [...collectWidgetTypes(roots)]
    .map((type) => widgetModuleFor(type))
    .filter((mod): mod is WidgetModuleEntry => mod !== undefined && !mod.loaded);
  let cancelled = false;
  let handle: IdleHandle | null = null;
  const next = () => {
    const mod = queue.shift();
    if (cancelled || !mod) return;
    void mod
      .load()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) handle = whenIdle(next);
      });
  };
  handle = whenIdle(next);
  return () => {
    cancelled = true;
    handle?.cancel();
  };
}

/**
 * Fold the manifest's editor half back onto the built-in entries registered
 * above.
 *
 * Called at module eval from `builtinWidgetsEditorMetadata.ts`, which only
 * `src/config/` imports — so this runs before any editor surface renders, and
 * never runs at all on an HMI route. Nothing here is async: the palette's
 * first paint already has the descriptions and icons.
 *
 * The visibility fields are skipped, and a field is *replaced* rather than
 * mutated in place. `VISIBILITY_SCHEMA` wins over a widget's own declaration in
 * `registerCustomWidget` and is one shared object spread into every entry, so
 * layering onto those two would both undo that precedence and write through to
 * every other widget.
 */
export function applyBuiltinWidgetsEditorMetadata(
  byKey: Record<string, BuiltinWidgetEditorEntry>,
): void {
  for (const row of BUILTIN_WIDGETS_MANIFEST) {
    const half = byKey[row.key];
    const entry = half && widgetRegistry[row.name];
    if (!half || !entry) continue;
    if (typeof half.description === 'string') entry.description = half.description;
    if (isIconValue(half.icon)) entry.icon = half.icon;
    if (half.exportedProperties) entry.exportedProperties = half.exportedProperties;
    for (const [key, extra] of Object.entries(half.schema ?? {})) {
      const field = entry.schema[key];
      if (field && !(key in VISIBILITY_SCHEMA)) entry.schema[key] = { ...field, ...extra };
    }
  }
}

let _loadPromise: Promise<void> | null = null;

export function loadCustomWidgets(): Promise<void> {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const list = await apiJson<CustomWidgetManifestEntry[]>('/api/widgets');
      for (const entry of list) registerCustomWidget(entry);
    } catch (err) {
      console.error('[NEXTHMI] Could not reach /api/widgets:', err);
    }
  })();
  return _loadPromise;
}

// ── Widget registration ───────────────────────────────────────────────────────

let _componentLoadPromise: Promise<void> | null = null;

/**
 * Register all reusable components as widget registry entries.
 * Each component gets a separate entry under the key "$component:{id}" with
 * a schema derived from its declared component properties.
 *
 * Called once at app startup (via loadComponents) and again whenever the
 * component store changes (via the App.tsx subscriber).
 */
export function loadComponents(): Promise<void> {
  if (_componentLoadPromise) return _componentLoadPromise;
  // Delegate to the store — it is the single fetch authority for /api/components.
  // After loading, register all components in the widget registry.
  _componentLoadPromise = useComponentStore
    .getState()
    .load()
    .then(() => registerComponents(useComponentStore.getState().components));
  return _componentLoadPromise;
}

export function registerComponents(components: ComponentDefinition[]): void {
  // Remove stale component entries.
  for (const key of Object.keys(widgetRegistry)) {
    if (key.startsWith('$component:')) {
      delete widgetRegistry[key];
    }
  }

  for (const component of components) {
    const slots = collectSlotKeys(component.children as WidgetConfig[]);
    const schema: Record<string, SchemaField> = {};
    for (const [k, p] of Object.entries(component.componentProperties)) {
      // A `widgets` property is the declared name of a slot. Until a
      // `ComponentSlot` picks it there is nowhere to put the content, so the
      // panel row would edit a hole — the row appears by itself once the
      // definition names it, since a component-store change re-registers.
      if (primaryType(p.type).toLowerCase() === 'widgets' && !slots.includes(k)) continue;
      schema[k] = componentPropertyToSchemaField(p);
    }

    // Import is deferred to avoid circular imports during module evaluation.
    // ComponentRenderer is the shared component for all user-defined component types.
    widgetRegistry[`$component:${component.id}`] = {
      name: component.name,
      component: makeComponentEntry(component.id),
      schema,
      category: component.category?.trim() || DEFAULT_COMPONENT_CATEGORY,
      description: component.description ?? undefined,
      icon: component.icon ?? undefined,
      slots,
    };
  }
}

/** Creates a wrapper component that injects _componentId into ComponentRenderer. */
function makeComponentEntry(componentId: string): ComponentType<HmiWidgetProps> {
  const Loader = makeStableComponentInstance(componentId);
  Loader.displayName = `Component(${componentId})`;
  return Loader;
}

// Map of componentId -> stable function component so React hooks don't remount.
const _componentCache: Record<string, ComponentType<HmiWidgetProps>> = {};

function makeStableComponentInstance(componentId: string): ComponentType<HmiWidgetProps> {
  if (_componentCache[componentId]) return _componentCache[componentId];

  function ComponentInstance(props: HmiWidgetProps) {
    const selfBoundary = useComponentSelfSuspense();
    const instance = <LazyComponentRenderer {...props} _widgetId={componentId} />;
    // Chrome pops in silently via its own boundary. Page content sets
    // the context to false so the load surfaces on the content-area spinner
    // (see PageGroupPageView) instead of a placeholder per component.
    return selfBoundary ? <Suspense fallback={null}>{instance}</Suspense> : instance;
  }

  ComponentInstance.displayName = `Component(${componentId})`;
  _componentCache[componentId] = ComponentInstance;
  return ComponentInstance;
}
