/* @jsxRuntime classic */
export const schema = {
  groupId: {
    type: 'page-group' as const,
    label: 'Target group',
    placeholder: '(nearest ancestor)',
  },
};

export const displayName = 'Page Navigator';
export const description = 'Previous / next controls stepping through a page group.';
export const category = 'Navigation';
export const icon = { type: 'builtin', name: 'arrows-left-right' } as const;

export default function PageNavigator({ properties, layout }: HmiWidgetProps) {
  const groupId = properties?.groupId as string | undefined;
  const entry = usePageGroup(groupId);

  if (!entry) return null;

  const { group, activePage, onNavigate } = entry;
  const siblings = group.children;
  const currentIndex = siblings.findIndex((p) => p.id === activePage.id);
  const prevPage = currentIndex > 0 ? siblings[currentIndex - 1] : null;
  const nextPage = currentIndex < siblings.length - 1 ? siblings[currentIndex + 1] : null;

  return (
    <div className="hmi-component hmi-page-navigator" style={selfLayoutStyle(layout)}>
      <button
        type="button"
        className="hmi-page-navigator__btn"
        disabled={!prevPage}
        onClick={() => prevPage && onNavigate(prevPage.id)}
        aria-label="Previous page"
      >
        ← Previous
      </button>
      <button
        type="button"
        className="hmi-page-navigator__btn"
        disabled={!nextPage}
        onClick={() => nextPage && onNavigate(nextPage.id)}
        aria-label="Next page"
      >
        Next →
      </button>
    </div>
  );
}
