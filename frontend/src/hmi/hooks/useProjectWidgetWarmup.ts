import { useEffect, useState } from 'react';
import { useConfigStore } from '@shared/store/configStore';
import { getPageChildren } from '@shared/utils/pageContent';
import { isPageGroup } from '@shared/utils/pageTree';
import type { PageNode, WidgetConfig } from '@shared/types/config';
import { warmWidgetModules } from '../registry/widgetRegistry';
import { useVariableStore } from '../store/variableStore';

/** Start anyway when the first page's data never settles (no backend, no ack). */
const WARMUP_GRACE_MS = 3000;

/**
 * Every widget the runtime can show: the shell regions, and every page and
 * page-group chrome band in both page trees. `flattenPages` would drop the
 * groups' own header and footer, so the walk is its own. Component instances
 * are expanded later, by `collectWidgetTypes`.
 */
export function collectProjectWidgetRoots(): WidgetConfig[] {
  const s = useConfigStore.getState();
  const roots: WidgetConfig[] = [...s.header, ...s.footer, ...s.leftSidebar, ...s.rightSidebar];
  const walk = (nodes: PageNode[]) => {
    for (const node of nodes) {
      if (isPageGroup(node)) {
        roots.push(...(node.header ?? []), ...(node.footer ?? []));
        walk(node.children);
      } else {
        roots.push(...getPageChildren(node));
      }
    }
  };
  walk(s.pages);
  walk(s.dialogs);
  return roots;
}

/**
 * Once the page on screen has its data, warm the widget code of every other
 * page in the project, so a first visit is as fast as a revisit.
 *
 * Waits for that page's `context_ready` so it never competes with what the
 * operator is looking at right now; latched, so later navigations do not
 * restart it. `pageId` is undefined until the shell is up.
 */
export function useProjectWidgetWarmup(pageId: string | undefined): void {
  const settled = useVariableStore(
    (s) => pageId !== undefined && s.contextReadyPageIds.includes(pageId),
  );
  const [graceOver, setGraceOver] = useState(false);
  const [started, setStarted] = useState(false);
  const shellUp = pageId !== undefined;

  useEffect(() => {
    if (!shellUp) return;
    const t = setTimeout(() => setGraceOver(true), WARMUP_GRACE_MS);
    return () => clearTimeout(t);
  }, [shellUp]);

  if (!started && shellUp && (settled || graceOver)) setStarted(true);

  useEffect(() => {
    if (!started) return;
    return warmWidgetModules(collectProjectWidgetRoots());
  }, [started]);
}
