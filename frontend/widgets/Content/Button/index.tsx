/* @jsxRuntime classic */
export const schema = {
  label: {
    type: 'string' as const,
    label: 'Label',
    description: 'Leave it empty with an icon set for an icon-only button.',
    defaultValue: 'Button',
    group: 'Content',
  },
  subLabel: {
    type: 'string' as const,
    label: 'Second line',
    description: 'Smaller text under the label. Empty hides it.',
    group: 'Content',
  },
  badge: {
    type: ['string', 'integer'] as const,
    label: 'Badge',
    description:
      'A small chip in the top-right corner, such as an alarm count. Empty or 0 hides it.',
    group: 'Content',
  },
  iconName: { type: 'icon' as const, label: 'Icon', group: 'Content' },
  iconPosition: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Icon position',
    display: 'button-text' as const,
    group: 'Content',
    defaultValue: 'left',
    options: [
      { label: 'Left', value: 'left' },
      { label: 'Top', value: 'top' },
    ],
  },
  color: {
    type: 'color' as const,
    label: 'Color',
    defaultToken: '--hmi-accent',
    group: 'Appearance',
  },
  iconColor: {
    type: 'color' as const,
    label: 'Icon color',
    description: 'Empty uses the text color.',
    group: 'Appearance',
  },
  variant: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Style',
    group: 'Appearance',
    defaultValue: 'solid',
    options: [
      { label: 'Solid', value: 'solid' },
      { label: 'Outline', value: 'outline' },
    ],
  },
  fill: {
    type: 'color' as const,
    label: 'Fill',
    description: 'Background of the outline button; empty keeps it transparent.',
    group: 'Appearance',
    visibleWhen: { property: 'variant', equals: 'outline' },
  },
  radius: {
    type: 'string' as const,
    format: 'length' as const,
    label: 'Radius',
    defaultToken: '--hmi-radius',
    group: 'Appearance',
  },
  borderWidth: {
    type: 'integer' as const,
    label: 'Border width (px)',
    min: 0,
    step: 1,
    group: 'Appearance',
  },
  align: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Content alignment',
    display: 'button-text' as const,
    group: 'Appearance',
    defaultValue: 'center',
    options: [
      { label: 'Center', value: 'center' },
      { label: 'Start', value: 'start' },
    ],
  },
  textTransform: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Text case',
    display: 'button-text' as const,
    group: 'Appearance',
    defaultValue: 'none',
    options: [
      { label: 'As typed', value: 'none' },
      { label: 'Uppercase', value: 'uppercase' },
    ],
  },
  letterSpacing: {
    type: 'string' as const,
    label: 'Letter spacing',
    description: 'Any CSS letter-spacing for the label, e.g. 0.08em.',
    group: 'Appearance',
  },
  iconSize: {
    type: 'integer' as const,
    label: 'Icon size (px)',
    min: 8,
    max: 512,
    step: 1,
    group: 'Appearance',
  },
  variable: {
    type: 'boolean' as const,
    label: 'Variable',
    description: 'Optional boolean written true on press.',
    group: 'Data',
  },
  actions: { type: 'actions' as const, label: 'Actions' },
};

export const description = 'Runs actions and can write true to a bound boolean on press.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'cursor-click' } as const;

export default function Button({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const scope = useHmiScope();
  const writeVariable = useWriteVariable(properties, 'variable');

  const color = getPropString(properties, 'color', undefined, evalCtx) || undefined;
  const iconName = getPropString(properties, 'iconName', '', evalCtx);
  const label = getPropString(properties, 'label', 'Button', evalCtx);
  const variant = getPropString(properties, 'variant', 'solid', evalCtx);
  const radius = getPropString(properties, 'radius', '', evalCtx);
  const iconTop = getPropString(properties, 'iconPosition', 'left', evalCtx) === 'top';
  const fill = getPropString(properties, 'fill', '', evalCtx);
  const borderWidth = getPropNumber(properties, 'borderWidth', NaN, evalCtx);
  const iconSize = getPropNumber(properties, 'iconSize', NaN, evalCtx);
  const subLabel = usePropString(properties, 'subLabel', '');
  const badge = usePropString(properties, 'badge', '').trim();
  const iconColor = usePropString(properties, 'iconColor', '');
  const alignStart = usePropString(properties, 'align', 'center') === 'start';
  const uppercase = usePropString(properties, 'textTransform', 'none') === 'uppercase';
  const letterSpacing = usePropString(properties, 'letterSpacing', '');
  const isOutline = variant === 'outline';
  const colorStyle: React.CSSProperties = color
    ? isOutline
      ? { color, borderColor: color }
      : { backgroundColor: color, borderColor: color }
    : {};

  // The radius rides a custom property rather than a literal inline
  // `borderRadius`: the value is consumed by `.hmi-button__btn` one level down,
  // and leaving it unset there keeps the themed default in the stylesheet.
  const style: Record<string, string | number> = { ...selfLayoutStyle(layout) };
  if (radius) style['--hmi-btn-radius'] = radius;
  if (fill) style['--hmi-btn-fill'] = fill;
  if (Number.isFinite(borderWidth)) style['--hmi-btn-border-width'] = `${borderWidth}px`;
  if (Number.isFinite(iconSize)) style['--hmi-btn-icon-size'] = `${iconSize}px`;
  if (iconColor) style['--hmi-btn-icon-color'] = iconColor;
  if (uppercase) style['--hmi-btn-transform'] = 'uppercase';
  if (letterSpacing) style['--hmi-btn-tracking'] = letterSpacing;

  const IconComp = iconName && isBuiltinIconId(iconName) ? getBuiltinIconComponent(iconName) : null;
  // An empty label is the icon-only button; without an icon it stays an empty text button.
  const iconOnly = !!iconName && !label.trim();
  const iconIsCustomAsset = iconName ? isCustomIconAssetPath(iconName) : false;
  const customSvgContent = useInlineSvg(iconIsCustomAsset ? iconName : null);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Execute configured actions
    const actions = properties?.actions as ActionsConfig | undefined;
    executeWidgetActions(actions?.onPress, { scope, evalCtx, anchorEl: e.currentTarget });

    writeVariable(true);
  };

  return (
    <div className="hmi-component hmi-button" style={style}>
      <button
        className={`hmi-button__btn${isOutline ? ' hmi-button__btn--outline' : ''}${iconTop ? ' hmi-button__btn--icon-top' : ''}${iconOnly ? ' hmi-button__btn--icon-only' : ''}${alignStart ? ' hmi-button__btn--start' : ''}`}
        style={colorStyle}
        aria-label={iconOnly && IconComp ? iconName : undefined}
        onClick={handleClick}
      >
        {iconName && (
          <span className="hmi-button__icon" aria-hidden="true">
            {IconComp ? (
              <React.Suspense fallback={null}>
                <IconComp size={18} weight="regular" />
              </React.Suspense>
            ) : iconIsCustomAsset && customSvgContent ? (
              <span
                className="hmi-button__icon-svg"
                dangerouslySetInnerHTML={{ __html: customSvgContent }}
              />
            ) : null}
          </span>
        )}
        {!iconOnly &&
          (subLabel ? (
            <span className="hmi-button__text">
              <span className="hmi-button__label">{label}</span>
              {/* Keeps the two lines apart in the accessible name; a flex
                  column drops the whitespace from the layout. */}{' '}
              <span className="hmi-button__sub">{subLabel}</span>
            </span>
          ) : (
            <span className="hmi-button__label">{label}</span>
          ))}
        {badge && badge !== '0' && <span className="hmi-button__badge">{badge}</span>}
      </button>
    </div>
  );
}
