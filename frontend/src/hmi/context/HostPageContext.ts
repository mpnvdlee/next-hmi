import { createContext, useContext } from 'react';

/**
 * The id of the page that owns the current render scope — the page actually
 * being rendered, which a page overlay makes different from the route's. Set by
 * page content and by a page-group's chrome bands (to their deepest active
 * child), so `$page` and `$pageIsActive` resolve that page when no explicit
 * target is configured.
 */
export const HostPageContext = createContext<string | undefined>(undefined);

export function useHostPageId(): string | undefined {
  return useContext(HostPageContext);
}
