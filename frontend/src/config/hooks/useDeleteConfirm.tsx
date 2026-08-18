import { useState, type ReactNode } from 'react';
import ConfirmModal from '@config/components/ui/ConfirmModal';

interface Options<T> {
  message: (target: T) => string;
  onConfirm: (target: T) => void;
  confirmLabel?: string;
}

interface Result<T> {
  ask: (target: T) => void;
  modal: ReactNode;
}

export function useDeleteConfirm<T>({
  message,
  onConfirm,
  confirmLabel = 'Delete',
}: Options<T>): Result<T> {
  const [target, setTarget] = useState<T | null>(null);

  const modal =
    target != null ? (
      <ConfirmModal
        message={message(target)}
        confirmLabel={confirmLabel}
        danger
        onConfirm={() => {
          onConfirm(target);
          setTarget(null);
        }}
        onCancel={() => setTarget(null)}
      />
    ) : null;

  return { ask: setTarget, modal };
}
