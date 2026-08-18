/**
 * Value coercion between base types, per the property-value-types spec.
 *
 * A source's base type should match the field's base type. When they differ the
 * runtime coerces where there is a sensible conversion and otherwise treats the
 * value as *absent* (`undefined`) so the field falls back. The editor is
 * responsible for rejecting impossible bindings at bind time; this function only
 * handles the still-possible conversions at render time and never throws.
 *
 * Rules (from docs/dev/architecture/value-types.md → Resolution & quality → Coercion):
 *  - integer/float → string and boolean → string coerce via display formatting.
 *  - integer and float interconvert freely (float → integer rounds; integer →
 *    float is exact).
 *  - string → integer/float coerces only if it parses cleanly; otherwise absent.
 *  - Mismatches with no sensible coercion resolve to absent.
 */

/**
 * Lenient scalar → number used by comparison / switch / random evaluation.
 * Parses leading numerics (`parseFloat`), so `"5"` and trailing-unit strings
 * yield a number; non-numeric strings yield `null`.
 */
export function toNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return isNaN(val) ? null : val;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  }
  if (typeof val === 'boolean') return val ? 1 : 0;
  return null;
}

/** Strict string → number: only a cleanly parseable numeric string converts. */
function strictNumber(val: unknown): number | null {
  if (typeof val === 'number') return isNaN(val) ? null : val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return isNaN(n) ? null : n;
  }
  return null;
}

/**
 * Coerce `value` to `baseType`. Returns `undefined` (absent) when there is no
 * sensible conversion. `null`/`undefined` inputs stay absent.
 */
export function coerceToBaseType(value: unknown, baseType: string): unknown {
  if (value === null || value === undefined) return undefined;

  switch (baseType.toLowerCase()) {
    case 'integer': {
      const n = strictNumber(value);
      return n === null ? undefined : Math.round(n);
    }
    case 'float': {
      const n = strictNumber(value);
      return n === null ? undefined : n;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'duration': {
      // Duration accepts a numeric (seconds) or an ISO-8601 string verbatim.
      if (typeof value === 'number') return isNaN(value) ? undefined : value;
      if (typeof value === 'string') return value;
      return undefined;
    }
    case 'string':
    case 'datetime':
    case 'date':
    case 'time':
    case 'color': {
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return isNaN(value) ? undefined : String(value);
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      return undefined;
    }
    default:
      // Unknown / structured base types (icon, image, struct, …) pass through;
      // the editor prevents impossible bindings for these at bind time.
      return value;
  }
}
