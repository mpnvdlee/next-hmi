/* @jsxRuntime classic */
export const schema = {
  mode: {
    type: 'String' as const,
    format: 'select' as const,
    label: 'Mode',
    group: 'Source',
    defaultValue: 'auto',
    options: [
      { label: 'Auto (mirror page tree)', value: 'auto' },
      { label: 'Manual (item list)', value: 'manual' },
    ],
  },
  items: {
    type: 'menu-items' as const,
    label: 'Items',
    group: 'Source',
    description: 'The entries the menu shows, in order. Manual mode only.',
    visibleWhen: { property: 'mode', equals: 'manual' },
  },
  orientation: {
    type: 'String' as const,
    format: 'select' as const,
    label: 'Orientation',
    group: 'Layout',
    defaultValue: 'vertical',
    options: [
      { label: 'Vertical (sidebar)', value: 'vertical' },
      { label: 'Horizontal (top-bar)', value: 'horizontal' },
    ],
  },
  display: {
    type: 'String' as const,
    format: 'select' as const,
    label: 'Display',
    group: 'Appearance',
    defaultValue: 'icon-label',
    options: [
      { label: 'Icon + label', value: 'icon-label' },
      { label: 'Icon only', value: 'icon-only' },
      { label: 'Label only', value: 'label-only' },
    ],
  },
  hierarchy: {
    type: 'String' as const,
    format: 'select' as const,
    label: 'Hierarchy',
    group: 'Source',
    defaultValue: 'tree',
    options: [
      { label: 'Tree (groups expandable)', value: 'tree' },
      { label: 'Flat (all groups flattened)', value: 'flat' },
    ],
  },
  submenuMode: {
    type: 'String' as const,
    format: 'select' as const,
    label: 'Submenu mode',
    group: 'Layout',
    defaultValue: 'auto',
    options: [
      { label: 'Auto', value: 'auto' },
      { label: 'Flyout (overlay)', value: 'flyout' },
      { label: 'Inline-expand (push siblings)', value: 'inline-expand' },
    ],
  },
  iconStrategy: {
    type: 'String' as const,
    format: 'select' as const,
    label: 'Icon strategy',
    group: 'Appearance',
    defaultValue: 'first-letter',
    options: [
      { label: 'Configured icon', value: 'configured' },
      { label: 'First letter', value: 'first-letter' },
      { label: 'None', value: 'none' },
    ],
  },
  activeStyle: {
    type: 'String' as const,
    format: 'select' as const,
    label: 'Active style',
    group: 'Appearance',
    defaultValue: 'left-border',
    options: [
      { label: 'Left border', value: 'left-border' },
      { label: 'Background', value: 'background' },
      { label: 'Underline', value: 'underline' },
    ],
  },
  groupExpansion: {
    type: 'String' as const,
    format: 'select' as const,
    label: 'Group expansion',
    group: 'Behaviour',
    defaultValue: 'auto',
    options: [
      { label: 'Auto (expand active branch)', value: 'auto' },
      { label: 'All expanded', value: 'all-expanded' },
      { label: 'All collapsed', value: 'all-collapsed' },
      { label: 'Remember (persist per browser)', value: 'remember' },
    ],
  },
  showSearch: {
    type: 'Boolean' as const,
    format: 'show' as const,
    label: 'Show search',
    defaultValue: false,
    group: 'Behaviour',
  },
  collapsed: {
    type: 'Boolean' as const,
    format: 'collapse' as const,
    label: 'Collapsed',
    group: 'Layout',
    defaultValue: false,
  },
};

export const displayName = 'Navigation Menu';
export const category = 'Navigation';
export const description =
  'Sidebar or top-bar menu mirroring the page tree, with rich display options.';
export const icon = { type: 'builtin', name: 'sidebar-simple' } as const;

// ── Types ─────────────────────────────────────────────────────────────────────

type Orientation = 'vertical' | 'horizontal';
type DisplayMode = 'icon-label' | 'icon-only' | 'label-only';
type Hierarchy = 'flat' | 'tree';
type SubmenuMode = 'flyout' | 'inline-expand' | 'auto';
type IconStrategy = 'configured' | 'first-letter' | 'none';
type ActiveStyle = 'left-border' | 'background' | 'underline';
type Mode = 'auto' | 'manual';
type GroupExpansion = 'auto' | 'all-expanded' | 'all-collapsed' | 'remember';

/** The `menu-items` property shape, as its editor writes it. Mirrors
 *  MenuItemConfig in @shared/types/config. */
type MenuItem =
  | { type: 'page-link'; pageId: string; label?: string; icon?: { $static: IconValue } }
  | {
      type: 'external-link';
      url: string;
      target?: '_self' | '_blank';
      label: string;
      icon?: { $static: IconValue };
    }
  | { type: 'action'; actions: ComponentAction[]; label: string; icon?: { $static: IconValue } }
  | { type: 'divider' }
  | { type: 'section-header'; label: string }
  | { type: 'submenu'; label: string; icon?: { $static: IconValue }; items: MenuItem[] };

const REMEMBER_STORAGE_PREFIX = 'nexthmi.navmenu.expanded.';

type ExpansionMap = Record<string, boolean>;

interface FlyoutState {
  parentId: string;
  rect: AnchorRect;
}

const EMPTY_MENU_ITEMS: MenuItem[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPageGroup(node: PageNode): node is PageGroupConfig {
  return (node as PageGroupConfig).type === 'page-group';
}

/** Match every whitespace-separated query word against one combined value, in
 *  any order. Render-time twin of matchesSearchWords in @shared/utils/search. */
function matchesSearchWords(query: string, searchable: (string | undefined)[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = searchable
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * Hidden / role-gated / order rules for one level of the tree.
 *
 * `useVisiblePages()` applies exactly this to the top level, but the shared
 * helpers behind it are deliberately shallow — every call site filters the level
 * it is about to iterate — so a menu that renders nested levels reapplies them
 * here. Same rules, and `userGroups` must come from `useCurrentUserGroups()`
 * for the same reason: it is the group source `useVisiblePages()` itself uses,
 * so the two levels of one menu cannot disagree about who is looking.
 */
function applyMetadataFilters<T extends PageNode>(nodes: T[], userGroups: string[]): T[] {
  const groups = new Set(userGroups);
  return nodes
    .filter((node) => node.hidden !== true)
    .filter((node) => !node.role || node.role.length === 0 || node.role.some((g) => groups.has(g)))
    .map((node, idx) => ({ node, idx }))
    .sort((a, b) => {
      const oa = typeof a.node.order === 'number' ? a.node.order : Number.POSITIVE_INFINITY;
      const ob = typeof b.node.order === 'number' ? b.node.order : Number.POSITIVE_INFINITY;
      return oa !== ob ? oa - ob : a.idx - b.idx;
    })
    .map((entry) => entry.node);
}

// Flat-mode flattening: page-groups inflate to their immediate page children;
// nested page-groups only inflate when `showChildPagesInMenu`.
function flattenForFlat(nodes: PageNode[]): PageNode[] {
  const out: PageNode[] = [];
  for (const node of nodes) {
    if (!isPageGroup(node)) {
      out.push(node);
      continue;
    }
    for (const child of node.children) {
      if (isPageGroup(child)) {
        if (child.showChildPagesInMenu === true) out.push(...flattenForFlat([child]));
      } else {
        out.push(child);
      }
    }
  }
  return out;
}

function filterPagesBySearch(nodes: PageNode[], query: string, ancestorPath = ''): PageNode[] {
  if (!query.trim()) return nodes;
  const filtered: PageNode[] = [];
  for (const node of nodes) {
    const title = resolvePageTitle(node.title);
    const path = ancestorPath ? `${ancestorPath} / ${title}` : title;
    if (matchesSearchWords(query, [path, node.id])) {
      filtered.push(node);
    } else if (isPageGroup(node)) {
      const children = filterPagesBySearch(node.children, query, path);
      if (children.length > 0) filtered.push({ ...node, children });
    }
  }
  return filtered;
}

function filterManualItems(items: MenuItem[], query: string, ancestorPath = ''): MenuItem[] {
  if (!query.trim()) return items;
  const filtered: MenuItem[] = [];
  for (const item of items) {
    if (item.type === 'divider') continue;
    const label = item.type === 'page-link' ? (item.label ?? item.pageId) : item.label;
    const path = ancestorPath ? `${ancestorPath} / ${label}` : label;
    const metadata =
      item.type === 'page-link'
        ? item.pageId
        : item.type === 'external-link'
          ? item.url
          : item.type;
    if (matchesSearchWords(query, [path, metadata])) {
      filtered.push(item);
    } else if (item.type === 'submenu') {
      const children = filterManualItems(item.items, query, path);
      if (children.length > 0) filtered.push({ ...item, items: children });
    }
  }
  return filtered;
}

function resolveIconLabel(
  node: { title: PageTitle; icon?: string },
  strategy: IconStrategy,
): string | null {
  if (strategy === 'none') return null;
  if (strategy === 'configured' && node.icon) return node.icon;
  // first-letter or fallback
  return resolvePageTitle(node.title).trim().slice(0, 1).toUpperCase() || '?';
}

function findGroupById(nodes: PageNode[], id: string): PageGroupConfig | null {
  for (const node of nodes) {
    if (!isPageGroup(node)) continue;
    if (node.id === id) return node;
    const nested = findGroupById(node.children, id);
    if (nested) return nested;
  }
  return null;
}

function staticIconToString(icon?: { $static: IconValue }): string | undefined {
  if (!icon) return undefined;
  const w = icon.$static;
  if (!w) return undefined;
  if (w.type === 'builtin') return w.name;
  return w.path;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function NavigationMenu({ properties, layout }: HmiWidgetProps = {}) {
  const evalCtx = useEvalContext();
  const visiblePages = useVisiblePages();
  const activePage = useActivePage();
  const navigateToPage = useNavigateToPage();
  const scope = useHmiScope();
  const userGroups = useCurrentUserGroups() as string[];
  const activePageId = activePage.pageId;
  // The resolved ancestor-group trail of the active page — the same answer a
  // per-group subtree walk would compute, already in hand.
  const activeGroupIds = activePage.groupIds;

  // Schema-driven props with defaults that preserve today's behaviour.
  const mode = getPropString(properties, 'mode', 'auto', evalCtx) as Mode;
  const orientation = getPropString(properties, 'orientation', 'vertical', evalCtx) as Orientation;
  const display = getPropString(properties, 'display', 'icon-label', evalCtx) as DisplayMode;
  const hierarchy = getPropString(properties, 'hierarchy', 'tree', evalCtx) as Hierarchy;
  const submenuMode = getPropString(properties, 'submenuMode', 'auto', evalCtx) as SubmenuMode;
  const showSearch = getPropBoolean(properties, 'showSearch', false, evalCtx);
  const iconStrategy = getPropString(
    properties,
    'iconStrategy',
    'first-letter',
    evalCtx,
  ) as IconStrategy;
  const activeStyle = getPropString(
    properties,
    'activeStyle',
    'left-border',
    evalCtx,
  ) as ActiveStyle;
  const groupExpansion = getPropString(
    properties,
    'groupExpansion',
    'auto',
    evalCtx,
  ) as GroupExpansion;

  // Optional bottom slot — accepts a single widget node (authored via JSON).
  const footerSlot = properties?.footerSlot as WidgetConfig | null | undefined;
  const isFooterSlotComponent =
    footerSlot && typeof footerSlot === 'object' && typeof footerSlot.type === 'string';

  // External `collapsed` binding takes precedence over local toggle.
  const externalCollapsed = usePropBoolean(properties, 'collapsed', false);
  const hasExternalCollapsed = properties?.collapsed !== undefined;
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = hasExternalCollapsed ? externalCollapsed : localCollapsed;

  const [expandedGroups, setExpandedGroups] = useState<ExpansionMap>(() => {
    if (groupExpansion !== 'remember' || typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(REMEMBER_STORAGE_PREFIX + 'default');
      return raw ? (JSON.parse(raw) as ExpansionMap) : {};
    } catch {
      return {};
    }
  });
  const [search, setSearch] = useState('');
  const [flyout, setFlyout] = useState<FlyoutState | null>(null);

  useEffect(() => {
    if (groupExpansion !== 'remember' || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        REMEMBER_STORAGE_PREFIX + 'default',
        JSON.stringify(expandedGroups),
      );
    } catch {
      // localStorage unavailable / quota exceeded — ignore.
    }
  }, [groupExpansion, expandedGroups]);

  const filteredPages = useMemo(
    () => filterPagesBySearch(visiblePages, search),
    [visiblePages, search],
  );

  const renderedNodes = useMemo(
    () => (hierarchy === 'flat' ? flattenForFlat(filteredPages) : filteredPages),
    [hierarchy, filteredPages],
  );

  // Effective submenu mode after auto-resolution.
  const effectiveSubmenuMode: 'flyout' | 'inline-expand' =
    submenuMode === 'auto'
      ? collapsed || orientation === 'horizontal'
        ? 'flyout'
        : 'inline-expand'
      : submenuMode;

  // Items array for manual mode.
  const manualItems = (properties?.items as MenuItem[] | undefined) ?? EMPTY_MENU_ITEMS;
  const filteredManualItems = useMemo(
    () => filterManualItems(manualItems, search),
    [manualItems, search],
  );

  // ── Helper: show submenu either as flyout or inline-expand ──
  function isGroupExpanded(group: PageGroupConfig): boolean {
    if (search.trim()) return true;
    const explicit = expandedGroups[group.id];
    if (typeof explicit === 'boolean') return explicit;
    // No explicit user override → fall back to the configured default policy.
    if (groupExpansion === 'all-expanded') return true;
    if (groupExpansion === 'all-collapsed') return false;
    if (groupExpansion === 'remember') return false; // empty memory = collapsed
    // 'auto' (default): expand the branch leading to the active page.
    if (activePageId === null) return false;
    return group.id === activePageId || activeGroupIds.includes(group.id);
  }

  function toggleGroupInline(group: PageGroupConfig) {
    setExpandedGroups((prev: ExpansionMap) => {
      const cur = typeof prev[group.id] === 'boolean' ? prev[group.id] : isGroupExpanded(group);
      return { ...prev, [group.id]: !cur };
    });
  }

  function openFlyout(group: PageGroupConfig, anchor: HTMLElement) {
    setFlyout({ parentId: group.id, rect: anchor.getBoundingClientRect() });
  }

  function closeFlyout() {
    setFlyout(null);
  }

  // ── Active class composer ──────────────────────────────────────────────────
  function activeClass(isActive: boolean): string {
    if (!isActive) return '';
    switch (activeStyle) {
      case 'background':
        return ' hmi-navmenu__link--active hmi-navmenu__link--active-bg';
      case 'underline':
        return ' hmi-navmenu__link--active hmi-navmenu__link--active-underline';
      case 'left-border':
      default:
        return ' hmi-navmenu__link--active';
    }
  }

  // ── Renderers ──────────────────────────────────────────────────────────────
  function navigateTo(id: string) {
    // Navigate urgently so the menu highlight updates immediately; HmiView
    // renders the page from a deferred id, keeping the heavy switch low-priority
    // and interruptible (see HmiView's useDeferredValue).
    navigateToPage(id);
    setFlyout(null);
  }

  function renderIcon(node: { title: PageTitle; icon?: string }): JSX.Element | null {
    if (display === 'label-only') return null;
    const label = resolveIconLabel(node, iconStrategy);
    if (!label) return null;
    if (isBuiltinIconId(label)) {
      const IconComp = getBuiltinIconComponent(label);
      if (IconComp)
        return (
          <span className="hmi-navmenu__icon">
            <React.Suspense fallback={null}>
              <IconComp size={21} weight="regular" />
            </React.Suspense>
          </span>
        );
    }
    return <span className="hmi-navmenu__icon hmi-navmenu__icon--letter">{label}</span>;
  }

  function renderLabel(label: string): JSX.Element | null {
    if (display === 'icon-only') return null;
    return <span className="hmi-navmenu__title">{label}</span>;
  }

  /**
   * Shared nav-button shape (icon + label) used by every render path below
   * (page row, group row, top-level node, manual page-link). Callers that
   * don't need a given attribute simply omit it, matching each site's
   * previous, slightly different markup exactly.
   */
  function renderNavButton({
    key,
    className,
    title,
    dataDepth,
    dataActive,
    onClick,
    node,
  }: {
    key?: string;
    className: string;
    title?: string;
    dataDepth?: number;
    dataActive?: boolean;
    onClick: () => void;
    node: { title: PageTitle; icon?: string };
  }): JSX.Element {
    return (
      <button
        key={key}
        type="button"
        className={className}
        title={title}
        data-depth={dataDepth}
        data-active={dataActive === undefined ? undefined : dataActive ? 'true' : 'false'}
        onClick={onClick}
      >
        {renderIcon(node)}
        {renderLabel(resolvePageTitle(node.title))}
      </button>
    );
  }

  function renderPageRow(page: PageNode, depth: number): JSX.Element {
    const isActive = activePageId === page.id;
    return renderNavButton({
      key: page.id,
      className: `hmi-navmenu__link hmi-navmenu__link--child${activeClass(isActive)}`,
      title: collapsed ? resolvePageTitle(page.title) : undefined,
      dataDepth: depth,
      dataActive: isActive,
      onClick: () => navigateTo(page.id),
      node: page,
    });
  }

  function renderGroupRow(group: PageGroupConfig, depth: number): JSX.Element {
    const isActive =
      activePageId !== null &&
      (group.id === activePageId || activeGroupIds.includes(group.id));
    const expanded = isGroupExpanded(group);

    return (
      <React.Fragment key={group.id}>
        <div className="hmi-navmenu__group-row">
          {renderNavButton({
            className: `hmi-navmenu__link${depth > 0 ? ' hmi-navmenu__link--child' : ''}${activeClass(isActive)}`,
            title: collapsed ? resolvePageTitle(group.title) : undefined,
            dataDepth: depth > 0 ? depth : undefined,
            dataActive: isActive,
            onClick: () => navigateTo(group.id),
            node: group,
          })}

          <button
            type="button"
            className="hmi-navmenu__expand"
            onClick={(e: { currentTarget: HTMLElement }) => {
              if (effectiveSubmenuMode === 'flyout') {
                openFlyout(group, e.currentTarget.parentElement as HTMLElement);
              } else {
                toggleGroupInline(group);
              }
            }}
            aria-label={expanded ? 'Collapse section' : 'Expand section'}
            data-testid={`group-toggle-${group.id}`}
          >
            {expanded ? '▾' : '▸'}
          </button>
        </div>

        {effectiveSubmenuMode === 'inline-expand' &&
          expanded &&
          applyMetadataFilters(group.children, userGroups).map((child) =>
            isPageGroup(child) ? renderGroupRow(child, depth + 1) : renderPageRow(child, depth + 1),
          )}
      </React.Fragment>
    );
  }

  function renderTopLevelNode(node: PageNode): JSX.Element {
    if (isPageGroup(node)) {
      if (node.showChildPagesInMenu === true && hierarchy === 'tree') {
        return renderGroupRow(node, 0);
      }
      const groupIsActive =
        (activePageId !== null && activeGroupIds.includes(node.id)) ||
        activePage.requestedId === node.id;
      return renderNavButton({
        key: node.id,
        className: `hmi-navmenu__link${activeClass(groupIsActive)}`,
        title: collapsed ? resolvePageTitle(node.title) : undefined,
        dataActive: groupIsActive,
        onClick: () => navigateTo(node.id),
        node,
      });
    }
    const pageIsActive = activePageId === node.id && activePage.groupIds.length === 0;
    return renderNavButton({
      key: node.id,
      className: `hmi-navmenu__link${activeClass(pageIsActive)}`,
      title: collapsed ? resolvePageTitle(node.title) : undefined,
      dataActive: pageIsActive,
      onClick: () => navigateTo(node.id),
      node,
    });
  }

  // ── Manual-mode rendering ───────────────────────────────────────────────────
  function renderManualItem(item: MenuItem, idx: number, depth: number): JSX.Element | null {
    if (item.type === 'divider') {
      return <div key={`d-${idx}`} className="hmi-navmenu__divider" role="separator" />;
    }
    if (item.type === 'section-header') {
      return (
        <div key={`s-${idx}`} className="hmi-navmenu__section">
          {item.label}
        </div>
      );
    }
    if (item.type === 'page-link') {
      const isActive = activePageId === item.pageId;
      const node = { title: item.label ?? item.pageId, icon: staticIconToString(item.icon) };
      return renderNavButton({
        key: `p-${item.pageId}-${idx}`,
        className: `hmi-navmenu__link${activeClass(isActive)}`,
        dataDepth: depth,
        onClick: () => navigateTo(item.pageId),
        node,
      });
    }
    if (item.type === 'external-link') {
      return (
        <a
          key={`e-${idx}`}
          className="hmi-navmenu__link"
          href={item.url}
          target={item.target ?? '_self'}
          rel={item.target === '_blank' ? 'noopener noreferrer' : undefined}
        >
          {renderIcon({ title: item.label, icon: staticIconToString(item.icon) })}
          {renderLabel(item.label)}
        </a>
      );
    }
    if (item.type === 'action') {
      return (
        <button
          key={`a-${idx}`}
          type="button"
          className="hmi-navmenu__link"
          onClick={(e: { currentTarget: HTMLElement }) =>
            executeWidgetActions(item.actions, {
              scope,
              evalCtx,
              anchorEl: e.currentTarget,
            })
          }
        >
          {renderIcon({ title: item.label, icon: staticIconToString(item.icon) })}
          {renderLabel(item.label)}
        </button>
      );
    }
    if (item.type === 'submenu') {
      const expanded = search.trim() ? true : expandedGroups[`manual-${idx}`] === true;
      const toggle = () =>
        setExpandedGroups((prev: ExpansionMap) => ({ ...prev, [`manual-${idx}`]: !expanded }));
      return (
        <React.Fragment key={`sm-${idx}`}>
          <div className="hmi-navmenu__group-row">
            <button
              type="button"
              className={`hmi-navmenu__link${depth > 0 ? ' hmi-navmenu__link--child' : ''}`}
              onClick={toggle}
            >
              {renderIcon({ title: item.label, icon: staticIconToString(item.icon) })}
              {renderLabel(item.label)}
            </button>
            <button
              type="button"
              className="hmi-navmenu__expand"
              onClick={toggle}
              aria-label={expanded ? 'Collapse section' : 'Expand section'}
            >
              {expanded ? '▾' : '▸'}
            </button>
          </div>
          {expanded && item.items.map((sub, i) => renderManualItem(sub, i, depth + 1))}
        </React.Fragment>
      );
    }
    return null;
  }

  // ── Layout / orientation classes ────────────────────────────────────────────
  const navClassName = [
    'hmi-component',
    'hmi-navmenu',
    orientation === 'horizontal' ? 'hmi-navmenu--horizontal' : '',
    collapsed ? 'hmi-navmenu--collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <nav className={navClassName} style={selfLayoutStyle(layout)}>
      {orientation === 'vertical' && !hasExternalCollapsed && (
        <button
          className="hmi-navmenu__toggle"
          onClick={() => setLocalCollapsed((c: boolean) => !c)}
          title={collapsed ? 'Expand menu' : 'Collapse menu'}
        >
          {collapsed ? '»' : '«'}
        </button>
      )}

      {showSearch && !collapsed && (
        <input
          type="search"
          className="hmi-navmenu__search"
          placeholder="Search…"
          value={search}
          onChange={(e: { target: HTMLInputElement }) => setSearch(e.target.value)}
        />
      )}

      {mode === 'manual'
        ? filteredManualItems.map((item, idx) => renderManualItem(item, idx, 0))
        : renderedNodes.map((node) => renderTopLevelNode(node))}

      {isFooterSlotComponent && (
        <div className="hmi-navmenu__footer">{renderWidget(footerSlot as WidgetConfig)}</div>
      )}

      {/* Flyout panel */}
      {flyout && effectiveSubmenuMode === 'flyout' && (
        <FlyoutPanel rect={flyout.rect} orientation={orientation} onDismiss={closeFlyout}>
          {(() => {
            const groupNode = findGroupById(visiblePages, flyout.parentId);
            if (!groupNode) return null;
            return applyMetadataFilters(groupNode.children, userGroups).map((child) =>
              isPageGroup(child) ? renderGroupRow(child, 0) : renderPageRow(child, 0),
            );
          })()}
        </FlyoutPanel>
      )}
    </nav>
  );
}

// ── Flyout panel via portal ───────────────────────────────────────────────────

function FlyoutPanel({
  rect,
  orientation,
  onDismiss,
  children,
}: {
  rect: AnchorRect;
  orientation: Orientation;
  onDismiss: () => void;
  children?: unknown;
}) {
  // Anchor: vertical → right of the parent button; horizontal → below it.
  const placement: OverlayPlacement =
    orientation === 'horizontal' ? 'trigger-below' : 'trigger-right';
  const [ref, style] = useAnchoredStyle(rect, placement);

  useEffect(() => {
    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    // Defer attach so the click that opened the flyout doesn't immediately close it.
    const t = window.setTimeout(() => {
      window.addEventListener('mousedown', onPointer);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [ref, onDismiss]);

  return createPortal(
    <div ref={ref} className="hmi-navmenu__flyout" style={style}>
      {children}
    </div>,
    document.body,
  );
}
