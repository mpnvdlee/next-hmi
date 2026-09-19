import { useMemo } from 'react';
import type { PageNode } from '@shared/types/config';
import { SHELL_REGION_IDS } from '@shared/types/config';
import { isPageGroup } from '@shared/utils/pageTree';
import { filterComponents, filterPage, filterPageGroup, type ShellAreas } from './treeFilters';
import { withDotSearchSeparators } from '@shared/utils/search';

interface FilteredTrees {
  filteredShell: ShellAreas;
  filteredPages: PageNode[];
  filteredDialogs: PageNode[];
}

/** One page-tree root filtered by the query, each path prefixed with the
 *  root's own section label so a search can name the section too. */
function filterRoot(nodes: PageNode[], wordQuery: string, label: string): PageNode[] {
  return nodes
    .map((node) =>
      isPageGroup(node)
        ? filterPageGroup(node, wordQuery, label)
        : filterPage(node, wordQuery, label),
    )
    .filter((n): n is PageNode => n !== null);
}

export function useTreeSearch(
  searchQuery: string,
  shell: ShellAreas,
  pages: PageNode[],
  dialogs: PageNode[],
): FilteredTrees {
  const wordQuery = withDotSearchSeparators(searchQuery);
  const filteredShell = useMemo<ShellAreas>(() => {
    if (!searchQuery.trim()) return shell;
    const out = {} as ShellAreas;
    for (const region of SHELL_REGION_IDS) {
      const items = shell[region];
      const regionLabel = region.replace(/([A-Z])/g, ' $1');
      out[region] = items.length > 0 ? filterComponents(items, wordQuery, regionLabel) : items;
    }
    return out;
  }, [shell, searchQuery, wordQuery]);

  const filteredPages = useMemo(
    () => (searchQuery.trim() ? filterRoot(pages, wordQuery, 'Pages') : pages),
    [pages, searchQuery, wordQuery],
  );

  const filteredDialogs = useMemo(
    () => (searchQuery.trim() ? filterRoot(dialogs, wordQuery, 'Dialogs') : dialogs),
    [dialogs, searchQuery, wordQuery],
  );

  return { filteredShell, filteredPages, filteredDialogs };
}
