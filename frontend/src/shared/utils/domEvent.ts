export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** How a click should change the selection. */
export interface SelectionModifiers {
  /** Cmd on macOS, Ctrl elsewhere — add or remove this row, keep the rest. */
  toggle: boolean;
  /** Shift — extend from the anchor to this row. */
  range: boolean;
}

/** Shared frozen value, so a default modifier argument never allocates. */
export const NO_MODIFIERS: SelectionModifiers = Object.freeze({ toggle: false, range: false });

export function selectionModifiers(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): SelectionModifiers {
  return { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey };
}

/**
 * Returns 'c', 'x' or 'v' if the event represents a copy/cut/paste shortcut
 * that the app should handle: modifier + the key, target not editable, no
 * active text selection. Returns null otherwise. Caller is still responsible
 * for `e.preventDefault()` once it commits to handling the event.
 */
export function detectCopyPasteKey(e: KeyboardEvent): 'c' | 'x' | 'v' | null {
  if (!(e.ctrlKey || e.metaKey)) return null;
  const key = e.key.toLowerCase();
  if (key !== 'c' && key !== 'x' && key !== 'v') return null;
  if (isEditableTarget(e.target)) return null;
  if (window.getSelection()?.toString()) return null;
  return key;
}
