/* @jsxRuntime classic */
export const schema = {
  groupId: {
    type: 'page-group' as const,
    label: 'Target group',
    placeholder: '(nearest ancestor)',
  },
  variant: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Style',
    group: 'Appearance',
    defaultValue: 'underline',
    options: [
      { label: 'Underline', value: 'underline' },
      { label: 'Pill', value: 'pill' },
    ],
  },
  showIcons: {
    type: 'boolean' as const,
    format: 'onoff' as const,
    label: 'Show icons',
    group: 'Appearance',
    defaultValue: false,
    description: "Shows each page's own icon beside its title.",
  },
};

export const displayName = 'Tab Bar';
export const description = 'Switches between the sibling pages of a group as tabs.';
export const category = 'Navigation';
export const icon = { type: 'builtin', name: 'browsers' } as const;

const VARIANTS = ['underline', 'pill'];

export default function TabBar({ properties, layout }: HmiWidgetProps) {
  const groupId = properties?.groupId as string | undefined;
  const entry = usePageGroup(groupId);
  const variantRaw = usePropString(properties, 'variant', 'underline');
  const showIcons = usePropBoolean(properties, 'showIcons', false);
  const variant = VARIANTS.indexOf(variantRaw) === -1 ? 'underline' : variantRaw;

  if (!entry) return null;

  const { group, activePage, onNavigate } = entry;

  return (
    <div
      className={`hmi-component hmi-tab-bar hmi-tab-bar--${variant}`}
      style={selfLayoutStyle(layout)}
    >
      <div className="hmi-tab-bar__tabs" role="tablist" aria-label={resolvePageTitle(group.title)}>
        {group.children.map((child) => {
          const IconComp =
            showIcons && child.icon && isBuiltinIconId(child.icon)
              ? getBuiltinIconComponent(child.icon)
              : null;
          return (
            <button
              key={child.id}
              type="button"
              role="tab"
              aria-selected={child.id === activePage.id}
              className={`hmi-tab-bar__tab${child.id === activePage.id ? ' hmi-tab-bar__tab--active' : ''}`}
              onClick={() => onNavigate(child.id)}
            >
              {IconComp && (
                <span className="hmi-tab-bar__icon" aria-hidden="true">
                  <React.Suspense fallback={null}>
                    <IconComp size={16} weight="regular" />
                  </React.Suspense>
                </span>
              )}
              {resolvePageTitle(child.title)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
