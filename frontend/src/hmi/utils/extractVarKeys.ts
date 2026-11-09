import { analyzePropertyValue } from './analyzePropertyValue';
import { structElementPath } from './repeatItemResolution';

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

const liveKeysCache = new WeakMap<readonly string[], WeakMap<object, readonly string[]>>();

/**
 * {@link extractVarKeys} plus the element keys of every struct array bound at
 * a literal index: the backend ships such an element under its own key and
 * not the whole array, so a live subscription on the array alone would never
 * tick. Memoised per (analysis, metadata) like the analysis itself.
 */
export function extractLiveKeys(value: unknown, varMeta: Record<string, unknown>): readonly string[] {
  const analysis = analyzePropertyValue(value);
  if (analysis.indexedVarRefs.length === 0) return analysis.varKeys;
  let byMeta = liveKeysCache.get(analysis.varKeys);
  if (!byMeta) {
    byMeta = new WeakMap();
    liveKeysCache.set(analysis.varKeys, byMeta);
  }
  const cached = byMeta.get(varMeta);
  if (cached) return cached;
  const keys = [...analysis.varKeys];
  for (const { key, index } of analysis.indexedVarRefs) {
    const elementKey = structElementPath(varMeta, key, index);
    if (elementKey !== undefined && !keys.includes(elementKey)) keys.push(elementKey);
  }
  byMeta.set(varMeta, keys);
  return keys;
}

/**
 * The subset of {@link extractVarKeys} the render actually reads — the losing
 * branches of `$if` / `$switch` dropped, their discriminants kept. Used by the
 * binding overlay, which must only mark a variable the viewer can see.
 */
export function extractRenderedVarKeys(value: unknown): readonly string[] {
  return analyzePropertyValue(value).renderedVarKeys;
}

/** Whether `value` holds a `$if` / `$switch` anywhere — a branch whose taken
 *  side only an eval context can name. */
export function usesBranch(value: unknown): boolean {
  return analyzePropertyValue(value).usesBranch;
}
