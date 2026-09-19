/**
 * Component Property — declarative schema for a parameter that a component, page
 * or page group accepts from its caller. Resolved at runtime via `{ $componentProp: "key" }`.
 */

import type { SchemaField } from './widgetSchema';

/**
 * A node in the visual struct-schema tree editor.
 * Stored under `ComponentPropertySchema.structSchema` for struct-type properties;
 * converted to `requiredFields` by `componentPropertyToSchemaField()` for the binding picker.
 */
export interface StructSchemaNode {
  kind: 'variable' | 'folder' | 'array';
  name: string;
  /** Simple datatype (variable / array rows) */
  type?: string;
  /** Whether the field requires write access (variable rows) */
  write?: boolean;
  /** Child nodes (folder rows) */
  children?: StructSchemaNode[];
}

/**
 * Schema definition for a single component property declared by a component, page
 * or page group.
 *
 * Mirrors `SchemaField` minus the component-only fields (`event`, `visibleWhen`)
 * and `requiredFields` — for component properties, the rich `structSchema` tree is
 * the source of truth and `requiredFields` is derived from it on the fly by
 * `componentPropertyToSchemaField()`.
 */
export type ComponentPropertySchema = Omit<
  SchemaField,
  'event' | 'visibleWhen' | 'requiredFields'
> & {
  /** Rich tree definition for struct-type properties, edited via StructSchemaModal. */
  structSchema?: StructSchemaNode[];
  /** For a `select` property: what its options hold. Absent reads as `string`,
   *  which is what every select stored before the others existed. */
  optionType?: ComponentPropertyOptionType;
};

/** The value kinds a `select` property's options may hold. `loc` is a string
 *  whose options are translations rather than literals. */
export type ComponentPropertyOptionType = 'string' | 'integer' | 'float' | 'boolean' | 'loc';

/** Base type each option kind resolves to — what source rules and the binding
 *  picker follow once the editor-only `select` wrapper is gone. */
const OPTION_TYPE_BASE: Record<ComponentPropertyOptionType, string> = {
  string: 'string',
  integer: 'integer',
  float: 'float',
  boolean: 'boolean',
  loc: 'string',
};

/** What an option of each kind holds before anything is filled in. A list that
 *  changes kind empties its rows to these, and a freshly added row starts on
 *  one: `loc` has no blank literal at all — a translation is picked or absent. */
export const OPTION_TYPE_EMPTY_VALUE: Record<
  ComponentPropertyOptionType,
  string | number | boolean | undefined
> = {
  string: '',
  integer: 0,
  float: 0,
  boolean: false,
  loc: undefined,
};

export const OPTION_TYPE_OPTIONS: { value: ComponentPropertyOptionType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'integer', label: 'Integer' },
  { value: 'float', label: 'Float' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'loc', label: 'Localisable text' },
];

export const VALUE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'integer', label: 'Integer' },
  { value: 'float', label: 'Float' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'datetime', label: 'DateTime' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'duration', label: 'Duration' },
  { value: 'color', label: 'Color' },
  { value: 'select', label: 'Select (enum)' },
  { value: 'icon', label: 'Icon' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
  { value: 'struct', label: 'Struct' },
  { value: 'actions', label: 'Actions' },
  { value: 'widgets', label: 'Widget slot' },
];

/** Property types that never resolve to a single literal value, so they take
 *  neither a write flag nor a default. */
export const VALUELESS_PROPERTY_TYPES = new Set(['struct', 'actions', 'widgets']);

/**
 * Recursively convert a StructSchemaNode tree to the RequiredFieldEntry array
 * expected by SchemaField.requiredFields (and read by VariableBindingPicker).
 */
function structSchemaToRequiredFields(nodes: StructSchemaNode[]): SchemaField['requiredFields'] {
  return nodes.map((node) => {
    if (node.kind === 'folder') {
      return {
        name: node.name,
        requiredFields: node.children?.length
          ? (structSchemaToRequiredFields(node.children) as { name: string }[])
          : [],
      };
    }
    const entry: Record<string, unknown> = { name: node.name };
    if (node.type) entry.type = node.type;
    if (node.write) entry.write = true;
    return entry as { name: string };
  });
}

/** Convert a ComponentPropertySchema to a SchemaField for the component registry / editors. */
export function componentPropertyToSchemaField(prop: ComponentPropertySchema): SchemaField {
  const { structSchema, optionType, ...rest } = prop;
  // A widgets property resolves to no value at all — its content is the
  // instance's own children. Anything hand-edited onto it (a default, a write
  // flag) would otherwise reach `withDeclaredDefaults` and be injected as the
  // value of a property nothing can read.
  if (rest.type === 'widgets') {
    return { type: rest.type, label: rest.label, description: rest.description, group: rest.group };
  }
  const field: SchemaField = {
    ...rest,
    requiredFields: structSchema?.length ? structSchemaToRequiredFields(structSchema) : undefined,
  };
  // `select` is authoring sugar for a dropdown editor over an ordinary value;
  // normalise it to the canonical base-type + format so source rules follow the
  // base type rather than the editor control.
  if (field.type === 'select') {
    field.type = OPTION_TYPE_BASE[optionType ?? 'string'] ?? 'string';
    field.format = 'select';
  }
  return field;
}

/**
 * Rename references to a component-property key in a widget subtree.
 * Slash paths retain their suffix: `motor/speed` becomes `machine/speed`.
 */
export function renameComponentPropertyReferences<T>(value: T, oldKey: string, newKey: string): T {
  if (Array.isArray(value)) {
    return value.map((item) => renameComponentPropertyReferences(item, oldKey, newKey)) as T;
  }
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const componentProp = record.$componentProp;
  const nextComponentProp =
    typeof componentProp === 'string' &&
    (componentProp === oldKey || componentProp.startsWith(`${oldKey}/`))
      ? `${newKey}${componentProp.slice(oldKey.length)}`
      : componentProp;
  const next = Object.fromEntries(
    Object.entries(record).map(([key, child]) => [
      key,
      key === '$componentProp'
        ? nextComponentProp
        : renameComponentPropertyReferences(child, oldKey, newKey),
    ]),
  );
  return next as T;
}
