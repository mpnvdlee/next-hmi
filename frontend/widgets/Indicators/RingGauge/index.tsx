/* @jsxRuntime classic */
export const schema = {
  value: { type: ['float', 'integer'] as const, label: 'Value', group: 'Data' },
  min: { type: 'float' as const, label: 'Min value', group: 'Data', step: 1, defaultValue: 0 },
  max: { type: 'float' as const, label: 'Max value', group: 'Data', step: 1, defaultValue: 100 },
  unit: { type: 'string' as const, label: 'Unit', group: 'Content', defaultValue: '%' },
  caption: { type: 'string' as const, label: 'Caption', group: 'Content' },
  decimals: {
    type: 'integer' as const,
    label: 'Decimal places',
    group: 'Appearance',
    min: 0,
    max: 3,
    step: 1,
    defaultValue: 1,
  },
  size: {
    type: 'integer' as const,
    label: 'Diameter (px)',
    group: 'Appearance',
    min: 72,
    max: 320,
    step: 4,
    defaultValue: 132,
  },
  thickness: {
    type: 'integer' as const,
    label: 'Ring thickness (px)',
    group: 'Appearance',
    min: 4,
    max: 48,
    step: 1,
    defaultValue: 18,
  },
  color: {
    type: 'color' as const,
    label: 'Ring color',
    group: 'Appearance',
    defaultToken: '--hmi-accent',
  },
};

export const displayName = 'Ring Gauge';
export const description =
  'A donut ring showing a value as a share of its range, with the reading in the hole.';
export const category = 'Indicators';
export const icon = { type: 'builtin', name: 'arrows-clockwise' } as const;

// The schema's min/max on `decimals` are editor hints, and the property is
// expression-capable: a binding can deliver anything, and toFixed throws a
// RangeError outside 0–100.
function formatValue(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '---';
  return value.toFixed(Math.min(3, Math.max(0, Math.trunc(decimals))));
}

export default function RingGauge({ properties, layout }: HmiWidgetProps) {
  const raw = usePropVar(properties, 'value');
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  const min = usePropNumber(properties, 'min', 0);
  const max = usePropNumber(properties, 'max', 100);
  const decimals = usePropNumber(properties, 'decimals', 1);
  const unit = usePropString(properties, 'unit', '%');
  const caption = usePropString(properties, 'caption', '');
  const size = usePropNumber(properties, 'size', 132);
  const thickness = usePropNumber(properties, 'thickness', 18);
  const color = usePropString(properties, 'color', '');

  const range = max - min;
  const pct = range > 0 ? Math.min(100, Math.max(0, ((value - min) / range) * 100)) : 0;
  const hole = Math.max(24, size - thickness * 2);

  const style: Record<string, string | number> = { ...selfLayoutStyle(layout) };
  style['--hmi-ring-gauge-size'] = `${size}px`;
  style['--hmi-ring-gauge-hole'] = `${hole}px`;
  style['--hmi-ring-gauge-sweep'] = `${(pct * 3.6).toFixed(2)}deg`;
  if (color) style['--hmi-ring-gauge-color'] = color;

  return (
    <div className="hmi-component hmi-ring-gauge" style={style}>
      <div className="hmi-ring-gauge__hole">
        <span className="hmi-ring-gauge__value">
          {raw == null ? '---' : formatValue(value, decimals)}
          {unit && <span className="hmi-ring-gauge__unit">{unit}</span>}
        </span>
        {caption && <span className="hmi-ring-gauge__caption">{caption}</span>}
      </div>
    </div>
  );
}
