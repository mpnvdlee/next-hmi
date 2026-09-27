import { createContext, useContext } from 'react';

/**
 * One copy of a Repeater's template, published to the widgets inside it.
 * `$repeatItem` and `$var` with `repeatIndex` read the innermost frame; an outer
 * Repeater's item is out of reach from inside a nested one.
 */
export interface RepeatScopeValue {
  /** 0-based position of this copy's element in the full items array. */
  index: number;
  /** The element itself — a scalar, a record, or a struct's field map. */
  item: unknown;
  /** Composite key (`datasource:path`) of the `$var` array the items came from.
   *  Absent for every other source, which makes the item read-only. */
  arrayKey?: string;
  /** The items are a struct-array variable, whose members are leaf variables
   *  of their own rather than slices of one array value. */
  structArray?: boolean;
  /** Unique per copy across nested Repeaters. Keys `$widgetProp` exports so two
   *  copies of the same template widget do not overwrite each other. */
  key: string;
  /** The first copy drawn — the one a reader outside the Repeater sees. */
  first: boolean;
  /** An editor-canvas copy past the first: drawn for context, never edited. */
  ghost?: boolean;
}

export const RepeatScopeContext = createContext<RepeatScopeValue | null>(null);

export function useRepeatScope(): RepeatScopeValue | null {
  return useContext(RepeatScopeContext);
}
