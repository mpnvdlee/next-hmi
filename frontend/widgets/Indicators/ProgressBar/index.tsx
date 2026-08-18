/* @jsxRuntime classic */
export const schema = {
  variable: {
    type: ['float', 'integer'] as const,
    label: 'Value',
    group: 'Data',
  },
  min: { type: 'float' as const, label: 'Min value', group: 'Data', step: 1, defaultValue: 0 },
  max: { type: 'float' as const, label: 'Max value', group: 'Data', step: 1, defaultValue: 100 },
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  unit: { type: 'string' as const, label: 'Unit', group: 'Content' },
  decimals: {
    type: 'integer' as const,
    label: 'Decimal places',
    group: 'Appearance',
    min: 0,
    max: 6,
    step: 1,
    defaultValue: 0,
  },
  showValue: {
    type: 'boolean' as const,
    label: 'Show value',
    group: 'Appearance',
    defaultValue: false,
  },
  showPercent: {
    type: 'boolean' as const,
    label: 'Show percent',
    group: 'Appearance',
    defaultValue: true,
  },
  color: {
    type: 'color' as const,
    label: 'Fill color',
    group: 'Appearance',
    defaultToken: '--hmi-accent',
  },
  barHeight: {
    type: 'integer' as const,
    label: 'Bar height (px)',
    group: 'Appearance',
    min: 2,
    max: 40,
    step: 1,
  },
  dense: {
    type: 'boolean' as const,
    label: 'Dense',
    group: 'Appearance',
    description: 'Drops the padding and the minimum width, for a bar inside a tight row.',
    defaultValue: false,
  },
};

export const displayName = 'Progress Bar';
export const description = 'A horizontal bar showing a percentage or progress value.';
export const category = 'Indicators';
export const icon = { type: 'builtin', name: 'chart-bar' } as const;

// The schema's min/max on `decimals` are editor hints, and the property is
// expression-capable: a binding can deliver anything, and toFixed throws a
// RangeError outside 0–100.
function formatValue(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '---';
  return value.toFixed(Math.min(6, Math.max(0, Math.trunc(decimals))));
}

export default function ProgressBar({ properties, layout }: HmiWidgetProps) {
  const rawValue = usePropVar(properties, 'variable');
  const value = typeof rawValue === 'number' && Number.isFinite(rawValue) ? rawValue : 0;

  const min = usePropNumber(properties, 'min', 0);
  const max = usePropNumber(properties, 'max', 100);
  const decimals = usePropNumber(properties, 'decimals', 0);
  const showValue = usePropBoolean(properties, 'showValue', false);
  const showPercent = usePropBoolean(properties, 'showPercent', true);
  const label = usePropString(properties, 'label', '');
  const unit = usePropString(properties, 'unit', '');
  const color = usePropString(properties, 'color', '');
  const barHeight = usePropNumber(properties, 'barHeight', 0);
  const dense = usePropBoolean(properties, 'dense', false);

  const range = max - min;
  // A collapsed range has no proportion to express: the bar reads full once the
  // value reaches the single point min and max agree on, and empty below it.
  const pct =
    range > 0 ? Math.min(100, Math.max(0, ((value - min) / range) * 100)) : value >= min ? 100 : 0;

  const valueText =
    rawValue == null
      ? '---'
      : typeof rawValue === 'number'
        ? formatValue(rawValue, decimals)
        : String(rawValue);

  const style: Record<string, string | number> = { ...selfLayoutStyle(layout) };
  style['--hmi-progress-bar-fill'] = `${pct}%`;
  if (color) style['--hmi-progress-bar-color'] = color;
  if (barHeight) style['--hmi-progress-bar-height'] = `${barHeight}px`;

  return (
    <div
      className={`hmi-component hmi-progress-bar${dense ? ' hmi-progress-bar--dense' : ''}`}
      style={style}
    >
      {(label || showValue || showPercent) && (
        <div className="hmi-progress-bar__header">
          {label && <span className="hmi-progress-bar__label">{label}</span>}
          {(showValue || showPercent) && (
            <span className="hmi-progress-bar__readout">
              {showValue && (
                <>
                  <span className="hmi-progress-bar__value">{valueText}</span>
                  {unit && <span className="hmi-progress-bar__unit">{unit}</span>}
                </>
              )}
              {showPercent && <span className="hmi-progress-bar__percent">{pct.toFixed(0)}%</span>}
            </span>
          )}
        </div>
      )}
      <div
        className="hmi-progress-bar__track"
        role="progressbar"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={typeof rawValue === 'number' ? rawValue : undefined}
        aria-label={label || undefined}
      >
        <div className="hmi-progress-bar__fill" />
      </div>
    </div>
  );
}
