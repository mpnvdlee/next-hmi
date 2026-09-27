import { createContext, useContext } from 'react';

/**
 * Input-scope frame published by component instances and Dialogs-folder page
 * overlays to their descendants. `$componentProp` lookups read the innermost
 * scope. A nested component instance shadows the surrounding overlay; an
 * explicit pass-through via the instance's properties is the way to forward
 * outer values inward.
 */
export interface InputScopeValue {
  /** Resolved instance property values keyed by property name. */
  properties: Record<string, unknown>;
}

export const InputScopeContext = createContext<InputScopeValue | null>(null);

export function useInputScope(): InputScopeValue | null {
  return useContext(InputScopeContext);
}
