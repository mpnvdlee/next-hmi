import { createContext, useContext } from 'react';

/**
 * HmiScopeContext — provides the current runtime scope key to all HMI components.
 *
 * Each HmiView instance generates a unique scope (`runtime:<uuid>`) on first mount
 * and provides it via this context. Components use it to:
 *   - Read their user identity:  hmiStore.currentUsersByScope[scope]
 *   - Send scoped WS messages:   { type: 'login', scope, ... }
 *   - Execute scoped actions:    executeWidgetActions(actions, { scope, evalCtx })
 *
 * Default value 'runtime:preview' is used in contexts where no HmiView wraps
 * (e.g. unit tests or preview frames that haven't set up their own key yet).
 */
export const HmiScopeContext = createContext<string>('runtime:preview');

/** Hook to read the current HMI scope. */
export function useHmiScope(): string {
  return useContext(HmiScopeContext);
}
