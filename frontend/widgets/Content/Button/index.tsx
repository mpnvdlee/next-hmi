/* @jsxRuntime classic */
export const schema = {
  label: { type: 'string' as const, label: 'Label', defaultValue: 'Button', group: 'Content' },
  iconName: { type: 'icon' as const, label: 'Icon', group: 'Content' },
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
  radius: {
    type: 'string' as const,
    format: 'length' as const,
    label: 'Radius',
    defaultToken: '--hmi-radius',
    group: 'Appearance',
  },
  variable: {
    type: 'struct' as const,
    label: 'Variable',
    description:
      'Optional struct driving the button from the PLC: bVisible and bEnabled gate it, bValue is written on press.',
    requiredFields: [
      { name: 'bVisible', type: 'Boolean' },
      { name: 'bEnabled', type: 'Boolean' },
      { name: 'bValue', type: 'Boolean', write: true },
    ],
  },
  actions: { type: 'actions' as const, label: 'Actions' },
};

export const description =
  'Runs actions and can bind a writable boolean struct (bVisible / bEnabled / bValue).';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'cursor-click' } as const;

export default function Button({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const scope = useHmiScope();
  const fields = usePropStruct(properties, 'variable') as Record<string, unknown>;
  const writeVariable = useWriteVariable(properties, 'variable');

  // Default visible / enabled when no struct data has arrived yet
  const bVisible = fields?.bVisible !== false;
  const bEnabled = fields?.bEnabled !== false;

  const color = getPropString(properties, 'color', undefined, evalCtx) || undefined;
  const iconName = getPropString(properties, 'iconName', '', evalCtx);
  const label = getPropString(properties, 'label', 'Button', evalCtx);
  const variant = getPropString(properties, 'variant', 'solid', evalCtx);
  const radius = getPropString(properties, 'radius', '', evalCtx);
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

  const IconComp = iconName && isBuiltinIconId(iconName) ? getBuiltinIconComponent(iconName) : null;
  const iconIsCustomAsset = iconName ? isCustomIconAssetPath(iconName) : false;
  const customSvgContent = useInlineSvg(iconIsCustomAsset ? iconName : null);

  if (!bVisible) return null;

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!bEnabled) return;

    // Execute configured actions
    const actions = properties?.actions as ActionsConfig | undefined;
    executeWidgetActions(actions?.onPress, { scope, evalCtx, anchorEl: e.currentTarget });

    writeVariable(true, { field: 'bValue' });
  };

  return (
    <div
      className={`hmi-component hmi-button${!bEnabled ? ' hmi-button--disabled' : ''}`}
      style={style}
    >
      <button
        className={`hmi-button__btn${isOutline ? ' hmi-button__btn--outline' : ''}`}
        style={colorStyle}
        onClick={handleClick}
        disabled={!bEnabled}
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
        <span className="hmi-button__label">{label}</span>
      </button>
    </div>
  );
}
