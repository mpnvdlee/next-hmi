import { PROPERTY_SOURCES, type PropertySource } from '@hmi/utils/propertySourceRegistry';
import Icon from '../../ui/glyphIcon';
import propertySourceIcons from './propertySourceIcons';

/** What a badge can display: a real property source, or `'mixed'` — a
 *  multi-selection whose widgets disagree on theirs. `'mixed'` is display-only;
 *  it is never a value anyone can pick or store. */
export type BadgeSource = PropertySource | 'mixed';

export const MIXED_SOURCE_LABEL = 'Mixed sources';

/** The `static` square, doubled and offset: "more than one kind". Lives here
 *  rather than in `propertySourceIcons` so that map stays a total function over
 *  `PropertySource` and a new source still forces a glyph. */
const mixedIcon = (
  <Icon viewBox="0 0 24 24" strokeWidth={2}>
    <path d="M10 3h7a4 4 0 0 1 4 4v7" />
    <rect x="3" y="10" width="11" height="11" rx="3" />
  </Icon>
);

interface Props {
  source: BadgeSource;
  /** 'cap' fills a `FieldGroup` badge slot (flush colored cap); 'pill' (default) is the small inline abbr chip used inside `cfg-source-pill`/popup rows. */
  variant?: 'pill' | 'cap';
}

export default function PropertySourceBadge({ source, variant = 'pill' }: Props) {
  const label = source === 'mixed' ? MIXED_SOURCE_LABEL : PROPERTY_SOURCES[source].label;
  const className =
    variant === 'cap'
      ? 'cfg-field-group__badge-cap cfg-property-source-badge'
      : 'cfg-source-pill__abbr cfg-property-source-badge';
  return (
    <span className={className} title={label} aria-label={label}>
      {source === 'mixed' ? mixedIcon : propertySourceIcons[source]}
    </span>
  );
}
