/* @jsxRuntime classic */
export const schema = {
  text: { type: 'string' as const, label: 'Text', group: 'Content' },
  subText: {
    type: 'string' as const,
    label: 'Sub text',
    group: 'Content',
    description: 'Optional second line under the text.',
  },
  tone: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Tone',
    group: 'Appearance',
    defaultValue: 'neutral',
    options: [
      { label: 'Accent', value: 'accent' },
      { label: 'Neutral', value: 'neutral' },
      { label: 'OK', value: 'ok' },
      { label: 'Warning', value: 'warn' },
      { label: 'Fault', value: 'fault' },
    ],
  },
  pulse: {
    type: 'boolean' as const,
    format: 'onoff' as const,
    label: 'Pulse',
    group: 'Appearance',
    defaultValue: false,
  },
  iconName: {
    type: 'icon' as const,
    label: 'Icon',
    group: 'Appearance',
    description: 'Shown when the dot is not pulsing.',
  },
};

export const displayName = 'Status Pill';
export const description =
  'A tone-colored status pill, with an optional second line and pulsing dot.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'activity' } as const;

const TONES = ['accent', 'neutral', 'ok', 'warn', 'fault'];

export default function StatusPill({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const text = getPropString(properties, 'text', '', evalCtx);
  const subText = getPropString(properties, 'subText', '', evalCtx);
  const toneRaw = getPropString(properties, 'tone', 'neutral', evalCtx);
  const tone = TONES.indexOf(toneRaw) === -1 ? 'neutral' : toneRaw;
  const pulse = getPropBoolean(properties, 'pulse', false, evalCtx);
  const iconName = getPropString(properties, 'iconName', '', evalCtx);
  const IconComp = iconName && isBuiltinIconId(iconName) ? getBuiltinIconComponent(iconName) : null;

  return (
    <div
      className={`hmi-component hmi-status-pill hmi-status-pill--${tone}`}
      style={selfLayoutStyle(layout)}
    >
      {pulse ? (
        <i className="hmi-status-pill__dot" aria-hidden="true" />
      ) : IconComp ? (
        <span className="hmi-status-pill__icon" aria-hidden="true">
          <React.Suspense fallback={null}>
            <IconComp size={14} weight="bold" />
          </React.Suspense>
        </span>
      ) : null}
      {(text || subText) && (
        <span className="hmi-status-pill__label">
          {text && <span className="hmi-status-pill__text">{text}</span>}
          {subText && <span className="hmi-status-pill__subtext">{subText}</span>}
        </span>
      )}
    </div>
  );
}
