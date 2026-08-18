import { analyzePropertyValue } from './analyzePropertyValue';

/**
 * True when `value` contains an `$http` wrapper anywhere inside it — including
 * nested in `$if` / `$switch` / `$stringExpr` and other wrappers, arrays, and
 * plain objects. A widget hands its resolved properties / layout here to decide
 * whether it needs to re-render when an HTTP response lands (see `useHttpTick`).
 *
 * Thin accessor over {@link analyzePropertyValue} — the same single, memoised walk
 * that `extractVarKeys` and `usesTime` use, so a widget needing several pays for
 * one traversal.
 */
export function usesHttp(value: unknown): boolean {
  return analyzePropertyValue(value).usesHttp;
}
