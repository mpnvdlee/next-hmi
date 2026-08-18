/* @jsxRuntime classic */
export const schema = {
  mode: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Mode',
    defaultValue: 'ratio',
    options: [
      { label: 'Ratio', value: 'ratio' },
      { label: 'Percent', value: 'percent' },
    ],
  },
  ratio: {
    type: 'integer' as const,
    label: 'Ratio',
    defaultValue: 1,
    min: 0,
    max: 100,
    step: 1,
    visibleWhen: { property: 'mode', notEquals: 'percent' },
  },
  percent: {
    type: 'integer' as const,
    label: 'Percent (%)',
    defaultValue: 50,
    min: 0,
    max: 100,
    step: 1,
    visibleWhen: { property: 'mode', equals: 'percent' },
  },
};

export const displayName = 'Stretch Spacer';
export const description = 'Flexible gap that pushes neighbours apart, by ratio or percent.';
export const category = 'Layout & structure';
export const icon = { type: 'builtin', name: 'arrows-out-line-horizontal' } as const;

export default function StretchSpacer({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const mode = getPropString(properties, 'mode', 'ratio', evalCtx);

  const flex: React.CSSProperties =
    mode === 'percent'
      ? { flex: `0 0 ${Math.max(0, getPropNumber(properties, 'percent', 50, evalCtx))}%` }
      : { flex: `${Math.max(0, getPropNumber(properties, 'ratio', 1, evalCtx))} 1 0px` };

  return (
    <div
      className="hmi-stretch-spacer"
      style={{ ...flex, ...selfLayoutStyle(layout) }}
      aria-hidden="true"
    />
  );
}
