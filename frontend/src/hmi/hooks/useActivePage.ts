import { useContext, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { isPageGroup, resolvePageContext } from '@shared/utils/pageTree';
import { PreviewContext } from '@shared/context/PreviewContext';

export interface ActivePage {
  /** Page id in the URL. `null` on a route that names none, where the runtime
   *  falls back to the first page — which `pageId` then reports. May name a
   *  *group* rather than a page. */
  requestedId: string | null;
  /** The page actually on screen, after a group resolves to its active child. */
  pageId: string | null;
  /** Ids of the page groups the active page sits inside, outermost first.
   *  Empty for a top-level page. */
  groupIds: readonly string[];
}

/** Stable empty trail — frozen because this one array is handed to every widget
 *  that asks for the active page, project-authored ones included, so a mutation
 *  would land on all of them. Matches EMPTY_PAGE_GROUPS in pageTree.ts. */
const NO_GROUPS: readonly string[] = Object.freeze([]);

/**
 * Where the runtime currently is in the page tree.
 *
 * The route carries an id that may name a page or a group, and a group resolves
 * to a child — so "which page is active" is a tree walk, not a URL read. Widgets
 * that mark an active entry (a menu, a breadcrumb) need the resolved answer plus
 * the trail of groups above it.
 *
 * Resolves against the *whole* tree, hidden and role-gated pages included: a
 * page the menu won't list can still be the one on screen, and reporting `null`
 * for it would unmark every ancestor. Exposed on `window.__nextHMI__`.
 */
export function useActivePage(): ActivePage {
  const pages = useConfigStore((s) => s.pages);
  const location = useLocation();
  const isPreview = useContext(PreviewContext);
  const base = isPreview ? '/preview/' : '/pages/';
  const requestedId = location.pathname.startsWith(base)
    ? location.pathname.slice(base.length) || null
    : null;

  return useMemo(() => {
    const context = resolvePageContext(pages, requestedId ?? undefined);
    const requested = context.requestedNode;
    return {
      requestedId,
      pageId: requested && !isPageGroup(requested) ? requested.id : (context.page?.id ?? null),
      groupIds: context.pageGroups.length ? context.pageGroups.map((group) => group.id) : NO_GROUPS,
    };
  }, [pages, requestedId]);
}
