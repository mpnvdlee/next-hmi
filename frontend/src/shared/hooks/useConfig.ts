import { useEffect } from 'react';
import { useConfigStore } from '../store/configStore';
import { projectIsDirty } from '../store/projectActions';
import { apiJson } from '@shared/utils/api';
import type { PagesBootstrapResponse } from '@shared/types/config';

/**
 * Fetches the page index + global areas from the backend on mount and stores
 * them in configStore. Individual page content is NOT loaded here — call
 * usePage(pageId) when a specific page needs its component children.
 *
 * Skips the fetch only when the index is already loaded AND there are unsaved changes.
 */
export function useConfig(): void {
  const setPages = useConfigStore((s) => s.setPages);

  useEffect(() => {
    const { loaded } = useConfigStore.getState();
    if (loaded && projectIsDirty()) return;

    void (async () => {
      try {
        const data = await apiJson<PagesBootstrapResponse>('/api/config/config');
        const store = useConfigStore.getState();
        setPages(data.pages ?? []);
        store.setHeader(data.header ?? []);
        store.setFooter(data.footer ?? []);
        store.setLeftSidebar(data.leftSidebar ?? []);
        store.setRightSidebar(data.rightSidebar ?? []);
        store.setShell(data.shell ?? {});
        store.setDialogs(data.dialogs ?? []);
        store.setGlobalEvents(data.globalEvents ?? {});
        store.markLoaded();
      } catch (err) {
        console.error('[useConfig] Failed to load config:', err);
      }
    })();
  }, [setPages]);
}

/**
 * Lazily loads the component content of a specific page when first needed.
 * Safe to call on every render — skips the fetch if already loaded.
 */
export function usePage(pageId: string | undefined): void {
  usePages(pageId ? [pageId] : []);
}

/**
 * Lazily loads the component content of multiple pages (e.g. open overlay pages).
 * Stable reference to `ids` array is not required — uses JSON-serialised dep.
 */
export function usePages(pageIds: string[]): void {
  const loadPageContent = useConfigStore((s) => s.loadPageContent);
  const loadedPageIds = useConfigStore((s) => s.loadedPageIds);

  useEffect(() => {
    for (const id of pageIds) {
      if (!id || loadedPageIds.has(id)) continue;
      loadPageContent(id);
    }
    // pageIds is normalized via JSON.stringify so callers can pass a fresh
    // array each render without re-firing the effect; eslint can't see the
    // captured dep through the stringify boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(pageIds), loadedPageIds, loadPageContent]);
}
