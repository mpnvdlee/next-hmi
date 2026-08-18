import { createContext, useContext } from 'react';

/**
 * Input-scope frame published by widgets and dialogs to their descendants.
 * `$componentProp` lookups read the innermost scope. A nested widget shadows the
 * surrounding dialog; an explicit pass-through via the widget's instance
 * properties is the way to forward outer values inward.
 */
interface InputScopeValue {
  /** Resolved instance property values keyed by property name. */
  properties: Record<string, unknown>;
}

export const InputScopeContext = createContext<InputScopeValue | null>(null);

export function useInputScope(): InputScopeValue | null {
  return useContext(InputScopeContext);
}
