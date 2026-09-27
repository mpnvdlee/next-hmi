import type { CSSProperties } from 'react';
import type { BadgeSource } from './PropertySourceBadge';

/** Sets `--option-color` to a `--cfg-source-*` tint, which every badge, option
 *  row and popup row in the editor reads its colour from. */
export function optionColorStyle(token: string): CSSProperties {
  return { '--option-color': `var(--cfg-source-${token})` } as CSSProperties;
}

export function propertySourceColorStyle(source: BadgeSource): CSSProperties {
  return optionColorStyle(source === 'static' || source === 'mixed' ? source : source.slice(1));
}
