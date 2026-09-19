import { useEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { executeWidgetActions } from '../utils/widgetActions';
import { resolvePageContext } from '@shared/utils/pageTree';
import { useResolvedPageOverlays } from './useOpenOverlays';
import type { PageNode } from '@shared/types/config';

/**
 * Nodes left and entered when navigation moves from one page trail to another.
 *
 * A trail is the ancestor page-groups outermost-first, followed by the page
 * itself. Whatever the two trails share stays open — which is what makes
 * navigation between sibling pages inside a group leave that group alone.
 *
 * `closed` comes back deepest-first and `opened` outermost-first, so firing
 * one then the other unwinds and rewinds the tree in the order a nested
 * structure expects.
 */
export function diffPageTrail(
  prev: PageNode[],
  next: PageNode[],
): { closed: PageNode[]; opened: PageNode[] } {
  let shared = 0;
  while (shared < prev.length && shared < next.length && prev[shared].id === next[shared].id) {
    shared += 1;
  }
  return { closed: prev.slice(shared).reverse(), opened: next.slice(shared) };
}

/** The ancestor page-groups outermost-first, followed by the resolved page
 *  itself — or just the groups, for a route that fell back into an empty one.
 *  Shared by the routed trail and every open overlay's own trail, so a page
 *  group opened either way resolves — and fires its own events — the same. */
function resolveTrail(nodes: PageNode[], id: string | undefined): PageNode[] {
  const { page, pageGroups } = resolvePageContext(nodes, id);
  return page ? [...pageGroups, page] : [...pageGroups];
}

/**
 * Diffs one evolving trail against its previous value and fires the closed
 * nodes' `onClose` then the opened nodes' `onOpen`. The one diffing strategy
 * behind both trackers in `usePageEvents`.
 *
 * Holds the node objects themselves, not just ids: a page deleted while it is
 * open still has to fire the onClose it was configured with.
 */
function useTrailEvents(trail: PageNode[], scope: string): void {
  const prevTrailRef = useRef<PageNode[]>([]);
  useEffect(() => {
    const { closed, opened } = diffPageTrail(prevTrailRef.current, trail);
    if (closed.length === 0 && opened.length === 0) return;
    prevTrailRef.current = trail;
    for (const node of closed) executeWidgetActions(node.events?.onClose, { scope });
    for (const node of opened) executeWidgetActions(node.events?.onOpen, { scope });
  }, [trail, scope]);
}

/**
 * Fires the `onOpen` / `onClose` action lists configured on page and page-group
 * nodes.
 *
 * Must be called once inside HmiView, after the scope context is established
 * and after `useGlobalEvents` — effects run in declaration order, so the global
 * `onPageLoaded` lands before the page's own `onOpen`.
 *
 * Two independent trackers, both diffed with `useTrailEvents`:
 * - the routed page and its page-group trail, diffed on every navigation;
 * - every open page overlay's own trail (concatenated in stack order), diffed
 *   on every open, close and in-overlay navigation. An overlay resolves
 *   through its own root exactly as a route would — a group it targets fires
 *   its own events too, not just the child it falls back to — but it never
 *   reaches the trail of whatever page is open underneath it.
 *
 * Nothing fires for a browser refresh or tab close: an unload handler cannot
 * reliably run an action list.
 */
export function usePageEvents(scope: string): void {
  const { id: routeId } = useParams<{ id: string }>();
  const pages = useConfigStore((s) => s.pages);

  // Resolve the route the same way HmiView renders it — a route naming a
  // page-group falls back to that group's first child page, and the trail
  // carries the groups it passed through.
  const trail = useMemo<PageNode[]>(() => resolveTrail(pages, routeId), [pages, routeId]);
  useTrailEvents(trail, scope);

  const overlays = useResolvedPageOverlays();
  // Each overlay's own trail, back to back in the stack's open order. Two
  // overlays never share a node, so this concatenation is exactly what
  // `diffPageTrail`'s shared-prefix check needs: swapping one overlay for a
  // sibling target under the same group leaves that group's entry alone,
  // the same way sibling routed navigation does.
  const overlayTrail = useMemo<PageNode[]>(
    () => overlays.flatMap((o) => resolveTrail(o.rootNodes, o.node.id)),
    [overlays],
  );
  useTrailEvents(overlayTrail, scope);
}
