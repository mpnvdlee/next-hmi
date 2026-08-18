import './style.css';
import { ClearIcon } from '@config/components/ui/actionIcons';
import AddButton from '@config/components/ui/AddButton';
import { FieldHeaderActions } from '@config/components/ui/FieldGroup';

export interface ItemEntry {
  label: string;
  value: string;
}

interface Props {
  value: ItemEntry[] | undefined;
  onChange: (v: ItemEntry[]) => void;
}

/**
 * ItemsInput — generic editor for an ordered list of { label, value } string pairs.
 *
 * Used by any schema field declared with type: 'option-list'.
 * The first consumer is Dropdown's staticOptions field.
 */
export default function ItemsInput({ value, onChange }: Props) {
  const items: ItemEntry[] = Array.isArray(value) ? value : [];

  function addItem() {
    onChange([...items, { label: '', value: '' }]);
  }

  function removeItem(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }

  function updateItem(idx: number, patch: Partial<ItemEntry>) {
    onChange(items.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  }

  function moveUp(idx: number) {
    if (idx === 0) return;
    const next = [...items];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onChange(next);
  }

  function moveDown(idx: number) {
    if (idx >= items.length - 1) return;
    const next = [...items];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onChange(next);
  }

  return (
    <div className="cfg-items-input">
      <FieldHeaderActions>
        <AddButton title="Add item" onClick={addItem}>
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
              onClick={() => moveUp(idx)}
            >
              ▲
            </button>
            <button
              type="button"
              className="cfg-items-input__reorder-btn"
              title="Move down"
              disabled={idx >= items.length - 1}
              onClick={() => moveDown(idx)}
            >
              ▼
            </button>
          </div>
          <input
            type="text"
            className="cfg-items-input__field cfg-prop-input"
            placeholder="Label"
            value={item.label}
            onChange={(e) => updateItem(idx, { label: e.target.value })}
          />
          <input
            type="text"
            className="cfg-items-input__field cfg-prop-input"
            placeholder="Value"
            value={item.value}
            onChange={(e) => updateItem(idx, { value: e.target.value })}
          />
          <button
            type="button"
            className="cfg-row-action-btn"
            title="Remove"
            onClick={() => removeItem(idx)}
          >
            <ClearIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
