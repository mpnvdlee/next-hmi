/**
 * PropertyModal — modal for adding a new component property to a widget or dialog.
 *
 * Asks for key + type up-front; the rest of the schema is edited inline once
 * the property exists. Keys can subsequently be renamed from the property row.
 */

import './componentProperty.css';
import { useState, useRef, useEffect } from 'react';
import ModalShell, { ModalCloseButton } from '../ui/ModalShell';
import { PickerTitle } from '../ui/PickerDrawerHeader';
import PickerFooter from '../ui/PickerFooter';
import Select from '../ui/Select';
import PropRow from '../ui/PropRow';
import BoolButtonGroup from '../ui/BoolButtonGroup';
import { VALUE_TYPE_OPTIONS } from '@shared/types/componentProperty';
import { isScalarType } from '@shared/utils/valueTypes';

interface Props {
  /** Keys already in use — used for uniqueness validation */
  existingKeys: string[];
  /** Name of the component the property is added to. */
  contextName?: string;
  onConfirm(key: string, label: string, type: string): void;
  onCancel(): void;
}

export function PropertyModal({ existingKeys, contextName, onConfirm, onCancel }: Props) {
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<string>('string');
  const [isArray, setIsArray] = useState(false);

  const keyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    keyRef.current?.focus();
  }, []);

  const trimmedKey = key.trim();
  const isDuplicateKey = existingKeys.includes(trimmedKey);
  const canConfirm = trimmedKey.length > 0 && !isDuplicateKey;
  const arrayCapable = isScalarType(type);

  function handleConfirm() {
    if (!canConfirm) return;
    const finalType = arrayCapable && isArray ? `${type}[]` : type;
    onConfirm(trimmedKey, label.trim() || trimmedKey, finalType);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleConfirm();
  }

  return (
    <ModalShell
      onClose={onCancel}
      overlayClassName="cfg-picker-drawer-overlay"
      dialogClassName="cfg-drawer cfg-drawer--sm property-dialog"
    >
      <div className="cfg-modal-header">
        <PickerTitle context={contextName} action="Add property" />
        <ModalCloseButton onClose={onCancel} />
      </div>

      <div className="property-dialog__body">
        <PropRow label="Key" sourceless>
          <input
            ref={keyRef}
            className="cfg-prop-input"
            type="text"
            value={key}
            placeholder="e.g. motorVar"
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {isDuplicateKey && <span className="property-dialog__error">Key already exists</span>}
        </PropRow>

        <PropRow label="Label" sourceless>
          <input
            className="cfg-prop-input"
            type="text"
            value={label}
            placeholder="Human-readable label"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </PropRow>

        <PropRow label="Type">
          <Select value={type} onChange={(v) => setType(v)}>
            {VALUE_TYPE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </PropRow>

        {arrayCapable && (
          <PropRow
            label="Array"
            description="Bind an array of this type instead of a single value."
          >
            <BoolButtonGroup value={isArray} onChange={setIsArray} />
          </PropRow>
        )}
      </div>

      <PickerFooter
        onCancel={onCancel}
        onConfirm={handleConfirm}
        confirmLabel="Add"
        confirmDisabled={!canConfirm}
      />
    </ModalShell>
  );
}
