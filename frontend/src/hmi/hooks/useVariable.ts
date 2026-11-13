import { useSyncExternalStore } from 'react';
import { readStoredValue, useVariableStore, type VarMeta } from '../store/variableStore';
import { type VariableBinding, bindingIndex, bindingKey } from '@shared/types/config';
import { readBit } from '@shared/utils/valueTypes';
import { readArrayElement } from '../utils/repeatItemResolution';
import { noSubscribe } from './useLiveScalars';

/**
 * Subscribe to a single scalar variable value.
 * Returns undefined until the first var_snapshot arrives.
 *
 * @example
 *   const speed = useVariable('MyPLC:Motor1/Speed'); // e.g. 1452.3
 */
export function useVariable(id: string): unknown {
  return useVariableStore((state) => readStoredValue(state.values, id));
}

/**
 * Subscribe to a variable binding and automatically resolve array index when set.
 * Components receive a single scalar value regardless of whether the source is an
 * array variable or a plain scalar.
 *
 * For a `struct[]`-typed source, `index` is a position in the array, counted
 * from 0: it reads the element folder whose metadata `position` matches,
 * under that folder's own key — the backend caches/broadcasts each element
 * there, so this only re-renders when that one element changes — and slices
 * the whole-array value when that key holds nothing (`readArrayElement`).
 * Scalar arrays have no per-element backend key, so `index` slices the array
 * value directly.
 *
 * @example
 *   const value = useBindingValue(binding); // returns binding.index element if array
 */
export function useBindingValue(binding: VariableBinding | undefined): unknown {
  const id = bindingKey(binding);
  const index = bindingIndex(binding);
  const bit = binding?.bit;
  // The snapshot is the resolved value itself — a store value or an element of
  // one, never a fresh object — so it compares equal across ticks that leave it
  // alone, and a scalar-array element re-renders only when that element changes.
  const getElement = (): unknown => {
    const { values, varMeta } = useVariableStore.getState();
    if (index === undefined) return id ? readStoredValue(values, id) : undefined;
    const type = id ? varMeta[id]?.type : undefined;
    if (!type?.array || !Number.isInteger(index) || index < 0) return null;
    if (type.kind === 'struct') return readArrayElement(values, varMeta, id, index);
    const raw = values[id];
    return Array.isArray(raw) ? (raw[index] ?? null) : null;
  };
  const getSnapshot = (): unknown => {
    const value = getElement();
    if (bit === undefined || value === undefined) return value;
    return readBit(value, bit);
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
