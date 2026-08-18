import { createContext, useContext } from 'react';
import type { PageGroupChild, PageGroupConfig } from '@shared/types/config';

export interface PageGroupStackEntry {
  group: PageGroupConfig;
  /** The active immediate child of `group` — a page or a nested group. */
  activePage: PageGroupChild;
  onNavigate: (pageId: string) => void;
}

export const PageGroupStackContext = createContext<PageGroupStackEntry[]>([]);

export function usePageGroup(groupId?: string): PageGroupStackEntry | null {
  const stack = useContext(PageGroupStackContext);
  if (!groupId) return stack[stack.length - 1] ?? null;
  if (groupId === '$parent') return stack[stack.length - 2] ?? null;
  return stack.find((e) => e.group.id === groupId) ?? null;
}
