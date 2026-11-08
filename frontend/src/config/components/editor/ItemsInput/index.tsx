import BoolButtonGroup from '@config/components/ui/BoolButtonGroup';
import RowList from './RowList';
import TranslationInput from '@config/components/editor/TranslationInput';
import {
  OPTION_TYPE_EMPTY_VALUE,
  type ComponentPropertyOptionType,
} from '@shared/types/componentProperty';

/** What one row's value may hold. It is absent while the row is still being
 *  authored — a translation nobody picked yet, a number cell the author
 *  cleared — which is also how such a row survives a round-trip through JSON. */
type ItemValue = string | number | boolean | { $loc: string };

export interface ItemEntry {
  /** Plain text, or a translation the runtime shows in the current language. */
  label: string | { $loc: string };
  value?: ItemValue;
}

interface Props {
  value: ItemEntry[] | undefined;
  onChange: (v: ItemEntry[]) => void;
  /** What each row's value holds. Absent, a list holding a number edits as
   *  numbers and any other as `string` — a widget's Options field declares no
   *  value kind, and a numbered list must not show empty cells. */
  valueType?: ComponentPropertyOptionType;
  /** Labels as plain text only: a `select` property's options, which the
   *  editor itself shows, untranslated. */
  plainLabels?: boolean;
}

/**
 * ItemsInput — generic editor for an ordered list of { label, value } pairs.
 *
 * Used by any schema field declared with type: 'option-list', and by the
 * component-property editor for a `select` property's options. `valueType`
 * decides the value cell: text, a number input, a Yes/No group or a
 * translation picker. A label is plain text or a translation.
 */
export default function ItemsInput({
  value,
  onChange,
  valueType: declaredType,
  plainLabels = false,
}: Props) {
  const items: ItemEntry[] = Array.isArray(value) ? value : [];
  const valueType =
    declaredType ?? (items.some((item) => typeof item.value === 'number') ? 'float' : 'string');

  function valueCell(item: ItemEntry, updateItem: (patch: Partial<ItemEntry>) => void) {
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
            updateItem({ value: isNaN(n) ? undefined : n });
          }}
        />
      );
    }
    if (valueType === 'boolean') {
      return (
        <div className="cfg-items-input__field">
          <BoolButtonGroup
            value={typeof item.value === 'boolean' ? item.value : undefined}
            onChange={(next) => updateItem({ value: next })}
          />
        </div>
      );
    }
    if (valueType === 'loc') {
      return (
        <div className="cfg-items-input__field">
          <TranslationInput
            value={item.value}
            onChange={(next) => updateItem({ value: next as ItemValue })}
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
        onChange={(e) => updateItem({ value: e.target.value })}
      />
    );
  }

  return (
    <RowList
      items={items}
      onChange={onChange}
      newItem={() => ({ label: '', value: OPTION_TYPE_EMPTY_VALUE[valueType] })}
      cells={(item, updateItem) => (
        <>
          {plainLabels ? (
            <input
              type="text"
              className="cfg-items-input__field cfg-prop-input"
              placeholder="Label"
              value={typeof item.label === 'string' ? item.label : ''}
              onChange={(e) => updateItem({ label: e.target.value })}
            />
          ) : (
            <div className="cfg-items-input__field">
              <TranslationInput
                value={item.label}
                onChange={(next) => updateItem({ label: next as ItemEntry['label'] })}
              />
            </div>
          )}
          {valueCell(item, updateItem)}
        </>
      )}
    />
  );
}
