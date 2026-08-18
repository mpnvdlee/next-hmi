import { useConfigStore } from '@shared/store/configStore';
import { useProjectStore } from '@shared/store/projectStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import {
  SHELL_REGION_IDS,
  shellSectionIdForRegion,
  regionForShellSectionId,
  type DialogConfig,
  type PageConfig,
  type PageGroupChild,
  type PageGroupConfig,
  type WidgetConfig,
} from '@shared/types/config';
import { EDITOR_NODE_IDS } from '@shared/constants/editorSentinels';
import { collectAllIds, type AllAreas } from '@shared/store/configStoreHelpers';
import { findComponentById, findInPages } from '@shared/utils/widgetTree';
import {
  findPageNodeById,
  findParentPageGroup,
  flattenPages,
  isPageGroup,
  pageHasExplicitSections,
} from '@shared/utils/pageTree';
import {
  pasteToast,
  regenerateIds,
  type ClipboardEntry,
  type ClipboardNode,
  type ClipboardNodeKind,
} from './clipboardOps';
import { clearCut, matchesPendingCut } from './cutState';
import { findParentInfo, type WidgetParentInfo } from './treeUtils';
import { batchInsertOrder, insertComponentInto } from './insertComponent';
import { verbTargets } from '@config/store/domains/selectionScope';
import { isContainerHostType } from '@hmi/registry/widgetRegistry';
import type { NodeKind } from './types';

type ProjectSnapshot = AllAreas;

interface StoreSnapshot extends ProjectSnapshot {
  loadedPageIds: Set<string>;
  dirtyPageIds: Set<string>;
}

function storeSnapshot(): StoreSnapshot {
  const s = useConfigStore.getState();
  return { ...projectFromStore(), loadedPageIds: s.loadedPageIds, dirtyPageIds: s.dirtyPageIds };
}

/** Put every area back as it was — the escape hatch for a cut whose insert
 *  refused after the removal had already run. Goes through the store so the
 *  restored tree is published with a fresh revision, like every other structural
 *  write. */
function restoreStore(before: StoreSnapshot): void {
  useConfigStore.getState().restoreAreas(before);
}

/** A move is a delete plus an insert, and `deletePageGroup` sweeps its pages out
 *  of `loadedPageIds` / `dirtyPageIds` while the insert re-adds none of them.
 *  Re-apply the pre-move membership for every page that is still in the tree, so
 *  a moved group's unsaved content still reaches disk. */
function keepPageState(before: StoreSnapshot): void {
  useConfigStore.setState((s) => {
    const present = new Set(flattenPages(s.pages).map((page) => page.id));
    const merge = (current: Set<string>, prior: Set<string>) => {
      const next = new Set(current);
      for (const id of prior) if (present.has(id)) next.add(id);
      return next.size === current.size ? current : next;
    };
    return {
      loadedPageIds: merge(s.loadedPageIds, before.loadedPageIds),
      dirtyPageIds: merge(s.dirtyPageIds, before.dirtyPageIds),
    };
  });
}

export function projectFromStore(): ProjectSnapshot {
  const s = useConfigStore.getState();
  return {
    header: s.header,
    footer: s.footer,
    leftSidebar: s.leftSidebar,
    rightSidebar: s.rightSidebar,
    pages: s.pages,
    dialogs: s.dialogs,
  };
}

function findWidgetInPageGroupChrome(
  nodes: ProjectSnapshot['pages'],
  id: string,
): WidgetConfig | null {
  for (const node of nodes) {
    if (!isPageGroup(node)) continue;
    if (node.header) {
      const found = findComponentById(node.header, id);
      if (found) return found;
    }
    if (node.footer) {
      const found = findComponentById(node.footer, id);
      if (found) return found;
    }
    const nested = findWidgetInPageGroupChrome(node.children, id);
    if (nested) return nested;
  }
  return null;
}

export function findWidgetEverywhere(p: ProjectSnapshot, id: string): WidgetConfig | null {
  for (const region of SHELL_REGION_IDS) {
    const found = findComponentById(p[region], id);
    if (found) return found;
  }
  for (const dialog of p.dialogs) {
    const found = findComponentById(dialog.widgets, id);
    if (found) return found;
  }
  const { comp } = findInPages(p.pages, id);
  if (comp) return comp;
  return findWidgetInPageGroupChrome(p.pages, id);
}

export function kindForSelectedId(
  p: ProjectSnapshot,
  id: string,
): { kind: NodeKind; nodeId: string } | null {
  if (
    id === EDITOR_NODE_IDS.SETTINGS ||
    id === EDITOR_NODE_IDS.EVENTS ||
    id === EDITOR_NODE_IDS.PAGES ||
    id === EDITOR_NODE_IDS.DIALOGS
  ) {
    return null;
  }
  if (regionForShellSectionId(id)) return null;
  if ((SHELL_REGION_IDS as readonly string[]).includes(id)) return { kind: 'area', nodeId: id };
  if (p.dialogs.some((d) => d.id === id)) return { kind: 'dialog-page', nodeId: id };
  const pageNode = findPageNodeById(p.pages, id);
  if (pageNode) {
    return isPageGroup(pageNode)
      ? { kind: 'page-group', nodeId: id }
      : { kind: 'page', nodeId: id };
  }
  const widget = findWidgetEverywhere(p, id);
  if (widget) {
    return { kind: isContainerHostType(widget.type) ? 'container' : 'leaf', nodeId: id };
  }
  return null;
}

export function resolveCopySource(
  p: ProjectSnapshot,
  nodeId: string,
  kind: NodeKind,
): ClipboardNode | null {
  if (kind === 'dialog-page') {
    const dialog = p.dialogs.find((d) => d.id === nodeId);
    return dialog ? { kind: 'dialog', node: dialog } : null;
  }
  if (kind === 'page' || kind === 'page-group') {
    const node = findPageNodeById(p.pages, nodeId);
    if (!node) return null;
    return isPageGroup(node) ? { kind: 'page-group', node } : { kind: 'page', node };
  }
  if (kind === 'container' || kind === 'leaf') {
    const widget = findWidgetEverywhere(p, nodeId);
    return widget ? { kind: 'widget', node: widget } : null;
  }
  return null;
}

/**
 * What Copy or Cut should write for the node the user acted on: the whole
 * multi-selection when that node is part of it, otherwise just that node.
 * Descendants of another selected node are dropped — copying a container already
 * takes its children.
 */
export function resolveCopyEntry(
  p: ProjectSnapshot,
  nodeId: string,
  kind: NodeKind,
): ClipboardEntry | null {
  const { selectedIds } = useEditorDomainStore.getState();
  const targets = verbTargets(selectedIds, nodeId, p);
  // Only the acted-on row arrives with its kind already resolved. When the
  // selection collapses onto a *different* node — a selected container that
  // swallowed the right-clicked child — that node is the target, exactly as it is
  // for delete and duplicate, so fall through and resolve its kind from the tree.
  if (targets.length === 1 && targets[0] === nodeId) return resolveCopySource(p, nodeId, kind);

  const nodes: ClipboardNode[] = [];
  for (const id of targets) {
    const resolved = kindForSelectedId(p, id);
    const source = resolved && resolveCopySource(p, resolved.nodeId, resolved.kind);
    if (source) nodes.push(source);
  }
  if (nodes.length === 0) return null;
  return nodes.length === 1 ? nodes[0] : { kind: 'multi', nodes };
}

export function clipboardNodeIds(entry: ClipboardEntry): string[] {
  return entriesOf(entry).map((n) => n.node.id);
}

/** Every node of a batch shares one kind — see `ClipboardMulti`. */
export function clipboardKind(entry: ClipboardEntry): ClipboardNodeKind {
  return entry.kind === 'multi' ? entry.nodes[0].kind : entry.kind;
}

function spliceAfter<T>(arr: T[], index: number, item: T): T[] {
  const at = index + 1;
  return [...arr.slice(0, at), item, ...arr.slice(at)];
}

function insertWidgetSiblingAfter(
  p: ProjectSnapshot,
  targetWidgetId: string,
  newWidget: WidgetConfig,
): boolean {
  const store = useConfigStore.getState();
  const parent: WidgetParentInfo | null = findParentInfo(p, targetWidgetId);
  if (!parent) return false;
  switch (parent.kind) {
    case 'container': {
      // Siblings inside a component instance share one array across every slot,
      // so the paste lands in the slot the target sits in, not the first one.
      const target = parent.siblings[parent.index];
      const slotted = target?.slot ? { ...newWidget, slot: target.slot } : newWidget;
      store.reorderChildren(parent.parentId, spliceAfter(parent.siblings, parent.index, slotted));
      return true;
    }
    case 'shell-area':
      store.reorderChildren(
        shellSectionIdForRegion(parent.region),
        spliceAfter(parent.siblings, parent.index, newWidget),
      );
      return true;
    case 'dialog':
      store.reorderChildren(parent.dialogId, spliceAfter(parent.siblings, parent.index, newWidget));
      return true;
    case 'page-section': {
      const page = findPageNodeById(p.pages, parent.pageId);
      if (!page || isPageGroup(page)) return false;
      const newSiblings = spliceAfter<WidgetConfig>(parent.siblings, parent.index, newWidget);
      store.setPageSections(parent.pageId, { ...page.sections, [parent.sectionId]: newSiblings });
      return true;
    }
    case 'page-group-chrome':
      store.updatePageGroup(parent.groupId, {
        [parent.area]: spliceAfter(parent.siblings, parent.index, newWidget),
      });
      return true;
  }
}

function findPageContainer(
  pages: ProjectSnapshot['pages'],
  pageId: string,
): { parentGroup: PageGroupConfig | null; siblings: PageGroupChild[]; index: number } | null {
  const topLevelIdx = pages.findIndex((n) => !isPageGroup(n) && n.id === pageId);
  if (topLevelIdx !== -1) {
    const topLevelPages = pages.filter((n): n is PageConfig => !isPageGroup(n));
    return {
      parentGroup: null,
      siblings: topLevelPages,
      index: topLevelPages.findIndex((p) => p.id === pageId),
    };
  }
  const parentGroup = findParentPageGroup(pages, pageId);
  if (parentGroup) {
    return {
      parentGroup,
      siblings: parentGroup.children,
      index: parentGroup.children.findIndex((c) => c.id === pageId),
    };
  }
  return null;
}

function insertPageSiblingAfter(
  p: ProjectSnapshot,
  targetPageId: string,
  newPage: PageConfig,
): void {
  const store = useConfigStore.getState();
  const ctx = findPageContainer(p.pages, targetPageId);
  if (!ctx) {
    store.addPage(newPage);
    return;
  }
  if (ctx.parentGroup) {
    const newChildren = spliceAfter(ctx.siblings, ctx.index, newPage);
    store.addPageToPageGroup(ctx.parentGroup.id, newPage);
    store.reorderPageGroupChildren(ctx.parentGroup.id, newChildren);
    return;
  }
  const topLevelIdx = p.pages.findIndex((n) => n.id === targetPageId);
  store.addPage(newPage);
  store.reorderPages(spliceAfter(p.pages, topLevelIdx, newPage));
}

type WidgetPasteAction = (p: ProjectSnapshot, nodeId: string, comp: WidgetConfig) => boolean;
type PagePasteAction = (p: ProjectSnapshot, nodeId: string, page: PageConfig) => boolean;
type PageGroupPasteAction = (p: ProjectSnapshot, nodeId: string, group: PageGroupConfig) => boolean;
type DialogPasteAction = (p: ProjectSnapshot, nodeId: string, dialog: DialogConfig) => boolean;

/** Kinds whose widget paste is exactly an append to that node — the same
 *  resolution the context-menu add flows and the widget drawer use. Listed
 *  rather than defaulted so a kind that cannot host a widget still reports
 *  "Cannot paste component here" instead of silently landing somewhere. */
const APPEND_PASTE_KINDS: ReadonlySet<NodeKind> = new Set([
  'container',
  'page-section',
  'page-group-section',
  'widget-slot',
  'area',
  'dialog-page',
]);

/** The two kinds whose paste is not a plain append. */
const WIDGET_PASTE: Partial<Record<NodeKind, WidgetPasteAction>> = {
  page: (p, id, comp) => {
    // A page with Header/Content/Footer folders requires an explicit section
    // target — mirrors the gating in ContextMenu.tsx and MoveModal.tsx.
    if (pageHasExplicitSections(findPageNodeById(p.pages, id))) return false;
    useConfigStore.getState().addComponentToPage(id, comp);
    return true;
  },
  leaf: (p, id, comp) => insertWidgetSiblingAfter(p, id, comp),
};

function pasteWidget(
  p: ProjectSnapshot,
  nodeId: string,
  kind: NodeKind,
  comp: WidgetConfig,
): boolean {
  const special = WIDGET_PASTE[kind];
  if (special) return special(p, nodeId, comp);
  if (!APPEND_PASTE_KINDS.has(kind)) return false;
  insertComponentInto(useConfigStore.getState(), kind, nodeId, comp);
  return true;
}

const PAGE_PASTE: Partial<Record<NodeKind, PagePasteAction>> = {
  'pages-root': (_p, _id, page) => {
    useConfigStore.getState().addPage(page);
    return true;
  },
  'page-group': (_p, id, page) => {
    useConfigStore.getState().addPageToPageGroup(id, page);
    return true;
  },
  page: (p, id, page) => {
    insertPageSiblingAfter(p, id, page);
    return true;
  },
};

const PAGE_GROUP_PASTE: Partial<Record<NodeKind, PageGroupPasteAction>> = {
  'pages-root': (_p, _id, group) => {
    useConfigStore.getState().addPageGroup(group);
    return true;
  },
  'page-group': (_p, id, group) => {
    useConfigStore.getState().addPageGroupToPageGroup(id, group);
    return true;
  },
};

const DIALOG_PASTE: Partial<Record<NodeKind, DialogPasteAction>> = {
  'dialog-page': (_p, _id, dialog) => {
    useConfigStore.getState().addDialog(dialog);
    return true;
  },
  area: (_p, _id, dialog) => {
    useConfigStore.getState().addDialog(dialog);
    return true;
  },
  'pages-root': (_p, _id, dialog) => {
    useConfigStore.getState().addDialog(dialog);
    return true;
  },
};

const REJECT_LABEL: Record<ClipboardNodeKind, string> = {
  widget: 'Cannot paste component here',
  page: 'Cannot paste page here',
  'page-group': 'Cannot paste page group here',
  dialog: 'Cannot paste dialog here',
};

function insertClipboardNode(
  p: ProjectSnapshot,
  entry: ClipboardNode,
  nodeId: string,
  kind: NodeKind,
): boolean {
  switch (entry.kind) {
    case 'widget':
      return pasteWidget(p, nodeId, kind, entry.node);
    case 'page':
      return PAGE_PASTE[kind]?.(p, nodeId, entry.node) ?? false;
    case 'page-group':
      return PAGE_GROUP_PASTE[kind]?.(p, nodeId, entry.node) ?? false;
    case 'dialog':
      return DIALOG_PASTE[kind]?.(p, nodeId, entry.node) ?? false;
  }
}

/** Whether this target would take this kind of node — the same rules the paste
 *  tables apply, asked ahead of time so a cut never removes what it cannot
 *  re-insert. */
function targetAccepts(
  p: ProjectSnapshot,
  clipboardKind: ClipboardNodeKind,
  nodeId: string,
  kind: NodeKind,
): boolean {
  switch (clipboardKind) {
    case 'widget':
      if (kind === 'leaf') return findParentInfo(p, nodeId) !== null;
      if (kind === 'page') return !pageHasExplicitSections(findPageNodeById(p.pages, nodeId));
      return APPEND_PASTE_KINDS.has(kind);
    case 'page':
      return PAGE_PASTE[kind] !== undefined;
    case 'page-group':
      return PAGE_GROUP_PASTE[kind] !== undefined;
    case 'dialog':
      return DIALOG_PASTE[kind] !== undefined;
  }
}

/** Remove the node a cut is moving, so the insert that follows re-homes it
 *  rather than duplicating it. */
function removeCutSource(entry: ClipboardNode): void {
  const store = useConfigStore.getState();
  switch (entry.kind) {
    case 'widget':
      store.deleteComponent(entry.node.id);
      break;
    case 'page':
      store.deletePage(entry.node.id);
      break;
    case 'page-group':
      store.deletePageGroup(entry.node.id);
      break;
    case 'dialog':
      store.deleteDialog(entry.node.id);
      break;
  }
}

/** A node cannot be re-homed inside itself: the target row must not be the
 *  node being moved, nor anything under it. A page group is the dangerous case
 *  — removing it takes its whole subtree with it, so a target underneath would
 *  be gone before the insert runs. */
function targetInsideMovedSubtree(entry: ClipboardNode, nodeId: string): boolean {
  const [targetWidgetId] = nodeId.split('::');
  if (entry.node.id === nodeId || entry.node.id === targetWidgetId) return true;
  switch (entry.kind) {
    case 'widget':
      return (
        findComponentById((entry.node.children as WidgetConfig[]) ?? [], targetWidgetId) !== null
      );
    case 'page-group': {
      const walk = (children: PageGroupChild[]): boolean =>
        children.some(
          (child) => child.id === nodeId || (isPageGroup(child) && walk(child.children)),
        );
      return walk(entry.node.children);
    }
    default:
      return false;
  }
}

/** Whether this paste is the second half of a cut: the same nodes, still in this
 *  project. Whether the *target* is legal is asked separately, so a cut into
 *  the node's own subtree is refused rather than quietly cloned. */
function isCutMove(p: ProjectSnapshot, entry: ClipboardEntry): boolean {
  const nodes = entriesOf(entry);
  if (!matchesPendingCut(nodes)) return false;
  return nodes.every((n) => nodeStillPresent(p, n));
}

/** A single entry as a one-element list, so the multi and single paths share code. */
function entriesOf(entry: ClipboardEntry): ClipboardNode[] {
  return entry.kind === 'multi' ? entry.nodes : [entry];
}

function nodeStillPresent(p: ProjectSnapshot, entry: ClipboardNode): boolean {
  switch (entry.kind) {
    case 'widget':
      return findWidgetEverywhere(p, entry.node.id) !== null;
    case 'page':
    case 'page-group':
      return findPageNodeById(p.pages, entry.node.id) !== null;
    case 'dialog':
      return p.dialogs.some((d) => d.id === entry.node.id);
  }
}

/** The order a batch has to be inserted in. `batchInsertOrder` covers the widget
 *  case; a page batch pasted on a page row lands each node *directly* after that
 *  row too, so it needs the same reversal to come out in the order it was copied. */
function pasteInsertOrder(nodes: ClipboardNode[], kind: NodeKind): readonly ClipboardNode[] {
  if (kind === 'page' && nodes[0].kind === 'page') return [...nodes].reverse();
  return batchInsertOrder(nodes, kind);
}

/** Insert every node of a batch. */
function insertClipboardNodes(nodes: ClipboardNode[], nodeId: string, kind: NodeKind): boolean {
  let inserted = 0;
  for (const node of pasteInsertOrder(nodes, kind)) {
    // Each insert resolves against the tree the previous one left behind.
    if (insertClipboardNode(projectFromStore(), node, nodeId, kind)) inserted += 1;
  }
  return inserted === nodes.length;
}

/** Paste of a `$hmiClipboard` batch: the single-node rules, asked once for the
 *  whole set so a partial move can never leave nodes deleted. */
function dispatchMultiPaste(
  p: ProjectSnapshot,
  nodes: ClipboardNode[],
  nodeId: string,
  kind: NodeKind,
): void {
  const { setSelectedMany } = useEditorDomainStore.getState();
  const entry: ClipboardEntry = { kind: 'multi', nodes };
  const reject = () => pasteToast('error', REJECT_LABEL[nodes[0].kind]);

  if (isCutMove(p, entry)) {
    if (
      nodes.some((node) => targetInsideMovedSubtree(node, nodeId)) ||
      !targetAccepts(p, nodes[0].kind, nodeId, kind)
    ) {
      reject();
      return;
    }
    let moved = false;
    useProjectStore.getState().runBatched(() => {
      const before = storeSnapshot();
      for (const node of nodes) removeCutSource(node);
      moved = insertClipboardNodes(nodes, nodeId, kind);
      if (moved) keepPageState(before);
      else restoreStore(before);
    });
    if (!moved) {
      reject();
      return;
    }
    clearCut();
    setSelectedMany(nodes.map((n) => n.node.id));
    return;
  }

  // Asked before the batch opens: `runBatched` pushes its undo step and dirties
  // the project up front, so a target that refuses would otherwise leave a step
  // that undoes nothing and a save indicator for an edit that never happened.
  if (!targetAccepts(p, nodes[0].kind, nodeId, kind)) {
    reject();
    return;
  }

  const fresh = regenerateIds(entry, collectAllIds(p));
  const clones = fresh.kind === 'multi' ? fresh.nodes : [fresh];
  // One batch so the whole paste is a single undo step, matching the cut-move path.
  let pasted = false;
  useProjectStore.getState().runBatched(() => {
    const before = storeSnapshot();
    pasted = insertClipboardNodes(clones, nodeId, kind);
    if (!pasted) restoreStore(before);
  });
  if (!pasted) {
    reject();
    return;
  }
  setSelectedMany(clones.map((n) => n.node.id));
}

export function dispatchPaste(
  p: ProjectSnapshot,
  entry: ClipboardEntry,
  nodeId: string,
  kind: NodeKind,
): void {
  const setSelected = useEditorDomainStore.getState().setSelected;

  if (entry.kind === 'multi') {
    dispatchMultiPaste(p, entry.nodes, nodeId, kind);
    return;
  }

  if (isCutMove(p, entry)) {
    // Acceptance is checked before the removal, so a rejected target can never
    // leave the node deleted; the cut stays pending for another try.
    if (targetInsideMovedSubtree(entry, nodeId) || !targetAccepts(p, entry.kind, nodeId, kind)) {
      pasteToast('error', REJECT_LABEL[entry.kind]);
      return;
    }
    let moved = false;
    useProjectStore.getState().runBatched(() => {
      const before = storeSnapshot();
      removeCutSource(entry);
      // The insert resolves against the tree the removal just left behind — and
      // a target that survived the pre-check can still refuse there, so put the
      // project back rather than drop the node on the floor.
      moved = insertClipboardNode(projectFromStore(), entry, nodeId, kind);
      if (moved) keepPageState(before);
      else restoreStore(before);
    });
    if (!moved) {
      pasteToast('error', REJECT_LABEL[entry.kind]);
      return;
    }
    clearCut();
    setSelected(entry.node.id);
    return;
  }

  // A single entry in, a single entry out — the multi case returned above.
  const fresh = regenerateIds(entry, collectAllIds(p)) as ClipboardNode;
  if (insertClipboardNode(p, fresh, nodeId, kind)) {
    setSelected(fresh.node.id);
  } else {
    pasteToast('error', REJECT_LABEL[fresh.kind]);
  }
}
