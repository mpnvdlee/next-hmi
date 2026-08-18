import { useEffect, type CSSProperties, type ReactNode, type RefObject } from 'react';
import CloseButton from '@shared/components/CloseButton';
import { useOwnerWindow } from '@shared/components/PopoutWindow/windowContext';

/** Standard close button used in configuration modal headers. */
export function ModalCloseButton({
  onClose,
  className = '',
}: {
  onClose: () => void;
  className?: string;
}) {
  const cls = ['cfg-modal-close', className].filter(Boolean).join(' ');
  return <CloseButton tone="config" className={cls} onClick={onClose} />;
}

interface ModalShellProps {
  children: ReactNode;
  onClose(): void;
  overlayClassName?: string;
  dialogClassName?: string;
  dialogStyle?: CSSProperties;
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export default function ModalShell({
  children,
  onClose,
  overlayClassName = '',
  dialogClassName = '',
  dialogStyle,
  closeOnEscape = true,
  initialFocusRef,
}: ModalShellProps) {
  const ownerWindow = useOwnerWindow();

  useEffect(() => {
    if (!closeOnEscape) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    ownerWindow.addEventListener('keydown', handleKeyDown);
    return () => ownerWindow.removeEventListener('keydown', handleKeyDown);
  }, [closeOnEscape, onClose, ownerWindow]);

  useEffect(() => {
    initialFocusRef?.current?.focus();
  }, [initialFocusRef]);

  const overlayClasses = ['cfg-modal-overlay', overlayClassName].filter(Boolean).join(' ');
  const dialogClasses = ['cfg-modal', dialogClassName].filter(Boolean).join(' ');

  return (
    <div className={overlayClasses} onMouseDown={onClose}>
      <div
        className={dialogClasses}
        style={dialogStyle}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
