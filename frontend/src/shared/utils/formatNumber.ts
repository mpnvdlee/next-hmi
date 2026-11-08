/**
 * How the HMI writes a number for the operator: a decimal comma and no
 * thousands separator, so 1234.5 reads "1234,5". Widgets, `$stringExpr` and
 * `$loc` placeholders, alarm texts and the numpad all go through here; what
 * is stored or written to a variable stays a plain number.
 */

/** A number's JS text in the HMI's form: the decimal point becomes a comma,
 *  and a grouping comma (`Thousands`) a point, so the two never read alike. */
export function toDecimalComma(text: string): string {
  return text.replace(/[.,]/g, (c) => (c === '.' ? ',' : '.'));
}

/**
 * `value` with `decimals` digits after the comma, or with the digits it has
 * when `decimals` is left out. `decimals` is clamped to 0–6: a bound one can
 * deliver anything, and `toFixed` throws outside 0–100. Not finite: `---`.
 */
export function formatNumber(value: number, decimals?: number): string {
  if (!Number.isFinite(value)) return '---';
  const text =
    decimals === undefined
      ? String(value)
      : value.toFixed(Math.min(6, Math.max(0, Math.trunc(decimals))));
  return toDecimalComma(text);
}
