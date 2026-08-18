/* @jsxRuntime classic */
export const schema = {
  text: {
    type: 'string' as const,
    label: 'Text',
    group: 'Content',
    placeholder: '(defaults to current page title)',
  },
  subtitle: {
    type: 'string' as const,
    label: 'Subtitle',
    group: 'Content',
  },
  iconName: {
    type: 'icon' as const,
    label: 'Icon',
    group: 'Content',
    placeholder: '(defaults to current page icon)',
  },
};

export const displayName = 'Page Title';
export const description = "The current page's title and icon, or your own override text.";
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'text-t' } as const;

/**
 * Themed page title. Defaults to the active page's `$page.title` and
 * `$page.icon`. Override the `text`, `subtitle` or `iconName` properties to
 * display custom strings or any expression.
 */
export default function PageTitle({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const titleFallback = (evalCtx.resolvePage?.('title') as string | null) ?? '';
  const iconFallback = (evalCtx.resolvePage?.('icon') as string | null) ?? '';
  const text = getPropString(properties, 'text', titleFallback, evalCtx);
  const subtitle = getPropString(properties, 'subtitle', '', evalCtx);
  const iconName = getPropString(properties, 'iconName', iconFallback, evalCtx);
  const IconComp = iconName && isBuiltinIconId(iconName) ? getBuiltinIconComponent(iconName) : null;

  if (!text && !subtitle) return null;
  return (
    <div className="hmi-component hmi-page-title" style={selfLayoutStyle(layout)}>
      {IconComp && (
        <span className="hmi-page-title__icon" aria-hidden="true">
          <React.Suspense fallback={null}>
            <IconComp size={28} weight="regular" />
          </React.Suspense>
        </span>
      )}
      <div className="hmi-page-title__text">
        {text && <h1 className="hmi-page-title__title">{text}</h1>}
        {subtitle && <span className="hmi-page-title__subtitle">{subtitle}</span>}
      </div>
    </div>
  );
}
