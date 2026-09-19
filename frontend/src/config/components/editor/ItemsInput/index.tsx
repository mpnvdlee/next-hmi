import './style.css';
import { ClearIcon } from '@config/components/ui/actionIcons';
import AddButton from '@config/components/ui/AddButton';
import BoolButtonGroup from '@config/components/ui/BoolButtonGroup';
import { FieldHeaderActions } from '@config/components/ui/FieldGroup';
import TranslationInput from '@config/components/editor/TranslationInput';
import {
  OPTION_TYPE_EMPTY_VALUE,
  type ComponentPropertyOptionType,
} from '@shared/types/componentProperty';

/** What one row's value may hold. It is absent while the row is still being
 *  authored — a translation nobody picked yet, a number cell the author
 *  cleared — which is also how such a row survives a round-trip through JSON. */
export type ItemValue = string | number | boolean | { $loc: string };

export interface ItemEntry {
  label: string;
  value?: ItemValue;
}

interface Props {
  value: ItemEntry[] | undefined;
  onChange: (v: ItemEntry[]) => void;
  /** What each row's value holds. Absent reads as `string` — the only kind the
   *  list offered before, and what every stored option-list still carries. */
  valueType?: ComponentPropertyOptionType;
}

/**
 * ItemsInput — generic editor for an ordered list of { label, value } pairs.
 *
 * Used by any schema field declared with type: 'option-list', and by the
 * component-property editor for a `select` property's options. `valueType`
 * decides the value cell: text, a number input, a Yes/No group or a
 * translation picker.
 */
export default function ItemsInput({ value, onChange, valueType = 'string' }: Props) {
  const items: ItemEntry[] = Array.isArray(value) ? value : [];

  function addItem() {
    onChange([...items, { label: '', value: OPTION_TYPE_EMPTY_VALUE[valueType] }]);
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

  function valueCell(item: ItemEntry, idx: number) {
    if (valueType === 'integer' || valueType === 'float') {
      const isInteger = valueType === 'integer';
      return (
        <input
          type="number"
          className="cfg-items-input__field cfg-prop-input"
          placeholder="Value"
          step={isInteger ? 1 : 'any'}
          value={typeof item.value === 'number' ? item.value : ''}
          onChange={(e) => {
            const n = isInteger ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
            // An emptied cell holds no number at all; NaN would persist as
            // `null` and turn a numbered option into a valueless one.
            updateItem(idx, { value: isNaN(n) ? undefined : n });
          }}
        />
      );
    }
    if (valueType === 'boolean') {
      return (
        <div className="cfg-items-input__field">
          <BoolButtonGroup
            value={typeof item.value === 'boolean' ? item.value : undefined}
            onChange={(next) => updateItem(idx, { value: next })}
          />
        </div>
      );
    }
    if (valueType === 'loc') {
      return (
        <div className="cfg-items-input__field">
          <TranslationInput
            value={item.value}
            onChange={(next) => updateItem(idx, { value: next as ItemValue })}
            translationOnly
          />
        </div>
      );
    }
    return (
      <input
        type="text"
        className="cfg-items-input__field cfg-prop-input"
        placeholder="Value"
        value={typeof item.value === 'string' ? item.value : ''}
        onChange={(e) => updateItem(idx, { value: e.target.value })}
      />
    );
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
          {valueCell(item, idx)}
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
