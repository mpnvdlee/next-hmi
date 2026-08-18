import { useEffect } from 'react';
import type { RefObject } from 'react';

export default function useDismissOnOutsideClick<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onDismiss: () => void,
  enabled = true,
  /** Additional subtrees (e.g. a portaled popup's own root) that also count
   *  as "inside" — a click landing in any of them does not dismiss. */
  extraRefs: RefObject<HTMLElement | null>[] = [],
) {
  useEffect(() => {
    if (!enabled) return;

    let blurTimer: number | null = null;

    function isInside(target: Node) {
      if (ref.current?.contains(target)) return true;
      return extraRefs.some((extra) => extra.current?.contains(target));
    }

    function onMouseDown(event: MouseEvent) {
      if (!isInside(event.target as Node)) {
        onDismiss();
      }
    }

    function onWindowBlur() {
      // Browsers update document.activeElement after dispatching window blur
      // when focus moves into an iframe. Defer the check so clicks inside the
      // HMI preview are recognised as outside clicks.
      if (blurTimer !== null) window.clearTimeout(blurTimer);
      blurTimer = window.setTimeout(() => {
        blurTimer = null;
        if (document.activeElement?.tagName === 'IFRAME') onDismiss();
      }, 0);
    }

    function onPreviewPointerDown(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'preview_pointer_down') onDismiss();
    }

    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('message', onPreviewPointerDown);
    return () => {
      if (blurTimer !== null) window.clearTimeout(blurTimer);
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('message', onPreviewPointerDown);
    };
    // extraRefs holds ref objects, not reactive values, and callers pass
    // array literals — depending on it would resubscribe every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, onDismiss, enabled]);
}
