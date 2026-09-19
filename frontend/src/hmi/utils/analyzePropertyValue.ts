import {
  isVarSource,
  isTimeSource,
  isHttpSource,
  isRecord,
} from '@shared/types/propertyValueGuards';

/**
 * Single recursive walk over a value that collects, in one pass:
 *  - every scalar variable key (`datasource:path`) referenced by a `$var`
 *    source anywhere inside it (including nested in `$if` / `$switch` /
 *    `$compare` / `$stringExpr` and other sources, arrays, and plain objects),
 *  - the subset of those keys the render actually *reads* (see
 *    `renderedVarKeys` below),
 *  - whether a `$time` source appears anywhere inside it, and
 *  - whether an `$http` source appears anywhere inside it.
 *
 * `extractVarKeys`, `extractRenderedVarKeys`, `usesTime` and `usesHttp` are thin
 * accessors over this, so a widget that needs several of them (WidgetRenderer)
 * pays for one walk per object it asks about rather than one per accessor. It
 * asks about more than one object: the whole `resolvedProperties` for the
 * subscription, then each property in turn for the binding overlay, which
 * decides per property (against its schema slot) whether that sub-tree's
 * variables are on screen at all. The var keys match the composite key used
 * by `resolveVariable` / the variable store's `values` map, so they can be
 * handed straight to `useLiveScalars`.
 *
 * Results are memoised per input object via a `WeakMap`, so re-reading the same
 * (stable) property/layout object returns the same analysis (and the same
 * `varKeys` array reference) — safe to use directly as a hook dependency.
 */

interface PropertyValueAnalysis {
  varKeys: readonly string[];
  /** The keys above minus the ones sitting in a branch that lost: the result
   *  slots of `$if` and `$switch` are alternatives, and at most one of them is
   *  on screen, so none of them can be said to be missing. Their discriminants
   *  — the condition, the switch value, each `when` — are read on every render
   *  and stay in. Drives the binding overlay, which must only mark a variable
   *  the viewer is actually looking at; the subscription uses `varKeys`, since a
   *  widget has to re-render when the branch it takes changes. */
  renderedVarKeys: readonly string[];
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
  renderedVarKeys: EMPTY_KEYS,
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
  const rendered = new Set<string>();
  const state: WalkState = { usesTime: false, usesHttp: false };
  walk(value, keys, seen, rendered, state, true);

  const result: PropertyValueAnalysis =
    keys.length || state.usesTime || state.usesHttp
      ? {
          varKeys: keys.length ? keys : EMPTY_KEYS,
          renderedVarKeys: rendered.size ? keys.filter((key) => rendered.has(key)) : EMPTY_KEYS,
          usesTime: state.usesTime,
          usesHttp: state.usesHttp,
        }
      : EMPTY;
  cache.set(value, result);
  return result;
}

function walk(
  value: unknown,
  keys: string[],
  seen: Set<string>,
  rendered: Set<string>,
  state: WalkState,
  onScreen: boolean,
): void {
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const el of value) walk(el, keys, seen, rendered, state, onScreen);
    return;
  }

  if (isVarSource(value)) {
    const path = value.$var.path;
    if (path) {
      if (!seen.has(path)) {
        seen.add(path);
        keys.push(path);
      }
      if (onScreen) rendered.add(path);
    }
    // A `$var` source only carries { path, index } — nothing else to walk.
    return;
  }

  // `$time` and `$http` sources can still contain `$var` (a bound timezone, a
  // url wildcard), so mark and keep walking rather than returning early.
  if (isTimeSource(value)) state.usesTime = true;
  if (isHttpSource(value)) state.usesHttp = true;

  // `$if` / `$switch` results are alternatives: still subscribed to (the branch
  // taken can change), but only the discriminants are read on every render.
  const record = value as Record<string, unknown>;
  const ifSource = record.$if;
  if (onScreen && isRecord(ifSource)) {
    walk(ifSource.condition, keys, seen, rendered, state, true);
    for (const [k, v] of Object.entries(ifSource)) {
      if (k !== 'condition') walk(v, keys, seen, rendered, state, false);
    }
    return;
  }
  const switchSource = record.$switch;
  if (onScreen && isRecord(switchSource)) {
    walk(switchSource.value, keys, seen, rendered, state, true);
    for (const [k, v] of Object.entries(switchSource)) {
      if (k === 'value') continue;
      if (k !== 'cases') {
        walk(v, keys, seen, rendered, state, false);
        continue;
      }
      if (!Array.isArray(v)) continue;
      for (const entry of v) {
        if (!isRecord(entry)) continue;
        for (const [ck, cv] of Object.entries(entry)) {
          walk(cv, keys, seen, rendered, state, ck === 'when');
        }
      }
    }
    return;
  }

  for (const v of Object.values(record)) walk(v, keys, seen, rendered, state, onScreen);
}
