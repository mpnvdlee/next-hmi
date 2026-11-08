import { useEffect, useLayoutEffect, useRef } from 'react';
import { localInputKey, useVariableStore } from '../store/variableStore';
import { evaluatePropertyValue } from '../utils/propertySourceEval';
import { extractVarKeys } from '../utils/extractVarKeys';
import { useEvalContext } from '../hooks/useEvalContext';
import { useLiveScalars } from '../hooks/useLiveScalars';
import type { ValueInputSeed } from '../hooks/useValueInputs';

/**
 * Reads each slot once, when it first appears, in the surrounding context —
 * the instance's page, or the dialog the opener's values were passed into. A
 * source that reads a variable whose value has not arrived yet waits for it,
 * so an instance mounted with its page does not latch the empty store of the
 * first paint. A different source (an author editing the instance) or a new
 * `generation` (a navigation passing it again) reads again; a live change of
 * the same source does not.
 */
export default function ValueInputSeeder({
  frame,
  seeds,
}: {
  frame: string;
  seeds: readonly ValueInputSeed[];
}) {
  const evalCtx = useEvalContext();
  // slot -> the source it was read from, once it has been read.
  const seeded = useRef(new Map<string, string>());
  // Every slot this frame has put in the store, read or still waiting.
  const written = useRef(new Set<string>());

  const signatures = seeds.map((seed) => JSON.stringify([seed.source ?? null, seed.generation]));
  const waitingOn = seeds.flatMap((seed, i) =>
    seeded.current.get(seed.slot) === signatures[i] ? [] : extractVarKeys(seed.source),
  );
  const arrived = useLiveScalars(waitingOn);
  const seedSignature = JSON.stringify(seeds.map((seed, i) => [seed.slot, signatures[i]]));

  // Before paint, so the first frame the operator sees already holds the value.
  useLayoutEffect(() => {
    const { values, applyBatch, removeVars } = useVariableStore.getState();
    const updates: Record<string, unknown> = {};
    const live = new Set<string>();
    seeds.forEach((seed, i) => {
      const key = localInputKey(frame, seed.slot);
      live.add(seed.slot);
      written.current.add(seed.slot);
      if (seeded.current.get(seed.slot) === signatures[i]) return;
      if (extractVarKeys(seed.source).some((k) => values[k] === undefined)) {
        if (!(key in values)) updates[key] = null;
        return;
      }
      updates[key] = evaluatePropertyValue(seed.source, evalCtx) ?? null;
      seeded.current.set(seed.slot, signatures[i]);
    });
    const gone = [...written.current].filter((slot) => !live.has(slot));
    for (const slot of gone) {
      seeded.current.delete(slot);
      written.current.delete(slot);
    }
    applyBatch(updates);
    if (gone.length) removeVars(gone.map((slot) => localInputKey(frame, slot)));
    // `seeds` and `evalCtx` are read through the signatures, which change
    // whenever what they would seed does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, seedSignature, arrived]);

  useEffect(() => {
    const read = seeded.current;
    const slots = written.current;
    return () => {
      useVariableStore.getState().removeVars([...slots].map((slot) => localInputKey(frame, slot)));
      read.clear();
      slots.clear();
    };
  }, [frame]);

  return null;
}
