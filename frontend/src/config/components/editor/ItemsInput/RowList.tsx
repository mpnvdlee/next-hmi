import type { ReactNode } from 'react';
import './style.css';
import { ClearIcon } from '@config/components/ui/actionIcons';
import AddButton from '@config/components/ui/AddButton';
import { FieldHeaderActions } from '@config/components/ui/FieldGroup';

interface Props<T> {
  items: T[];
  onChange: (items: T[]) => void;
  /** The row Add item appends. */
  newItem: () => T;
  /** One row's own fields, between its move and remove buttons. */
  cells: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
}

/** An ordered list of rows the author adds, moves and removes — the frame
 *  the option list and the Data Grid's columns share. */
export default function RowList<T>({ items, onChange, newItem, cells }: Props<T>) {
  function move(idx: number, to: number) {
    const next = [...items];
    [next[idx], next[to]] = [next[to], next[idx]];
    onChange(next);
  }

  return (
    <div className="cfg-items-input">
      <FieldHeaderActions>
        <AddButton title="Add item" onClick={() => onChange([...items, newItem()])}>
          + Add item
        </AddButton>
      </FieldHeaderActions>
      {items.length === 0 && <div className="cfg-items-input__empty">No items yet</div>}
      {items.map((item, idx) => (
        <div key={idx} className="cfg-items-input__row">
          <div className="cfg-items-input__reorder">
            <button
              type="button"
              className="cfg-items-input__reorder-btn"
              title="Move up"
              disabled={idx === 0}
              onClick={() => move(idx, idx - 1)}
            >
              ▲
            </button>
            <button
              type="button"
              className="cfg-items-input__reorder-btn"
              title="Move down"
              disabled={idx >= items.length - 1}
              onClick={() => move(idx, idx + 1)}
            >
              ▼
            </button>
          </div>
          {cells(item, (patch) =>
            onChange(items.map((row, i) => (i === idx ? { ...row, ...patch } : row))),
          )}
          <button
            type="button"
            className="cfg-row-action-btn"
            title="Remove"
            onClick={() => onChange(items.filter((_, i) => i !== idx))}
          >
            <ClearIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
