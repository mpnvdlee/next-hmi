import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import Button from '@config/components/ui/Button';
import VirtualTreeRows from '@config/components/shared/VirtualTreeRows';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import {
  diffSelectionKey,
  type AddedRow,
  type BrowseDiff,
  type ChangedField,
  type FolderRenameRow,
  type ModifiedEntry,
  type ModifiedRow,
  type RemovedRow,
} from './datasourceBrowseDiff';

type Category = 'added' | 'modified' | 'removed';

const CATEGORIES: readonly Category[] = ['added', 'modified', 'removed'];

// A re-browse can change tens of thousands of variables, so the list is
// virtualized: group headers and rows are one flat list of fixed-height items.
const GROUP_HEIGHT = 32;
const ROW_HEIGHT = 30;

type BannerItem =
  | { kind: 'group'; category: Category }
  | { kind: 'added'; row: AddedRow }
  | { kind: 'modified'; row: ModifiedEntry }
  | { kind: 'removed'; row: RemovedRow };

function itemCategory(item: BannerItem): Category {
  return item.kind === 'group' ? item.category : item.kind;
}

const CATEGORY_LABEL: Record<Category, string> = {
  added: 'Added',
  modified: 'Modified',
  removed: 'Removed from server',
};

interface Props {
  dsName: string;
  onApply: (diff: BrowseDiff, selected: ReadonlySet<string>) => void;
}

function formatField(field: ChangedField): string {
  return field === 'parent_path' ? 'path' : field;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function valueForField(row: ModifiedRow, field: ChangedField, side: 'before' | 'after'): unknown {
  const entry = side === 'before' ? row.before : row.after;
  if (field === 'parent_path') {
    return side === 'before' ? row.beforePath : row.afterPath;
  }
  return entry[field as keyof typeof entry];
}

function AddedRowItem({
  row,
  selected,
  onToggle,
}: {
  row: AddedRow;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="cfg-browse-diff__row">
      <input type="checkbox" checked={selected} onChange={onToggle} />
      <span className="cfg-browse-diff__path">{row.path}</span>
      <span className="cfg-browse-diff__meta">{row.entry.data_type}</span>
    </label>
  );
}

function RemovedRowItem({
  row,
  selected,
  onToggle,
}: {
  row: RemovedRow;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="cfg-browse-diff__row">
      <input type="checkbox" checked={selected} onChange={onToggle} />
      <span className="cfg-browse-diff__path cfg-browse-diff__path--removed">{row.path}</span>
      <span className="cfg-browse-diff__meta">
        {selected ? 'will be deleted' : 'kept as stale'}
      </span>
    </label>
  );
}

function ModifiedRowItem({
  row,
  selected,
  onToggle,
}: {
  row: ModifiedRow;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="cfg-browse-diff__row">
      <input type="checkbox" checked={selected} onChange={onToggle} />
      <span className="cfg-browse-diff__path">{row.afterPath}</span>
      <span className="cfg-browse-diff__chips">
        {row.changedFields.map((field) => {
          const label = formatField(field);
          const before = formatValue(valueForField(row, field, 'before'));
          const after = formatValue(valueForField(row, field, 'after'));
          // The row is one fixed-height line, so a long value is cut off.
          return (
            <span
              key={field}
              className="cfg-browse-diff__chip"
              title={`${label}: ${before} → ${after}`}
            >
              <span className="cfg-browse-diff__chip-label">{label}</span>
              <span className="cfg-browse-diff__chip-before">{before}</span>
              <span className="cfg-browse-diff__chip-arrow">→</span>
              <span className="cfg-browse-diff__chip-after">{after}</span>
            </span>
          );
        })}
      </span>
    </label>
  );
}

function FolderRenameRowItem({
  row,
  selected,
  onToggle,
}: {
  row: FolderRenameRow;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="cfg-browse-diff__row">
      <input type="checkbox" checked={selected} onChange={onToggle} />
      <span className="cfg-browse-diff__path">
        {row.beforeParent || '(root)'} → {row.afterParent || '(root)'}
      </span>
      <span className="cfg-browse-diff__meta">folder renamed · {row.rows.length} fields</span>
    </label>
  );
}

export default function DatasourceBrowseDiffBanner({ dsName, onApply }: Props) {
  const pending = useVariablesDomainStore((s) => s.pendingBrowse[dsName]);
  const toggle = useVariablesDomainStore((s) => s.togglePendingSelection);
  const setCategorySelection = useVariablesDomainStore((s) => s.setCategorySelection);
  const clearPendingBrowse = useVariablesDomainStore((s) => s.clearPendingBrowse);

  const [openCategories, setOpenCategories] = useState<Record<Category, boolean>>({
    added: true,
    modified: true,
    removed: true,
  });
  const bodyRef = useRef<HTMLDivElement>(null);

  const diff = pending?.diff;
  const selected = pending?.selected;

  const items = useMemo((): BannerItem[] => {
    if (!diff) return [];
    const out: BannerItem[] = [];
    for (const category of CATEGORIES) {
      if (diff[category].length === 0) continue;
      out.push({ kind: 'group', category });
      if (!openCategories[category]) continue;
      if (category === 'added') for (const row of diff.added) out.push({ kind: 'added', row });
      if (category === 'modified')
        for (const row of diff.modified) out.push({ kind: 'modified', row });
      if (category === 'removed')
        for (const row of diff.removed) out.push({ kind: 'removed', row });
    }
    return out;
  }, [diff, openCategories]);

  const allSelected = useMemo((): Record<Category, boolean> => {
    const every = (category: Category): boolean => {
      const rows = diff?.[category] ?? [];
      return (
        rows.length > 0 &&
        rows.every((r) => selected?.has(diffSelectionKey(category, r.node_id)) ?? false)
      );
    };
    return { added: every('added'), modified: every('modified'), removed: every('removed') };
  }, [diff, selected]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: (index) => (items[index].kind === 'group' ? GROUP_HEIGHT : ROW_HEIGHT),
    overscan: 10,
    getItemKey: (index) => {
      const item = items[index];
      return item.kind === 'group' ? `group:${item.category}` : `${item.kind}:${item.row.node_id}`;
    },
  });

  if (!pending || !diff || !selected) return null;

  const counts: Record<Category, number> = {
    added: diff.added.length,
    modified: diff.modified.length,
    removed: diff.removed.length,
  };
  const selectedCount = selected.size;
  // Applying with 0 selected still marks every Removed row as stale, which is
  // a meaningful action — so we only block Apply when there's literally
  // nothing to commit.
  const canApply = selectedCount > 0 || counts.removed > 0;

  const handleApply = () => {
    onApply(diff, selected);
    clearPendingBrowse(dsName);
  };

  const handleDiscard = () => {
    clearPendingBrowse(dsName);
  };

  const toggleCategoryOpen = (category: Category) => {
    setOpenCategories((prev) => ({ ...prev, [category]: !prev[category] }));
  };

  return (
    <div className="cfg-browse-diff" role="region">
      <div className="cfg-browse-diff__header">
        <span className="cfg-browse-diff__title">
          {counts.added + counts.modified + counts.removed} changes pending
        </span>
        <span className="cfg-browse-diff__summary">
          {counts.added} added · {counts.modified} modified · {counts.removed} removed
        </span>
        <div className="cfg-browse-diff__actions">
          <Button size="sm" variant="ghost" onClick={handleDiscard}>
            Discard
          </Button>
          <Button size="sm" variant="primary" onClick={handleApply} disabled={!canApply}>
            {selectedCount > 0
              ? `Apply (${selectedCount})`
              : counts.removed > 0
                ? `Apply (mark ${counts.removed} stale)`
                : 'Apply'}
          </Button>
        </div>
      </div>

      <div className="cfg-browse-diff__body" ref={bodyRef}>
        <VirtualTreeRows
          rows={items}
          virtualizer={virtualizer}
          getRowClassName={(item) => `cfg-browse-diff__group--${itemCategory(item)}`}
          renderRow={(item) => {
            if (item.kind === 'group') {
              const { category } = item;
              const open = openCategories[category];
              return (
                <div className="cfg-browse-diff__group-header">
                  <button
                    type="button"
                    className="cfg-browse-diff__group-toggle"
                    onClick={() => toggleCategoryOpen(category)}
                    aria-expanded={open}
                  >
                    <span className="cfg-browse-diff__group-caret">{open ? '▾' : '▸'}</span>
                    <span>{CATEGORY_LABEL[category]}</span>
                    <span className="cfg-browse-diff__group-count">{counts[category]}</span>
                  </button>
                  <label className="cfg-browse-diff__group-selectall">
                    <input
                      type="checkbox"
                      checked={allSelected[category]}
                      onChange={(e) => setCategorySelection(dsName, category, e.target.checked)}
                    />
                    Select all
                  </label>
                </div>
              );
            }
            const key = diffSelectionKey(item.kind, item.row.node_id);
            const rowSelected = selected.has(key);
            const onToggle = () => toggle(dsName, key);
            if (item.kind === 'added')
              return <AddedRowItem row={item.row} selected={rowSelected} onToggle={onToggle} />;
            if (item.kind === 'removed')
              return <RemovedRowItem row={item.row} selected={rowSelected} onToggle={onToggle} />;
            return item.row.kind === 'folder-rename' ? (
              <FolderRenameRowItem row={item.row} selected={rowSelected} onToggle={onToggle} />
            ) : (
              <ModifiedRowItem row={item.row} selected={rowSelected} onToggle={onToggle} />
            );
          }}
        />
      </div>
    </div>
  );
}
