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

  // Longhands, not a `flex` shorthand, and set unconditionally after the
  // spread — every render supplies its own `flexGrow`/`flexShrink`/`flexBasis`
  // for React to diff against the previous render's, so they always win over
  // whatever a stored `grow` a layout carries (this widget has
  // no `.hmi-component` class, so the Layout panel's Fill/weight rows are
  // irrelevant to it — it sizes from Ratio/Percent alone). A shorthand here
  // would break on an update where only `layout` changes: React skips
  // reapplying a style key whose value is unchanged from the previous render,
  // so an unchanged `flex` shorthand would not re-run and a newly-appeared
  // `flexGrow`/`flexBasis` from `layout` would land after it and win anyway —
  // same bug a mount-only spread-order fix cannot prevent, since React diffs
  // per key across renders, not per object-literal position within one.
  const size: React.CSSProperties =
    mode === 'percent'
      ? {
          flexGrow: 0,
          flexShrink: 0,
          flexBasis: `${Math.max(0, getPropNumber(properties, 'percent', 50, evalCtx))}%`,
        }
      : {
          flexGrow: Math.max(0, getPropNumber(properties, 'ratio', 1, evalCtx)),
          flexShrink: 1,
          flexBasis: '0px',
        };

  return (
    <div
      className="hmi-stretch-spacer"
      // `selfLayoutStyle` also carries `minWidth`/`maxWidth`/`minHeight`/
      // `maxHeight` when the panel has them set. Before this widget switched
      // from custom properties to direct CSS properties, those four were inert
      // here too (no `.hmi-component` class to consume the old `--self-*`
      // vars) — now they apply, same as `width`/`height` already did.
      // Accepted, not overridden: they constrain rather than size, so they do
      // not compete with this widget's own Ratio/Percent the way a stored
      // `grow` would.
      style={{ ...selfLayoutStyle(layout), ...size }}
      aria-hidden="true"
    />
  );
}
