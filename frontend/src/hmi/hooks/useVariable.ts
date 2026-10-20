import { useSyncExternalStore } from 'react';
import { useVariableStore, type VarMeta } from '../store/variableStore';
import { type VariableBinding, bindingKey } from '@shared/types/config';

const noSubscribe = (): (() => void) => () => {};

/**
 * Subscribe to a single scalar variable value.
 * Returns undefined until the first var_snapshot arrives.
 *
 * @example
 *   const speed = useVariable('MyPLC:Motor1/Speed'); // e.g. 1452.3
 */
export function useVariable(id: string): unknown {
  return useVariableStore((state) => state.values[id]);
}

/**
 * Subscribe to a variable binding and automatically resolve array index when set.
 * Components receive a single scalar value regardless of whether the source is an
 * array variable or a plain scalar.
 *
 * For a `struct[]`-typed source, `index` resolves to the element's own
 * composite key (e.g. `ds:Motors/[2]`) rather than slicing the whole-array
 * value client-side — the backend caches/broadcasts each element under its
 * own key, so this only re-renders when that one element changes,
 * not on every element's update. Scalar arrays have no per-element backend
 * key, so `index` still slices the array value directly.
 *
 * @example
 *   const value = useBindingValue(binding); // returns binding.index element if array
 */
export function useBindingValue(binding: VariableBinding | undefined): unknown {
  const id = bindingKey(binding);
  const index = binding?.index;
  // The snapshot is the resolved value itself — a store value or an element of
  // one, never a fresh object — so it compares equal across ticks that leave it
  // alone, and a scalar-array element re-renders only when that element changes.
  const getSnapshot = (): unknown => {
    const { values, varMeta } = useVariableStore.getState();
    if (index === undefined) return id ? values[id] : undefined;
    const type = id ? varMeta[id]?.type : undefined;
    if (!type?.array || !Number.isInteger(index) || index < 0) return null;
    if (type.kind === 'struct') return values[`${id}/[${index}]`];
    const raw = values[id];
    return Array.isArray(raw) ? (raw[index] ?? null) : null;
  };
  // A property with no binding has nothing to watch, so it registers no store
  // listener; every widget reads several such properties.
  const subscribe = id ? useVariableStore.subscribe : noSubscribe;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to a variable's shape metadata (kind, data type, configured
 * min/max range, struct field ranges). Undefined until the metadata for
 * this key arrives (or if the key doesn't exist).
 *
 * @example
 *   const meta = useVariableMeta('MyPLC:Motor1/HMI/input1');
 *   const { min, max } = meta?.fieldRanges?.fValue ?? {};
 */
export function useVariableMeta(id: string): VarMeta | undefined {
  return useVariableStore((state) => state.varMeta[id]);
}
