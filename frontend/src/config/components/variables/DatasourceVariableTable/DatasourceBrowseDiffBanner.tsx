import { useState } from 'react';
import Button from '@config/components/ui/Button';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import {
  diffSelectionKey,
  type AddedRow,
  type BrowseDiff,
  type ChangedField,
  type FolderRenameRow,
  type ModifiedRow,
  type RemovedRow,
} from './datasourceBrowseDiff';

type Category = 'added' | 'modified' | 'removed';

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
        {row.changedFields.map((field) => (
          <span key={field} className="cfg-browse-diff__chip">
            <span className="cfg-browse-diff__chip-label">{formatField(field)}</span>
            <span className="cfg-browse-diff__chip-before">
              {formatValue(valueForField(row, field, 'before'))}
            </span>
            <span className="cfg-browse-diff__chip-arrow">→</span>
            <span className="cfg-browse-diff__chip-after">
              {formatValue(valueForField(row, field, 'after'))}
            </span>
          </span>
        ))}
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

  if (!pending) return null;

  const { diff, selected } = pending;
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

  const isCategorySelected = (category: Category): boolean => {
    const rows = diff[category];
    if (rows.length === 0) return false;
    return rows.every((r) => selected.has(diffSelectionKey(category, r.node_id)));
  };

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
    <div className="cfg-browse-diff" role="region" aria-label="Pending browse changes">
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

      {(['added', 'modified', 'removed'] as const).map((category) => {
        const rows = diff[category];
        if (rows.length === 0) return null;
        const open = openCategories[category];
        const allSelected = isCategorySelected(category);
        return (
          <div
            key={category}
            className={`cfg-browse-diff__group cfg-browse-diff__group--${category}`}
          >
            <div className="cfg-browse-diff__group-header">
              <button
                type="button"
                className="cfg-browse-diff__group-toggle"
                onClick={() => toggleCategoryOpen(category)}
                aria-expanded={open}
              >
                <span className="cfg-browse-diff__group-caret">{open ? '▾' : '▸'}</span>
                <span>{CATEGORY_LABEL[category]}</span>
                <span className="cfg-browse-diff__group-count">{rows.length}</span>
              </button>
              <label className="cfg-browse-diff__group-selectall">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => setCategorySelection(dsName, category, e.target.checked)}
                />
                Select all
              </label>
            </div>

            {open && (
              <div className="cfg-browse-diff__rows">
                {category === 'added' &&
                  diff.added.map((row) => (
                    <AddedRowItem
                      key={row.node_id}
                      row={row}
                      selected={selected.has(diffSelectionKey('added', row.node_id))}
                      onToggle={() => toggle(dsName, diffSelectionKey('added', row.node_id))}
                    />
                  ))}
                {category === 'modified' &&
                  diff.modified.map((row) =>
                    row.kind === 'folder-rename' ? (
                      <FolderRenameRowItem
                        key={row.node_id}
                        row={row}
                        selected={selected.has(diffSelectionKey('modified', row.node_id))}
                        onToggle={() => toggle(dsName, diffSelectionKey('modified', row.node_id))}
                      />
                    ) : (
                      <ModifiedRowItem
                        key={row.node_id}
                        row={row}
                        selected={selected.has(diffSelectionKey('modified', row.node_id))}
                        onToggle={() => toggle(dsName, diffSelectionKey('modified', row.node_id))}
                      />
                    ),
                  )}
                {category === 'removed' &&
                  diff.removed.map((row) => (
                    <RemovedRowItem
                      key={row.node_id}
                      row={row}
                      selected={selected.has(diffSelectionKey('removed', row.node_id))}
                      onToggle={() => toggle(dsName, diffSelectionKey('removed', row.node_id))}
                    />
                  ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
