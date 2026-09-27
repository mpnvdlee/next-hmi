/**
 * Property-source defaults and validation.
 *
 * Each value type has a fixed set of allowed property sources, decided by the
 * field's type alone.
 */

import {
  PROPERTY_SOURCES,
  PROPERTY_SOURCE_KEYS,
  SCALAR_FIELD_TYPES,
  isPropertySourceKey,
  producedFits,
} from './propertySourceRegistry';
import type { PropertySourceKey } from './propertySourceRegistry';
import { isStructType } from '@shared/utils/valueTypes';

export { PROPERTY_SOURCE_KEYS };

// A source is offered on a scalar field when one of the types it *produces*
// fits the field's family (`producedFits`) — there is no hand-maintained
// per-field allowlist; the matrix below is derived from each source's
// `produces`. A source with an inner `field` selector produces what its
// choices do (`SOURCE_FIELD_PRODUCES`), so it is offered where one of them fits.

// Scope-injected sources: availability is decided by ambient editor scope
// (component-property scope / action-result handler), not by the field's type,
// so they are added by PropertySourceSelector — never by the type matrix.
export const SCOPE_SOURCES = new Set<PropertySourceKey>([
  '$componentProp',
  '$result',
  '$repeatItem',
]);

/** Sources offered on a scalar field, derived from each source's produced type(s). */
function deriveScalarSources(fieldType: string): PropertySourceKey[] {
  return PROPERTY_SOURCE_KEYS.filter((key) => {
    if (SCOPE_SOURCES.has(key)) return false;
    const source = key === '$static' ? 'static' : key;
    return PROPERTY_SOURCES[source].produces.some((p) => producedFits(p, fieldType));
  });
}

// Editor-kind fields (color/icon/image/option-list) are not plain scalar types
// and their offered sources are curated explicitly rather than derived.
const EDITOR_KIND_SOURCES: Record<string, PropertySourceKey[]> = {
  color: ['$static', '$var', '$if', '$switch', '$widgetProp'],
  icon: ['$static', '$var', '$urlParam', '$if', '$switch', '$page', '$widgetProp'],
  image: ['$static', '$var', '$urlParam', '$if', '$switch', '$widgetProp'],
  video: ['$static', '$var', '$urlParam', '$if', '$switch', '$widgetProp'],
  'option-list': ['$static', '$user', '$var', '$languages', '$widgetProp'],
  // A bound array-of-records (e.g. a data grid's rows). No static — always
  // resolves to a real array from a variable, the recipe list, or an export.
  'record-list': ['$var', '$recipeList', '$widgetProp'],
  // What a Repeater repeats over: any array, scalar or record, from any source
  // that can produce one. `$http` counts when its pick is a JSON array.
  'item-list': ['$static', '$var', '$http', '$recipeList', '$user', '$widgetProp'],
};

/** Allowed property sources per value type, derived from per-source produced types. */
const DEFAULT_SOURCE_MATRIX: Record<string, PropertySourceKey[]> = {
  ...Object.fromEntries(SCALAR_FIELD_TYPES.map((t) => [t, deriveScalarSources(t)])),
  ...EDITOR_KIND_SOURCES,
};

/** Value types that support property sources. */
export const SOURCE_CAPABLE_TYPES = new Set([
  'string',
  'datetime',
  'date',
  'time',
  'duration',
  'integer',
  'float',
  'boolean',
  'color',
  'icon',
  'image',
  'video',
  'option-list',
  'record-list',
  'item-list',
]);

/**
 * Whether a schema field's row binds a variable — i.e. draws the path input and
 * its binding picker (`✎` / `×`) rather than a plain value editor.
 *
 * Two disjoint families qualify: source-capable types (scalars, `record-list`,
 * the editor kinds), and struct types — `struct`, `struct[]`, or a named type a
 * custom widget declares (`Alarms[]`). Both bind a single `$var` /
 * `$componentProp`.
 *
 * `SchemaFieldRow` draws the row with this test, so every panel that decides
 * whether to *offer* the picker has to ask the same question — a literal
 * `'struct'` at any one of them leaves a `struct[]` rendered as a binding row
 * with no picker to open, and its `✎` and `×` vanish.
 */
export function bindsVariable(fieldType: string): boolean {
  const type = fieldType.toLowerCase();
  return isStructType(type) || SOURCE_CAPABLE_TYPES.has(type);
}

/**
 * Get the default allowed property sources for a value type.
 * Returns an empty array for non-source-capable types.
 */
export function getDefaultPropertySources(fieldType: string): PropertySourceKey[] {
  return DEFAULT_SOURCE_MATRIX[fieldType.toLowerCase()] ?? [];
}

/**
 * Determine the allowed property sources for a field, decided by its type alone:
 * for a union (`['float', 'integer']`), every source any of its source-capable
 * types offers, as the backend's `source_type_mismatch` accepts. Returns an
 * empty array for non-source-capable types (struct, actions).
 */
export function getAllowedPropertySources(
  fieldType: string | readonly string[],
): PropertySourceKey[] {
  const types = typeof fieldType === 'string' ? [fieldType] : fieldType;
  return [
    ...new Set(
      types.flatMap((t) =>
        // struct and actions do not support property sources
        SOURCE_CAPABLE_TYPES.has(t.toLowerCase()) ? getDefaultPropertySources(t) : [],
      ),
    ),
  ];
}

/**
 * Validate that a property source is allowed for the given value type.
 * Returns { valid: boolean; reason?: string }
 */
export function isPropertySourceAllowed(
  fieldType: string | readonly string[],
  sourceKey: string,
): { valid: boolean; reason?: string } {
  const types = typeof fieldType === 'string' ? [fieldType] : fieldType;
  const typeLabel = types.join(' | ');
  // Check if the value type supports property sources at all
  if (!types.some((t) => SOURCE_CAPABLE_TYPES.has(t.toLowerCase()))) {
    return { valid: false, reason: `Value type '${typeLabel}' does not support property sources` };
  }

  // Check if the property source exists
  if (!isPropertySourceKey(sourceKey)) {
    return { valid: false, reason: `Unknown property source '${sourceKey}'` };
  }

  // Get allowed sources for this field
  const allowed = getAllowedPropertySources(fieldType);
  if (!allowed.includes(sourceKey as PropertySourceKey)) {
    return {
      valid: false,
      reason: `Property source '${sourceKey}' is not allowed for value type '${typeLabel}' (allowed: ${allowed.join(', ')})`,
    };
  }

  return { valid: true };
}
