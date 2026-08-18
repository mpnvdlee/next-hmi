/**
 * Component Property — declarative schema for a parameter that a widget or dialog
 * accepts from its caller. Resolved at runtime via `{ $componentProp: "key" }`.
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
 * Schema definition for a single component property declared by a widget or dialog.
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
};

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
  { value: 'struct', label: 'Struct' },
  { value: 'actions', label: 'Actions' },
  { value: 'widgets', label: 'Widget slot' },
];

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
  const { structSchema, ...rest } = prop;
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
  // `select` is authoring sugar for a string with a dropdown editor; normalise it
  // to the canonical base-type + format so source rules follow the base type.
  if (field.type === 'select') {
    field.type = 'string';
    field.format = 'select';
  }
  return field;
}

/**
 * Rename references to a component-property key in a widget/dialog subtree.
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
