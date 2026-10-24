/* @jsxRuntime classic */
export const schema = {
  label: { type: 'string' as const, label: 'Label', defaultValue: 'Button', group: 'Content' },
  iconName: { type: 'icon' as const, label: 'Icon', group: 'Content' },
  showLabel: {
    type: 'boolean' as const,
    format: 'show' as const,
    label: 'Show label',
    description:
      'Off makes an icon-only button. The label text stays its accessible name, so keep it filled in.',
    group: 'Content',
    defaultValue: true,
  },
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
  const showLabel = getPropBoolean(properties, 'showLabel', true, evalCtx);
  const iconTop = getPropString(properties, 'iconPosition', 'left', evalCtx) === 'top';
  const fill = getPropString(properties, 'fill', '', evalCtx);
  const borderWidth = getPropNumber(properties, 'borderWidth', NaN, evalCtx);
  const iconSize = getPropNumber(properties, 'iconSize', NaN, evalCtx);
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

  const IconComp = iconName && isBuiltinIconId(iconName) ? getBuiltinIconComponent(iconName) : null;
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
        className={`hmi-button__btn${isOutline ? ' hmi-button__btn--outline' : ''}${iconTop ? ' hmi-button__btn--icon-top' : ''}`}
        style={colorStyle}
        aria-label={showLabel || !label ? undefined : label}
        title={showLabel || !label ? undefined : label}
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
        {showLabel && <span className="hmi-button__label">{label}</span>}
      </button>
    </div>
  );
}
