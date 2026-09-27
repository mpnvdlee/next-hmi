/* @jsxRuntime classic */
export const schema = {
  groupId: {
    type: 'page-group' as const,
    label: 'Target group',
    placeholder: '(nearest ancestor)',
  },
  previousLabel: {
    type: 'string' as const,
    label: 'Previous label',
    defaultValue: '← Previous',
    placeholder: '← Previous',
  },
  nextLabel: {
    type: 'string' as const,
    label: 'Next label',
    defaultValue: 'Next →',
    placeholder: 'Next →',
  },
  showPrevious: {
    type: 'boolean' as const,
    format: 'onoff' as const,
    label: 'Show previous',
    group: 'Appearance',
    defaultValue: true,
    description: 'Drop the Previous control entirely, rather than only disabling it.',
  },
  showNext: {
    type: 'boolean' as const,
    format: 'onoff' as const,
    label: 'Show next',
    group: 'Appearance',
    defaultValue: true,
    description: 'Drop the Next control entirely, rather than only disabling it.',
  },
  prevEnabled: {
    type: 'boolean' as const,
    format: 'onoff' as const,
    label: 'Previous enabled',
    group: 'Behaviour',
    defaultValue: true,
    description: 'Bind a condition to hold Previous shut on a step.',
  },
  nextEnabled: {
    type: 'boolean' as const,
    format: 'onoff' as const,
    label: 'Next enabled',
    group: 'Behaviour',
    defaultValue: true,
    description: 'Bind a condition to hold Next shut on a step.',
  },
};

export const displayName = 'Page Navigator';
export const description =
  'Previous / next controls stepping through a page group. Either control can be relabelled, gated on a condition, or hidden.';
export const category = 'Navigation';
export const icon = { type: 'builtin', name: 'arrows-left-right' } as const;

export default function PageNavigator({ properties, layout }: HmiWidgetProps) {
  const groupId = properties?.groupId as string | undefined;
  const entry = usePageGroup(groupId);
  const showPrevious = usePropBoolean(properties, 'showPrevious', true);
  const showNext = usePropBoolean(properties, 'showNext', true);
  const previousLabel = usePropString(properties, 'previousLabel', '← Previous');
  const nextLabel = usePropString(properties, 'nextLabel', 'Next →');
  const prevEnabled = usePropBoolean(properties, 'prevEnabled', true);
  const nextEnabled = usePropBoolean(properties, 'nextEnabled', true);

  if (!entry) return null;

  const { group, activePage, onNavigate } = entry;
  const siblings = group.children;
  const currentIndex = siblings.findIndex((p) => p.id === activePage.id);
  const prevPage = currentIndex > 0 ? siblings[currentIndex - 1] : null;
  const nextPage = currentIndex < siblings.length - 1 ? siblings[currentIndex + 1] : null;

  return (
    <div className="hmi-component hmi-page-navigator" style={selfLayoutStyle(layout)}>
      {showPrevious && (
        <button
          type="button"
          className="hmi-page-navigator__btn"
          disabled={!prevPage || !prevEnabled}
          onClick={() => prevPage && prevEnabled && onNavigate(prevPage.id)}
          aria-label="Previous page"
        >
          {previousLabel}
        </button>
      )}
      {showNext && (
        <button
          type="button"
          className="hmi-page-navigator__btn"
          disabled={!nextPage || !nextEnabled}
          onClick={() => nextPage && nextEnabled && onNavigate(nextPage.id)}
          aria-label="Next page"
        >
          {nextLabel}
        </button>
      )}
    </div>
  );
}
