/**
 * Parsing for CSS length strings, split out from `LengthField` so the pure
 * helper is importable without a component (Fast Refresh wants component files
 * to export only components).
 */

/**
 * Every unit the length field's cycle can reach — and so every unit it can
 * *return* to: an unlisted one a project already stores is rewritten to `px` by
 * the first click (`nextUnit` reads `indexOf` === -1 as "start over"), with no
 * way back.
 */
export const CYCLE_UNITS = ['px', '%', 'rem', 'auto'] as const;

/** Units that stand alone, with no magnitude to attach — they commit as-is. */
export const KEYWORD_UNITS: readonly string[] = ['auto'];

/**
 * Parse a stored length string ("16px", "auto", "0") into its number/unit parts
 * for the split control.
 *
 * The unit is optional — `"0"` is valid CSS and must survive the round trip —
 * and an unrecognised one is captured rather than dropped, so editing the
 * magnitude never silently rewrites someone's `ch`/`ex`/`vmin`.
 */
export function parseLength(raw: string, units: readonly string[]): { num: string; unit: string } {
  const text = raw.trim();
  if (text === '') return { num: '', unit: '' };
  const m = text.match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i);
  if (m) return { num: m[1], unit: m[2] };
  return units.includes(text) ? { num: '', unit: text } : { num: '', unit: '' };
}
