import { useSyncExternalStore } from 'react';
import { useVariableStore } from '../store/variableStore';

/**
 * Granular subscription to a specific set of scalar variable keys.
 *
 * Re-renders the calling component only when one of the given `keys`' values in
 * the variable store changes — unlike subscribing to the whole `values` map,
 * which re-renders on every tick of any variable. Pass the keys collected by
 * `extractVarKeys` over a widget's resolved properties / layout.
 *
 * Returns a signature string that changes iff a subscribed value changes; use it
 * as a `useMemo` dependency at call-sites that evaluate `$var` inside a memo
 * (e.g. `useResolvedLayout`), whose eval context is otherwise stable per tick.
 *
 * @example
 *   const keys = extractVarKeys(resolvedProperties);
 *   useLiveScalars(keys); // re-renders when any of `keys` updates
 */
export function useLiveScalars(keys: readonly string[]): string {
  const getSnapshot = () => {
    if (keys.length === 0) return '[]';
    const { values } = useVariableStore.getState();
    // Fixed key order → the serialised value tuple is a stable, collision-free
    // signature: identical string (Object.is by value) when nothing changed,
    // a new string as soon as any subscribed value changes. Values are tokenised
    // first so transitions JSON.stringify would flatten to the same text —
    // undefined↔null, and NaN↔Infinity↔-Infinity (all `null` under stringify) —
    // still change the signature and trigger the re-render.
    return JSON.stringify(keys.map((key) => sigToken(values[key])));
  };
  return useSyncExternalStore(useVariableStore.subscribe, getSnapshot, getSnapshot);
}

function sigToken(value: unknown): unknown {
  if (value === undefined) return '\u0000undefined';
  if (typeof value === 'number' && !Number.isFinite(value)) return `\u0000${String(value)}`;
  if (Array.isArray(value)) return value.map(sigToken);
  return value;
}
