import { useMemo } from 'react';
import { useConfigStore } from '@shared/store/configStore';
import { findPageNodeById, findPageRoot, resolvePageContext } from '@shared/utils/pageTree';
import type { PageConfig, PageNode, PageRoot } from '@shared/types/config';
import { useHmiStore, type PageOverlayEntry } from '../store/hmiStore';

interface ResolvedPageOverlay {
  entry: PageOverlayEntry;
  /** The node the overlay currently shows — a page, or a page group whose active
   *  child renders inside its chrome. */
  node: PageNode;
  /** The leaf page actually rendered: the node itself, or the group's active
   *  child. `null` only for an empty group. This — not the group id — is the id
   *  the backend knows: it is what `set_context` sends, what `context_ready`
   *  echoes back for the settle gate, and what has a page file to hydrate. */
  page: PageConfig | null;
  /** The page-tree root the shown node lives in. Only a node in the Dialogs
   *  folder takes input parameters and has close settings of its own. */
  root: PageRoot;
  /** That root's top-level nodes — the tree a group trail inside the overlay
   *  resolves against. */
  rootNodes: PageNode[];
  /** The node the action named (`entry.pageId`), whose close settings the card
   *  follows even after navigation inside the overlay moved `node` off it. */
  target: PageNode;
}

/**
 * Resolve each open page-overlay entry to the node it shows, dropping entries
 * whose target no longer exists. Resolution goes through `findPageNodeById`
 * rather than `findPageById` because an overlay may target a page group, and
 * searches both page-tree roots because the target may sit in either.
 */
export function useResolvedPageOverlays(): ResolvedPageOverlay[] {
  const pages = useConfigStore((s) => s.pages);
  const dialogs = useConfigStore((s) => s.dialogs);
  const openPageOverlayEntries = useHmiStore((s) => s.openPageOverlays);
  return useMemo(
    () =>
      openPageOverlayEntries.flatMap((entry) => {
        const shownId = entry.activePageId ?? entry.pageId;
        const root = findPageRoot({ pages, dialogs }, shownId);
        if (!root) return [];
        const rootNodes = root === 'pages' ? pages : dialogs;
        const node = findPageNodeById(rootNodes, shownId);
        if (!node) return [];
        return [
          {
            entry,
            node,
            page: resolvePageContext(rootNodes, shownId).page,
            root,
            rootNodes,
            target: findPageNodeById(rootNodes, entry.pageId) ?? node,
          },
        ];
      }),
    [openPageOverlayEntries, pages, dialogs],
  );
}
