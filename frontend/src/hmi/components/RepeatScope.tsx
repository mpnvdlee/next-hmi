import type { ReactNode } from 'react';
import { RepeatScopeContext, type RepeatScopeValue } from '../context/RepeatScopeContext';

/**
 * Publish one Repeater copy to the widgets rendered inside it — what
 * `$repeatItem`, `$var` with `repeatIndex`, and per-copy `$widgetProp` read.
 * Keep `value` referentially stable per copy: every reader re-evaluates when
 * it changes.
 */
export function RepeatScope({ value, children }: { value: RepeatScopeValue; children: ReactNode }) {
  return <RepeatScopeContext.Provider value={value}>{children}</RepeatScopeContext.Provider>;
}
