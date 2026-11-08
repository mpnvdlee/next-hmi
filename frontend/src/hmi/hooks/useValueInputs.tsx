/**
 * Local state for Value inputs — the inputs a dialog, page, page group or
 * component instance reads once and then owns (`inputMode`).
 *
 * Each slot is a key of the variable store under `LOCAL_INPUT_DATASOURCE`, and
 * the scope hands its readers a plain `$var` to it. Reading, subscribing,
 * `$compare`, Write, Toggle and a widget's write-back therefore work on a Value
 * input exactly as on a variable, while `sendWsMessage` keeps its writes in
 * this browser. A slot belongs to one mounted frame, so a second panel showing
 * the same dialog has slots of its own, and unmounting the frame drops them.
 */

import { useMemo, useState, type ReactElement } from 'react';
import type { VarSource } from '@shared/types/config';
import ValueInputSeeder from '../components/ValueInputSeeder';
import { localInputKey } from '../store/variableStore';

export interface ValueInputSeed {
  /** Unique within the frame: the input's name, prefixed by its declaring
   *  node where one frame serves several. */
  slot: string;
  /** What the slot starts as: the value passed in, or the declared default. */
  source: unknown;
}

let frameCount = 0;

/**
 * One local slot per seed. Returns each slot's `$var`, keyed by slot, and an
 * element to render beside the frame's content that fills the slots.
 *
 * The `$var`s depend on the slot names alone, so the scope built from them
 * never changes with a value. The element does the reading, in a component of
 * its own, so the store subscriptions an evaluation needs re-render nothing
 * but it.
 */
export function useValueInputs(
  seeds: readonly ValueInputSeed[],
): [Record<string, VarSource>, ReactElement | null] {
  const [frame] = useState(() => `f${++frameCount}`);
  const slotList = seeds.map((seed) => seed.slot).join('\n');
  const vars = useMemo(() => {
    const out: Record<string, VarSource> = {};
    for (const slot of slotList ? slotList.split('\n') : []) {
      out[slot] = { $var: { path: localInputKey(frame, slot) } };
    }
    return out;
  }, [frame, slotList]);
  return [vars, seeds.length ? <ValueInputSeeder frame={frame} seeds={seeds} /> : null];
}
