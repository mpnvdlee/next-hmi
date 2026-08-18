/* @jsxRuntime classic */
export const schema = {
  orientation: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Orientation',
    display: 'button-text' as const,
    defaultValue: 'horizontal',
    options: [
      { label: 'Horizontal', value: 'horizontal' },
      { label: 'Vertical', value: 'vertical' },
    ],
  },
  thickness: {
    type: 'integer' as const,
    label: 'Thickness (px)',
    min: 1,
    step: 1,
    defaultValue: 1,
  },
  color: { type: 'color' as const, label: 'Color', defaultToken: '--hmi-border' },
  inset: { type: 'integer' as const, label: 'Inset (px)', min: 0, step: 1, defaultValue: 0 },
};

export const description = 'A thin divider line between widgets.';
export const category = 'Layout & structure';
export const icon = { type: 'builtin', name: 'columns' } as const;

export default function Separator({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const orientation = getPropString(properties, 'orientation', 'horizontal', evalCtx);
  const thickness = getPropNumber(properties, 'thickness', 1, evalCtx);
  const color = getPropString(properties, 'color', '', evalCtx);
  const inset = getPropNumber(properties, 'inset', 0, evalCtx);

  const isHorizontal = orientation !== 'vertical';

  const style: Record<string, string | number> = { ...selfLayoutStyle(layout) };
  style['--hmi-separator-thickness'] = `${thickness}px`;
  if (color) style['--hmi-separator-color'] = color;
  if (inset > 0) style['--hmi-separator-inset'] = `${inset}px`;

  return (
    <div
      className={`hmi-component hmi-separator ${isHorizontal ? 'hmi-separator--horizontal' : 'hmi-separator--vertical'}`}
      style={style}
      role="separator"
      aria-orientation={isHorizontal ? 'horizontal' : 'vertical'}
    />
  );
}
