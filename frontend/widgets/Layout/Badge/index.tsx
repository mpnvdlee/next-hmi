/* @jsxRuntime classic */
export const schema = {
  badge: {
    type: ['string', 'integer'] as const,
    label: 'Badge',
    description:
      'A small chip on the top-right corner, such as an alarm count. Empty or 0 hides it.',
    group: 'Content',
  },
  color: {
    type: 'color' as const,
    label: 'Color',
    defaultToken: '--hmi-fault',
    group: 'Appearance',
  },
  offset: {
    type: 'integer' as const,
    label: 'Offset (px)',
    description:
      'Moves the chip inward from the corner; negative moves it further out. 0 centres it on the corner.',
    step: 1,
    group: 'Appearance',
  },
  size: {
    type: 'integer' as const,
    label: 'Size (px)',
    description: 'Text size of the chip; the chip scales with it.',
    min: 6,
    max: 96,
    step: 1,
    group: 'Appearance',
  },
};

export const description =
  'Puts a small chip, such as an alarm count, on the top-right corner of the one widget placed inside it.';
export const category = 'Layout & structure';
export const icon = { type: 'builtin', name: 'tag' } as const;
export const hostsChildren = true;

export default function Badge({ properties, layout, children }: HmiWidgetProps) {
  const badge = usePropString(properties, 'badge', '').trim();
  const color = usePropString(properties, 'color', '');
  const offset = usePropNumber(properties, 'offset', NaN);
  const size = usePropNumber(properties, 'size', NaN);

  const chipStyle: Record<string, string> = {};
  if (color) chipStyle['--hmi-badge-color'] = color;
  if (Number.isFinite(offset)) chipStyle['--hmi-badge-offset'] = `${offset}px`;
  if (Number.isFinite(size)) chipStyle['--hmi-badge-size'] = `${size}px`;

  return (
    <div className="hmi-badge" style={selfLayoutStyle(layout)}>
      {/* shortcut: the editor still accepts more children and only the first renders;
          add a child limit to the manifest when more widgets need one. */}
      {React.Children.toArray(children)[0]}
      {badge && badge !== '0' && (
        <span className="hmi-badge__chip" style={chipStyle}>
          {badge}
        </span>
      )}
    </div>
  );
}
