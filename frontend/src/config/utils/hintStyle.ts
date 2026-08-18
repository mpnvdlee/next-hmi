import type { CSSProperties } from 'react';

/**
 * Placeholder for an unset field with nothing to fall back to — an empty box
 * reads as a rendering failure rather than as "this property has no value".
 * It names a state instead of standing in for a value, so it renders a size
 * down (`cfg-prop-input--no-value`).
 */
export const NO_VALUE_LABEL = 'not set';

/**
 * Width for a control hugging its resolved-default placeholder, as a custom
 * property the `cfg-prop-input--hint` CSS rule turns into a `ch` width.
 * Measured here rather than left to `field-sizing: content` so the suffix
 * lands directly behind the value in every browser, not just the ones
 * shipping that property.
 */
export function hintWidthVar(placeholder?: string): CSSProperties {
  return { '--cfg-hint-len': String((placeholder ?? '').length) } as CSSProperties;
}
