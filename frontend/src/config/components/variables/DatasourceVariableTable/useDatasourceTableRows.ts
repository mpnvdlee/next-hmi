import { useMemo, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { filterTree } from '@config/components/ui/datasourceTreeHelpers';
import { filterBrowse, flattenWithPlc, type PlcOverlay, type TableRow } from './plcRows';

/**
 * Min/Max range editing is fully built (see `RangeCells` in rowRenderers.tsx)
 * but hidden from the table for this release. Flip to true to bring the
 * columns back.
 */
export const SHOW_RANGE_COLUMNS = false;

interface Params {
  tree: Parameters<typeof filterTree>[0];
  filter: string;
  collapsed: Set<string>;
  showLive: boolean;
  isEditable: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The PLC's not-yet-added variables, shown dimmed among the saved ones (ADS). */
  plc?: PlcOverlay | null;
}

export function useDatasourceTableRows({
  tree,
  filter,
  collapsed,
  showLive,
  isEditable,
  scrollRef,
  plc = null,
}: Params) {
  // `wanted`: lazy PLC levels an open saved folder needs before its new
  // variables can show.
  const { rows, wanted } = useMemo(() => {
    const query = filter.trim();
    const displayTree = query ? filterTree(tree, query) : tree;
    // A filter opens every folder, PLC ones included, as it does saved ones.
    const overlay =
      plc && query ? { ...plc, nodes: filterBrowse(plc.nodes, query), open: null } : plc;
    const wanted: string[] = [];
    const rows: TableRow[] = flattenWithPlc(
      displayTree,
      query ? new Set() : collapsed,
      overlay,
      query ? [] : wanted,
    );
    return { rows, wanted };
  }, [tree, filter, collapsed, plc]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29,
    overscan: 10,
    getItemKey: (index) => {
      const item = rows[index];
      if (item.kind === 'folder') return `f:${item.path}`;
      if (item.kind === 'array-element') return `ae:${item.path}[${item.index}]`;
      if (item.kind === 'plc') return `p:${item.node.node_id}`;
      return `v:${item.path}`;
    },
  });

  const colsTmpl = useMemo(() => {
    const base =
      '44px minmax(120px, 1.5fr) 140px 90px' +
      (SHOW_RANGE_COLUMNS ? ' 64px 64px' : '') +
      (showLive ? ' 270px' : '');
    return base + (isEditable ? ' 36px' : '');
  }, [showLive, isEditable]);

  return { rows, wanted, rowVirtualizer, colsTmpl };
}
