import type { ReactNode } from 'react';
import Button from '../Button';

interface PickerFooterProps {
  /** Selection preview shown at the left edge, away from the buttons. */
  preview?: ReactNode;
  /** Destructive action (clear a binding, …) — sits left of Cancel. */
  destructive?: { label: string; onClick(): void };
  onCancel(): void;
  /** Omit to render a Cancel-only footer (drawers that commit on click). */
  onConfirm?(): void;
  confirmLabel?: string;
  confirmDisabled?: boolean;
}

/** Shared footer for every picker drawer: preview … destructive, Cancel, primary. */
export default function PickerFooter({
  preview,
  destructive,
  onCancel,
  onConfirm,
  confirmLabel = 'Confirm',
  confirmDisabled,
}: PickerFooterProps) {
  return (
    <div className="cfg-picker-footer">
      <div className="cfg-picker-footer__preview">{preview}</div>
      {destructive && (
        <Button variant="danger" type="button" onClick={destructive.onClick}>
          {destructive.label}
        </Button>
      )}
      <Button variant="neutral" type="button" onClick={onCancel}>
        Cancel
      </Button>
      {onConfirm && (
        <Button variant="primary" type="button" onClick={onConfirm} disabled={confirmDisabled}>
          {confirmLabel}
        </Button>
      )}
    </div>
  );
}
