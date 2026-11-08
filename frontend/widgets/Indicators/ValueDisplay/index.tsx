/* @jsxRuntime classic */
export const schema = {
  variable: {
    type: ['float', 'integer', 'byte'] as const,
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

export default function ValueDisplay({ properties, layout }: HmiWidgetProps) {
  const resolvedValue = usePropVar(properties, 'variable');
  const decimals = usePropNumber(properties, 'decimals', 1);
  const label = usePropString(properties, 'label', '');
  const unit = usePropString(properties, 'unit', '');

  const displayValue =
    resolvedValue == null
      ? '---'
      : typeof resolvedValue === 'number'
        ? formatNumber(resolvedValue, decimals)
        : String(resolvedValue);

  return (
    <div className="hmi-component hmi-value-display" style={selfLayoutStyle(layout)}>
      {label && <span className="hmi-value-display__label">{label}</span>}
      <span className="hmi-value-display__value">{displayValue}</span>
      {unit && <span className="hmi-value-display__unit">{unit}</span>}
    </div>
  );
}
