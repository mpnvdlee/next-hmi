import type { CSSProperties } from 'react';
import type { BadgeSource } from './PropertySourceBadge';

export function propertySourceColorStyle(source: BadgeSource): CSSProperties {
  const token = source === 'static' || source === 'mixed' ? source : source.slice(1);
  return { '--option-color': `var(--cfg-source-${token})` } as CSSProperties;
}
