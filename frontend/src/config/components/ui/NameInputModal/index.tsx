import './style.css';
import { useState, useRef } from 'react';
import Button from '../Button';
import ModalShell from '../ModalShell';

interface Props {
  title?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  onConfirm(name: string): void;
  onCancel(): void;
}

export default function NameInputModal({
  title = 'New Dictionary',
  placeholder = 'Dictionary name…',
  initialValue = '',
  confirmLabel = 'Create',
  onConfirm,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleConfirm() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter') handleConfirm();
  }

  return (
    <ModalShell
      onClose={onCancel}
      dialogClassName="name-modal cfg-flex-col"
      initialFocusRef={inputRef}
    >
      <div className="name-modal__title">{title}</div>
      <input
        ref={inputRef}
        className="cfg-prop-input"
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleConfirm} disabled={!value.trim()}>
          {confirmLabel}
        </Button>
      </div>
    </ModalShell>
  );
}
