import type { ComponentType } from 'react';
import type { HmiWidgetProps, IconValue, VisibilityCondition } from './config';

/** A simple datatype, array, named struct, or editor-only kind. A schema
 *  field's `type` may be one of these or a list of them (first entry drives the
 *  editor control; the rest form the variable-binding filter). */
type SchemaType = string;

/** A required field entry in a struct schema — supports nested struct matching. */
export type RequiredFieldEntry =
  | string
  | {
      name: string;
      write?: boolean;
      /** Simple datatype the field must match (e.g. 'Float', 'Boolean'). */
      type?: SchemaType;
      /** For nested structs: required fields that must exist in the sub-folder. */
      requiredFields?: RequiredFieldEntry[];
    };

export interface SchemaField {
  /** Simple datatype(s) / struct name(s) / editor kind. May be a list for
   *  multi-accept value fields (first entry = editor control, rest = filter). */
  type: SchemaType | SchemaType[];
  label: string;
  /** One line explaining what the property does, rendered between the label and
   *  the field box. For anything the label cannot carry on its own — keep units
   *  in the label (`Size (px)`), put behaviour here. */
  description?: string;
  /** Section this property is filed under in the properties panel. Fields with
   *  no group fall into one "Properties" section, in declaration order — which
   *  is what every schema did before grouping existed. */
  group?: string;
  defaultValue?: unknown;
  min?: number;
  max?: number;
  step?: number;
  /** For 'struct' type: field names that must all be present in the variable's children.
   *  Each entry is either a plain string (read-only) or an object with `write: true`
   *  to indicate the component needs write access to that field.
   *  For nested structs, include `requiredFields` on the entry to match sub-folder shapes.
   *  Example: `['bVisible', { name: 'limits', requiredFields: ['fMin', 'fMax'] }]` */
  requiredFields?: RequiredFieldEntry[];
  /** When true, variable picker only shows writable variables. */
  write?: boolean;
  /** For a `format: 'select'` field: the list of options shown in the dropdown */
  options?: { label: string; value: string | number | boolean; icon?: string }[];
  /** For a `format: 'select'` field: display mode for options (auto | dropdown | button-text | button-icon) */
  display?: 'auto' | 'dropdown' | 'button-text' | 'button-icon';
  /** Hint text shown inside an empty input (string, integer/float, icon, image fields) */
  placeholder?: string;
  /** For a `color` field: the theme token (cssVar, e.g. `--hmi-accent`) an unset
   *  value falls back to in the component's CSS. Editor-only — lets the color
   *  picker show that an untouched color is themed, and which token supplies it. */
  defaultToken?: string;
  /** Optional format refining a base type — a UI-only hint that upgrades the
   *  editor without changing the value's base type (so source rules are still
   *  decided by the base type). Open-ended; recognised values include
   *  `url`, `multiline`, `select`, `password` (string) and `percentage` (float). */
  format?: string;
  /** For 'actions' type: the ActionsConfig event key this field edits (defaults to 'onPress'). */
  event?: string;
  /** Conditional visibility: field only shown when condition(s) pass.
   *  Conditions reference other properties in the same component schema.
   *  All conditions in an array must pass (AND logic). */
  visibleWhen?: VisibilityCondition | VisibilityCondition[];
}

/** A declared field of a `Struct`-typed exported property. */
export interface ExportedStructField {
  name: string;
  /** Simple datatype (e.g. 'String', 'Float', 'DateTime'); shown in the picker. */
  type?: string;
  /** Whether consumers may write the field (drives the access badge). */
  write?: boolean;
}

/** A property that this component exposes for use by $widgetProp in sibling components. */
export interface ExportedProperty {
  key: string; // property key published to widgetPropStore
  label: string; // human-readable label shown in the editor picker
  type?: string; // e.g. 'String', 'Float', 'Boolean'
  /** For a `Struct` export: declared fields with datatypes, so the $widgetProp
   *  picker can show and type-check individual fields. Falls back to the
   *  component's configured column keys (untyped) when omitted. */
  structSchema?: ExportedStructField[];
}

/**
 * One row of `GET /api/widgets` — a custom widget as the backend reports it.
 *
 * Mirrors `backend/api/widgets_api.py::_entry`. The build half comes from the
 * compiler's status file, the catalog half from the compiled schema manifest,
 * which is what lets the editor register, offer and validate a widget without
 * importing its module.
 */
export interface CustomWidgetManifestEntry {
  /** Canonical normalized path relative to custom-widgets/. */
  key: string;
  /** Folder name, which is also the widget type nodes reference. */
  name: string;
  /** Label shown in the palette, tree and property panel. Folder names cannot
   *  carry spaces, so a widget exports this when its type reads badly as a
   *  label ('StretchSpacer' → 'Stretch Spacer'). Falls back to `name`. */
  displayName?: string | null;
  group: string | null;
  hasStyle: boolean;
  hasFonts?: boolean;
  buildOk?: boolean | null;
  buildError?: string | null;
  buildTs?: string | null;
  category?: string | null;
  description?: string | null;
  icon?: unknown;
  schema?: Record<string, SchemaField> | null;
  exportedProperties?: ExportedProperty[] | null;
  /** Set when the widget compiles but its schema/catalog exports could not be
   *  extracted — it renders, but the editor offers no property fields for it. */
  schemaError?: string | null;
  /** Where the compiled module is served from. Absent (or 'project') means the
   *  live project's custom-widgets/, compiled on load and fetched from
   *  /widget-js/. 'stdlib' means a product widget compiled at build time and
   *  fetched from /stdlib-js/. */
  origin?: WidgetOrigin | null;
  /** Declared by `export const hostsChildren = true`: nodes of this type carry
   *  a `children` array and the editor treats them as containers — drop target,
   *  collapse toggle, tree recursion, move target. The component receives the
   *  rendered children as its `children` prop. */
  hostsChildren?: boolean | null;
  /** Whether the compiled module references the Recharts SDK global. Only
   *  those modules need it populated before import, so the chart library stays
   *  out of first paint on pages that have no chart. Baked by the stdlib build;
   *  absent for project widgets, which conservatively always wait. */
  usesRecharts?: boolean | null;
}

export type WidgetOrigin = 'project' | 'stdlib';

/**
 * One stdlib widget's editor-only half of the baked manifest, keyed by the
 * row's `key`.
 *
 * The compiler writes the manifest as two files (see
 * `generate_stdlib_manifest`): a runtime half every route's static-import
 * closure carries, and this half, imported only from `src/config/` so it lands
 * in the editor's chunk. Both are static imports — an editor surface reads a
 * whole `RegistryEntry` on its first render, an HMI page never fetches these
 * bytes at all. A field absent here simply had nothing beyond `type` /
 * `requiredFields` to say.
 */
export interface StdlibEditorEntry {
  description?: string | null;
  icon?: unknown;
  exportedProperties?: ExportedProperty[] | null;
  schema?: Record<string, Partial<SchemaField>> | null;
}

export interface RegistryEntry {
  /** Display name used in selectors, trees, and property panels. */
  name: string;
  component: ComponentType<HmiWidgetProps>;
  schema: Record<string, SchemaField>;
  /** Properties this component exports to sibling components via $widgetProp */
  exportedProperties?: ExportedProperty[];
  /** Functional category shown in widget selectors and add menus. */
  category: string;
  /** One-line summary shown on the app-drawer card. */
  description?: string;
  /** Drawer/tree icon. */
  icon?: IconValue;
  /** For a `$component:` entry: the slot names its definition declares, in tree
   *  order. A non-empty list makes instances host children (see
   *  `isContainerHostType`), one group per slot. */
  slots?: string[];
}
