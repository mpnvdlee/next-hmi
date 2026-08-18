import { isVarSource, isTimeSource, isHttpSource } from '@shared/types/propertyValueGuards';

/**
 * Single recursive walk over a value that collects, in one pass:
 *  - every scalar variable key (`datasource:path`) referenced by a `$var`
 *    source anywhere inside it (including nested in `$if` / `$switch` /
 *    `$compare` / `$stringExpr` and other sources, arrays, and plain objects),
 *  - whether a `$time` source appears anywhere inside it, and
 *  - whether an `$http` source appears anywhere inside it.
 *
 * `extractVarKeys`, `usesTime` and `usesHttp` are thin accessors over this, so a
 * widget that needs all three (WidgetRenderer) walks its property tree only once.
 * The var keys match the composite key used by `resolveVariable` / the variable
 * store's `values` map, so they can be handed straight to `useLiveScalars`.
 *
 * Results are memoised per input object via a `WeakMap`, so re-reading the same
 * (stable) property/layout object returns the same analysis (and the same
 * `varKeys` array reference) — safe to use directly as a hook dependency.
 */

interface PropertyValueAnalysis {
  varKeys: readonly string[];
  usesTime: boolean;
  usesHttp: boolean;
}

interface WalkState {
  usesTime: boolean;
  usesHttp: boolean;
}

const EMPTY_KEYS: readonly string[] = Object.freeze([]);
const EMPTY: PropertyValueAnalysis = Object.freeze({
  varKeys: EMPTY_KEYS,
  usesTime: false,
  usesHttp: false,
});
const cache = new WeakMap<object, PropertyValueAnalysis>();

export function analyzePropertyValue(value: unknown): PropertyValueAnalysis {
  if (value === null || typeof value !== 'object') return EMPTY;
  const cached = cache.get(value);
  if (cached) return cached;

  const keys: string[] = [];
  const seen = new Set<string>();
  const state: WalkState = { usesTime: false, usesHttp: false };
  walk(value, keys, seen, state);

  const result: PropertyValueAnalysis =
    keys.length || state.usesTime || state.usesHttp
      ? {
          varKeys: keys.length ? keys : EMPTY_KEYS,
          usesTime: state.usesTime,
          usesHttp: state.usesHttp,
        }
      : EMPTY;
  cache.set(value, result);
  return result;
}

function walk(value: unknown, keys: string[], seen: Set<string>, state: WalkState): void {
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const el of value) walk(el, keys, seen, state);
    return;
  }

  if (isVarSource(value)) {
    const path = value.$var.path;
    if (path && !seen.has(path)) {
      seen.add(path);
      keys.push(path);
    }
    // A `$var` source only carries { path, index } — nothing else to walk.
    return;
  }

  // `$time` and `$http` sources can still contain `$var` (a bound timezone, a
  // url wildcard), so mark and keep walking rather than returning early.
  if (isTimeSource(value)) state.usesTime = true;
  if (isHttpSource(value)) state.usesHttp = true;

  for (const v of Object.values(value)) walk(v, keys, seen, state);
}
