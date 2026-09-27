/**
 * Lenient scalar → number used by the evaluator: `$compare` operands, `$formula`
 * wildcards, `$random` bounds and `$http`'s `refreshSeconds`.
 * Parses leading numerics (`parseFloat`), so `"5"` and trailing-unit strings
 * yield a number; non-numeric strings yield `null`. A widget's own number read
 * is stricter — see `getPropNumber`.
 */
export function toNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return isNaN(val) ? null : val;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  }
  if (typeof val === 'boolean') return val ? 1 : 0;
  return null;
}
