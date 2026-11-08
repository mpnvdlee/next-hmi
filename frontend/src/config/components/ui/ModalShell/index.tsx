import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
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
  // Read at keydown: re-subscribing on every new onClose dropped an Escape
  // whose own handler re-rendered the shell mid-dispatch.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!closeOnEscape) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      // A field that used the Escape itself (a search clearing) prevents it.
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Only the topmost shell — last in the document, as a drawer opened from
      // inside another is — closes, so a source drawer over a list drawer
      // goes on its own.
      const overlays = ownerWindow.document.querySelectorAll('.cfg-modal-overlay');
      if (overlays[overlays.length - 1] !== overlayRef.current) return;
      event.preventDefault();
      onCloseRef.current();
    };

    ownerWindow.addEventListener('keydown', handleKeyDown);
    return () => ownerWindow.removeEventListener('keydown', handleKeyDown);
  }, [closeOnEscape, ownerWindow]);

  useEffect(() => {
    initialFocusRef?.current?.focus();
  }, [initialFocusRef]);

  const overlayClasses = ['cfg-modal-overlay', overlayClassName].filter(Boolean).join(' ');
  const dialogClasses = ['cfg-modal', dialogClassName].filter(Boolean).join(' ');

  return (
    <div ref={overlayRef} className={overlayClasses} onMouseDown={onClose}>
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
