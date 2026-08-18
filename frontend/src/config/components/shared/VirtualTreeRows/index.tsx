import type { CSSProperties, ReactNode } from 'react';

interface VirtualItemLike {
  key: string | number | bigint;
  index: number;
  size: number;
  start: number;
}

interface VirtualizerLike {
  getTotalSize: () => number;
  getVirtualItems: () => VirtualItemLike[];
}

interface Props<T> {
  rows: T[];
  virtualizer: VirtualizerLike;
  renderRow: (row: T, index: number) => ReactNode;
  getRowClassName?: (row: T, index: number) => string;
  getRowDataAttrs?: (row: T, index: number) => Record<string, string>;
  emptyState?: ReactNode;
}

export default function VirtualTreeRows<T>({
  rows,
  virtualizer,
  renderRow,
  getRowClassName,
  getRowDataAttrs,
  emptyState,
}: Props<T>) {
  return (
    <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
      {virtualizer.getVirtualItems().map((vRow) => {
        const item = rows[vRow.index];
        const wrapperStyle: CSSProperties = {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: `${vRow.size}px`,
          transform: `translateY(${vRow.start}px)`,
          boxSizing: 'border-box',
        };
        const dataAttrs = getRowDataAttrs ? getRowDataAttrs(item, vRow.index) : undefined;
        return (
          <div
            key={vRow.key}
            data-index={vRow.index}
            className={getRowClassName ? getRowClassName(item, vRow.index) : undefined}
            style={wrapperStyle}
            {...dataAttrs}
          >
            {renderRow(item, vRow.index)}
          </div>
        );
      })}
      {rows.length === 0 && emptyState}
    </div>
  );
}
