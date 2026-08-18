/* @jsxRuntime classic */
export const schema = {
  text: { type: 'string' as const, label: 'Text', group: 'Content' },
  typography: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Typography',
    group: 'Appearance',
    defaultValue: 'body',
    options: [
      { label: 'Heading', value: 'heading' },
      { label: 'Subheading', value: 'subheading' },
      { label: 'Body', value: 'body' },
      { label: 'Caption', value: 'caption' },
      { label: 'Code', value: 'code' },
      { label: 'Value', value: 'value' },
      { label: 'Label', value: 'label' },
    ],
  },
  color: {
    type: 'color' as const,
    label: 'Color',
    defaultToken: '--hmi-text',
    group: 'Appearance',
  },
  align: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Align',
    group: 'Appearance',
    defaultValue: 'left',
    options: [
      { label: 'Left', value: 'left' },
      { label: 'Center', value: 'center' },
      { label: 'Right', value: 'right' },
    ],
  },
  wrap: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Overflow',
    group: 'Appearance',
    defaultValue: 'wrap',
    options: [
      { label: 'Wrap', value: 'wrap' },
      { label: 'Truncate', value: 'truncate' },
    ],
  },
  size: {
    type: 'string' as const,
    label: 'Size override',
    group: 'Appearance',
    description: 'One-off font size for the rare case the typography combos do not cover.',
  },
  weight: {
    type: 'integer' as const,
    label: 'Weight override',
    min: 100,
    max: 900,
    step: 100,
    group: 'Appearance',
  },
};

export const description = 'Text in one of the theme typography combos, with translation support.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'text-t' } as const;

const TYPOGRAPHY = ['heading', 'subheading', 'body', 'caption', 'code', 'value', 'label'];
const ALIGN = ['left', 'center', 'right'];

export default function Label({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const text = getPropString(properties, 'text', '', evalCtx);
  const typography = getPropString(properties, 'typography', 'body', evalCtx);
  const align = getPropString(properties, 'align', 'left', evalCtx);
  const wrap = getPropString(properties, 'wrap', 'wrap', evalCtx);
  const color = getPropString(properties, 'color', '', evalCtx);
  // Escape hatches for the one-off sizes the seven theme combos don't cover.
  const size = getPropString(properties, 'size', '', evalCtx);
  const weight = getPropNumber(properties, 'weight', 0, evalCtx);

  if (!text) return null;

  const style: Record<string, string | number> = { ...selfLayoutStyle(layout) };
  if (color) style['--hmi-label-color'] = color;
  if (size) style['--hmi-label-size'] = size;
  if (weight) style['--hmi-label-weight'] = String(weight);

  const className = [
    'hmi-component',
    'hmi-label',
    `hmi-label--type-${TYPOGRAPHY.indexOf(typography) === -1 ? 'body' : typography}`,
    `hmi-label--align-${ALIGN.indexOf(align) === -1 ? 'left' : align}`,
    wrap === 'truncate' ? 'hmi-label--truncate' : 'hmi-label--wrap',
  ].join(' ');

  return (
    <span className={className} style={style}>
      {text}
    </span>
  );
}
