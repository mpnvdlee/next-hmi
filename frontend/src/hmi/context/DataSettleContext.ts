import { createContext, useContext } from 'react';

/**
 * Whether the surrounding surface is still waiting for its variable values to
 * land. While `true`, `useBindingStatus` withholds the binding overlay: the
 * widget renders with whatever the store already holds (the values a previous
 * visit left behind, or its own defaults) instead of being covered by a mark
 * that only says "the data has not arrived *yet*".
 *
 * Default `false` — settled. A surface that never opts in (a widget rendered
 * standalone, the editor's own panels) marks immediately, as before.
 *
 * `DataSettleGate` is what opens the window; see it for how it closes.
 */
export const DataSettleContext = createContext(false);

export function useDataSettling(): boolean {
  return useContext(DataSettleContext);
}
