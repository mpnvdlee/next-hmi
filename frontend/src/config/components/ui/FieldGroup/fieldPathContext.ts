import { createContext, useContext } from 'react';

/** Breadcrumb of display names from the panel root (component/dialog/page name)
 *  down through nested tier-3 fields — shown in the FieldDrawer header so a
 *  drawer opened several levels deep still reads as "Button › Actions › Label". */
export const FieldPathContext = createContext<string[]>([]);

/** The nearest FieldGroup's label and the slot right below it, so a leaf editor
 *  deep in the box can add a sibling row beneath the field — a bound array
 *  index. Null when there is no FieldGroup ancestor — see `FieldRowBelow`. */
export const FieldBelowSlotContext = createContext<{
  el: HTMLElement | null;
  label?: string;
} | null>(null);

/** The enclosing FieldGroup's label, for a row named after its field. */
export function useFieldLabel(): string | undefined {
  return useContext(FieldBelowSlotContext)?.label;
}
