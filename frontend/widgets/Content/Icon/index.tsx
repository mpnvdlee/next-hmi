/* @jsxRuntime classic */
export const schema = {
  iconName: { type: 'icon' as const, label: 'Icon' },
  size: {
    type: 'integer' as const,
    label: 'Size (px)',
    defaultValue: 24,
    min: 8,
    max: 512,
    step: 1,
  },
  color: { type: 'color' as const, label: 'Color', defaultToken: '--hmi-text' },
  chrome: {
    type: 'boolean' as const,
    format: 'show' as const,
    label: 'Chip background',
    defaultValue: true,
  },
};

export const description = 'A themeable Phosphor icon at any size and colour.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'star' } as const;

export default function Icon({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const iconValue = getPropString(properties, 'iconName', '', evalCtx);
  const size = getPropNumber(properties, 'size', 24, evalCtx);
  const color = getPropString(properties, 'color', '', evalCtx) || undefined;
  const chrome = getPropBoolean(properties, 'chrome', true, evalCtx);

  const IconComp =
    iconValue && isBuiltinIconId(iconValue) ? getBuiltinIconComponent(iconValue) : null;
  const isCustomIcon = iconValue ? isCustomIconAssetPath(iconValue) : false;

  const svgContent = useInlineSvg(isCustomIcon ? iconValue : null);

  return (
    <div
      className={`hmi-component hmi-icon${chrome ? '' : ' hmi-icon--bare'}`}
      style={selfLayoutStyle(layout)}
    >
      {IconComp && (
        <span style={color ? { color } : undefined}>
          <React.Suspense fallback={null}>
            <IconComp size={size} weight="regular" />
          </React.Suspense>
        </span>
      )}
      {isCustomIcon && svgContent && (
        <span
          className="hmi-icon__svg"
          style={{ ...(color ? { color } : {}), width: size, height: size }}
          dangerouslySetInnerHTML={{ __html: svgContent }}
        />
      )}
    </div>
  );
}
