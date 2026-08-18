/* @jsxRuntime classic */
export const schema = {
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  value: { type: 'string' as const, label: 'Value', group: 'Content' },
  unit: { type: 'string' as const, label: 'Unit', group: 'Content' },
  icon: {
    type: 'icon' as const,
    label: 'Icon',
    group: 'Appearance',
    description: 'Shown in a tinted square beside the reading, in row layout only.',
  },
  tone: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Tone',
    group: 'Appearance',
    defaultValue: 'accent',
    options: [
      { label: 'Accent', value: 'accent' },
      { label: 'Neutral', value: 'neutral' },
      { label: 'OK', value: 'ok' },
      { label: 'Warning', value: 'warn' },
    ],
  },
  size: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Size',
    group: 'Appearance',
    defaultValue: 'row',
    options: [
      { label: 'Row (icon left)', value: 'row' },
      { label: 'Stacked (large)', value: 'stacked' },
    ],
  },
};

export const displayName = 'Stat Tile';
export const description = 'KPI tile: label, value and unit, with a tinted icon in row mode.';
export const category = 'Indicators';
export const icon = { type: 'builtin', name: 'trend-up' } as const;

const TONES = ['accent', 'neutral', 'ok', 'warn'];
const SIZES = ['row', 'stacked'];

export default function StatTile({ properties, layout }: HmiWidgetProps) {
  const label = usePropString(properties, 'label', '');
  const value = usePropString(properties, 'value', '---');
  const unit = usePropString(properties, 'unit', '');
  const toneRaw = usePropString(properties, 'tone', 'accent');
  const sizeRaw = usePropString(properties, 'size', 'row');
  const iconId = usePropString(properties, 'icon', '');
  const IconComp = iconId && isBuiltinIconId(iconId) ? getBuiltinIconComponent(iconId) : null;

  const tone = TONES.indexOf(toneRaw) === -1 ? 'accent' : toneRaw;
  const size = SIZES.indexOf(sizeRaw) === -1 ? 'row' : sizeRaw;

  // Row tiles tint the icon and keep the number in text colour; stacked tiles
  // drop the icon and tint the number instead.
  const numTone = size === 'stacked' && tone !== 'neutral' ? ` hmi-stat-tile__num--${tone}` : '';

  return (
    <div
      className={`hmi-component hmi-stat-tile hmi-stat-tile--${size}`}
      style={selfLayoutStyle(layout)}
    >
      {size === 'row' && IconComp && (
        <div className={`hmi-stat-tile__icon hmi-stat-tile__icon--${tone}`} aria-hidden="true">
          <React.Suspense fallback={null}>
            <IconComp size={20} weight="regular" />
          </React.Suspense>
        </div>
      )}
      <div className="hmi-stat-tile__info">
        <span className="hmi-stat-tile__label">{label}</span>
        <div className="hmi-stat-tile__val">
          <span className={`hmi-stat-tile__num${numTone}`}>{value}</span>
          {unit && <span className="hmi-stat-tile__unit">{unit}</span>}
        </div>
      </div>
    </div>
  );
}
