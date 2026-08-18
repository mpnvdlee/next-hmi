import { Fragment, Suspense, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import type {
  HmiWidgetProps,
  IconValue,
  MenuItemConfig,
  OverlayPlacement,
  PageConfig,
  PageGroupConfig,
  PageNode,
  PageTitle,
} from '@shared/types/config';
import {
  filterByRole,
  filterHidden,
  isPageGroup,
  resolvePageContext,
  resolvePageTitle,
  sortPagesByOrder,
} from '@shared/utils/pageTree';
import { useAnchoredStyle } from '@shared/hooks/useAnchoredStyle';
import { useHmiStore } from '../../store/hmiStore';
import { useHmiScope } from '../../context/HmiScopeContext';
import { useReactiveEval } from '@hmi/hooks/useReactiveEval';
import { executeWidgetActions } from '@hmi/utils/widgetActions';
import { getPropString, getPropBoolean, usePropBoolean } from '../layoutUtils';
import { getBuiltinIconComponent, isBuiltinIconId } from '@shared/utils/phosphorIcons';
import WidgetRenderer from '../WidgetRenderer';
import type { WidgetConfig } from '@shared/types/config';
import styles from './index.module.css';
import { matchesSearchWords } from '@shared/utils/search';

// ── Types ─────────────────────────────────────────────────────────────────────

type Orientation = 'vertical' | 'horizontal';
type DisplayMode = 'icon-label' | 'icon-only' | 'label-only';
type Hierarchy = 'flat' | 'tree';
type SubmenuMode = 'flyout' | 'inline-expand' | 'auto';
type IconStrategy = 'configured' | 'first-letter' | 'none';
type ActiveStyle = 'left-border' | 'background' | 'underline';
type Mode = 'auto' | 'manual';
type GroupExpansion = 'auto' | 'all-expanded' | 'all-collapsed' | 'remember';

const REMEMBER_STORAGE_PREFIX = 'nexthmi.navmenu.expanded.';

type ExpansionMap = Record<string, boolean>;

interface FlyoutState {
  parentId: string;
  rect: DOMRect;
}

const EMPTY_GROUPS: readonly string[] = [];
const EMPTY_MENU_ITEMS: MenuItemConfig[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function pageGroupContains(group: PageGroupConfig, id: string): boolean {
  for (const child of group.children) {
    if (child.id === id) return true;
    if (isPageGroup(child) && pageGroupContains(child, id)) return true;
  }
  return false;
}

function applyMetadataFilters<T extends PageNode>(nodes: T[], userGroups: readonly string[]): T[] {
  return sortPagesByOrder(filterByRole(filterHidden(nodes), userGroups as string[]));
}

// Flat-mode flattening: page-groups inflate to their immediate page children;
// nested page-groups only inflate when `showChildPagesInMenu`.
function flattenForFlat<T extends PageNode>(nodes: T[]): PageConfig[] {
  const out: PageConfig[] = [];
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

function filterManualItems(
  items: MenuItemConfig[],
  query: string,
  ancestorPath = '',
): MenuItemConfig[] {
  if (!query.trim()) return items;
  const filtered: MenuItemConfig[] = [];
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

// ── Component ─────────────────────────────────────────────────────────────────

export default function NavigationMenu({ properties }: HmiWidgetProps = {}) {
  // Menu properties evaluate `$var` / `$time` at render. As the fallback sidebar
  // the menu renders outside WidgetRenderer, so subscribe here or those values
  // freeze (evalCtx is stable across ticks); when placed as a widget the extra
  // subscription is harmless.
  const evalCtx = useReactiveEval(properties);
  const pages = useConfigStore((s) => s.pages);
  const location = useLocation();
  const navigate = useNavigate();
  const scope = useHmiScope();
  const currentUser = useHmiStore((s) => s.currentUsersByScope[scope]);
  const userGroups = currentUser?.groups ?? EMPTY_GROUPS;

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

  // Optional bottom slot — accepts a single WidgetConfig (authored via JSON).
  const footerSlot = properties?.footerSlot as WidgetConfig | null | undefined;
  const isFooterSlotComponent =
    footerSlot &&
    typeof footerSlot === 'object' &&
    typeof (footerSlot as WidgetConfig).type === 'string';

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

  const routeBase = location.pathname.startsWith('/preview/') ? '/preview' : '/pages';
  const currentId = location.pathname.startsWith(`${routeBase}/`)
    ? location.pathname.slice(`${routeBase}/`.length)
    : undefined;
  const currentContext = resolvePageContext(pages, currentId);
  const activePageId =
    currentContext.requestedNode && !isPageGroup(currentContext.requestedNode)
      ? currentContext.requestedNode.id
      : (currentContext.page?.id ?? null);

  const visiblePages = useMemo(() => applyMetadataFilters(pages, userGroups), [pages, userGroups]);

  const filteredPages = useMemo(() => {
    return filterPagesBySearch(visiblePages, search);
  }, [visiblePages, search]);

  const renderedNodes = useMemo<PageNode[]>(
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
  const manualItems = (properties?.items as MenuItemConfig[] | undefined) ?? EMPTY_MENU_ITEMS;
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
    return group.id === activePageId || pageGroupContains(group, activePageId);
  }

  function toggleGroupInline(group: PageGroupConfig) {
    setExpandedGroups((prev) => {
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
        return ` ${styles.linkActive} ${styles.linkActiveBg}`;
      case 'underline':
        return ` ${styles.linkActive} ${styles.linkActiveUnderline}`;
      case 'left-border':
      default:
        return ` ${styles.linkActive}`;
    }
  }

  // ── Renderers ──────────────────────────────────────────────────────────────
  function navigateTo(id: string) {
    // Navigate urgently so the menu highlight updates immediately; HmiView
    // renders the page from a deferred id, keeping the heavy switch low-priority
    // and interruptible (see HmiView's useDeferredValue).
    navigate(`${routeBase}/${id}`);
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
          <span className={styles.icon}>
            <Suspense fallback={null}>
              <IconComp size={21} weight="regular" />
            </Suspense>
          </span>
        );
    }
    return <span className={`${styles.icon} ${styles.iconLetter}`}>{label}</span>;
  }

  function renderLabel(label: string): JSX.Element | null {
    if (display === 'icon-only') return null;
    return <span className={styles.title}>{label}</span>;
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

  function renderPageRow(page: PageConfig, depth: number): JSX.Element {
    const isActive = activePageId === page.id;
    return renderNavButton({
      key: page.id,
      className: `${styles.link} ${styles.childLink}${activeClass(isActive)}`,
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
      (group.id === activePageId || pageGroupContains(group, activePageId));
    const expanded = isGroupExpanded(group);

    return (
      <Fragment key={group.id}>
        <div className={styles.groupRow}>
          {renderNavButton({
            className: `${styles.link}${depth > 0 ? ` ${styles.childLink}` : ''}${activeClass(isActive)}`,
            title: collapsed ? resolvePageTitle(group.title) : undefined,
            dataDepth: depth > 0 ? depth : undefined,
            dataActive: isActive,
            onClick: () => navigateTo(group.id),
            node: group,
          })}

          <button
            type="button"
            className={styles.expandToggle}
            onClick={(e) => {
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
      </Fragment>
    );
  }

  function renderTopLevelNode(node: PageNode): JSX.Element {
    if (isPageGroup(node)) {
      if (node.showChildPagesInMenu === true && hierarchy === 'tree') {
        return renderGroupRow(node, 0);
      }
      const groupIsActive =
        (activePageId !== null && pageGroupContains(node, activePageId)) || currentId === node.id;
      return renderNavButton({
        key: node.id,
        className: `${styles.link}${activeClass(groupIsActive)}`,
        title: collapsed ? resolvePageTitle(node.title) : undefined,
        dataActive: groupIsActive,
        onClick: () => navigateTo(node.id),
        node,
      });
    }
    const pageIsActive = activePageId === node.id && currentContext.pageGroups.length === 0;
    return renderNavButton({
      key: node.id,
      className: `${styles.link}${activeClass(pageIsActive)}`,
      title: collapsed ? resolvePageTitle(node.title) : undefined,
      dataActive: pageIsActive,
      onClick: () => navigateTo(node.id),
      node,
    });
  }

  // ── Manual-mode rendering ───────────────────────────────────────────────────
  function renderManualItem(item: MenuItemConfig, idx: number, depth: number): JSX.Element | null {
    if (item.type === 'divider') {
      return <div key={`d-${idx}`} className={styles.divider} role="separator" />;
    }
    if (item.type === 'section-header') {
      return (
        <div key={`s-${idx}`} className={styles.sectionHeader}>
          {item.label}
        </div>
      );
    }
    if (item.type === 'page-link') {
      const isActive = activePageId === item.pageId;
      const node = { title: item.label ?? item.pageId, icon: staticIconToString(item.icon) };
      return renderNavButton({
        key: `p-${item.pageId}-${idx}`,
        className: `${styles.link}${activeClass(isActive)}`,
        dataDepth: depth,
        onClick: () => navigateTo(item.pageId),
        node,
      });
    }
    if (item.type === 'external-link') {
      return (
        <a
          key={`e-${idx}`}
          className={styles.link}
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
          className={styles.link}
          onClick={(e) =>
            executeWidgetActions(item.actions, { scope, evalCtx, anchorEl: e.currentTarget })
          }
        >
          {renderIcon({ title: item.label, icon: staticIconToString(item.icon) })}
          {renderLabel(item.label)}
        </button>
      );
    }
    if (item.type === 'submenu') {
      const expanded = search.trim() ? true : expandedGroups[`manual-${idx}`] === true;
      return (
        <Fragment key={`sm-${idx}`}>
          <div className={styles.groupRow}>
            <button
              type="button"
              className={`${styles.link}${depth > 0 ? ` ${styles.childLink}` : ''}`}
              onClick={() =>
                setExpandedGroups((prev) => ({ ...prev, [`manual-${idx}`]: !expanded }))
              }
            >
              {renderIcon({ title: item.label, icon: staticIconToString(item.icon) })}
              {renderLabel(item.label)}
            </button>
            <button
              type="button"
              className={styles.expandToggle}
              onClick={() =>
                setExpandedGroups((prev) => ({ ...prev, [`manual-${idx}`]: !expanded }))
              }
              aria-label={expanded ? 'Collapse section' : 'Expand section'}
            >
              {expanded ? '▾' : '▸'}
            </button>
          </div>
          {expanded && item.items.map((sub, i) => renderManualItem(sub, i, depth + 1))}
        </Fragment>
      );
    }
    return null;
  }

  // ── Layout / orientation classes ────────────────────────────────────────────
  const navClassName = [
    styles.nav,
    orientation === 'horizontal' ? styles.navHorizontal : '',
    collapsed ? styles.navCollapsed : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <nav className={navClassName}>
      {orientation === 'vertical' && !hasExternalCollapsed && (
        <button
          className={styles.toggle}
          onClick={() => setLocalCollapsed((c) => !c)}
          title={collapsed ? 'Expand menu' : 'Collapse menu'}
        >
          {collapsed ? '»' : '«'}
        </button>
      )}

      {showSearch && !collapsed && (
        <input
          type="search"
          className={styles.search}
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {mode === 'manual'
        ? filteredManualItems.map((item, idx) => renderManualItem(item, idx, 0))
        : renderedNodes.map((node) => renderTopLevelNode(node))}

      {isFooterSlotComponent && (
        <div className={styles.footerSlot}>
          <WidgetRenderer node={footerSlot as WidgetConfig} />
        </div>
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
  rect: DOMRect;
  orientation: Orientation;
  onDismiss: () => void;
  children: React.ReactNode;
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
    <div ref={ref} className={styles.flyout} style={style}>
      {children}
    </div>,
    document.body,
  );
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

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
