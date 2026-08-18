import type { WidgetConfig, PageConfig, PageGroupConfig, PageNode } from '@shared/types/config';
import { getPageChildren } from './pageContent';
import { isPageGroup } from './pageTree';

export function findComponentById(components: WidgetConfig[], id: string): WidgetConfig | null {
  for (const comp of components) {
    if (comp.id === id) return comp;
    if (comp.children) {
      const found = findComponentById(comp.children as WidgetConfig[], id);
      if (found) return found;
    }
  }
  return null;
}

export function flattenComponents(comps: WidgetConfig[]): WidgetConfig[] {
  const result: WidgetConfig[] = [];
  for (const c of comps) {
    result.push(c);
    if (c.children) result.push(...flattenComponents(c.children as WidgetConfig[]));
  }
  return result;
}

interface FindInPagesResult {
  page?: PageConfig;
  pageGroup?: PageGroupConfig;
  comp?: WidgetConfig;
  /** When a comp matches, the array reference holding it (page-group header/footer or page children). */
  container?: WidgetConfig[];
  /** Page-group ancestors of the match (root → leaf). */
  groupTrail?: PageGroupConfig[];
}

export function isFound(r: FindInPagesResult): boolean {
  return r.page != null || r.pageGroup != null || r.comp != null;
}

export function findInPages(pages: PageNode[], id: string): FindInPagesResult {
  const trail: PageGroupConfig[] = [];
  function walk(nodes: PageNode[]): FindInPagesResult {
    for (const node of nodes) {
      if (node.id === id) {
        const snapshot = [...trail];
        return isPageGroup(node)
          ? { pageGroup: node, groupTrail: snapshot }
          : { page: node, groupTrail: snapshot };
      }
      if (isPageGroup(node)) {
        trail.push(node);
        if (node.header) {
          const comp = findComponentById(node.header, id);
          if (comp) return { comp, container: node.header, groupTrail: [...trail] };
        }
        if (node.footer) {
          const comp = findComponentById(node.footer, id);
          if (comp) return { comp, container: node.footer, groupTrail: [...trail] };
        }
        const nested = walk(node.children);
        if (isFound(nested)) return nested;
        trail.pop();
        continue;
      }
      const comps = getPageChildren(node);
      const comp = findComponentById(comps, id);
      if (comp) return { comp, container: comps, groupTrail: [...trail] };
    }
    return {};
  }
  return walk(pages);
}

/** Top-level component list that contains the given component id. */
export function findContainerComps(pages: PageNode[], id: string): WidgetConfig[] {
  return findInPages(pages, id).container ?? [];
}

export function findComponentInPages(pages: PageNode[], id: string): WidgetConfig | null {
  return findInPages(pages, id).comp ?? null;
}
