/**
 * Parsing for CSS length strings, split out from `LengthField` so the pure
 * helper is importable without a component (Fast Refresh wants component files
 * to export only components).
 */

/**
 * The units the length field's cycle button offers by default. A unit a project
 * already stores but this list does not name joins that field's own rotation
 * (`offeredUnits` in `LengthField`), so an accidental click steps off a stored
 * `40vh` and back onto it rather than rewriting it away.
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
