/**
 * Widget registry — maps type id to canonical catalog metadata, renderer, and schema.
 *
 * Built-in components are eagerly imported at module load.
 * Custom components from the live project's custom-widgets/ folder are loaded lazily via
 * loadCustomWidgets(), called once at app startup.
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
  StdlibEditorEntry,
} from '@shared/types/widgetSchema';

export type { CustomWidgetManifestEntry };
import type { ComponentDefinition } from '@shared/types/componentTypes';
import { wrapComponentWithStylesheet } from '@shared/hooks/useWidgetStylesheet';
import { getWidgetJsPath } from '@shared/utils/widgetPaths';
import { loadWidgetModule } from '@shared/utils/widgetModuleLoader';
import { componentPropertyToSchemaField } from '@shared/types/componentProperty';
import { useComponentStore } from '@shared/store/componentStore';
import { apiJson } from '@shared/utils/api';
import { isIconValue } from '@shared/utils/iconValue';
import { primaryType } from '@shared/utils/valueTypes';
import { ensureRecharts } from '@shared/utils/rechartsLoader';
// Product stdlib widgets: authored against the same SDK contract as a project's
// custom widgets, but compiled at build time (`npm run build:stdlib`). The
// manifest is imported statically rather than fetched so schemas and categories
// are present at module eval — that is what keeps this registry synchronous and
// the editor palette populated at first paint. Only the component modules load
// lazily, from /stdlib-js/.
//
// This is the manifest's *runtime* half: the registration fields, plus each
// schema field's `type` and `requiredFields`, which is all `useBindingStatus`
// needs to raise the disconnected/disabled overlay. Labels, options, defaults,
// descriptions and icons live in the `.editor.json` sibling, which only
// `stdlibEditorMetadata.ts` imports — from `src/config/`, so an HMI route never
// carries them. Every route reaches this module, so a byte here is a byte on
// every page.
import stdlibManifest from '../../generated/stdlibManifest.json';

// Deferred to break the circular import:
//   widgetRegistry → ComponentRenderer → WidgetRenderer → widgetRegistry
// React.lazy handles the Promise correctly and re-renders when ready.
const LazyComponentRenderer = lazy(
  () => import('../components/ComponentRenderer'),
) as ComponentType<HmiWidgetProps & { _widgetId: string }>;

// ── Built-in components ────────────────────────────────────────────────────────
import ComponentSlot from '../components/ComponentSlot';
import { collectSlotKeys } from '../components/ComponentSlot/slotKey';
import ImageContainer from '../components/ImageContainer';
import NavigationMenu from '../components/NavigationMenu';

// ── Shared schema fragments ───────────────────────────────────────────────────

// Standard visibility gate present on every widget. Both fields are plain
// booleans, expression-capable — switch either to the `$userGroups` source to
// gate by user group (empty group list = everyone), or nest `$if` etc.
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

// ── Registry (mutable — custom components are added at runtime) ───────────────
export const widgetRegistry: Record<string, RegistryEntry> = {
  ComponentSlot: {
    name: 'Component Slot',
    category: 'Layout & structure',
    description:
      'Marks where content the caller supplies is rendered. Put one in a reusable component and instances of it gain a named slot — in the widget tree, and in the properties panel when a "Widget slot" property names it.',
    icon: { type: 'builtin', name: 'frame-corners' },
    component: ComponentSlot,
    schema: {
      slot: {
        type: 'slot',
        label: 'Slot name',
        // Literal, not DEFAULT_SLOT_KEY: the widget-schema extractor only
        // inlines const literals declared in this file.
        placeholder: 'content',
        description:
          'Names this slot — pick one of the component\'s "Widget slot" properties. Instances get that property as a row in their properties panel, and the widgets put there render here.',
      },
      ...VISIBILITY_SCHEMA,
    },
  },

  ImageContainer: {
    name: 'Image Container',
    category: 'Layout & structure',
    description:
      'Places children at absolute spots over a background image. Collapses below a set width.',
    icon: { type: 'builtin', name: 'frame-corners' },
    component: ImageContainer,
    schema: {
      src: { type: 'image', label: 'Image', group: 'Image' },
      alt: { type: 'String', label: 'Alt text', group: 'Image' },
      fit: {
        type: 'String',
        format: 'select',
        label: 'Fit',
        group: 'Image',
        defaultValue: 'contain',
        options: [
          { label: 'Contain', value: 'contain' },
          { label: 'Cover', value: 'cover' },
          { label: 'Fill', value: 'fill' },
          { label: 'None', value: 'none' },
          { label: 'Scale down', value: 'scale-down' },
        ],
      },
      collapseBelow: {
        type: 'Integer',
        label: 'Collapse below (px)',
        group: 'Responsive',
        description:
          'Below this width the image drops out and children stack in normal flow. 0 never collapses.',
        defaultValue: 0,
        min: 0,
        max: 4096,
        step: 1,
      },
      childPositions: { type: 'child-positions', label: 'Child placement', group: 'Children' },
      ...VISIBILITY_SCHEMA,
    },
  },

  NavigationMenu: {
    name: 'Navigation Menu',
    category: 'Navigation',
    description: 'Sidebar or top-bar menu mirroring the page tree, with rich display options.',
    icon: { type: 'builtin', name: 'sidebar-simple' },
    component: NavigationMenu,
    schema: {
      mode: {
        type: 'String',
        format: 'select',
        label: 'Mode',
        group: 'Source',
        defaultValue: 'auto',
        options: [
          { label: 'Auto (mirror page tree)', value: 'auto' },
          { label: 'Manual (item list)', value: 'manual' },
        ],
      },
      items: {
        type: 'menu-items',
        label: 'Items',
        group: 'Source',
        description: 'The entries the menu shows, in order. Manual mode only.',
        visibleWhen: { property: 'mode', equals: 'manual' },
      },
      orientation: {
        type: 'String',
        format: 'select',
        label: 'Orientation',
        group: 'Layout',
        defaultValue: 'vertical',
        options: [
          { label: 'Vertical (sidebar)', value: 'vertical' },
          { label: 'Horizontal (top-bar)', value: 'horizontal' },
        ],
      },
      display: {
        type: 'String',
        format: 'select',
        label: 'Display',
        group: 'Appearance',
        defaultValue: 'icon-label',
        options: [
          { label: 'Icon + label', value: 'icon-label' },
          { label: 'Icon only', value: 'icon-only' },
          { label: 'Label only', value: 'label-only' },
        ],
      },
      hierarchy: {
        type: 'String',
        format: 'select',
        label: 'Hierarchy',
        group: 'Source',
        defaultValue: 'tree',
        options: [
          { label: 'Tree (groups expandable)', value: 'tree' },
          { label: 'Flat (all groups flattened)', value: 'flat' },
        ],
      },
      submenuMode: {
        type: 'String',
        format: 'select',
        label: 'Submenu mode',
        group: 'Layout',
        defaultValue: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Flyout (overlay)', value: 'flyout' },
          { label: 'Inline-expand (push siblings)', value: 'inline-expand' },
        ],
      },
      iconStrategy: {
        type: 'String',
        format: 'select',
        label: 'Icon strategy',
        group: 'Appearance',
        defaultValue: 'first-letter',
        options: [
          { label: 'Configured icon', value: 'configured' },
          { label: 'First letter', value: 'first-letter' },
          { label: 'None', value: 'none' },
        ],
      },
      activeStyle: {
        type: 'String',
        format: 'select',
        label: 'Active style',
        group: 'Appearance',
        defaultValue: 'left-border',
        options: [
          { label: 'Left border', value: 'left-border' },
          { label: 'Background', value: 'background' },
          { label: 'Underline', value: 'underline' },
        ],
      },
      groupExpansion: {
        type: 'String',
        format: 'select',
        label: 'Group expansion',
        group: 'Behaviour',
        defaultValue: 'auto',
        options: [
          { label: 'Auto (expand active branch)', value: 'auto' },
          { label: 'All expanded', value: 'all-expanded' },
          { label: 'All collapsed', value: 'all-collapsed' },
          { label: 'Remember (persist per browser)', value: 'remember' },
        ],
      },
      showSearch: {
        type: 'Boolean',
        format: 'show',
        label: 'Show search',
        defaultValue: false,
        group: 'Behaviour',
      },
      collapsed: {
        type: 'Boolean',
        format: 'collapse',
        label: 'Collapsed',
        group: 'Layout',
        defaultValue: false,
      },
      ...VISIBILITY_SCHEMA,
    },
  },
};

// Through `unknown`: TypeScript infers the JSON as a union of per-widget object
// literals whose `schema` shapes differ, so it never structurally matches the
// entry type. stdlibManifest.test.ts is the guard that the file really has this
// shape — it is generated by the build, not hand-written.
/** Types that declared `hostsChildren` on their manifest row. Mutable: project
 *  widgets register after boot, and a recompile re-registers. */
const declaredHostTypes = new Set<string>();

const STDLIB_WIDGETS = stdlibManifest as unknown as CustomWidgetManifestEntry[];

// ── Built-in type set (used by editor to separate built-in from custom in menus) ───
// "Built-in" means product-shipped, whichever half of the product it comes from:
// the entries compiled into this bundle above, plus the stdlib widgets compiled
// at build time. A *project's* custom widgets are the ones this set excludes.
export const BUILTIN_WIDGET_TYPES: ReadonlySet<string> = new Set([
  ...Object.keys(widgetRegistry),
  ...STDLIB_WIDGETS.map((entry) => entry.name),
]);

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
// makeComponentOfType) must see the stdlib on the first render. `registerCustomWidget`
// is a hoisted function declaration, and every const it closes over is defined above.
for (const entry of STDLIB_WIDGETS) registerCustomWidget(entry);

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
 *  Compiled-in hosts are listed here; a manifest-registered widget declares it
 *  instead, with `export const hostsChildren = true`. That declaration is what
 *  lets the stdlib's Container host children, and it is open to project widgets
 *  on the same terms. */
const CONTAINER_HOST_TYPES: ReadonlySet<string> = new Set(['ImageContainer']);

export function isContainerHostType(type: string): boolean {
  return (
    CONTAINER_HOST_TYPES.has(type) || declaredHostTypes.has(type) || widgetSlots(type).length > 0
  );
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
// The stylesheet is injected into <head> when the component first mounts and
// removed when the last instance unmounts (reference-counted via useStylesheet).

/** Build the registry entry for one manifest row, deferring its module. */
export function registerCustomWidget(entry: CustomWidgetManifestEntry): void {
  // A custom widget still wins — projects may override a built-in on purpose —
  // but the swap used to be silent, and a page that reads as
  // `"type": "PageTitle"` then renders something else entirely. Stdlib widgets
  // are themselves part of that built-in set, so they never shadow anything.
  if (entry.origin !== 'stdlib' && BUILTIN_WIDGET_TYPES.has(entry.name)) {
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
  const LazyComp = lazy(async () => {
    if (needsRecharts) await ensureRecharts();
    const mod = await loadWidgetModule(getWidgetJsPath(entry));
    if (!mod?.default) {
      throw new Error(`custom widget "${entry.key}" has no default export`);
    }
    return { default: mod.default as ComponentType<HmiWidgetProps> };
  }) as ComponentType<HmiWidgetProps>;

  if (entry.hostsChildren) declaredHostTypes.add(entry.name);
  else declaredHostTypes.delete(entry.name);

  const Wrapped: ComponentType<HmiWidgetProps> = entry.hasStyle
    ? wrapComponentWithStylesheet(LazyComp, entry)
    : LazyComp;

  function CustomWidgetEntry(props: HmiWidgetProps) {
    return (
      <Suspense fallback={null}>
        <Wrapped {...props} />
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

/**
 * Fold the manifest's editor half back onto the stdlib entries registered above.
 *
 * Called at module eval from `stdlibEditorMetadata.ts`, which only `src/config/`
 * imports — so this runs before any editor surface renders, and never runs at
 * all on an HMI route. Nothing here is async: the palette's first paint already
 * has the descriptions and icons.
 *
 * The visibility fields are skipped, and a field is *replaced* rather than
 * mutated in place. `VISIBILITY_SCHEMA` wins over a widget's own declaration in
 * `registerCustomWidget` and is one shared object spread into every entry, so
 * layering onto those two would both undo that precedence and write through to
 * every other widget.
 */
export function applyStdlibEditorMetadata(byKey: Record<string, StdlibEditorEntry>): void {
  for (const row of STDLIB_WIDGETS) {
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
    // Chrome/dialogs pop in silently via their own boundary. Page content sets
    // the context to false so the load surfaces on the content-area spinner
    // (see PageGroupPageView) instead of a placeholder per component.
    return selfBoundary ? <Suspense fallback={null}>{instance}</Suspense> : instance;
  }

  ComponentInstance.displayName = `Component(${componentId})`;
  _componentCache[componentId] = ComponentInstance;
  return ComponentInstance;
}
