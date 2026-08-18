/* @jsxRuntime classic */
export const schema = {
  separator: {
    type: 'string' as const,
    label: 'Separator',
    defaultValue: ' / ',
    placeholder: ' / ',
  },
  showHomeIcon: {
    type: 'boolean' as const,
    format: 'show' as const,
    label: 'Show home icon',
    defaultValue: false,
  },
  homeLabel: {
    type: 'string' as const,
    label: 'Home label',
    defaultValue: 'Home',
    placeholder: 'Home',
  },
  homePageId: {
    type: 'string' as const,
    format: 'page' as const,
    label: 'Home page',
    description: 'Page the home icon links to. Leave empty to hide the home segment.',
    placeholder: '(no home segment)',
  },
};

export const description = 'The trail of pages to where you are, with optional home icon.';
export const category = 'Navigation';
export const icon = { type: 'builtin', name: 'path' } as const;

/**
 * Breadcrumb trail of the active page's ancestors. Each segment is clickable
 * and navigates to that ancestor page or page-group.
 */
export default function Breadcrumb({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const navigateToPage = useNavigateToPage();
  const separator = getPropString(properties, 'separator', ' / ', evalCtx);
  const showHomeIcon = getPropBoolean(properties, 'showHomeIcon', false, evalCtx);
  const homeLabel = getPropString(properties, 'homeLabel', 'Home', evalCtx);
  const homePageId = getPropString(properties, 'homePageId', '', evalCtx);

  const segments = evalCtx.resolvePagePath ? evalCtx.resolvePagePath() : [];

  const showHome =
    showHomeIcon && homePageId && (segments.length === 0 || segments[0]?.id !== homePageId);
  const allSegments = showHome
    ? [{ id: homePageId, label: homeLabel || 'Home', home: true }, ...segments]
    : segments;
  const HomeIcon = showHome ? getBuiltinIconComponent('house') : null;

  if (allSegments.length === 0) return null;

  return (
    <nav
      className="hmi-component hmi-breadcrumb"
      style={selfLayoutStyle(layout)}
      aria-label="breadcrumb"
    >
      {allSegments.map((segment, idx) => {
        const isLast = idx === allSegments.length - 1;
        const iconEl =
          HomeIcon && (segment as { home?: boolean }).home ? (
            <span className="hmi-breadcrumb__icon" aria-hidden="true">
              <React.Suspense fallback={null}>
                <HomeIcon size={16} weight="regular" />
              </React.Suspense>
            </span>
          ) : null;
        return (
          <React.Fragment key={`${segment.id}-${idx}`}>
            {isLast ? (
              <span
                className="hmi-breadcrumb__segment hmi-breadcrumb__segment--current"
                aria-current="page"
              >
                {iconEl}
                {segment.label}
              </span>
            ) : (
              <button
                type="button"
                className="hmi-breadcrumb__segment hmi-breadcrumb__segment--link"
                onClick={() => navigateToPage(segment.id)}
              >
                {iconEl}
                {segment.label}
              </button>
            )}
            {!isLast && (
              <span className="hmi-breadcrumb__separator" aria-hidden="true">
                {separator}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
