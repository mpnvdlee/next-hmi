import { useMemo, useSyncExternalStore } from 'react';
import { useVariableStore } from '../store/variableStore';
import { recipeParameterKeys, useRecipeStore } from '../store/recipeStore';
import { analyzePropertyValue } from '../utils/analyzePropertyValue';
import { extractLiveKeys } from '../utils/extractVarKeys';

/** No listener registered, so no re-render — the snapshot still reads current. */
export const noSubscribe = (): (() => void) => () => {};

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
  // A caller with no keys can never see a change, so it registers no listener —
  // this runs on every widget, and a leaf that reads no `$var` would otherwise
  // still be woken (and re-serialised) on every tick of the variable store.
  const subscribe = keys.length ? useVariableStore.subscribe : noSubscribe;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const NO_META: Record<string, unknown> = {};

/**
 * The keys `useLiveScalars` should watch for `value`: its `$var` keys, plus
 * the element key of every struct array bound at a literal index, plus the
 * parameter keys of a recipe whose changed fields it reads. Only a
 * value with such an index subscribes to the metadata (the element's name
 * comes from it); every other widget registers no listener for it. The keys
 * are the snapshot, not the metadata, so a widget whose indexes all fall in
 * scalar arrays does not re-render on every `var_metadata`.
 */
export function useLiveKeys(value: unknown): readonly string[] {
  const { indexedVarRefs, recipeChangeTypes } = analyzePropertyValue(value);
  const indexed = indexedVarRefs.length > 0;
  const keys = useSyncExternalStore(
    indexed ? useVariableStore.subscribe : noSubscribe,
    () => extractLiveKeys(value, indexed ? useVariableStore.getState().varMeta : NO_META),
    () => extractLiveKeys(value, NO_META),
  );
  // A recipe's changed fields read its parameters' live values, which the
  // `$recipe` source does not name: watch the keys the parameters are bound to.
  const readsRecipe = recipeChangeTypes.length > 0;
  const getRecipeConfig = () => (readsRecipe ? useRecipeStore.getState().config : null);
  const recipeConfig = useSyncExternalStore(
    readsRecipe ? useRecipeStore.subscribe : noSubscribe,
    getRecipeConfig,
    getRecipeConfig,
  );
  return useMemo(
    () =>
      recipeConfig
        ? [...new Set([...keys, ...recipeParameterKeys(recipeConfig, recipeChangeTypes)])]
        : keys,
    [keys, recipeConfig, recipeChangeTypes],
  );
}

function sigToken(value: unknown): unknown {
  if (value === undefined) return '\u0000undefined';
  if (typeof value === 'number' && !Number.isFinite(value)) return `\u0000${String(value)}`;
  if (Array.isArray(value)) return value.map(sigToken);
  return value;
}
