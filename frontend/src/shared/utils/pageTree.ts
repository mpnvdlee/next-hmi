import type {
  WidgetConfig,
  PageConfig,
  PageGroupChild,
  PageNode,
  PageGroupConfig,
  PageTitle,
  ShellConfig,
} from '@shared/types/config';
import type { CSSWithVars } from '@shared/types/style';
import { getPageChildren } from './pageContent';
import { useTranslationStore } from '@shared/store/translationStore';

/** Stable empty page-group trail — reused so equality checks stay cheap. */
export const EMPTY_PAGE_GROUPS: readonly PageGroupConfig[] = Object.freeze([]);

// Reads the translation store via .getState() without subscribing — safe for
// non-React callers and for code where re-renders are driven by some other
// subscription (e.g. configStore). React render code that should refresh when
// the active locale flips should call `usePageTitle` instead.
export function resolvePageTitle(title: PageTitle): string {
  if (typeof title === 'string') return title;
  if (title && typeof title === 'object') {
    const wrapped = title as Record<string, unknown>;
    if (typeof wrapped.$loc === 'string') {
      return useTranslationStore.getState().resolve(wrapped.$loc) ?? wrapped.$loc;
    }
    if (typeof wrapped.$static === 'string') return wrapped.$static;
  }
  return '';
}

/**
 * React hook variant of `resolvePageTitle`. Subscribes to the translation
 * store's `activeLanguage` and `translations`, so the consumer re-renders on
 * locale switches and translation edits.
 */
export function usePageTitle(title: PageTitle): string {
  useTranslationStore((s) => s.activeLanguage);
  useTranslationStore((s) => s.translations);
  return resolvePageTitle(title);
}

export function isPageGroup(node: PageNode): node is PageGroupConfig {
  return node.type === 'page-group';
}

/**
 * True when a page has active Header/Footer chrome, so adding or moving a
 * widget at the bare page level is ambiguous — callers must target an
 * explicit section (Header/Content/Footer) instead. Shared by the widget
 * tree's context menu, paste dispatch, and move-to-page dialog so the rule
 * can't drift between them.
 */
export function pageHasExplicitSections(node: PageNode | null | undefined): boolean {
  return !!node && !isPageGroup(node) && !!(node.showHeader || node.showFooter);
}

/** The section ids/labels a page with explicit sections exposes, in display order. */
export function pageSectionGroups(page: PageConfig): { id: string; label: string }[] {
  const groups: { id: string; label: string }[] = [];
  if (page.showHeader) groups.push({ id: 'header', label: 'Header' });
  groups.push({ id: 'content', label: 'Content' });
  if (page.showFooter) groups.push({ id: 'footer', label: 'Footer' });
  return groups;
}

function isPageNode(node: PageNode): node is PageConfig {
  return !isPageGroup(node);
}

function isLikelyPageGroupCandidate(candidate: Record<string, unknown>): boolean {
  return candidate.type === 'page-group';
}

function readMetadata(c: Record<string, unknown>) {
  const meta: Partial<{
    description: string;
    breadcrumbLabel: string;
    hidden: boolean;
    role: string[];
    order: number;
    mainPadding: string;
    mainBackground: string;
  }> = {};
  if (typeof c.description === 'string') meta.description = c.description;
  if (typeof c.breadcrumbLabel === 'string') meta.breadcrumbLabel = c.breadcrumbLabel;
  if (typeof c.hidden === 'boolean') meta.hidden = c.hidden;
  if (Array.isArray(c.role) && c.role.every((g) => typeof g === 'string')) {
    meta.role = c.role as string[];
  }
  if (typeof c.order === 'number' && Number.isFinite(c.order)) meta.order = c.order;
  if (typeof c.mainPadding === 'string') meta.mainPadding = c.mainPadding;
  if (typeof c.mainBackground === 'string') meta.mainBackground = c.mainBackground;
  return meta;
}

/** Runtime guard for a page's `sections` wire field: drops non-array section
 *  values and any non-object input, and always guarantees `content`. */
export function normalizeSections(raw: unknown): Record<string, WidgetConfig[]> {
  const sections: Record<string, WidgetConfig[]> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [sectionId, children] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(children)) sections[sectionId] = children as WidgetConfig[];
    }
  }
  if (!Array.isArray(sections.content)) sections.content = [];
  return sections;
}

export function normalizePageNode(node: unknown): PageNode | null {
  if (!node || typeof node !== 'object') return null;

  const candidate = node as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id : null;
  const title: PageTitle | null =
    typeof candidate.title === 'string'
      ? candidate.title
      : candidate.title && typeof candidate.title === 'object'
        ? (candidate.title as Record<string, unknown>)
        : null;
  const icon = typeof candidate.icon === 'string' ? candidate.icon : undefined;

  if (!id || !title) return null;
  const metadata = readMetadata(candidate);

  if (isLikelyPageGroupCandidate(candidate)) {
    const rawChildren = Array.isArray(candidate.children) ? candidate.children : [];
    const children = rawChildren
      .map(normalizePageNode)
      .filter((entry): entry is PageGroupChild => entry !== null);

    return {
      id,
      title,
      icon,
      type: 'page-group',
      children,
      ...metadata,
      ...(typeof candidate.showChildPagesInMenu === 'boolean'
        ? { showChildPagesInMenu: candidate.showChildPagesInMenu }
        : {}),
      ...(Array.isArray(candidate.header) ? { header: candidate.header as WidgetConfig[] } : {}),
      ...(Array.isArray(candidate.footer) ? { footer: candidate.footer as WidgetConfig[] } : {}),
    };
  }

  const sections = normalizeSections(candidate.sections);

  return {
    id,
    title,
    icon,
    type: 'page' as const,
    sections,
    ...metadata,
    ...(typeof candidate.showHeader === 'boolean' ? { showHeader: candidate.showHeader } : {}),
    ...(typeof candidate.showFooter === 'boolean' ? { showFooter: candidate.showFooter } : {}),
    ...(candidate.shellOverride && typeof candidate.shellOverride === 'object'
      ? { shellOverride: candidate.shellOverride as Partial<ShellConfig> }
      : {}),
  };
}

export function normalizePageNodes(nodes: unknown[]): PageNode[] {
  return nodes.map(normalizePageNode).filter((entry): entry is PageNode => entry !== null);
}

export function flattenPages(nodes: PageNode[]): PageConfig[] {
  const pages: PageConfig[] = [];
  function walk(node: PageNode): void {
    if (isPageGroup(node)) {
      for (const child of node.children) walk(child);
      return;
    }
    pages.push(node);
  }
  for (const node of nodes) walk(node);
  return pages;
}

export function findFirstPage(nodes: PageNode[]): PageConfig | undefined {
  return findFirstPageWithTrail(nodes)?.page;
}

function findFirstPageWithTrail(
  nodes: PageNode[],
): { page: PageConfig; trail: PageGroupConfig[] } | undefined {
  for (const node of nodes) {
    if (!isPageGroup(node)) return { page: node, trail: [] };
    const inner = findFirstPageWithTrail(node.children);
    if (inner) return { page: inner.page, trail: [node, ...inner.trail] };
  }
  return undefined;
}

export function findPageNodeById(nodes: PageNode[], id: string): PageNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (isPageGroup(node)) {
      const nested = findPageNodeById(node.children, id);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function findPageById(nodes: PageNode[], id: string): PageConfig | undefined {
  const node = findPageNodeById(nodes, id);
  return node && isPageNode(node) ? node : undefined;
}

export function findParentPageGroup(
  nodes: PageNode[],
  nodeId: string,
): PageGroupConfig | undefined {
  for (const node of nodes) {
    if (!isPageGroup(node)) continue;
    if (node.children.some((child) => child.id === nodeId)) return node;
    const nested = findParentPageGroup(node.children, nodeId);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Returns the ancestor chain for a given page or page-group id, root → target.
 * Empty array when not found.
 */
export function findPagePath(nodes: PageNode[], id: string): PageNode[] {
  for (const node of nodes) {
    const path = findPagePathFromNode(node, id, []);
    if (path) return path;
  }
  return [];
}

function findPagePathFromNode(node: PageNode, id: string, trail: PageNode[]): PageNode[] | null {
  const next = [...trail, node];
  if (node.id === id) return next;
  if (isPageGroup(node)) {
    for (const child of node.children) {
      const found = findPagePathFromNode(child, id, next);
      if (found) return found;
    }
  }
  return null;
}

export function findPageGroupById(nodes: PageNode[], id: string): PageGroupConfig | undefined {
  for (const node of nodes) {
    if (!isPageGroup(node)) continue;
    if (node.id === id) return node;
    const nested = findPageGroupById(node.children, id);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Walk every page group in the tree (top-level and nested), replacing each
 * with `patch(group)` — `children` is always re-derived from the (recursed)
 * originals, so `patch` only needs to return the group's own field changes.
 * Non-group nodes pass through unchanged. Shared by `mapPageGroupChrome` and
 * `updatePageGroupChrome`, which differ only in what `patch` does.
 */
function walkPageGroups(
  nodes: PageNode[],
  patch: (group: PageGroupConfig) => PageGroupConfig,
): PageNode[] {
  function applyToGroup(group: PageGroupConfig): PageGroupConfig {
    return {
      ...patch(group),
      children: group.children.map((child) => (isPageGroup(child) ? applyToGroup(child) : child)),
    };
  }
  return nodes.map((node) => (isPageGroup(node) ? applyToGroup(node) : node));
}

/**
 * Walk every page group in the tree (top-level and nested) and apply `mapFn`
 * to its `header` and `footer` widget arrays. Undefined arrays are passed
 * through untouched so the field stays absent on groups that never used it.
 */
export function mapPageGroupChrome(
  nodes: PageNode[],
  mapFn: (widgets: WidgetConfig[]) => WidgetConfig[],
): PageNode[] {
  return walkPageGroups(nodes, (group) => ({
    ...group,
    header: group.header === undefined ? undefined : mapFn(group.header),
    footer: group.footer === undefined ? undefined : mapFn(group.footer),
  }));
}

/**
 * Update a single page group's `header` or `footer` widget array.
 * Unlike `mapPageGroupChrome` this targets one group by id and runs the
 * mapper even when the field is currently undefined (so it can create the
 * array from scratch when adding the first widget to a chrome slot).
 */
export function updatePageGroupChrome(
  nodes: PageNode[],
  groupId: string,
  area: 'header' | 'footer',
  mapFn: (widgets: WidgetConfig[]) => WidgetConfig[],
): PageNode[] {
  return walkPageGroups(nodes, (group) =>
    group.id === groupId ? { ...group, [area]: mapFn(group[area] ?? []) } : group,
  );
}

export function mapPages(nodes: PageNode[], mapper: (page: PageConfig) => PageConfig): PageNode[] {
  function walk(node: PageNode): PageNode {
    if (isPageGroup(node)) {
      return { ...node, children: node.children.map(walk) as PageGroupChild[] };
    }
    return mapper(node);
  }
  return nodes.map(walk);
}

export function removePageNode(
  nodes: PageNode[],
  id: string,
): { nodes: PageNode[]; removed: PageNode | null } {
  let removed: PageNode | null = null;

  function walk(node: PageNode): PageNode | null {
    if (removed) return node;
    if (node.id === id) {
      removed = node;
      return null;
    }
    if (!isPageGroup(node)) return node;
    const nextChildren = node.children.map(walk).filter((c): c is PageGroupChild => c !== null);
    return { ...node, children: nextChildren };
  }

  const nextNodes = nodes.map(walk).filter((node): node is PageNode => node !== null);
  return { nodes: nextNodes, removed };
}

export function insertPageIntoPageGroup(
  nodes: PageNode[],
  pageGroupId: string,
  page: PageConfig,
): PageNode[] {
  return insertChildIntoPageGroup(nodes, pageGroupId, page);
}

export function insertPageGroupIntoPageGroup(
  nodes: PageNode[],
  pageGroupId: string,
  group: PageGroupConfig,
): PageNode[] {
  return insertChildIntoPageGroup(nodes, pageGroupId, group);
}

function insertChildIntoPageGroup(
  nodes: PageNode[],
  pageGroupId: string,
  child: PageGroupChild,
): PageNode[] {
  function walk(node: PageNode): PageNode {
    if (!isPageGroup(node)) return node;
    if (node.id === pageGroupId) {
      return { ...node, children: [...node.children, child] };
    }
    return { ...node, children: node.children.map(walk) as PageGroupChild[] };
  }
  return nodes.map(walk);
}

export function replacePageGroupChildren(
  nodes: PageNode[],
  pageGroupId: string,
  children: PageGroupChild[],
): PageNode[] {
  function walk(node: PageNode): PageNode {
    if (!isPageGroup(node)) return node;
    if (node.id === pageGroupId) return { ...node, children };
    return { ...node, children: node.children.map(walk) as PageGroupChild[] };
  }
  return nodes.map(walk);
}

export function removePageGroup(nodes: PageNode[], pageGroupId: string): PageNode[] {
  function walk(node: PageNode): PageNode | null {
    if (isPageGroup(node) && node.id === pageGroupId) return null;
    if (!isPageGroup(node)) return node;
    return {
      ...node,
      children: node.children.map(walk).filter((c): c is PageGroupChild => c !== null),
    };
  }
  return nodes.map(walk).filter((n): n is PageNode => n !== null);
}

export function findOwningPage(nodes: PageNode[], componentId: string): PageConfig | undefined {
  return flattenPages(nodes).find((page) => treeContains(getPageChildren(page), componentId));
}

export function treeContains(components: WidgetConfig[], id: string): boolean {
  return components.some(
    (component) => component.id === id || treeContains(component.children ?? [], id),
  );
}

interface ResolvedPageContext {
  page: PageConfig | null;
  /** The ancestor chain of page-groups for the resolved page, outer → innermost. */
  pageGroups: PageGroupConfig[];
  requestedNode: PageNode | null;
  fellBackToFirstChild: boolean;
}

export function resolvePageContext(nodes: PageNode[], id?: string): ResolvedPageContext {
  if (!id) {
    const first = findFirstPageWithTrail(nodes);
    return {
      page: first?.page ?? null,
      pageGroups: first?.trail ?? [],
      requestedNode: first?.page ?? null,
      fellBackToFirstChild: false,
    };
  }

  const match = resolvePageContextById(nodes, id, []);
  if (!match) {
    return { page: null, pageGroups: [], requestedNode: null, fellBackToFirstChild: false };
  }
  return match;
}

function resolvePageContextById(
  nodes: PageNode[],
  id: string,
  trail: PageGroupConfig[],
): ResolvedPageContext | null {
  for (const node of nodes) {
    if (node.id === id) {
      if (isPageGroup(node)) {
        const first = findFirstPageWithTrail(node.children);
        return {
          page: first?.page ?? null,
          pageGroups: first ? [...trail, node, ...first.trail] : [...trail, node],
          requestedNode: node,
          fellBackToFirstChild: first !== undefined,
        };
      }
      return {
        page: node,
        pageGroups: trail,
        requestedNode: node,
        fellBackToFirstChild: false,
      };
    }
    if (isPageGroup(node)) {
      const found = resolvePageContextById(node.children, id, [...trail, node]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolve `mainPadding` / `mainBackground` along the active page chain
 * (outer groups → page) into a `--hmi-main-padding` / `--hmi-main-bg` style.
 * Innermost defined value wins.
 */
export function resolveMainStyle(
  groups: readonly PageGroupConfig[],
  page: PageConfig | null,
): CSSWithVars {
  let padding: string | undefined;
  let background: string | undefined;
  for (const g of groups) {
    if (g.mainPadding !== undefined) padding = g.mainPadding;
    if (g.mainBackground !== undefined) background = g.mainBackground;
  }
  if (page) {
    if (page.mainPadding !== undefined) padding = page.mainPadding;
    if (page.mainBackground !== undefined) background = page.mainBackground;
  }
  const style: CSSWithVars = {};
  if (padding) style['--hmi-main-padding'] = padding;
  if (background) style['--hmi-main-bg'] = background;
  return style;
}

/**
 * Sort an array of PageNodes by `order` (ascending). Nodes without an explicit
 * order are placed last in original input order, preserving stability.
 */
export function sortPagesByOrder<T extends PageNode>(nodes: T[]): T[] {
  return nodes
    .map((n, idx) => ({ n, idx }))
    .sort((a, b) => {
      const oa = typeof a.n.order === 'number' ? a.n.order : Number.POSITIVE_INFINITY;
      const ob = typeof b.n.order === 'number' ? b.n.order : Number.POSITIVE_INFINITY;
      if (oa !== ob) return oa - ob;
      return a.idx - b.idx;
    })
    .map((entry) => entry.n);
}

/**
 * Drop nodes flagged `hidden: true`. Does not recurse into descendants — call
 * sites are expected to apply this on each level they iterate.
 */
export function filterHidden<T extends PageNode>(nodes: T[]): T[] {
  return nodes.filter((n) => n.hidden !== true);
}

/**
 * Drop nodes whose `role` whitelist excludes every group the user is in.
 * - Empty / absent `role` → visible to everyone.
 * - Non-empty `role` → visible only when at least one entry intersects.
 */
export function filterByRole<T extends PageNode>(nodes: T[], userGroups: string[]): T[] {
  const userSet = new Set(userGroups);
  return nodes.filter((n) => {
    if (!n.role || n.role.length === 0) return true;
    return n.role.some((g) => userSet.has(g));
  });
}
