import BoolButtonGroup from '@config/components/ui/BoolButtonGroup';
import PropRow from '@config/components/ui/PropRow';
import TranslationInput from '@config/components/editor/TranslationInput';
import { CollapsiblePropertyCard } from '@config/components/editor/PropertySourceEditor/editors/shared';
import {
  ParentPathContext,
  useParentPath,
  withSegs,
} from '@config/components/editor/PropertySourceEditor/parentPathContext';
import { isLocSource } from '@shared/types/propertyValueGuards';
import type { SchemaField } from '@shared/types/widgetSchema';
import {
  OPTION_TYPE_EMPTY_VALUE,
  type ComponentPropertyOptionType,
} from '@shared/types/componentProperty';
import PanelList from './PanelList';
import './style.css';

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

const LABEL_SCHEMA: SchemaField = { type: 'String', label: 'Label' };

/** A value or label as one line of the list shows it. */
function shown(v: unknown): string {
  if (isLocSource(v)) return v.$loc || '—';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return v === undefined || v === '' ? '—' : String(v);
}

/**
 * ItemsInput — generic editor for an ordered list of { label, value } pairs.
 *
 * Used by any schema field declared with type: 'option-list', and by the
 * component-property editor for a `select` property's options. The panel
 * shows one line per option, value first, then the label (see `PanelList`).
 * `valueType` decides the drawer's value field: text, a number input, a Yes/No
 * group or a translation picker.
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
  const path = useParentPath();

  const newItem = (): ItemEntry => ({ label: '', value: OPTION_TYPE_EMPTY_VALUE[valueType] });

  function valueField(item: ItemEntry, updateItem: (patch: Partial<ItemEntry>) => void) {
    if (valueType === 'integer' || valueType === 'float') {
      const isInteger = valueType === 'integer';
      return (
        <input
          type="number"
          className="cfg-prop-input"
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
        <BoolButtonGroup
          value={typeof item.value === 'boolean' ? item.value : undefined}
          onChange={(next) => updateItem({ value: next })}
        />
      );
    }
    if (valueType === 'loc') {
      return (
        <TranslationInput
          value={item.value}
          onChange={(next) => updateItem({ value: next as ItemValue })}
          translationOnly
        />
      );
    }
    return (
      <input
        type="text"
        className="cfg-prop-input"
        placeholder="Value"
        value={typeof item.value === 'string' ? item.value : ''}
        onChange={(e) => updateItem({ value: e.target.value })}
      />
    );
  }

  return (
    <PanelList
      title="Options"
      noun="option"
      items={items}
      onChange={onChange}
      newItem={newItem}
      empty="No options yet"
      line={(item) => (
        <>
          <span className="cfg-option-list__value">{shown(item.value)}</span>
          <span className="cfg-panel-list__text">{shown(item.label)}</span>
        </>
      )}
      itemTitle={(item) => (
        <>
          <span className="cfg-option-list__value">{shown(item.value)}</span> {shown(item.label)}
        </>
      )}
      renderItem={(item, updateItem, idx) => (
        <>
          <PropRow label="Value" block={valueType === 'loc'}>
            {valueField(item, updateItem)}
          </PropRow>
          {plainLabels ? (
            <PropRow label="Label">
              <input
                type="text"
                className="cfg-prop-input"
                placeholder="Label"
                value={typeof item.label === 'string' ? item.label : ''}
                onChange={(e) => updateItem({ label: e.target.value })}
              />
            </PropRow>
          ) : (
            // Its own path, so selecting the Options field does not mark every label.
            <ParentPathContext.Provider value={withSegs(path, String(idx), 'label')}>
              <CollapsiblePropertyCard
                title="Label"
                value={item.label}
                schema={LABEL_SCHEMA}
                forcedSources={['static', '$loc']}
                onChange={(label) => updateItem({ label: label as ItemEntry['label'] })}
              />
            </ParentPathContext.Provider>
          )}
        </>
      )}
    />
  );
}
