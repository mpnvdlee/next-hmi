/* @jsxRuntime classic */
export const schema = {
  variable: { type: 'boolean' as const, label: 'Value', group: 'Data' },
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
};

export const displayName = 'LED Indicator';
export const description = 'A status light that changes colour with a boolean.';
export const category = 'Indicators';
export const icon = { type: 'builtin', name: 'broadcast' } as const;

// A tag's text "false", "0", "no" or "off" reads as off, the way getPropBoolean
// reads it; an empty text or NaN says nothing, so it stays off rather than
// taking getPropBoolean's truthy reading.
function isOnValue(value: unknown): boolean {
  if (typeof value === 'string' && value.trim() === '') return false;
  if (typeof value === 'number' && Number.isNaN(value)) return false;
  return getPropBoolean({ value }, 'value');
}

export default function LedIndicator({ properties, layout }: HmiWidgetProps) {
  const isOn = isOnValue(usePropVar(properties, 'variable'));
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
