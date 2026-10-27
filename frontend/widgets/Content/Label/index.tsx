/* @jsxRuntime classic */
export const schema = {
  text: { type: 'string' as const, label: 'Text', group: 'Content' },
  unit: {
    type: 'string' as const,
    label: 'Unit',
    description: 'Shown after the text in a style of its own, e.g. g or °C.',
    group: 'Content',
  },
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
  padding: {
    type: 'string' as const,
    label: 'Padding override',
    description: 'Any CSS padding, e.g. 4px 8px.',
    group: 'Appearance',
  },
  lineHeight: {
    type: 'string' as const,
    label: 'Line height',
    description: 'A factor such as 1.2, or a length.',
    group: 'Appearance',
  },
  letterSpacing: {
    type: 'string' as const,
    label: 'Letter spacing',
    description: 'Any CSS letter-spacing, e.g. 0.08em or -0.02em.',
    group: 'Appearance',
  },
  unitSize: {
    type: 'string' as const,
    label: 'Unit size',
    description: 'Font size of the unit; empty uses the text size.',
    group: 'Appearance',
  },
  unitColor: {
    type: 'color' as const,
    label: 'Unit color',
    defaultToken: '--hmi-text-muted',
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
  const lineHeight = usePropString(properties, 'lineHeight', '');
  const letterSpacing = usePropString(properties, 'letterSpacing', '');
  const unit = usePropString(properties, 'unit', '');
  const unitSize = usePropString(properties, 'unitSize', '');
  const unitColor = usePropString(properties, 'unitColor', '');
  const padding = usePropString(properties, 'padding', '');

  if (!text) return null;

  const style: Record<string, string | number> = { ...selfLayoutStyle(layout) };
  if (color) style['--hmi-label-color'] = color;
  if (size) style['--hmi-label-size'] = size;
  if (weight) style['--hmi-label-weight'] = String(weight);
  if (lineHeight) style['--hmi-label-line-height'] = lineHeight;
  if (letterSpacing) style['--hmi-label-tracking'] = letterSpacing;
  if (unitSize) style['--hmi-label-unit-size'] = unitSize;
  if (unitColor) style['--hmi-label-unit-color'] = unitColor;
  if (padding) style['--hmi-label-padding'] = padding;

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
      {unit && ' '}
      {unit && <span className="hmi-label__unit">{unit}</span>}
    </span>
  );
}
