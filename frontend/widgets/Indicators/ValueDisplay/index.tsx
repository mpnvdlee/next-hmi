/* @jsxRuntime classic */
export const schema = {
  variable: {
    type: ['float', 'integer', 'boolean'] as const,
    label: 'Value',
    group: 'Data',
  },
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  unit: { type: 'string' as const, label: 'Unit', group: 'Content' },
  decimals: {
    type: 'integer' as const,
    label: 'Decimal places',
    group: 'Appearance',
    min: 0,
    max: 6,
    step: 1,
    defaultValue: 1,
  },
};

export const displayName = 'Value Display';
export const description = 'Displays a numeric value with a label and unit.';
export const category = 'Indicators';
export const icon = { type: 'builtin', name: 'thermometer' } as const;

// The schema's min/max on `decimals` are editor hints, and the property is
// expression-capable: a binding can deliver anything, and toFixed throws a
// RangeError outside 0–100.
function formatValue(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '---';
  return value.toFixed(Math.min(6, Math.max(0, Math.trunc(decimals))));
}

export default function ValueDisplay({ properties, layout }: HmiWidgetProps) {
  const resolvedValue = usePropVar(properties, 'variable');
  const decimals = usePropNumber(properties, 'decimals', 1);
  const label = usePropString(properties, 'label', '');
  const unit = usePropString(properties, 'unit', '');

  const displayValue =
    resolvedValue == null
      ? '---'
      : typeof resolvedValue === 'number'
        ? formatValue(resolvedValue, decimals)
        : String(resolvedValue);

  return (
    <div className="hmi-component hmi-value-display" style={selfLayoutStyle(layout)}>
      {label && <span className="hmi-value-display__label">{label}</span>}
      <span className="hmi-value-display__value">{displayValue}</span>
      {unit && <span className="hmi-value-display__unit">{unit}</span>}
    </div>
  );
}
