import { createContext, useContext } from 'react';
import type { WidgetConfig } from '@shared/types/config';

/**
 * Slot content a component instance hands to its own definition.
 *
 * The instance's children are authored in the page tree, tagged with the slot
 * they fill; `ComponentRenderer` groups them by tag and publishes them here, and
 * the `ComponentSlot` widgets inside the definition read their own key back out.
 * A nested instance re-provides, so the innermost frame wins — the same
 * shadowing rule as {@link InputScopeContext}.
 */
export const ComponentSlotContext = createContext<Record<string, WidgetConfig[]> | null>(null);

export function useComponentSlot(key: string): WidgetConfig[] {
  return useContext(ComponentSlotContext)?.[key] ?? [];
}
