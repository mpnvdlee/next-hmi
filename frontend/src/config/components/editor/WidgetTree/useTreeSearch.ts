import { useMemo } from 'react';
import type { DialogConfig, PageNode } from '@shared/types/config';
import { SHELL_REGION_IDS } from '@shared/types/config';
import { isPageGroup } from '@shared/utils/pageTree';
import { filterComponents, filterPage, filterPageGroup, type ShellAreas } from './treeFilters';
import { matchesSearchWords, withDotSearchSeparators } from '@shared/utils/search';

interface FilteredTrees {
  filteredShell: ShellAreas;
  filteredPages: PageNode[];
  filteredDialogs: DialogConfig[];
}

export function useTreeSearch(
  searchQuery: string,
  shell: ShellAreas,
  pages: PageNode[],
  dialogs: DialogConfig[],
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

  const filteredPages = useMemo(() => {
    if (!searchQuery.trim()) return pages;
    return pages
      .map((node) =>
        isPageGroup(node)
          ? filterPageGroup(node, wordQuery, 'Pages')
          : filterPage(node, wordQuery, 'Pages'),
      )
      .filter((n): n is PageNode => n !== null);
  }, [pages, searchQuery, wordQuery]);

  const filteredDialogs = useMemo(() => {
    if (!searchQuery.trim()) return dialogs;
    return dialogs
      .map((d) => {
        const dialogPath = `Dialogs / ${d.title}`;
        const titleMatches = matchesSearchWords(wordQuery, [dialogPath, d.id]);
        const filteredComponents = filterComponents(d.widgets, wordQuery, dialogPath);
        if (titleMatches || filteredComponents.length > 0) {
          return { ...d, widgets: titleMatches ? d.widgets : filteredComponents };
        }
        return null;
      })
      .filter((d): d is DialogConfig => d !== null);
  }, [dialogs, searchQuery, wordQuery]);

  return { filteredShell, filteredPages, filteredDialogs };
}
