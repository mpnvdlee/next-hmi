import { useVariableStore } from '../store/variableStore';

/**
 * Subscribe to a struct variable's field map.
 * Returns an empty object until the first var_snapshot arrives.
 *
 * The entire object is replaced on any field change, so components
 * that call this hook re-render once per struct update (not per field).
 *
 * @example
 *   const fields = useStructVariable('MyPLC:Motor1/HMI/input1');
 *   // fields = { bVisible: true, bEnabled: true, fValue: 1500.0 }
 */

// Stable fallback — a new `{}` literal inside a Zustand selector is a different
// reference on every call, which causes Zustand to trigger infinite re-renders
// when the id is empty or not yet present in the store.
const EMPTY: Record<string, unknown> = {};

export function useStructVariable(id: string): Record<string, unknown> | unknown[] {
  return useVariableStore(
    (state) => (state.values[id] as Record<string, unknown> | unknown[] | undefined) ?? EMPTY,
  );
}
