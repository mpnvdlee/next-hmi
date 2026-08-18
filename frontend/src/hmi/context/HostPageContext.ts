import { createContext, useContext } from 'react';

/**
 * The id of the page that owns the current render scope. Set by page routes,
 * overlays, and page-group children so `$pageIsActive` can fall back to the
 * host page when no explicit target is configured.
 */
export const HostPageContext = createContext<string | undefined>(undefined);

export function useHostPageId(): string | undefined {
  return useContext(HostPageContext);
}
