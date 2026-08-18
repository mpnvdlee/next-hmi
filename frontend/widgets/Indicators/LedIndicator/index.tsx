/* @jsxRuntime classic */
export const schema = {
  variable: { type: 'boolean' as const, label: 'Value', group: 'Data' },
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
};

export const displayName = 'LED Indicator';
export const description = 'A status light that changes colour with a boolean.';
export const category = 'Indicators';
export const icon = { type: 'builtin', name: 'broadcast' } as const;

export default function LedIndicator({ properties, layout }: HmiWidgetProps) {
  const value = usePropVar(properties, 'variable');
  const isOn = Boolean(value);
  const label = usePropString(properties, 'label', '');

  return (
    <div
      className={`hmi-component hmi-led-indicator ${isOn ? 'hmi-led-indicator--on' : 'hmi-led-indicator--off'}`}
      style={selfLayoutStyle(layout)}
    >
      <span className="hmi-led-indicator__dot" aria-hidden="true" />
      {label && <span className="hmi-led-indicator__label">{label}</span>}
    </div>
  );
}
