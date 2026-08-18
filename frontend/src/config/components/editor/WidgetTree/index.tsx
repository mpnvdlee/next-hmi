/**
 * WidgetTree — left sidebar panel for /editor.
 *
 * Four collapsible sections: Header · Footer · Pages · Dialogs
 *
 * - Header / Footer: singleton areas; right-click or + to add components
 * - Pages: existing page CRUD + drag reorder
 * - Dialogs: add / rename / delete dialog, edit components inside it
 * - Components inside any area: same container / leaf context menu as before
 *
 * Style rule: zero `style={{}}` except CSS custom properties.
 */

import { Fragment, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  DndContext,
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useDndSensors } from '@shared/hooks/useDndSensors';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useConfigStore } from '@shared/store/configStore';
import { collectAllIds } from '@shared/store/configStoreHelpers';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useToggleSet } from '@shared/hooks/useToggleSet';
import {
  SHELL_REGION_IDS,
  shellSectionIdForRegion,
  type PageConfig,
  type ShellRegionId,
} from '@shared/types/config';
import ContextMenu from './ContextMenu';
import WidgetSelector from '../../ui/WidgetSelector';
import {
  makeComponentOfType,
  makeDefaultContainer,
  makeDefaultDialog,
  makeDefaultPage,
  makeDefaultPageGroup,
} from './treeUtils';
import { copyTreeNode, pasteToast, readTreeNodeFromClipboard } from './clipboardOps';
import { deleteWidgetsKeepingSelection } from './deleteSelection';
import { DropIndicatorProvider } from './dropIndicator';
import type { DropIndicator } from './dropIndicatorContext';
import { bandOf, dropFeedback, pointerYOf, resolveDropTarget } from './dropTarget';
import { collectMovedWidgets, type MovedWidgets } from '@shared/store/configStoreHelpers';
import { clearCut, setCut } from './cutState';
import {
  clipboardKind,
  clipboardNodeIds,
  dispatchPaste,
  kindForSelectedId,
  projectFromStore,
  resolveCopyEntry,
} from './clipboardDispatch';
import { collectAllCollapsibleIds, findRevealTarget, type ShellAreas } from './treeFilters';
import { useTreeSearch } from './useTreeSearch';
import { findPageNodeById, isPageGroup, resolvePageTitle } from '@shared/utils/pageTree';
import { findComponentInPages } from '@shared/utils/widgetTree';
import { detectCopyPasteKey, type SelectionModifiers } from '@shared/utils/domEvent';
import { canExtendWith, verbTargets } from '@config/store/domains/selectionScope';
import { flattenVisibleRows, rowsBetween, type VisibleRowsInput } from './visibleRows';
import { matchesSearchWords, withDotSearchSeparators } from '@shared/utils/search';
import { EDITOR_NODE_IDS, parseWidgetSlotId } from '@shared/constants/editorSentinels';
import { slotTargetLabel } from '@hmi/components/ComponentSlot/slotKey';
import { insertComponentInto } from './insertComponent';
import type { ContextMenuState, NodeKind } from './types';
import AreaWidgetList from './AreaWidgetList';
import TreePage from './TreePage';
import TreePageGroup from './TreePageGroup';
import TreeDialogPage from './TreeDialogPage';
import SectionRow from './SectionRow';
import TreeRow from '../../ui/TreeRow';
import TreeSearchBar from '../../ui/TreeSearchBar';
import { TreeDiagnosticDot } from '../../ui/TreeAffordances';
import { containsSeverityTitle, useDiagnosticIndex } from '@config/hooks/useProjectDiagnostics';
import { TreeSelectionContext } from './treeSelectionContext';
import { TreeSearchHighlight, TreeSearchQueryProvider } from './TreeSearchHighlight';

interface ShellSectionMeta {
  label: string;
  icon: string;
  addTitle: string;
  emptyMessage: string;
}

const SHELL_SECTION_META: Record<ShellRegionId, ShellSectionMeta> = {
  header: {
    label: 'Header',
    icon: '▣',
    addTitle: 'Add to header',
    emptyMessage: 'No header components match',
  },
  leftSidebar: {
    label: 'Left sidebar',
    icon: '◧',
    addTitle: 'Add to left sidebar',
    emptyMessage: 'No left sidebar components match',
  },
  rightSidebar: {
    label: 'Right sidebar',
    icon: '◨',
    addTitle: 'Add to right sidebar',
    emptyMessage: 'No right sidebar components match',
  },
  footer: {
    label: 'Footer',
    icon: '▄',
    addTitle: 'Add to footer',
    emptyMessage: 'No footer components match',
  },
};

/** Display name of the node a widget is about to be inserted into — the widget
 *  selector shows it before its own action. */
function insertTargetName(
  store: ReturnType<typeof useConfigStore.getState>,
  nodeId: string,
  kind: NodeKind,
): string | undefined {
  if (kind === 'area') return SHELL_SECTION_META[nodeId as ShellRegionId]?.label;
  if (kind === 'dialog-page') {
    const dialog = store.dialogs.find((d) => d.id === nodeId);
    return dialog ? resolvePageTitle(dialog.title) : undefined;
  }
  if (kind === 'page') {
    const page = findPageNodeById(store.pages, nodeId);
    return page && !isPageGroup(page) ? resolvePageTitle(page.title) : undefined;
  }
  if (kind === 'widget-slot') {
    const [widgetId, slot] = parseWidgetSlotId(nodeId);
    const widget = findComponentInPages(store.pages, widgetId);
    return widget ? slotTargetLabel(widget.name, slot) : undefined;
  }
  return findComponentInPages(store.pages, nodeId)?.name;
}

/** Pointer-first so the band under the cursor decides the drop; the rect-based
 *  fallback keeps keyboard drags working. */
const treeCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCenter(args);
};

// ── WidgetTree root ────────────────────────────────────────────────────────
export default function WidgetTree() {
  const pages = useConfigStore((s) => s.pages);
  const header = useConfigStore((s) => s.header);
  const footer = useConfigStore((s) => s.footer);
  const leftSidebar = useConfigStore((s) => s.leftSidebar);
  const rightSidebar = useConfigStore((s) => s.rightSidebar);
  const dialogs = useConfigStore((s) => s.dialogs);
  const loaded = useConfigStore((s) => s.loaded);
  const selectedId = useEditorDomainStore((s) => s.selectedId);
  const selectedIdList = useEditorDomainStore((s) => s.selectedIds);
  const setSelected = useEditorDomainStore((s) => s.setSelected);
  const treeCollapsedIds = useEditorDomainStore((s) => s.treeCollapsedIds);
  const treeOpenSectionIds = useEditorDomainStore((s) => s.treeOpenSectionIds);
  const setTreeCollapsedIds = useEditorDomainStore((s) => s.setTreeCollapsedIds);
  const setTreeOpenSectionIds = useEditorDomainStore((s) => s.setTreeOpenSectionIds);

  const sensors = useDndSensors();
  const diagnostics = useDiagnosticIndex();
  const eventsSeverity = diagnostics.byArtifact.get('globalEvents:globalEvents');

  const [collapsed, toggleCollapsed, setCollapsed] = useToggleSet<string>(treeCollapsedIds);
  const [sectionsOpen, toggleSection, setSectionsOpen] = useToggleSet<string>(treeOpenSectionIds);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [selectorTarget, setSelectorTarget] = useState<{
    nodeId: string;
    kind: NodeKind;
    name?: string;
  } | null>(null);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const initializedClosedTreeRef = useRef(false);

  const shell = useMemo<ShellAreas>(
    () => ({ header, footer, leftSidebar, rightSidebar }),
    [header, footer, leftSidebar, rightSidebar],
  );

  const allCollapsibleIds = useMemo(
    () => collectAllCollapsibleIds(pages, shell, dialogs),
    [pages, shell, dialogs],
  );

  useEffect(() => {
    setTreeCollapsedIds(Array.from(collapsed));
  }, [collapsed, setTreeCollapsedIds]);

  useEffect(() => {
    setTreeOpenSectionIds(Array.from(sectionsOpen));
  }, [sectionsOpen, setTreeOpenSectionIds]);

  const collapseAll = useCallback(() => {
    setSectionsOpen(new Set());
    setCollapsed(new Set(allCollapsibleIds));
  }, [allCollapsibleIds, setCollapsed, setSectionsOpen]);

  useEffect(() => {
    if (!loaded || initializedClosedTreeRef.current) return;
    initializedClosedTreeRef.current = true;
    collapseAll();
  }, [collapseAll, loaded]);

  useEffect(() => {
    if (!selectedId) return;
    const target = findRevealTarget(selectedId, pages, shell, dialogs);
    if (!target) return;

    setSectionsOpen((prev) => {
      if (prev.has(target.sectionId)) return prev;
      const next = new Set(prev);
      next.add(target.sectionId);
      return next;
    });

    if (target.expandIds.length === 0) return;

    setCollapsed((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of target.expandIds) {
        if (!next.has(id)) continue;
        next.delete(id);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [selectedId, pages, shell, dialogs, setCollapsed, setSectionsOpen]);

  useEffect(() => {
    if (!selectedId) return;
    const raf = requestAnimationFrame(() => {
      const row = scrollRef.current?.querySelector(
        '.cfg-tree-item--selected',
      ) as HTMLElement | null;
      row?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedId, collapsed, sectionsOpen]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        clearCut();
        return;
      }
      const key = detectCopyPasteKey(e);
      if (!key) return;
      // PropertiesPanel owns the shortcut when a parameter is selected.
      if (useEditorDomainStore.getState().selectedParam) return;
      const sid = useEditorDomainStore.getState().selectedId;
      if (!sid) return;
      const project = projectFromStore();
      const resolved = kindForSelectedId(project, sid);
      if (!resolved) return;
      e.preventDefault();
      if (key === 'c' || key === 'x') {
        const src = resolveCopyEntry(project, resolved.nodeId, resolved.kind);
        if (!src) {
          pasteToast('error', `Nothing to ${key === 'x' ? 'cut' : 'copy'}`);
          return;
        }
        void copyTreeNode(src, key === 'x' ? 'cut' : 'copy');
        if (key === 'x') setCut(clipboardNodeIds(src), clipboardKind(src));
        else clearCut();
      } else {
        void readTreeNodeFromClipboard().then((entry) => {
          if (!entry) return;
          dispatchPaste(projectFromStore(), entry, resolved.nodeId, resolved.kind);
        });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { filteredShell, filteredPages, filteredDialogs } = useTreeSearch(
    searchQuery,
    shell,
    pages,
    dialogs,
  );
  const isSearching = searchQuery.trim().length > 0;
  const wordSearchQuery = withDotSearchSeparators(searchQuery);

  const effectiveSectionsOpen = useMemo(() => {
    if (!isSearching) return sectionsOpen;
    const open = new Set(sectionsOpen);
    for (const region of SHELL_REGION_IDS) {
      if (filteredShell[region].length > 0) open.add(shellSectionIdForRegion(region));
    }
    if (filteredPages.length > 0) open.add(EDITOR_NODE_IDS.PAGES);
    if (filteredDialogs.length > 0) open.add(EDITOR_NODE_IDS.DIALOGS);
    return open;
  }, [isSearching, sectionsOpen, filteredShell, filteredPages, filteredDialogs]);

  const effectiveCollapsed = useMemo(() => {
    if (!isSearching) return collapsed;
    // When searching, expand everything — filter already hides non-matches
    return new Set<string>();
  }, [isSearching, collapsed]);

  const settingsVisible = !isSearching || matchesSearchWords(wordSearchQuery, 'Settings');
  const eventsVisible = !isSearching || matchesSearchWords(wordSearchQuery, 'Global Events');
  const pagesVisible =
    !isSearching || matchesSearchWords(wordSearchQuery, 'Pages') || filteredPages.length > 0;
  const dialogsVisible =
    !isSearching || matchesSearchWords(wordSearchQuery, 'Dialogs') || filteredDialogs.length > 0;

  // Hoisted out of the render so `flattenVisibleRows` below decides section
  // visibility from the same value the rows are rendered from.
  const hiddenShellRegions = useMemo(() => {
    const hidden = new Set<ShellRegionId>();
    if (!isSearching) return hidden;
    for (const region of SHELL_REGION_IDS) {
      const { label } = SHELL_SECTION_META[region];
      if (
        !matchesSearchWords(wordSearchQuery, [label, region]) &&
        filteredShell[region].length === 0
      )
        hidden.add(region);
    }
    return hidden;
  }, [isSearching, wordSearchQuery, filteredShell]);

  // What the rows the user can see right now are flattened from. Only a Shift-range
  // reads them, so the walk itself waits until the click — `pages` is rewritten on
  // every keystroke in the properties panel, and flattening the whole project each
  // time buys nothing. The ref keeps `selectRow` (and therefore the tree's whole
  // selection context) at a stable identity across renders.
  const rowSource: VisibleRowsInput = {
    pages: filteredPages,
    shell: filteredShell,
    dialogs: filteredDialogs,
    collapsed: effectiveCollapsed,
    sectionsOpen: effectiveSectionsOpen,
    visible: {
      settings: settingsVisible,
      events: eventsVisible,
      pages: pagesVisible,
      dialogs: dialogsVisible,
      hiddenShellRegions,
    },
  };
  const rowSourceRef = useRef(rowSource);
  // Written after the commit, never during render: a render React throws away
  // must not leave `selectRow` slicing a range out of a tree state that was
  // never shown. No dependency list — every commit is a new row source.
  useEffect(() => {
    rowSourceRef.current = rowSource;
  });

  const selectRow = useCallback((id: string, mods: SelectionModifiers) => {
    const store = useEditorDomainStore.getState();
    if (mods.range) {
      const anchorId = store.selectionAnchorId ?? store.selectedId;
      const rows = anchorId === null ? [] : flattenVisibleRows(rowSourceRef.current);
      // Only a widget row can anchor a range. A page, dialog or section row is not
      // part of the result, so slicing from it would hand back every widget between
      // two areas the user never pointed at — the click degrades to a plain select.
      const anchorRow = rows.find((row) => row.id === anchorId);
      const span = anchorRow?.selectable ? rowsBetween(rows, anchorRow.id, id) : [];
      const ids = span.filter((row) => row.selectable).map((row) => row.id);
      // An anchor that has been collapsed or filtered away leaves nothing to slice.
      if (ids.length > 0) {
        store.setSelectedMany(ids, null, anchorRow?.id);
        return;
      }
    }
    if (mods.toggle && canExtendWith(store.selectedIds, id, projectFromStore())) {
      store.toggleSelected(id);
      return;
    }
    store.setSelected(id);
  }, []);

  const handleCtxMenu = useCallback((e: React.MouseEvent, nodeId: string, kind: NodeKind) => {
    e.preventDefault();
    // Right-clicking a widget outside the selection starts over, so a menu verb
    // never acts on rows the tree no longer shows as selected. Right-clicking one
    // that is already in it keeps the set, which is what makes "select five, then
    // right-click one and delete" work. Section and page rows keep their old
    // behaviour of not moving the selection at all.
    if (kind === 'container' || kind === 'leaf') {
      const store = useEditorDomainStore.getState();
      if (!store.selectedIds.includes(nodeId)) store.setSelected(nodeId);
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId, kind });
  }, []);

  const handleEditCommit = useCallback(
    (id: string) => {
      if (editingTitle.trim()) {
        if (dialogs.some((p) => p.id === id)) {
          useConfigStore.getState().renameDialog(id, editingTitle.trim());
        } else {
          const node = findPageNodeById(pages, id);
          if (node) {
            const title = editingTitle.trim();
            if (isPageGroup(node)) useConfigStore.getState().updatePageGroup(id, { title });
            else useConfigStore.getState().updatePage(id, { title });
          }
        }
      }
      setEditingPageId(null);
    },
    [editingTitle, dialogs, pages],
  );

  const handleAction = useCallback(
    (action: string) => {
      if (!ctxMenu) return;
      const { nodeId, kind } = ctxMenu;
      const store = useConfigStore.getState();
      const selectedWidgetTargets = (id: string) =>
        verbTargets(useEditorDomainStore.getState().selectedIds, id, projectFromStore());
      const ids = collectAllIds(store);
      const sep = action.indexOf(':');
      const verb = sep === -1 ? action : action.slice(0, sep);

      switch (verb) {
        case 'addPage':
          store.addPage(makeDefaultPage(ids));
          break;

        case 'addPageGroup':
          if (kind === 'page-group') {
            store.addPageGroupToPageGroup(nodeId, makeDefaultPageGroup(ids));
          } else {
            store.addPageGroup(makeDefaultPageGroup(ids));
          }
          break;

        case 'addPageToPageGroup':
          if (kind === 'page-group') store.addPageToPageGroup(nodeId, makeDefaultPage(ids));
          break;

        case 'addContainer':
          insertComponentInto(store, kind, nodeId, makeDefaultContainer(ids));
          break;

        case 'openWidgetSelector':
          setSelectorTarget({ nodeId, kind, name: insertTargetName(store, nodeId, kind) });
          break;

        case 'rename': {
          const dialog = dialogs.find((p) => p.id === nodeId);
          if (dialog) {
            setEditingPageId(nodeId);
            setEditingTitle(dialog.title);
            break;
          }
          const pg = findPageNodeById(pages, nodeId);
          if (pg) {
            setEditingPageId(nodeId);
            setEditingTitle(resolvePageTitle(pg.title));
          }
          break;
        }

        case 'deletePage':
          store.deletePage(nodeId);
          useEditorDomainStore.getState().closeTab(nodeId);
          if (useEditorDomainStore.getState().selectedId === nodeId)
            useEditorDomainStore.getState().setSelected(null);
          break;

        case 'deletePageGroup': {
          const groupNode = findPageNodeById(pages, nodeId);
          const idsToClose = [nodeId];
          if (groupNode && isPageGroup(groupNode))
            idsToClose.push(...groupNode.children.map((c) => c.id));
          useEditorDomainStore.getState().closeTabs(idsToClose);
          store.deletePageGroup(nodeId);
          const currentSelected = useEditorDomainStore.getState().selectedId;
          if (currentSelected && idsToClose.includes(currentSelected))
            useEditorDomainStore.getState().setSelected(null);
          break;
        }

        case 'deleteDialog':
          store.deleteDialog(nodeId);
          useEditorDomainStore.getState().closeTab(nodeId);
          if (useEditorDomainStore.getState().selectedId === nodeId)
            useEditorDomainStore.getState().setSelected(null);
          break;

        case 'delete':
          // Right-click has already re-pointed the selection unless the node was
          // part of it, so acting on the selection is acting on what the tree shows.
          deleteWidgetsKeepingSelection(selectedWidgetTargets(nodeId));
          break;

        case 'duplicate': {
          const newIds = store.duplicateComponents(selectedWidgetTargets(nodeId));
          if (newIds.length > 1) useEditorDomainStore.getState().setSelectedMany(newIds);
          break;
        }

        case 'copy':
        case 'cut': {
          const project = projectFromStore();
          const src = resolveCopyEntry(project, nodeId, kind);
          if (!src) {
            pasteToast('error', `Nothing to ${verb}`);
            break;
          }
          void copyTreeNode(src, verb === 'cut' ? 'cut' : 'copy');
          if (verb === 'cut') setCut(clipboardNodeIds(src), clipboardKind(src));
          else clearCut();
          break;
        }

        case 'paste': {
          void readTreeNodeFromClipboard().then((entry) => {
            if (!entry) return;
            dispatchPaste(projectFromStore(), entry, nodeId, kind);
          });
          break;
        }
      }
    },
    [ctxMenu, pages, dialogs],
  );

  // ── Dragging ───────────────────────────────────────────────────────────────
  // The whole tree is one drag context, so a drop is resolved from the hovered
  // row plus the band of that row rather than from "which list am I in".

  const [indicator, setIndicator] = useState<DropIndicator | null>(null);
  const autoExpandRef = useRef<{ overId: string; timer: number } | null>(null);

  const cancelAutoExpand = useCallback(() => {
    if (autoExpandRef.current) window.clearTimeout(autoExpandRef.current.timer);
    autoExpandRef.current = null;
  }, []);

  /** Hovering a collapsed parent long enough opens it, so a drag can reach
   *  anything without opening the tree first. */
  const scheduleAutoExpand = useCallback(
    (overId: string, into: boolean) => {
      if (autoExpandRef.current?.overId === overId) return;
      cancelAutoExpand();
      if (!into || !collapsed.has(overId)) return;
      autoExpandRef.current = {
        overId,
        timer: window.setTimeout(() => {
          autoExpandRef.current = null;
          toggleCollapsed(overId);
        }, 600),
      };
    },
    [cancelAutoExpand, collapsed, toggleCollapsed],
  );

  // Dragging a row that is part of the selection drags the whole set; page drags
  // stay single-node. Resolved before the plan so the drop is validated against
  // every widget it would move, not just the one under the pointer. Cached for
  // the length of the drag: `verbTargets` and `collectMovedWidgets` each walk the
  // whole project, dnd-kit fires `onDragOver` on every pointer move, and neither
  // the selection nor the dragged row can change while the pointer is down.
  const dragTargetsRef = useRef<{
    activeId: string;
    nodeIds: string[];
    moved: MovedWidgets;
  } | null>(null);

  const dragTargets = useCallback(
    (activeId: string, project: ReturnType<typeof projectFromStore>) => {
      const cached = dragTargetsRef.current;
      if (cached?.activeId === activeId) return cached;
      const nodeIds = verbTargets(useEditorDomainStore.getState().selectedIds, activeId, project);
      const entry = { activeId, nodeIds, moved: collectMovedWidgets(project, nodeIds) };
      dragTargetsRef.current = entry;
      return entry;
    },
    [],
  );

  const endDrag = useCallback(() => {
    cancelAutoExpand();
    setIndicator(null);
    dragTargetsRef.current = null;
  }, [cancelAutoExpand]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      dragTargetsRef.current = null;
      dragTargets(String(event.active.id), projectFromStore());
    },
    [dragTargets],
  );

  const planFor = useCallback(
    (event: DragOverEvent | DragEndEvent) => {
      const { active, over, delta, activatorEvent } = event;
      if (!over) return null;
      const band = bandOf(over.rect, pointerYOf(activatorEvent, delta.y));
      const overId = String(over.id);
      const activeId = String(active.id);
      const project = projectFromStore();
      const { nodeIds, moved } = dragTargets(activeId, project);
      const plan = resolveDropTarget(project, activeId, overId, band, moved);
      return { overId, band, plan, nodeIds };
    },
    [dragTargets],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const resolved = planFor(event);
      if (!resolved?.plan) {
        cancelAutoExpand();
        setIndicator(null);
        return;
      }
      const feedback = dropFeedback(resolved.plan, resolved.band);
      setIndicator({ overId: resolved.overId, ...feedback });
      scheduleAutoExpand(resolved.overId, feedback.into);
    },
    [cancelAutoExpand, planFor, scheduleAutoExpand],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const resolved = planFor(event);
      endDrag();
      const plan = resolved?.plan;
      if (!resolved || !plan) return;
      const store = useConfigStore.getState();
      if (plan.kind === 'widget') {
        store.moveWidgetsTo(resolved.nodeIds, plan.target, plan.index);
      } else store.movePageTo(plan.nodeId, plan.groupId, plan.index);
    },
    [endDrag, planFor],
  );

  const selectedIds = useMemo(() => new Set(selectedIdList), [selectedIdList]);
  const treeSelection = useMemo(() => ({ selectedIds, selectRow }), [selectedIds, selectRow]);

  return (
    <TreeSearchQueryProvider query={wordSearchQuery}>
      <TreeSelectionContext.Provider value={treeSelection}>
        <div className="cfg-tree cfg-editor-tree">
          <TreeSearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            label="Search widget tree"
            // The widget selector drawer owns `/` while it's open.
            shortcutDisabled={selectorTarget !== null}
            onCollapseAll={() => {
              // A search force-expands the tree, so the collapse would be invisible.
              setSearchQuery('');
              collapseAll();
            }}
          />
          <DndContext
            sensors={sensors}
            collisionDetection={treeCollision}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={endDrag}
          >
            <DropIndicatorProvider indicator={indicator}>
              <div ref={scrollRef} className="cfg-tree__scroll">
                {settingsVisible && (
                  <TreeRow
                    variant="group"
                    selected={selectedId === EDITOR_NODE_IDS.SETTINGS}
                    icon={<span className="cfg-tree-item__icon">⚙</span>}
                    label={
                      <span className="cfg-tree-item__label">
                        <TreeSearchHighlight text="Settings" />
                      </span>
                    }
                    onSelect={() =>
                      useEditorDomainStore.getState().setSelected(EDITOR_NODE_IDS.SETTINGS)
                    }
                  />
                )}

                {eventsVisible && (
                  <TreeRow
                    variant="group"
                    selected={selectedId === EDITOR_NODE_IDS.EVENTS}
                    icon={<span className="cfg-tree-item__icon">↯</span>}
                    label={
                      <span className="cfg-tree-item__label">
                        <TreeSearchHighlight text="Global Events" />
                      </span>
                    }
                    onSelect={() =>
                      useEditorDomainStore.getState().setSelected(EDITOR_NODE_IDS.EVENTS)
                    }
                  >
                    {eventsSeverity && (
                      <TreeDiagnosticDot
                        severity={eventsSeverity}
                        title={containsSeverityTitle(eventsSeverity)}
                      />
                    )}
                  </TreeRow>
                )}

                {SHELL_REGION_IDS.map((region) => {
                  const { label, icon, addTitle, emptyMessage } = SHELL_SECTION_META[region];
                  const sectionId = shellSectionIdForRegion(region);
                  const filteredItems = filteredShell[region];
                  const isOpen = effectiveSectionsOpen.has(sectionId);
                  if (hiddenShellRegions.has(region)) return null;
                  return (
                    <Fragment key={region}>
                      <SectionRow
                        label={label}
                        icon={icon}
                        dropId={sectionId}
                        isOpen={isOpen}
                        onToggle={() => toggleSection(sectionId)}
                        addTitle={addTitle}
                        onAdd={(e) =>
                          setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: region, kind: 'area' })
                        }
                        selected={selectedId === sectionId}
                        onSelect={() =>
                          useEditorDomainStore.getState().setSelected(sectionId, region)
                        }
                        onCtxMenu={(e) =>
                          setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: region, kind: 'area' })
                        }
                        onDoubleClick={() => useEditorDomainStore.getState().openTab(sectionId)}
                        count={shell[region].length}
                        severity={diagnostics.byShellArea.get(sectionId)}
                      />
                      {isOpen &&
                        (isSearching && filteredItems.length === 0 ? (
                          <div className="cfg-tree-section-empty">{emptyMessage}</div>
                        ) : (
                          <AreaWidgetList
                            dropId={region}
                            components={filteredItems}
                            collapsed={effectiveCollapsed}
                            onToggle={toggleCollapsed}
                            onCtxMenu={handleCtxMenu}
                          />
                        ))}
                    </Fragment>
                  );
                })}

                {pagesVisible && (
                  <SectionRow
                    label="Pages"
                    icon="📄"
                    isOpen={effectiveSectionsOpen.has(EDITOR_NODE_IDS.PAGES)}
                    onToggle={() => toggleSection(EDITOR_NODE_IDS.PAGES)}
                    addTitle="Add page or page group"
                    onAdd={(e) =>
                      setCtxMenu({
                        x: e.clientX,
                        y: e.clientY,
                        nodeId: EDITOR_NODE_IDS.PAGES,
                        kind: 'pages-root',
                      })
                    }
                    selected={selectedId === EDITOR_NODE_IDS.PAGES}
                    onSelect={() =>
                      useEditorDomainStore.getState().setSelected(EDITOR_NODE_IDS.PAGES, 'pages')
                    }
                    onCtxMenu={(e) =>
                      setCtxMenu({
                        x: e.clientX,
                        y: e.clientY,
                        nodeId: EDITOR_NODE_IDS.PAGES,
                        kind: 'pages-root',
                      })
                    }
                    count={pages.length}
                    severity={diagnostics.byKind.get('page')}
                  />
                )}
                {pagesVisible &&
                  effectiveSectionsOpen.has(EDITOR_NODE_IDS.PAGES) &&
                  (isSearching ? (
                    filteredPages.length === 0 ? (
                      <div className="cfg-tree-section-empty">No pages match</div>
                    ) : (
                      filteredPages.map((node) =>
                        isPageGroup(node) ? (
                          <TreePageGroup
                            key={node.id}
                            group={node}
                            collapsed={effectiveCollapsed}
                            onToggle={toggleCollapsed}
                            onCtxMenu={handleCtxMenu}
                            editingPageId={editingPageId}
                            editingTitle={editingTitle}
                            onEditChange={setEditingTitle}
                            onEditCommit={handleEditCommit}
                          />
                        ) : (
                          <TreePage
                            key={node.id}
                            page={node as PageConfig}
                            collapsed={effectiveCollapsed}
                            onToggle={toggleCollapsed}
                            onCtxMenu={handleCtxMenu}
                            editingPageId={editingPageId}
                            editingTitle={editingTitle}
                            onEditChange={setEditingTitle}
                            onEditCommit={handleEditCommit}
                          />
                        ),
                      )
                    )
                  ) : (
                    <SortableContext
                      items={pages.map((p) => p.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {pages.length === 0 ? (
                        <div className="cfg-tree-section-empty">No pages — use + to add one</div>
                      ) : (
                        pages.map((node) =>
                          isPageGroup(node) ? (
                            <TreePageGroup
                              key={node.id}
                              group={node}
                              collapsed={collapsed}
                              onToggle={toggleCollapsed}
                              onCtxMenu={handleCtxMenu}
                              editingPageId={editingPageId}
                              editingTitle={editingTitle}
                              onEditChange={setEditingTitle}
                              onEditCommit={handleEditCommit}
                            />
                          ) : (
                            <TreePage
                              key={node.id}
                              page={node}
                              collapsed={collapsed}
                              onToggle={toggleCollapsed}
                              onCtxMenu={handleCtxMenu}
                              editingPageId={editingPageId}
                              editingTitle={editingTitle}
                              onEditChange={setEditingTitle}
                              onEditCommit={handleEditCommit}
                            />
                          ),
                        )
                      )}
                    </SortableContext>
                  ))}

                {dialogsVisible && (
                  <SectionRow
                    label="Dialogs"
                    icon="⊞"
                    isOpen={effectiveSectionsOpen.has(EDITOR_NODE_IDS.DIALOGS)}
                    onToggle={() => toggleSection(EDITOR_NODE_IDS.DIALOGS)}
                    addTitle="Add dialog"
                    selected={selectedId === EDITOR_NODE_IDS.DIALOGS}
                    onSelect={() =>
                      useEditorDomainStore
                        .getState()
                        .setSelected(EDITOR_NODE_IDS.DIALOGS, 'dialogs')
                    }
                    onAdd={() => {
                      const store = useConfigStore.getState();
                      store.addDialog(makeDefaultDialog(collectAllIds(store)));
                    }}
                    count={dialogs.length}
                    severity={diagnostics.byKind.get('dialog')}
                  />
                )}
                {dialogsVisible && effectiveSectionsOpen.has(EDITOR_NODE_IDS.DIALOGS) && (
                  <>
                    {filteredDialogs.length === 0 ? (
                      <div className="cfg-tree-section-empty">
                        {isSearching ? 'No dialogs match' : 'No dialogs — use + to add one'}
                      </div>
                    ) : (
                      filteredDialogs.map((dialog) => (
                        <TreeDialogPage
                          key={dialog.id}
                          popup={dialog}
                          collapsed={effectiveCollapsed}
                          onToggle={toggleCollapsed}
                          onCtxMenu={handleCtxMenu}
                          editingPageId={editingPageId}
                          editingTitle={editingTitle}
                          onEditChange={setEditingTitle}
                          onEditCommit={handleEditCommit}
                        />
                      ))
                    )}
                  </>
                )}
              </div>
            </DropIndicatorProvider>
          </DndContext>

          {ctxMenu && (
            <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} onAction={handleAction} />
          )}

          {selectorTarget && (
            <WidgetSelector
              contextName={selectorTarget.name}
              onClose={() => setSelectorTarget(null)}
              onInsert={(type) => {
                const store = useConfigStore.getState();
                const ids = collectAllIds(store);
                const comp =
                  type === 'Container' ? makeDefaultContainer(ids) : makeComponentOfType(type, ids);
                insertComponentInto(store, selectorTarget.kind, selectorTarget.nodeId, comp);
                setSelected(comp.id);
                setSelectorTarget(null);
              }}
            />
          )}
        </div>
      </TreeSelectionContext.Provider>
    </TreeSearchQueryProvider>
  );
}
