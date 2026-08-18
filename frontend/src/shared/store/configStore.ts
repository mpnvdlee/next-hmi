import { create } from 'zustand';
import type {
  PageConfig,
  PageGroupChild,
  PageNode,
  WidgetConfig,
  LayoutConfig,
  DialogConfig,
  PageGroupConfig,
  GlobalEventsConfig,
  ShellAreaId,
  ShellConfig,
  LazyPageResponse,
} from '../types/config';
import { SHELL_REGION_IDS, regionForShellSectionId } from '../types/config';
import { useProjectStore } from './projectStore';
import {
  findPageById,
  findPageGroupById,
  flattenPages,
  findOwningPage,
  insertPageIntoPageGroup,
  insertPageGroupIntoPageGroup,
  isPageGroup,
  mapPages,
  mapPageGroupChrome,
  normalizePageNodes,
  normalizeSections,
  removePageGroup,
  removePageNode,
  replacePageGroupChildren,
  updatePageGroupChrome,
} from '@shared/utils/pageTree';
import {
  appendToSection,
  distributeToSections,
  getPageChildren,
  replacePageSectionWidgets,
} from '@shared/utils/pageContent';
import { mapAllComponents } from '@config/components/editor/WidgetTree/treeUtils';
import { projectMarkDirty, projectSnapshotAndDirty } from './projectActions';
import {
  collectAllIds as _collectAllIds,
  collectMovedWidgets as _collectMovedWidgets,
  collectWidgetIds as _collectWidgetIds,
  duplicateWidgets as _duplicateWidgets,
  editAllAreas as _editAllAreas,
  findWidgetsByIds as _findWidgetsByIds,
  mapAllAreas as _mapAllAreas,
  pruneWidgets as _pruneWidgets,
  removeComponentFromPage as _removeComponentFromPage,
  removeNode as _removeNode,
  toIndexNodes as _toIndexNodes,
} from './configStoreHelpers';
import { apiJson, errorMessage } from '@shared/utils/api';

const PAGE_SAVE_FIELDS = [
  'title',
  'icon',
  'description',
  'breadcrumbLabel',
  'hidden',
  'role',
  'order',
  'showHeader',
  'showFooter',
  'shellOverride',
  'mainPadding',
  'mainBackground',
] as const satisfies readonly (keyof PageConfig)[];

// Compile-time invariant: every non-structural PageConfig key must appear in PAGE_SAVE_FIELDS.
// If a new metadata field is added to PageConfig without updating PAGE_SAVE_FIELDS, the
// `missing` member surfaces the omission as a tsc error.
type _PageMetadataKeys = Exclude<keyof PageConfig, 'id' | 'type' | 'sections'>;
type _AssertSaveFieldsCover = [
  Exclude<_PageMetadataKeys, (typeof PAGE_SAVE_FIELDS)[number]>,
] extends [never]
  ? true
  : { missing: Exclude<_PageMetadataKeys, (typeof PAGE_SAVE_FIELDS)[number]> };
const _PAGE_SAVE_FIELDS_COVERAGE: _AssertSaveFieldsCover = true;
void _PAGE_SAVE_FIELDS_COVERAGE;

// ── Snapshot helper ──────────────────────────────────────────────────────────

function _snapshot() {
  projectSnapshotAndDirty();
}

/** Throttled snapshot for high-frequency mutations (e.g. updateComponent per keystroke). */
let _lastThrottledSnapshot = 0;
function _throttledSnapshot(ms = 500) {
  const now = Date.now();
  if (now - _lastThrottledSnapshot > ms) {
    useProjectStore.getState().pushSnapshot();
    _lastThrottledSnapshot = now;
  }
  projectMarkDirty();
}

/**
 * `set` for a write that changes the *shape* of the tree — anything that adds,
 * removes, moves or wholesale-replaces a page, page-group, dialog or widget.
 *
 * The `structureRev` bump rides in the same patch as the change, so no subscriber can
 * observe one without the other: a separate `setState` would let a memo keyed on the
 * revision recompute against the old tree and then cache that answer under the new
 * number. Structural actions route through here rather than each folding the bump in
 * themselves, so an action added later inherits it. Property-value writes keep using
 * plain `set` — not bumping for them is the whole point.
 */
function _setTree(patch: Partial<ConfigStore> | ((s: ConfigStore) => Partial<ConfigStore>)) {
  useConfigStore.setState((s) => ({
    ...(typeof patch === 'function' ? patch(s) : patch),
    structureRev: s.structureRev + 1,
  }));
}

// ── Move helpers ─────────────────────────────────────────────────────────────

/** Where a relocated widget lands, named by its new parent rather than by the
 *  tree row that was dropped on — the tree resolves rows to one of these. */
export type WidgetParentTarget =
  | { kind: 'container'; containerId: string; slot?: string }
  | { kind: 'shell-area'; region: ShellAreaId }
  | { kind: 'dialog'; dialogId: string }
  | { kind: 'page-section'; pageId: string; sectionId: string }
  | { kind: 'page-group-chrome'; groupId: string; area: 'header' | 'footer' };

function _spliceAt(list: WidgetConfig[], nodes: WidgetConfig[], index?: number): WidgetConfig[] {
  const next = [...list];
  next.splice(index ?? next.length, 0, ...nodes);
  return next;
}

/** The page whose file has to be rewritten because the target lives on it. */
function _targetOwningPage(
  s: Pick<ConfigStore, 'pages'>,
  target: WidgetParentTarget,
): PageConfig | null {
  if (target.kind === 'page-section') return findPageById(s.pages, target.pageId) ?? null;
  if (target.kind === 'container') return findOwningPage(s.pages, target.containerId) ?? null;
  return null;
}

type AreaSlice = Pick<ConfigStore, 'pages' | 'dialogs' | ShellAreaId>;

/** Clone every listed widget in place, each directly after its own original, in one
 *  pass over the tree. Returns the new id per original id, and the pages that gained
 *  a clone. `taken` is shared across the batch so two clones can never be handed the
 *  same id. */
function _duplicateWidgetsEverywhere(
  s: AreaSlice,
  ids: ReadonlySet<string>,
  taken: Set<string>,
): { areas: AreaSlice; created: Map<string, string>; touchedPageIds: string[] } {
  const created = new Map<string, string>();
  const { areas, touchedPageIds } = _editAllAreas(s, (widgets) =>
    _duplicateWidgets(widgets, ids, taken, created),
  );
  return { areas, created, touchedPageIds };
}

/** Sweep every listed widget out of every area in one pass, reporting the node that
 *  came out per id and the pages that lost one. Deleting or moving a selection runs
 *  this once inside a single `set`, which keeps one snapshot, one generation of
 *  object identities and one re-render for the whole batch. */
function _removeWidgetsEverywhere(
  s: AreaSlice,
  ids: ReadonlySet<string>,
): { areas: AreaSlice; removed: Map<string, WidgetConfig>; touchedPageIds: string[] } {
  const removed = new Map<string, WidgetConfig>();
  const { areas, touchedPageIds } = _editAllAreas(s, (widgets) =>
    _pruneWidgets(widgets, ids, removed),
  );
  return { areas, removed, touchedPageIds };
}

/** A widget the move takes away cannot also host it: the sweep removes the target
 *  parent before the insert looks for it, so the batch would land nowhere and be
 *  lost. Checked before the batch opens, so a refused move leaves no undo step. */
function _targetSweptByMove(s: AreaSlice, nodeIds: string[], target: WidgetParentTarget): boolean {
  if (target.kind !== 'container') return false;
  // Asked of the ids rather than of the resolved widgets, so a target that is not in
  // the tree at all still refuses instead of swallowing the batch.
  if (nodeIds.includes(target.containerId)) return true;
  return _collectMovedWidgets(s, nodeIds).descendants.has(target.containerId);
}

function _insertWidgetsAtTarget(
  s: AreaSlice,
  nodes: WidgetConfig[],
  target: WidgetParentTarget,
  index?: number,
): Partial<AreaSlice> {
  switch (target.kind) {
    case 'shell-area':
      return { [target.region]: _spliceAt(s[target.region], nodes, index) };
    case 'dialog':
      return {
        dialogs: s.dialogs.map((d) =>
          d.id === target.dialogId ? { ...d, widgets: _spliceAt(d.widgets, nodes, index) } : d,
        ),
      };
    case 'page-section':
      return {
        pages: mapPages(s.pages, (page) =>
          page.id === target.pageId
            ? {
                ...page,
                sections: {
                  ...page.sections,
                  [target.sectionId]: _spliceAt(
                    page.sections[target.sectionId] ?? [],
                    nodes,
                    index,
                  ),
                },
              }
            : page,
        ),
      };
    case 'page-group-chrome':
      return {
        pages: updatePageGroupChrome(s.pages, target.groupId, target.area, (widgets) =>
          _spliceAt(widgets, nodes, index),
        ),
      };
    case 'container': {
      // A container can live in any area, so every area gets the same mapper —
      // which hands back the list it was given wherever the container is not.
      const insert = (comps: WidgetConfig[]): WidgetConfig[] => {
        let changed = false;
        const next = comps.map((c) => {
          if (c.id === target.containerId) {
            changed = true;
            return {
              ...c,
              children: _spliceAt((c.children as WidgetConfig[]) ?? [], nodes, index),
            };
          }
          const children = c.children as WidgetConfig[] | undefined;
          if (!children) return c;
          const mapped = insert(children);
          if (mapped === children) return c;
          changed = true;
          return { ...c, children: mapped };
        });
        return changed ? next : comps;
      };
      return _editAllAreas(s, insert).areas;
    }
  }
}

function _insertIntoGroup(
  nodes: PageNode[],
  groupId: string,
  child: PageGroupChild,
  index?: number,
): PageNode[] {
  return nodes.map((node) => {
    if (!isPageGroup(node)) return node;
    if (node.id === groupId) {
      const children = [...node.children];
      children.splice(index ?? children.length, 0, child);
      return { ...node, children };
    }
    return {
      ...node,
      children: _insertIntoGroup(node.children, groupId, child, index) as PageGroupChild[],
    };
  });
}

/** True when `candidateId` sits inside the subtree rooted at `nodeId` — moving a
 *  group into its own descendant would detach both from the tree. */
function _isDescendantPageNode(nodes: PageNode[], nodeId: string, candidateId: string): boolean {
  const node = findPageGroupById(nodes, nodeId);
  if (!node) return false;
  const walk = (children: PageGroupChild[]): boolean =>
    children.some(
      (child) => child.id === candidateId || (isPageGroup(child) && walk(child.children)),
    );
  return nodeId === candidateId || walk(node.children);
}

/** Returns the same Set reference if `id` is already present — avoids per-keystroke Set churn. */
function _withDirty(prev: Set<string>, id: string): Set<string> {
  if (prev.has(id)) return prev;
  return new Set([...prev, id]);
}

// Shallow ref-equality only — callers must hand in fresh object/array values when
// they want an object-valued patch (e.g. `shellOverride`) to register as a change.
function _patchHasChange<T extends object>(current: T, patch: Partial<T>): boolean {
  for (const key in patch) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if ((current as Record<string, unknown>)[key] !== (patch as Record<string, unknown>)[key])
      return true;
  }
  return false;
}

// ── Store interface ───────────────────────────────────────────────────────────

interface ConfigStore {
  pages: PageNode[];
  header: WidgetConfig[];
  footer: WidgetConfig[];
  leftSidebar: WidgetConfig[];
  rightSidebar: WidgetConfig[];
  /** Project-wide shell config. Empty object = use built-in defaults. */
  shell: ShellConfig;
  dialogs: DialogConfig[];
  globalEvents: GlobalEventsConfig;
  /**
   * Counts changes to the *shape* of the tree — a page, page-group, dialog or widget
   * added, removed, moved, or replaced wholesale by a load. Transient view state, not
   * project data: `saveConfigToBackend` and projectStore's `captureSnapshot` each
   * enumerate the fields they take and this is not one of them, so it reaches neither
   * the backend nor an undo snapshot.
   *
   * It exists so a consumer that resolves ids against the whole tree (the properties
   * panel's selection walk) can skip that walk on a property-value write, which
   * replaces every widget object without moving one.
   */
  structureRev: number;
  /** True once the page index has been successfully fetched from the backend. */
  loaded: boolean;
  /** IDs of pages whose component content is currently in memory. */
  loadedPageIds: Set<string>;
  /** IDs of loaded pages whose content has changed since the last save. */
  dirtyPageIds: Set<string>;
  /** Why the last `saveConfigToBackend` failed, or null after a clean save. */
  saveError: string | null;

  // Bootstrap / hydration
  /** Accepts raw, unvalidated wire nodes — runs them through normalizePageNodes(). */
  setPages(pages: unknown[]): void;
  markLoaded(): void;
  setHeader(components: WidgetConfig[]): void;
  setFooter(components: WidgetConfig[]): void;
  setLeftSidebar(components: WidgetConfig[]): void;
  setRightSidebar(components: WidgetConfig[]): void;
  setShell(shell: ShellConfig): void;
  updateShell(patch: Partial<ShellConfig>): void;
  setDialogs(dialogs: DialogConfig[]): void;
  /**
   * Put every area back as it was, together with the page bookkeeping that went
   * with it — the rollback for a composite edit whose second half refused after
   * the first had already run. Pushes no snapshot: the caller owns the undo step.
   *
   * A store action rather than a raw `setState` at the call site so the revision
   * bump rides with the tree it describes. `setPages` cannot serve here: it
   * recomputes `loadedPageIds` from page content, losing the difference between
   * "loaded and empty" and "never loaded".
   */
  restoreAreas(snapshot: AreaSlice & Pick<ConfigStore, 'loadedPageIds' | 'dirtyPageIds'>): void;
  /** Bulk-set globalEvents from API load. Does not push an undo snapshot. */
  setGlobalEvents(events: GlobalEventsConfig): void;
  /** User-initiated edit of globalEvents — pushes a throttled undo snapshot. */
  updateGlobalEvents(events: GlobalEventsConfig): void;
  /** Fetch a single page's component content from the backend and hydrate it. */
  loadPageContent(pageId: string): Promise<void>;

  // Page CRUD
  addPage(page: PageConfig): void;
  addPageGroup(group: PageGroupConfig): void;
  /** Insert a page-group as a direct child of another page-group. */
  addPageGroupToPageGroup(parentGroupId: string, group: PageGroupConfig): void;
  deletePage(pageId: string): void;
  /** Patch any subset of page metadata (title, description, breadcrumbLabel, hidden, role, order, icon). */
  updatePage(pageId: string, patch: Partial<Omit<PageConfig, 'id' | 'type' | 'sections'>>): void;
  updatePageGroup(
    groupId: string,
    patch: Partial<Omit<PageGroupConfig, 'id' | 'type' | 'children'>>,
  ): void;
  deletePageGroup(groupId: string): void;
  addPageToPageGroup(groupId: string, page: PageConfig): void;
  reorderPageGroupChildren(groupId: string, children: PageGroupChild[]): void;
  reorderPageChildren(pageId: string, widgets: WidgetConfig[]): void;
  setPageSections(pageId: string, sections: Record<string, WidgetConfig[]>): void;

  // Dialog CRUD
  addDialog(dialog: DialogConfig): void;
  deleteDialog(dialogId: string): void;
  renameDialog(dialogId: string, title: string): void;
  updateDialog(dialogId: string, patch: Partial<Omit<DialogConfig, 'id' | 'widgets'>>): void;

  // Component mutations — work across all areas
  addComponentToPage(pageId: string, comp: WidgetConfig): void;
  addComponentToPageSection(pageId: string, sectionId: string, comp: WidgetConfig): void;
  addComponentToPageGroupArea(groupId: string, area: 'header' | 'footer', comp: WidgetConfig): void;
  addComponentToArea(area: ShellAreaId, comp: WidgetConfig): void;
  addComponentToDialog(dialogId: string, comp: WidgetConfig): void;
  addComponentToContainer(containerId: string, comp: WidgetConfig): void;
  addComponentToWidgetSlot(widgetId: string, slot: string, comp: WidgetConfig): void;
  deleteComponent(id: string): void;
  /**
   * Delete many widgets as one undo step. Pass ids with descendants already
   * removed (see `topLevelSelection`).
   *
   * Returns every id the delete took out of the tree, descendants of the listed
   * widgets included — a caller pruning its own state (the tree's selection) would
   * otherwise have to walk the whole project twice to work that out.
   */
  deleteComponents(ids: string[]): Set<string>;
  duplicateComponent(id: string): void;
  /** Duplicate many widgets as one undo step, each clone landing directly after its
   *  own original. Returns the new ids in the order the originals were given. */
  duplicateComponents(ids: string[]): string[];
  reorderChildren(parentId: string, newChildren: WidgetConfig[]): void;
  /** Relocate a widget to another parent, keeping its id. `index` places it in
   *  the new parent's list; omitted appends. One undo step. */
  moveWidgetTo(nodeId: string, target: WidgetParentTarget, index?: number): void;
  /**
   * Move several widgets into one parent as a single undo step, landing them
   * contiguously in the order given. `index` is the position in the parent's list
   * once the moved widgets are out of it — what `resolveDropTarget` returns.
   */
  moveWidgetsTo(nodeIds: string[], target: WidgetParentTarget, index?: number): void;
  /** Relocate a page or page group into a group (`null` = root), keeping its id. */
  movePageTo(nodeId: string, target: string | null, index?: number): void;
  reorderPages(pages: PageNode[]): void;

  /** Persist the current runtime config state to the backend via PUT /api/config/config. */
  saveConfigToBackend(): Promise<boolean>;

  // ── Phase 12 component property mutations ──────────────────────────────────
  /**
   * Shallow-merge name/properties/layout into a single component anywhere in
   * the tree. properties and layout keys are merged individually — existing
   * keys not present in the patch are left unchanged.
   */
  updateComponent(
    id: string,
    patch: {
      name?: string;
      properties?: Record<string, unknown>;
      layout?: Partial<LayoutConfig>;
    },
  ): void;
  /**
   * The same patch applied to many components in one sweep — the properties
   * panel's multi-selection write. One pass over the tree instead of N, and one
   * throttled snapshot, so editing a multi-selection undoes at the same
   * granularity as editing a single widget.
   */
  updateComponents(
    ids: string[],
    patch: {
      name?: string;
      properties?: Record<string, unknown>;
      layout?: Partial<LayoutConfig>;
    },
  ): void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useConfigStore = create<ConfigStore>((set, get) => ({
  pages: [],
  header: [],
  footer: [],
  leftSidebar: [],
  rightSidebar: [],
  shell: {},
  dialogs: [],
  globalEvents: {},
  structureRev: 0,
  loaded: false,
  loadedPageIds: new Set<string>(),
  dirtyPageIds: new Set<string>(),
  saveError: null,

  // ── Bootstrap / hydration ───────────────────────────────────────────────────

  setPages: (pages) => {
    const normalized = normalizePageNodes(pages);
    // Recompute loaded set: any page that arrives with non-empty content is
    // already hydrated (e.g. from undo/redo snapshots). Mark those dirty too
    // so they will be saved on the next explicit save.
    const loadedPageIds = new Set<string>(
      flattenPages(normalized)
        .filter((p) => getPageChildren(p).length > 0)
        .map((p) => p.id),
    );
    _setTree({ pages: normalized, loadedPageIds, dirtyPageIds: new Set(loadedPageIds) });
  },
  markLoaded: () => set({ loaded: true }),
  setHeader: (header) => _setTree({ header }),
  setFooter: (footer) => _setTree({ footer }),
  setLeftSidebar: (leftSidebar) => _setTree({ leftSidebar }),
  setRightSidebar: (rightSidebar) => _setTree({ rightSidebar }),
  setShell: (shell) => set({ shell }),
  updateShell: (patch) => {
    _throttledSnapshot();
    set((s) => ({ shell: { ...s.shell, ...patch } }));
  },
  setDialogs: (dialogs) => _setTree({ dialogs }),
  restoreAreas: (snapshot) => {
    _setTree({
      pages: snapshot.pages,
      header: snapshot.header,
      footer: snapshot.footer,
      leftSidebar: snapshot.leftSidebar,
      rightSidebar: snapshot.rightSidebar,
      dialogs: snapshot.dialogs,
      loadedPageIds: snapshot.loadedPageIds,
      dirtyPageIds: snapshot.dirtyPageIds,
    });
  },
  setGlobalEvents: (globalEvents) => set({ globalEvents }),
  updateGlobalEvents: (globalEvents) => {
    _throttledSnapshot();
    set({ globalEvents });
  },

  // ── Page mutations ─────────────────────────────────────────────────────────

  addPage: (page) => {
    _snapshot();
    const newPage: PageConfig = {
      ...page,
      type: 'page',
      sections: page.sections ?? { content: [] },
    };
    _setTree((s) => ({
      pages: [...s.pages, newPage],
      loadedPageIds: new Set([...s.loadedPageIds, newPage.id]),
      dirtyPageIds: _withDirty(s.dirtyPageIds, newPage.id),
    }));
  },

  addPageGroup: (group) => {
    _snapshot();
    _setTree((s) => ({
      pages: [...s.pages, { ...group, children: group.children ?? [] }],
    }));
  },

  addPageGroupToPageGroup: (parentGroupId, group) => {
    _snapshot();
    const nested: PageGroupConfig = { ...group, children: group.children ?? [] };
    _setTree((s) => ({
      pages: insertPageGroupIntoPageGroup(s.pages, parentGroupId, nested),
    }));
  },

  deletePage: (pageId) => {
    _snapshot();
    _setTree((s) => ({
      pages: removePageNode(s.pages, pageId).nodes,
      loadedPageIds: new Set([...s.loadedPageIds].filter((id) => id !== pageId)),
      dirtyPageIds: new Set([...s.dirtyPageIds].filter((id) => id !== pageId)),
    }));
  },

  updatePage: (pageId, patch) => {
    const current = findPageById(get().pages, pageId);
    if (!current || !_patchHasChange(current, patch)) return;
    _throttledSnapshot();
    set((s) => ({
      pages: mapPages(s.pages, (page) => (page.id === pageId ? { ...page, ...patch } : page)),
      dirtyPageIds: _withDirty(s.dirtyPageIds, pageId),
    }));
  },

  // Structural: the patch can carry the group's `header` / `footer` widget lists, and
  // the paste path uses it to splice a widget into group chrome.
  updatePageGroup: (groupId, patch) => {
    const current = findPageGroupById(get().pages, groupId);
    if (!current || !_patchHasChange(current, patch)) return;
    _throttledSnapshot();
    _setTree((s) => {
      function walk(node: PageNode): PageNode {
        if (!isPageGroup(node)) return node;
        if (node.id === groupId) return { ...node, ...patch };
        return { ...node, children: node.children.map(walk) as PageGroupChild[] };
      }
      return { pages: s.pages.map(walk) };
    });
  },

  deletePageGroup: (groupId) => {
    _snapshot();
    const group = findPageGroupById(get().pages, groupId);
    const descendantIds = group ? flattenPages(group.children).map((p) => p.id) : [];
    _setTree((s) => {
      // Sweep every descendant page, not just direct children — nested groups
      // would otherwise leak pages into loadedPageIds/dirtyPageIds.
      const descendantPageIds = new Set(descendantIds);
      return {
        pages: removePageGroup(s.pages, groupId),
        loadedPageIds: new Set([...s.loadedPageIds].filter((id) => !descendantPageIds.has(id))),
        dirtyPageIds: new Set([...s.dirtyPageIds].filter((id) => !descendantPageIds.has(id))),
      };
    });
  },

  addPageToPageGroup: (groupId, page) => {
    _snapshot();
    const newPage: PageConfig = {
      ...page,
      type: 'page',
      sections: page.sections ?? { content: [] },
    };
    _setTree((s) => ({
      pages: insertPageIntoPageGroup(s.pages, groupId, newPage),
      loadedPageIds: new Set([...s.loadedPageIds, newPage.id]),
      dirtyPageIds: _withDirty(s.dirtyPageIds, newPage.id),
    }));
  },

  reorderPageGroupChildren: (groupId, pages) => {
    _snapshot();
    _setTree((s) => ({ pages: replacePageGroupChildren(s.pages, groupId, pages) }));
  },

  reorderPageChildren: (pageId, children) => {
    _snapshot();
    _setTree((s) => ({
      pages: mapPages(s.pages, (page) => {
        if (page.id !== pageId) return page;
        return { ...page, sections: distributeToSections(page, children) };
      }),
      dirtyPageIds: _withDirty(s.dirtyPageIds, pageId),
    }));
  },

  setPageSections: (pageId, sections) => {
    _snapshot();
    _setTree((s) => ({
      pages: mapPages(s.pages, (page) => (page.id === pageId ? { ...page, sections } : page)),
      dirtyPageIds: _withDirty(s.dirtyPageIds, pageId),
    }));
  },

  // ── Dialog mutations ────────────────────────────────────────────────────────

  addDialog: (dialog) => {
    _snapshot();
    _setTree((s) => ({ dialogs: [...s.dialogs, dialog] }));
  },

  deleteDialog: (dialogId) => {
    _snapshot();
    _setTree((s) => ({ dialogs: s.dialogs.filter((p) => p.id !== dialogId) }));
  },

  renameDialog: (dialogId, title) => {
    _throttledSnapshot();
    set((s) => ({ dialogs: s.dialogs.map((p) => (p.id === dialogId ? { ...p, title } : p)) }));
  },

  updateDialog: (dialogId, patch) => {
    _throttledSnapshot();
    set((s) => ({ dialogs: s.dialogs.map((p) => (p.id === dialogId ? { ...p, ...patch } : p)) }));
  },

  // ── Component mutations ────────────────────────────────────────────────────

  addComponentToPage: (pageId, comp) => {
    _snapshot();
    _setTree((s) => ({
      pages: mapPages(s.pages, (page) => (page.id === pageId ? appendToSection(page, comp) : page)),
      dirtyPageIds: _withDirty(s.dirtyPageIds, pageId),
    }));
  },

  addComponentToPageSection: (pageId, sectionId, comp) => {
    _snapshot();
    _setTree((s) => ({
      pages: mapPages(s.pages, (page) =>
        page.id === pageId ? appendToSection(page, comp, sectionId) : page,
      ),
      dirtyPageIds: _withDirty(s.dirtyPageIds, pageId),
    }));
  },

  addComponentToPageGroupArea: (groupId, area, comp) => {
    _snapshot();
    _setTree((s) => ({
      pages: updatePageGroupChrome(s.pages, groupId, area, (widgets) => [...widgets, comp]),
    }));
  },

  addComponentToArea: (area, comp) => {
    _snapshot();
    _setTree((s) => ({ [area]: [...s[area], comp] }));
  },

  addComponentToDialog: (dialogId, comp) => {
    _snapshot();
    _setTree((s) => ({
      dialogs: s.dialogs.map((pop) =>
        pop.id === dialogId ? { ...pop, widgets: [...pop.widgets, comp] } : pop,
      ),
    }));
  },

  addComponentToContainer: (containerId, comp) => {
    _snapshot();
    const owningPage = findOwningPage(get().pages, containerId);
    _setTree((s) => ({
      ..._mapAllAreas(s, (components) =>
        mapAllComponents(components, (c) =>
          c.id === containerId ? { ...c, children: [...(c.children ?? []), comp] } : c,
        ),
      ),
      dirtyPageIds: owningPage ? _withDirty(s.dirtyPageIds, owningPage.id) : s.dirtyPageIds,
    }));
  },

  // Slot children share the instance's flat `children` array, tagged with the
  // slot they fill — so this is `addComponentToContainer` plus the tag.
  addComponentToWidgetSlot: (widgetId, slot, comp) => {
    get().addComponentToContainer(widgetId, { ...comp, slot });
  },

  deleteComponent: (id) => {
    get().deleteComponents([id]);
  },

  deleteComponents: (ids) => {
    const removedIds = new Set<string>();
    if (ids.length === 0) return removedIds;
    _snapshot();
    const idSet = new Set(ids);
    _setTree((s) => {
      const { areas, removed, touchedPageIds } = _removeWidgetsEverywhere(s, idSet);
      _collectWidgetIds([...removed.values()], removedIds);
      let dirtyPageIds = s.dirtyPageIds;
      for (const pageId of touchedPageIds) dirtyPageIds = _withDirty(dirtyPageIds, pageId);
      return { ...areas, dirtyPageIds };
    });
    return removedIds;
  },

  duplicateComponent: (id) => {
    get().duplicateComponents([id]);
  },

  duplicateComponents: (ids) => {
    if (ids.length === 0) return [];
    const idSet = new Set(ids);
    // Nothing left to duplicate — the widgets went away since the menu was opened.
    // Checked before the batch opens, so it leaves no undo step, no dirty flag and
    // no revision bump.
    if (_findWidgetsByIds(get(), idSet).size === 0) return [];
    _snapshot();
    const taken = _collectAllIds(get());
    let created = new Map<string, string>();
    _setTree((s) => {
      const result = _duplicateWidgetsEverywhere(s, idSet, taken);
      created = result.created;
      let dirtyPageIds = s.dirtyPageIds;
      for (const pageId of result.touchedPageIds) dirtyPageIds = _withDirty(dirtyPageIds, pageId);
      return { ...result.areas, dirtyPageIds };
    });
    return ids.map((id) => created.get(id)).filter((id): id is string => id !== undefined);
  },

  reorderChildren: (parentId, newChildren) => {
    _snapshot();
    _setTree((s) => {
      const shellRegion = regionForShellSectionId(parentId);
      if (shellRegion) return { [shellRegion]: newChildren };
      if (s.dialogs.some((pop) => pop.id === parentId)) {
        return {
          dialogs: s.dialogs.map((pop) =>
            pop.id === parentId ? { ...pop, widgets: newChildren } : pop,
          ),
        };
      }
      if (findPageById(s.pages, parentId)) {
        return {
          pages: mapPages(s.pages, (page) =>
            page.id === parentId
              ? { ...page, sections: replacePageSectionWidgets(page, newChildren) }
              : page,
          ),
          dirtyPageIds: _withDirty(s.dirtyPageIds, parentId),
        };
      }
      const mapper = (c: WidgetConfig) => (c.id === parentId ? { ...c, children: newChildren } : c);
      const owningPage = findOwningPage(s.pages, parentId);
      return {
        ..._mapAllAreas(s, (comps) => mapAllComponents(comps, mapper)),
        dirtyPageIds: owningPage ? _withDirty(s.dirtyPageIds, owningPage.id) : s.dirtyPageIds,
      };
    });
  },

  moveWidgetTo: (nodeId, target, index) => {
    useProjectStore.getState().runBatched(() => {
      const before = get();
      const sourcePage = findOwningPage(before.pages, nodeId);
      const targetPage = _targetOwningPage(before, target);
      _setTree((s) => {
        // One pass: sweep the node out of wherever it lives, then splice it into
        // the target. Doing both in a single `set` keeps the tree consistent for
        // subscribers even when source and target share a parent array.
        let moved: WidgetConfig | null = null;
        const removeFrom = (components: WidgetConfig[]) => {
          if (moved) return components;
          const { arr, removed } = _removeNode(components, nodeId);
          if (removed) moved = removed;
          return arr;
        };
        const pagesAfterSections = mapPages(s.pages, (page) => {
          const res = _removeComponentFromPage(page, nodeId);
          if (!moved && res.removed) moved = res.removed;
          return res.page;
        });
        const pagesWithout = mapPageGroupChrome(pagesAfterSections, removeFrom);
        const shellWithout = {} as Record<ShellAreaId, WidgetConfig[]>;
        for (const region of SHELL_REGION_IDS) shellWithout[region] = removeFrom(s[region]);
        const dialogsWithout = s.dialogs.map((d) => ({ ...d, widgets: removeFrom(d.widgets) }));
        if (!moved) return {};

        // The slot tag names a slot of the old parent; a target that has no slots
        // must clear it or the backend reports `slot-unknown`.
        const node: WidgetConfig = { ...(moved as WidgetConfig) };
        if (target.kind === 'container' && target.slot) node.slot = target.slot;
        else delete node.slot;

        // Every area is written back, not just the one the insert touched — the
        // node was swept out of all of them.
        const swept: AreaSlice = { pages: pagesWithout, ...shellWithout, dialogs: dialogsWithout };
        let dirtyPageIds = s.dirtyPageIds;
        if (sourcePage) dirtyPageIds = _withDirty(dirtyPageIds, sourcePage.id);
        if (targetPage) dirtyPageIds = _withDirty(dirtyPageIds, targetPage.id);
        return { ...swept, ..._insertWidgetsAtTarget(swept, [node], target, index), dirtyPageIds };
      });
    });
  },

  moveWidgetsTo: (nodeIds, target, index) => {
    if (nodeIds.length === 0) return;
    if (_targetSweptByMove(get(), nodeIds, target)) return;
    // Nothing left to move — the widgets went away between drag start and drop.
    // Checked before the batch opens, so a move that resolves to nothing leaves
    // no undo step, no dirty flag and no revision bump.
    if (_findWidgetsByIds(get(), new Set(nodeIds)).size === 0) return;
    if (nodeIds.length === 1) {
      get().moveWidgetTo(nodeIds[0], target, index);
      return;
    }
    useProjectStore.getState().runBatched(() => {
      const targetPage = _targetOwningPage(get(), target);
      _setTree((s) => {
        // Sweep every node out first, then splice them back in contiguously — an
        // index taken before the sweep would be off by however many of them sat
        // above the drop point in the same list.
        const { areas, removed, touchedPageIds } = _removeWidgetsEverywhere(s, new Set(nodeIds));
        if (removed.size === 0) return {};

        // The slot tag names a slot of the old parent; a target that has no slots
        // must clear it or the backend reports `slot-unknown`. Ordered by the ids
        // as given, not by where the sweep happened to find them.
        const nodes: WidgetConfig[] = [];
        for (const id of nodeIds) {
          const node = removed.get(id);
          if (!node) continue;
          const next: WidgetConfig = { ...node };
          if (target.kind === 'container' && target.slot) next.slot = target.slot;
          else delete next.slot;
          nodes.push(next);
        }

        let dirtyPageIds = s.dirtyPageIds;
        for (const pageId of touchedPageIds) dirtyPageIds = _withDirty(dirtyPageIds, pageId);
        if (targetPage) dirtyPageIds = _withDirty(dirtyPageIds, targetPage.id);
        return { ...areas, ..._insertWidgetsAtTarget(areas, nodes, target, index), dirtyPageIds };
      });
    });
  },

  movePageTo: (nodeId, target, index) => {
    // A group cannot become its own descendant. Checked before the batch opens,
    // so a refused move leaves no snapshot and no dirty flag behind.
    if (target && _isDescendantPageNode(get().pages, nodeId, target)) return;
    useProjectStore.getState().runBatched(() => {
      _setTree((s) => {
        const { nodes, removed } = removePageNode(s.pages, nodeId);
        if (!removed) return {};
        if (!target) {
          const roots = [...nodes];
          roots.splice(index ?? roots.length, 0, removed);
          return { pages: roots };
        }
        return { pages: _insertIntoGroup(nodes, target, removed as PageGroupChild, index) };
      });
    });
  },

  reorderPages: (pages) => {
    _snapshot();
    _setTree({ pages });
  },

  // ── Backend persistence ────────────────────────────────────────────────────

  updateComponent: (id, patch) => {
    _throttledSnapshot();
    // Find the owning page so only that page is marked dirty (common hot path).
    const owningPage = findOwningPage(get().pages, id);
    set((s) => {
      const updated = _mapAllAreas(s, (components) =>
        mapAllComponents(components, (c) => {
          if (c.id !== id) return c;
          return {
            ...c,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.properties !== undefined
              ? { properties: { ...c.properties, ...patch.properties } }
              : {}),
            ...(patch.layout !== undefined ? { layout: { ...c.layout, ...patch.layout } } : {}),
          };
        }),
      );
      // Widgets without an owning page live in shell, dialogs, or page-group chrome —
      // all persisted via the index PUT, so no per-page save is needed.
      const dirtyPageIds = owningPage ? _withDirty(s.dirtyPageIds, owningPage.id) : s.dirtyPageIds;
      return { ...updated, dirtyPageIds };
    });
  },

  updateComponents: (ids, patch) => {
    if (ids.length === 0) return;
    if (ids.length === 1) {
      get().updateComponent(ids[0], patch);
      return;
    }
    // Throttled like the single-widget write rather than batched: `runBatched`
    // pushes a snapshot unconditionally, which would make every keystroke in a
    // multi-selected field its own undo entry.
    _throttledSnapshot();
    const idSet = new Set(ids);
    const owningPages = ids
      .map((id) => findOwningPage(get().pages, id))
      .filter((page): page is PageConfig => page != null);
    set((s) => {
      const updated = _mapAllAreas(s, (components) =>
        mapAllComponents(components, (c) => {
          if (!idSet.has(c.id)) return c;
          return {
            ...c,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.properties !== undefined
              ? { properties: { ...c.properties, ...patch.properties } }
              : {}),
            ...(patch.layout !== undefined ? { layout: { ...c.layout, ...patch.layout } } : {}),
          };
        }),
      );
      let dirtyPageIds = s.dirtyPageIds;
      for (const page of owningPages) dirtyPageIds = _withDirty(dirtyPageIds, page.id);
      return { ...updated, dirtyPageIds };
    });
  },

  loadPageContent: async (pageId) => {
    if (get().loadedPageIds.has(pageId)) return;
    try {
      const data = await apiJson<LazyPageResponse>(
        `/api/config/pages/${encodeURIComponent(pageId)}`,
      );
      const sections = normalizeSections(data.sections);

      _setTree((s) => ({
        pages: mapPages(s.pages, (page) => (page.id === pageId ? { ...page, sections } : page)),
        loadedPageIds: new Set([...s.loadedPageIds, pageId]),
      }));
    } catch (err) {
      console.error(`[configStore] Failed to load page ${pageId}:`, err);
    }
  },

  saveConfigToBackend: async () => {
    if (!get().loaded) {
      console.warn('[configStore] Skipping save: index was never loaded from backend');
      return true;
    }
    const {
      pages,
      header,
      footer,
      leftSidebar,
      rightSidebar,
      shell,
      dialogs,
      globalEvents,
      dirtyPageIds,
    } = get();
    try {
      await apiJson('/api/config/config', {
        method: 'PUT',
        body: {
          pages: _toIndexNodes(pages),
          header,
          footer,
          leftSidebar,
          rightSidebar,
          shell,
          dialogs,
          globalEvents,
        },
      });
      // Track which pages actually persisted so only those are cleared from the
      // dirty set — a page edited during this in-flight save (or one whose PUT
      // failed) must stay dirty so its change isn't silently dropped.
      const savedPageIds = new Set<string>();
      const failedPages: Array<{ id: string; message: string }> = [];
      if (dirtyPageIds.size > 0) {
        const pageMap = new Map(flattenPages(pages).map((p) => [p.id, p]));
        const { loadedPageIds } = get();
        // Each page resolves to its own outcome rather than throwing: one
        // failing page must not discard the dirty-clears of its siblings that
        // saved successfully in the batch, and its reason has to survive so the
        // save status can name the page that failed.
        const results = await Promise.all(
          Array.from(dirtyPageIds).map(async (pageId) => {
            const page = pageMap.get(pageId);
            if (!page) return null;
            const body: Record<string, unknown> = { id: pageId };
            // Send null for undefined fields so the backend can strip them from
            // disk — without this, clearing a metadata field (e.g. unchecking
            // "Hidden in menu") leaves the previous value in the per-page file.
            for (const key of PAGE_SAVE_FIELDS) {
              const value = page[key];
              body[key] = value === undefined ? null : value;
            }
            if (loadedPageIds.has(pageId)) {
              body.sections = page.sections;
            }
            try {
              await apiJson(`/api/config/pages/${encodeURIComponent(pageId)}`, {
                method: 'PUT',
                body,
              });
            } catch (err) {
              console.error(`[configStore] Failed to save page ${pageId}:`, err);
              return { id: pageId, message: errorMessage(err) };
            }
            return pageId;
          }),
        );
        for (const result of results) {
          if (!result) continue;
          if (typeof result === 'string') savedPageIds.add(result);
          else failedPages.push(result);
        }
      }
      // Clear only successfully-saved pages; keep pages dirtied mid-save (and
      // any that failed) so their edits are retried on the next save.
      set((s) => ({
        dirtyPageIds: new Set([...s.dirtyPageIds].filter((id) => !savedPageIds.has(id))),
        saveError:
          failedPages.length === 0
            ? null
            : failedPages.length === 1
              ? `page "${failedPages[0].id}" — ${failedPages[0].message}`
              : `${failedPages.length} pages (${failedPages.map((p) => p.id).join(', ')}) — ${failedPages[0].message}`,
      }));
      return failedPages.length === 0;
    } catch (err) {
      console.error('[configStore] Failed to save config:', err);
      set({ saveError: errorMessage(err) });
      return false;
    }
  },
}));
