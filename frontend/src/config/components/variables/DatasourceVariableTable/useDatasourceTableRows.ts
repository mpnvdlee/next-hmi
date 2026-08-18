import { useMemo, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RowItem } from '@config/components/ui/datasourceTreeHelpers';
import { filterTree, flattenForRender } from '@config/components/ui/datasourceTreeHelpers';

interface Params {
  tree: Parameters<typeof filterTree>[0];
  filter: string;
  collapsed: Set<string>;
  showLive: boolean;
  isEditable: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function useDatasourceTableRows({
  tree,
  filter,
  collapsed,
  showLive,
  isEditable,
  scrollRef,
}: Params) {
  const rows = useMemo((): RowItem[] => {
    const query = filter.trim();
    const displayTree = query ? filterTree(tree, query) : tree;
    return flattenForRender(displayTree, 0, query ? new Set() : collapsed);
  }, [tree, filter, collapsed]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29,
    overscan: 10,
    getItemKey: (index) => {
      const item = rows[index];
      if (item.kind === 'folder') return `f:${item.path}`;
      if (item.kind === 'array-element') return `ae:${item.path}[${item.index}]`;
      return `v:${item.path}`;
    },
  });

  const colsTmpl = useMemo(() => {
    const base = '44px minmax(120px, 1.5fr) 140px 90px 64px 64px' + (showLive ? ' 270px' : '');
    return base + (isEditable ? ' 36px' : '');
  }, [showLive, isEditable]);

  return { rows, rowVirtualizer, colsTmpl };
}
