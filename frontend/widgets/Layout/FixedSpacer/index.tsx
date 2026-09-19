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
      // Longhands after the spread, not a `flex` shorthand — see StretchSpacer
      // for why: a shorthand whose value is unchanged from the previous render
      // does not get reapplied by React even when a newly-appeared longhand
      // from `layout` lands after it in this same object, so a stored `grow`
      // can still win on an update despite losing on mount.
      // `flexGrow`/`flexShrink`/`flexBasis`, always present here, avoid that:
      // this widget's own `size` prop wins on every render, not just the
      // first. `minWidth`/`maxWidth`/`minHeight`/`maxHeight` from
      // `selfLayoutStyle` are newly live too (no `.hmi-component` class to
      // have consumed the old `--self-*` vars) — accepted: they don't compete
      // with this widget's own fixed size.
      style={{ ...selfLayoutStyle(layout), flexGrow: 0, flexShrink: 0, flexBasis: `${size}px` }}
      aria-hidden="true"
    />
  );
}
