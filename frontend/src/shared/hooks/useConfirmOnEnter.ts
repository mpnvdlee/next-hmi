import { useEffect } from 'react';

/**
 * Fires `onConfirm` when Enter is pressed, unless focus is inside an
 * input/textarea/select. Used by modal pickers so typing in the search box
 * doesn't accidentally confirm.
 */
export function useConfirmOnEnter(onConfirm: () => void, disabled?: boolean): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Enter' || disabled) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      onConfirm();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, disabled]);
}
