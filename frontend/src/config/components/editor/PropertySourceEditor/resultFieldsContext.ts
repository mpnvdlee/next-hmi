import { createContext, useContext } from 'react';

/**
 * Context published by action editors when an expression is being authored
 * inside an async action's onSuccess / onFailed / onSettled slot. Lists the
 * fields the backend actually populates on the result payload for that
 * (action type, slot) pair — e.g. `loginUser.onSuccess` exposes username /
 * groups / groupLabels but no reason, and `writeDataVariable.onSuccess`
 * exposes only datasource / path. ResultEditor reads this to limit its
 * field dropdown to fields that will actually resolve.
 *
 * Null when not inside a result handler — ResultEditor falls back to the
 * full preset list.
 */
type ResultFieldsContextValue = string[] | null;

export const ResultFieldsContext = createContext<ResultFieldsContextValue>(null);

export function useResultFields(): ResultFieldsContextValue {
  return useContext(ResultFieldsContext);
}
