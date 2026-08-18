/* @jsxRuntime classic */
export const schema = {
  title: { type: 'string' as const, label: 'Title', group: 'Content' },
  showWhenEmpty: {
    type: 'boolean' as const,
    format: 'show' as const,
    label: 'Show when empty',
    group: 'Content',
    defaultValue: false,
    description:
      'Keep the frame and background even when every child is hidden, instead of collapsing away.',
  },
  background: { type: 'color' as const, label: 'Background', group: 'Appearance' },
  border: {
    type: 'string' as const,
    label: 'Border',
    defaultValue: 'none',
    description: 'Any CSS border shorthand, e.g. 1px solid var(--hmi-border).',
    group: 'Appearance',
  },
  shadow: {
    type: 'string' as const,
    label: 'Shadow',
    defaultValue: 'none',
    description: 'Any CSS box-shadow, e.g. var(--hmi-shadow).',
    group: 'Appearance',
  },
};

export const description =
  'Groups and lays out child widgets in a row or column. Hosts other widgets.';
export const category = 'Layout & structure';
export const icon = { type: 'builtin', name: 'stack' } as const;
/** Nodes of this type carry a `children` array; the renderer hands them in
 *  already rendered, and the editor treats the node as a drop target. */
export const hostsChildren = true;

export default function Container({ properties, layout, children }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const title = getPropString(properties, 'title', '', evalCtx);
  const showWhenEmpty = getPropBoolean(properties, 'showWhenEmpty', false, evalCtx);
  const background = getPropString(properties, 'background', '', evalCtx);
  const border = getPropString(properties, 'border', '', evalCtx);
  const shadow = getPropString(properties, 'shadow', '', evalCtx);
  const isEmpty = React.Children.count(children) === 0;

  if (isEmpty && !showWhenEmpty) return null;

  // style is the ONLY exception to the no-inline-styles rule here:
  // dynamic layout values (direction, gap, basis, etc.) come from JSON config
  // and cannot be encoded as static CSS class names.
  const style: Record<string, string | number> = containerLayoutStyle(layout) ?? {};
  // Only set fields are emitted. An unset one must NOT inherit from an ancestor
  // container — the `.hmi-container` rule resets every `--container-*` it reads,
  // so omitting a field here lands on that rule's documented default instead.
  if (background) style['--container-bg'] = background;
  if (border) style['--container-border'] = border;
  if (shadow) style['--container-shadow'] = shadow;

  return (
    <div className="hmi-container" style={style}>
      {title && <span className="hmi-container__title">{title}</span>}
      <div className="hmi-container__content">{children}</div>
    </div>
  );
}
