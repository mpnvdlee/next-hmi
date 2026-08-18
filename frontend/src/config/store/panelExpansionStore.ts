import { createContext, useCallback } from 'react';
import { create } from 'zustand';

/**
 * Session-scoped expand/collapse memory for the properties panel.
 *
 * On a fresh page load the store is empty, so every composite field and section
 * reads as collapsed (its `defaultExpanded` initial value applies). Toggling a
 * field writes an explicit boolean that survives switching between components
 * for as long as the page stays open, and resets only on reload — the store is
 * plain in-memory state, never persisted.
 *
 * Keys are `${scope}::${identity}` where `scope` comes from
 * {@link PanelScopeContext} (the component/composition id, so same-named fields
 * on different widgets stay independent) and `identity` is the field's
 * selection path or label.
 */
interface PanelExpansionState {
  expanded: Record<string, boolean>;
  setExpanded: (key: string, value: boolean) => void;
}

export const usePanelExpansionStore = create<PanelExpansionState>((set) => ({
  expanded: {},
  setExpanded: (key, value) =>
    set((s) => {
      if ((s.expanded[key] ?? undefined) === value) return s;
      const next = { ...s.expanded };
      next[key] = value;
      return { expanded: next };
    }),
}));

/** Panel identity a field's expand key is scoped under — set per panel root so
 *  same-named fields on different components don't share expand state. */
export const PanelScopeContext = createContext<string>('');

/**
 * Reads/writes one field's session expand state. Returns `[stored, setStored]`
 * where `stored` is `undefined` until the field has been toggled — callers fall
 * back to their own `defaultExpanded` while it is undefined. A `null`/`undefined`
 * key opts out entirely (no shared identity), leaving the field on local state.
 */
export function usePanelFieldExpanded(
  key: string | undefined,
): readonly [boolean | undefined, (value: boolean) => void] {
  const stored = usePanelExpansionStore((s) => (key ? s.expanded[key] : undefined));
  const setExpanded = usePanelExpansionStore((s) => s.setExpanded);
  const set = useCallback(
    (value: boolean) => {
      if (key) setExpanded(key, value);
    },
    [key, setExpanded],
  );
  return [stored, set] as const;
}
