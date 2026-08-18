/* @jsxRuntime classic */
export const schema = {
  size: {
    type: 'integer' as const,
    label: 'Size (px)',
    defaultValue: 8,
    min: 0,
    max: 512,
    step: 1,
  },
};

export const displayName = 'Fixed Spacer';
export const description = 'A precise pixel gap between widgets.';
export const category = 'Layout & structure';
export const icon = { type: 'builtin', name: 'arrows-in-line-horizontal' } as const;

export default function FixedSpacer({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const size = Math.max(0, getPropNumber(properties, 'size', 8, evalCtx));

  return (
    <div
      className="hmi-fixed-spacer"
      style={{ flex: `0 0 ${size}px`, ...selfLayoutStyle(layout) }}
      aria-hidden="true"
    />
  );
}
