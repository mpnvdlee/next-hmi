/* @jsxRuntime classic */
export const schema = {
  variable: { type: 'boolean' as const, label: 'Value', group: 'Data' },
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  onColor: {
    type: 'color' as const,
    label: 'On color',
    defaultToken: '--hmi-ok',
    group: 'Appearance',
  },
  offColor: {
    type: 'color' as const,
    label: 'Off color',
    defaultToken: '--hmi-text-muted',
    group: 'Appearance',
  },
};

export const displayName = 'LED Indicator';
export const description = 'A status light that changes colour with a boolean.';
export const category = 'Indicators';
export const icon = { type: 'builtin', name: 'broadcast' } as const;

export default function LedIndicator({ properties, layout }: HmiWidgetProps) {
  const isOn = usePropBoolean(properties, 'variable', null);
  const label = usePropString(properties, 'label', '');
  const onColor = usePropString(properties, 'onColor', '');
  const offColor = usePropString(properties, 'offColor', '');
  const state = isOn === null ? 'unknown' : isOn ? 'on' : 'off';

  const dotStyle: Record<string, string> = {};
  if (onColor) dotStyle['--hmi-led-on-color'] = onColor;
  if (offColor) dotStyle['--hmi-led-off-color'] = offColor;

  return (
    <div
      className={`hmi-component hmi-led-indicator hmi-led-indicator--${state}`}
      style={selfLayoutStyle(layout)}
    >
      <span className="hmi-led-indicator__dot" style={dotStyle} aria-hidden="true" />
      {label && <span className="hmi-led-indicator__label">{label}</span>}
    </div>
  );
}
