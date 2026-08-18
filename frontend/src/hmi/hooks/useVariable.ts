import { useVariableStore, type VarMeta } from '../store/variableStore';
import { type VariableBinding, bindingKey } from '@shared/types/config';

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
 * own key (§10.5), so this only re-renders when that one element changes,
 * not on every element's update. Scalar arrays have no per-element backend
 * key, so `index` still slices the array value directly.
 *
 * @example
 *   const value = useBindingValue(binding); // returns binding.index element if array
 */
export function useBindingValue(binding: VariableBinding | undefined): unknown {
  const id = bindingKey(binding);
  const type = useVariableStore((state) => (id ? state.varMeta[id]?.type : undefined));
  const isStructArray = type?.kind === 'struct' && type.array;
  const resolvedId =
    binding?.index !== undefined && isStructArray ? `${id}/[${binding.index}]` : id;
  const raw = useVariableStore((state) => (resolvedId ? state.values[resolvedId] : undefined));
  if (binding?.index !== undefined) {
    if (!type?.array || !Number.isInteger(binding.index) || binding.index < 0) return null;
    if (!isStructArray) {
      return Array.isArray(raw) ? (raw[binding.index] ?? null) : null;
    }
  }
  return raw;
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
