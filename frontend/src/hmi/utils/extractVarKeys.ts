import { analyzePropertyValue } from './analyzePropertyValue';

/**
 * Every scalar variable key (`datasource:path`) referenced by a `$var` wrapper
 * anywhere inside `value` — including bindings nested inside `$if` / `$switch` /
 * `$compare` / `$stringExpr` and other wrappers, arrays, and plain objects.
 *
 * Thin accessor over {@link analyzePropertyValue} (which does the single, memoised
 * walk shared with `usesTime`). The returned keys match the composite key used
 * by `resolveVariable` and the variable store's `values` map, so the list can
 * be handed straight to `useLiveScalars` for a granular subscription. Re-reading
 * the same (stable) input object returns the same array reference.
 */
export function extractVarKeys(value: unknown): readonly string[] {
  return analyzePropertyValue(value).varKeys;
}
