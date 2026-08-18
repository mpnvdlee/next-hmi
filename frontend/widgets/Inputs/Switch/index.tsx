/* @jsxRuntime classic */
export const schema = {
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  labelPosition: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Label position',
    group: 'Appearance',
    defaultValue: 'inline',
    options: [
      { label: 'Beside the switch', value: 'inline' },
      { label: 'Above the switch', value: 'above' },
    ],
  },
  variable: { type: 'boolean' as const, label: 'Value', group: 'Data' },
  color: {
    type: 'color' as const,
    label: 'On color',
    description: 'Replaces the theme accent while the switch is on.',
    defaultToken: '--hmi-accent',
    group: 'Appearance',
  },
};

export const description = 'A toggle that writes a boolean on/off to a variable.';
export const category = 'Inputs';
export const icon = { type: 'builtin', name: 'check-circle' } as const;

export default function Switch({ properties, layout }: HmiWidgetProps) {
  const isOn = Boolean(usePropVar(properties, 'variable'));
  const label = usePropString(properties, 'label', '');
  const labelPosition = usePropString(properties, 'labelPosition', 'inline');
  const color = usePropString(properties, 'color', '');
  const writeVariable = useWriteVariable(properties, 'variable');

  // `variable` accepts any boolean source, but only a `$var` binding can be
  // written back: a `$static` / `$if` / `$widgetProp` source renders a state
  // the writer cannot change, so the control must read as disabled rather than
  // swallow the click and snap back.
  const isReadOnly = !writeVariable.canWrite;

  return (
    <div
      className={`hmi-component hmi-switch${labelPosition === 'above' ? ' hmi-switch--above' : ''}${isReadOnly ? ' hmi-switch--disabled' : ''}`}
      style={selfLayoutStyle(layout)}
    >
      {label && <span className="hmi-switch__label">{label}</span>}
      <button
        className={`hmi-switch__track${isOn ? ' hmi-switch__track--on' : ''}`}
        style={isOn ? widgetColorStyle(color) : {}}
        type="button"
        role="switch"
        aria-checked={isOn}
        disabled={isReadOnly}
        onClick={() => writeVariable(!isOn)}
      >
        <span className="hmi-switch__thumb" />
      </button>
    </div>
  );
}
