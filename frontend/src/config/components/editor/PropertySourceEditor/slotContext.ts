import { createContext, useContext } from 'react';
import type { SlotType } from './editors/utils';

/**
 * The type the nested slot being edited takes, when it is not its schema's —
 * see `SlotType`. The innermost slot that names one wins, the rule `wrapPicker`
 * applies to the variable picker, so the variable picker, a source's `field`
 * choices and the component/exported-property pickers inside one slot agree.
 */
export const SlotContext = createContext<SlotType | undefined>(undefined);

export function useSlotType(): SlotType | undefined {
  return useContext(SlotContext);
}

/**
 * Set by a slot that takes any type but only one value of it — an alarm's
 * `{n}` — so a whole array bound there asks for its element, as a scalar
 * field's does.
 */
export const TakesOneValueContext = createContext(false);
