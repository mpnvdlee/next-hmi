import { createContext, useContext } from 'react';

export interface DataSettle {
  /**
   * Whether the surrounding surface is still waiting for its variable values to
   * land. While `true`, `useBindingStatus` withholds the binding overlay: the
   * widget renders with whatever the store already holds (the values a previous
   * visit left behind, or its own defaults) instead of being covered by a mark
   * that only says "the data has not arrived *yet*".
   */
  settling: boolean;
  /**
   * Whether the metadata in the store is this surface's own, so a binding
   * missing from it is wrong rather than not yet described. Unlike `settling`
   * it does not end on the grace timer: until this page's data has arrived, the
   * metadata in hand can still be the previous page's.
   */
  metaSettled: boolean;
}

/**
 * Default: settled. A surface that never opts in (a widget rendered standalone,
 * the editor's own panels) marks immediately, as before.
 *
 * `DataSettleGate` is what opens the window; see it for how it closes.
 */
export const DataSettleContext = createContext<DataSettle>({ settling: false, metaSettled: true });

export function useDataSettling(): DataSettle {
  return useContext(DataSettleContext);
}
