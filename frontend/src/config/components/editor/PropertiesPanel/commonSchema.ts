import { widgetRegistry } from '@hmi/registry/widgetRegistry';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { WidgetConfig } from '@shared/types/config';
import { acceptedValueTypes, primaryType } from '@shared/utils/valueTypes';

/**
 * The properties a multi-selection can be edited through: every selected widget
 * declares the key, and declares it compatibly enough that one write is valid for
 * all of them.
 *
 * Shared by the page editor's `MultiComponentPanel` and the component editor's
 * `CompositionMultiWidgetPanel`.
 */

/**
 * List editors whose value is a whole collection. Applying one list to N widgets is
 * either meaningless (`child-positions` names the parent's own children) or
 * destructive (it replaces each widget's list wholesale), so they are left to
 * single selection.
 */
const MULTI_EXCLUDED_TYPES = new Set([
  'image-indicators',
  'child-positions',
  'menu-items',
  'actions',
  'option-list',
  'groups',
  'page-group',
  'slot',
  'widgets',
]);

export interface CommonSchema {
  /** Keys every widget declares compatibly, in the lead widget's own order. */
  keys: string[];
  /** The field to render per key — the lead widget's, since labels and defaults
   *  are presentation and only the lead's are shown. */
  schema: Record<string, SchemaField>;
}

/** Small literal objects only — enough to compare options, requiredFields, visibleWhen. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameTypeSet(a: SchemaField['type'], b: SchemaField['type']): boolean {
  if (primaryType(a).toLowerCase() !== primaryType(b).toLowerCase()) return false;
  const toSorted = (t: SchemaField['type']) =>
    [...acceptedValueTypes(t)].map((v) => v.toLowerCase()).sort();
  return sameJson(toSorted(a), toSorted(b));
}

/**
 * Whether one write can serve both fields. What changes the control, the legal value
 * space, or when the row applies at all is compared — label, description, group,
 * placeholder and the defaults are presentation, and the lead's win.
 *
 * `visibleWhen` has to be compared because the panel decides a row's visibility by
 * evaluating the *lead's* condition against every selected widget: two widgets that
 * reveal the key under different conditions would then be offered a row one of them
 * hides, and the write would land on a property that widget ignores.
 */
export function schemaFieldsCompatible(a: SchemaField, b: SchemaField): boolean {
  if (!sameTypeSet(a.type, b.type)) return false;
  if (a.format !== b.format) return false;
  if (a.event !== b.event) return false;
  if (a.write !== b.write) return false;
  if (a.min !== b.min || a.max !== b.max || a.step !== b.step) return false;
  if (!sameJson(a.requiredFields, b.requiredFields)) return false;
  if (!sameJson(a.visibleWhen, b.visibleWhen)) return false;
  // Option labels are cosmetic, but writing a value another widget does not
  // accept is a real bug — so compare the values, in order.
  const optionsMatter = a.format === 'select' || a.display !== undefined;
  if (optionsMatter && !sameJson(a.options?.map(optionValue), b.options?.map(optionValue))) {
    return false;
  }
  return true;
}

function optionValue(option: unknown): unknown {
  return option !== null && typeof option === 'object' && 'value' in option
    ? (option as { value: unknown }).value
    : option;
}

export function commonSchemaOf(comps: WidgetConfig[]): CommonSchema {
  const [lead, ...rest] = comps;
  const leadSchema = (lead && widgetRegistry[lead.type]?.schema) ?? {};
  const others = rest.map((comp) => widgetRegistry[comp.type]?.schema ?? {});

  const keys: string[] = [];
  const schema: Record<string, SchemaField> = {};
  // All one type is the common case (six buttons); nothing to intersect.
  const uniform = others.every((s) => s === leadSchema);

  for (const [key, field] of Object.entries(leadSchema)) {
    if (MULTI_EXCLUDED_TYPES.has(primaryType(field.type).toLowerCase())) continue;
    if (!uniform && !others.every((s) => s[key] && schemaFieldsCompatible(field, s[key]))) continue;
    keys.push(key);
    schema[key] = field;
  }

  return { keys, schema };
}
