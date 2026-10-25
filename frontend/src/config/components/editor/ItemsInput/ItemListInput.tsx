import { useState } from 'react';
import { isRecord } from '@shared/types/propertyValueGuards';
import { FieldHeaderActions } from '@config/components/ui/FieldGroup';
import ItemsInput, { type ItemEntry } from './index';

interface Props {
  value: unknown;
  onChange: (v: unknown[]) => void;
}

function isLabelValue(item: unknown): boolean {
  return isRecord(item) && Object.keys(item).every((k) => k === 'label' || k === 'value');
}

/**
 * The static value of an `item-list` field: label / value rows, or the whole
 * list as JSON — what a list of records with fields of their own (a Repeater's
 * x / y / side) needs. Opens as JSON when any element is more than a
 * label / value pair, so no field is hidden.
 */
export default function ItemListInput({ value, onChange }: Props) {
  const items = Array.isArray(value) ? value : [];
  const [asJson, setAsJson] = useState(() => !items.every(isLabelValue));
  // The text being typed, kept while it does not parse so the author's
  // formatting survives every keystroke.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  function edit(text: string) {
    setDraft(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    setInvalid(!Array.isArray(parsed));
    if (Array.isArray(parsed)) onChange(parsed);
  }

  return (
    <>
      <FieldHeaderActions>
        <button
          type="button"
          className="cfg-btn cfg-btn--ghost cfg-btn--sm"
          onClick={() => {
            setAsJson(!asJson);
            setDraft(null);
            setInvalid(false);
          }}
        >
          {asJson ? 'Edit as rows' : 'Edit as JSON'}
        </button>
      </FieldHeaderActions>
      {asJson ? (
        <>
          <textarea
            className="cfg-prop-input"
            aria-label="Items as JSON"
            rows={8}
            spellCheck={false}
            value={draft ?? JSON.stringify(items, null, 2)}
            onChange={(e) => edit(e.target.value)}
            onBlur={() => {
              if (!invalid) setDraft(null);
            }}
          />
          {invalid && (
            <p className="cfg-prop-hint cfg-prop-hint--error">
              Not saved: the text is not a JSON list.
            </p>
          )}
        </>
      ) : (
        <ItemsInput value={items as ItemEntry[]} onChange={onChange} />
      )}
    </>
  );
}
