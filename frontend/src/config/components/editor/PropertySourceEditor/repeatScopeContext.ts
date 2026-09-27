import { createContext, useContext } from 'react';
import type { StructMember } from '@shared/types/varType';

/**
 * Published around the properties of a widget that sits inside a Repeater —
 * the editor-side twin of the runtime's `RepeatScopeContext`. Its presence is
 * what offers the Repeat item rows in the binding picker.
 */
export interface RepeatEditorScope {
  /** Member names an element is known to have, for the member picker. `null`
   *  when the shape is not known up front (an HTTP response, a recipe row). */
  members: string[] | null;
  /** The element is a variable, so it can be written to. */
  writable: boolean;
  /** Type of one element (`Float`, a struct's name, `Struct`), when known. */
  elementType?: string;
  /** Type of each member, where known. */
  memberTypes?: Record<string, string>;
  /** Each member as the variable metadata states it — full type and access —
   *  by its path below the element (`Speed`, `Io/On`), nested structs
   *  included. Present only for an element that is a variable. */
  memberInfo?: Record<string, StructMember>;
}

export const RepeatEditorScopeContext = createContext<RepeatEditorScope | null>(null);

export function useRepeatEditorScope(): RepeatEditorScope | null {
  return useContext(RepeatEditorScopeContext);
}
