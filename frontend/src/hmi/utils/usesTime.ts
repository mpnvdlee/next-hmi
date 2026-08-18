import { analyzePropertyValue } from './analyzePropertyValue';

/**
 * True when `value` contains a `$time` wrapper anywhere inside it — including
 * nested in `$if` / `$switch` / `$stringExpr` and other wrappers, arrays, and
 * plain objects. A widget hands its resolved properties / layout here to decide
 * whether it needs the per-second `$time` tick (see `useTimeTick`).
 *
 * Thin accessor over {@link analyzePropertyValue} — the same single, memoised walk
 * that `extractVarKeys` uses, so a widget needing both pays for one traversal.
 */
export function usesTime(value: unknown): boolean {
  return analyzePropertyValue(value).usesTime;
}
