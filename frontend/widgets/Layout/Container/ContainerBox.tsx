/* @jsxRuntime classic */
/** The Container's box, shared with Button Container, which hands in the press
 *  handlers and the class that make it a control. */
export function ContainerBox({
  properties,
  layout,
  children,
  rootProps,
}: HmiWidgetProps & { rootProps?: { className?: string } & Record<string, unknown> }) {
  const evalCtx = useEvalContext();
  const title = getPropString(properties, 'title', '', evalCtx);
  const showWhenEmpty = getPropBoolean(properties, 'showWhenEmpty', false, evalCtx);
  const background = getPropString(properties, 'background', '', evalCtx);
  const border = getPropString(properties, 'border', '', evalCtx);
  const overflow = getPropString(properties, 'overflow', 'visible', evalCtx);
  const isEmpty = React.Children.count(children) === 0;

  if (isEmpty && !showWhenEmpty) return null;

  // Inline style is the ONLY exception to the no-inline-styles rule here:
  // dynamic layout values (direction, gap, size modes, etc.) come from JSON config
  // and cannot be encoded as static CSS class names.
  const { style, ...flowAttrs } = containerLayoutProps(layout);
  // Only set fields are emitted. An unset one must NOT inherit from an ancestor
  // container — the layout barrier in hmi.css resets every `--container-*` the
  // SDK emits and `.hmi-container` the two skin vars below, so omitting a
  // field here lands on the documented default instead.
  if (background) style['--container-bg'] = background;
  if (border) style['--container-border'] = border;

  // Padding moves off `.hmi-container` itself and onto its title/content
  // children instead of staying in `style`: `.hmi-container` is also the box
  // Fill mode's flex-grow/flex-basis land on, and a border-box flex item's own
  // padding sets a floor under its flex-basis-0 math — a Fill weight of 2
  // next to weight-1 siblings stops landing at a clean 2x split the moment
  // that item's padding is non-zero while a sibling's isn't (the exact case
  // for a widget wrapped by WidgetRenderer's binding/lock overlay, which has
  // no padding of its own). `.hmi-container` never flows its own children
  // through anyway — `.hmi-container__content` does — so the inset costs
  // nothing visually by moving down a level.
  const { paddingTop, paddingRight, paddingBottom, paddingLeft, ...selfStyle } = style;
  const pad = {
    top: paddingTop ?? 'var(--hmi-space-sm)',
    right: paddingRight ?? 'var(--hmi-space-sm)',
    bottom: paddingBottom ?? 'var(--hmi-space-sm)',
    left: paddingLeft ?? 'var(--hmi-space-sm)',
  };
  // The title sits above content in `.hmi-container`'s own column, so it alone
  // carries the top inset; content always carries the bottom one, and the top
  // only when there is no title to carry it instead.
  const titleStyle = title
    ? { paddingTop: pad.top, paddingRight: pad.right, paddingLeft: pad.left }
    : undefined;
  const contentStyle = {
    paddingRight: pad.right,
    paddingBottom: pad.bottom,
    paddingLeft: pad.left,
    ...(title ? {} : { paddingTop: pad.top }),
  };

  const { className, ...rest } = rootProps ?? {};
  return (
    <div
      className={className ? `hmi-container ${className}` : 'hmi-container'}
      style={selfStyle}
      {...rest}
    >
      {title && (
        <span className="hmi-container__title" style={titleStyle}>
          {title}
        </span>
      )}
      <div
        className={
          overflow === 'clip' || overflow === 'scroll'
            ? `hmi-container__content hmi-container__content--${overflow}`
            : 'hmi-container__content'
        }
        style={contentStyle}
        {...flowAttrs}
      >
        {children}
      </div>
    </div>
  );
}
