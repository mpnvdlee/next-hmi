/**
 * Property-source defaults and validation.
 *
 * Each value type has a fixed set of allowed property sources, decided by the
 * field's type alone.
 */

import {
  PROPERTY_SOURCES,
  PROPERTY_SOURCE_KEYS,
  isPropertySourceKey,
} from './propertySourceRegistry';
import type { ProducedValueType, PropertySourceKey } from './propertySourceRegistry';

export { PROPERTY_SOURCE_KEYS };

// Scalar field-type families. A source is offered on a scalar field when one of
// the types it *produces* fits the field's family — there is no hand-maintained
// per-field allowlist; the matrix below is derived from each source's `produces`.
const TEXT_TYPES = new Set(['string', 'datetime', 'date', 'time']);
const NUMERIC_TYPES = new Set(['integer', 'float', 'duration']);
const SCALAR_FIELD_TYPES = [
  'string',
  'datetime',
  'date',
  'time',
  'duration',
  'integer',
  'float',
  'boolean',
];

// Scope-injected sources: availability is decided by ambient editor scope
// (component-property scope / action-result handler), not by the field's type,
// so they are added by PropertySourceSelector — never by the type matrix.
export const SCOPE_SOURCES = new Set<PropertySourceKey>(['$componentProp', '$result']);

/** Whether a produced base type fits a scalar field type (offer-time gate). */
function producedFits(produced: ProducedValueType, fieldType: string): boolean {
  if (produced === 'any') return true;
  // array producers are gated by the editor-kind lists, never scalar fields
  if (produced === 'string[]' || produced === 'record-list') return false;
  if ((produced === 'integer' || produced === 'float') && NUMERIC_TYPES.has(fieldType)) return true;
  if ((produced === 'string' || produced === 'datetime') && TEXT_TYPES.has(fieldType)) return true;
  // booleans render as text too, so boolean producers serve text fields as well
  if (produced === 'boolean' && (fieldType === 'boolean' || TEXT_TYPES.has(fieldType))) return true;
  return false;
}

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
  'option-list': ['$static', '$user', '$var', '$languages', '$widgetProp'],
  // A bound array-of-records (e.g. a data grid's rows). No static — always
  // resolves to a real array from a variable, the recipe list, or an export.
  'record-list': ['$var', '$recipeList', '$widgetProp'],
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
  'option-list',
  'record-list',
]);

/**
 * Get the default allowed property sources for a value type.
 * Returns an empty array for non-source-capable types.
 */
export function getDefaultPropertySources(fieldType: string): PropertySourceKey[] {
  return DEFAULT_SOURCE_MATRIX[fieldType.toLowerCase()] ?? [];
}

/**
 * Determine the allowed property sources for a field, decided by its type alone.
 * Returns an empty array for non-source-capable types (struct, actions).
 */
export function getAllowedPropertySources(fieldType: string): PropertySourceKey[] {
  if (!SOURCE_CAPABLE_TYPES.has(fieldType.toLowerCase())) {
    // struct and actions do not support property sources
    return [];
  }
  return getDefaultPropertySources(fieldType);
}

/**
 * Validate that a property source is allowed for the given value type.
 * Returns { valid: boolean; reason?: string }
 */
export function isPropertySourceAllowed(
  fieldType: string,
  sourceKey: string,
): { valid: boolean; reason?: string } {
  // Check if the value type supports property sources at all
  if (!SOURCE_CAPABLE_TYPES.has(fieldType.toLowerCase())) {
    return { valid: false, reason: `Value type '${fieldType}' does not support property sources` };
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
      reason: `Property source '${sourceKey}' is not allowed for value type '${fieldType}' (allowed: ${allowed.join(', ')})`,
    };
  }

  return { valid: true };
}
