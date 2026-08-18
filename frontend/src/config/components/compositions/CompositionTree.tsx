/**
 * CompositionTree — left panel of /config/components.
 *
 * Lists all components as expandable tree branches showing their widget tree.
 * Components can be organised into folders nested to any depth, mirrored
 * as real subfolders under the components/ directory on disk.
 * Click the component row = select component (shows schema editor on right).
 * Click a widget = select it (shows widget properties on right).
 */

import { useState, useCallback, useMemo } from 'react';
import {
  DndContext,
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { useDndSensors } from '@shared/hooks/useDndSensors';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { WidgetConfig } from '@shared/types/config';
import type { SelectionModifiers } from '@shared/utils/domEvent';
import AreaWidgetList from '../editor/WidgetTree/AreaWidgetList';
import type { NodeKind } from '../editor/WidgetTree/types';
import TreeContextMenu from '../editor/WidgetTree/ContextMenu';
import { useIsCut } from '../editor/WidgetTree/cutState';
import { DropIndicatorProvider } from '../editor/WidgetTree/dropIndicator';
import type { DropIndicator } from '../editor/WidgetTree/dropIndicatorContext';
import { bandOf, pointerYOf } from '../editor/WidgetTree/dropTarget';
import { resolveCompositionDrop } from './compositionDrop';
import { widgetSelectionTargets } from './compositionTreeOps';
import { filterCompositions } from './compositionSearch';
import { TreeSelectionContext } from '../editor/WidgetTree/treeSelectionContext';
import {
  TreeSearchHighlight,
  TreeSearchQueryProvider,
} from '../editor/WidgetTree/TreeSearchHighlight';
import { collectContainerIds } from '../editor/WidgetTree/treeFilters';
import { withDotSearchSeparators } from '@shared/utils/search';
import { useComponentEditorStore } from '../../store/componentEditorStore';
import { TreeRowActionButton } from '../ui/TreeAffordances';
import TreeRow from '../ui/TreeRow';
import TreeSearchBar from '../ui/TreeSearchBar';
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '../ui/ContextMenu';
import WidgetIcon from '../ui/WidgetIcon';

interface CompositionTreeProps {
  widgets: ComponentDefinition[];
  folders: string[];
  selectedId: string | null;
  /** Every selected widget of the open definition — a row is highlighted when it
   *  is in here, not only when it is the lead. */
  selectedIds: readonly string[];
  onSelectWidget: (id: string) => void;
  /** Double-click a component row: pin it as a permanent preview tab. */
  onOpenWidget: (id: string) => void;
  onSelectComponent: (widgetId: string, compId: string) => void;
  /** A widget row click carrying its modifiers — plain replaces, ctrl/cmd toggles,
   *  shift extends from the anchor. */
  onSelectRow: (componentId: string, widgetId: string, mods: SelectionModifiers) => void;
  /** Context-menu verb from the widget tree inside a definition, or from the
   *  definition row itself (`kind: 'area'`, `nodeId` = the component's id). */
  onTreeAction: (action: string, nodeId: string, kind: NodeKind) => void;
  onDeleteWidget: (id: string) => void;
  /** Create a new component; `group` is the target folder (null = ungrouped root). */
  onCreateWidget: (group: string | null) => void;
  /** Create a new folder; `parent` is the containing folder path (null = top level). */
  onCreateFolder: (parent: string | null) => void;
  /** Delete a folder (and everything inside it); `path` is the full folder path. */
  onDeleteFolder: (path: string) => void;
  /** Copy the complete reusable component definition to the system clipboard. */
  onCopyWidget: (id: string) => void;
  /** Create a reusable component from the system clipboard in the target folder. */
  onPasteWidget: (group: string | null) => void;
  /** Applies a drag inside one definition: same id, new parent and position. */
  onMoveWidget: (
    componentId: string,
    nodeId: string,
    parentId: string | null,
    index: number,
  ) => void;
}

interface CtxMenu {
  x: number;
  y: number;
  /** 'widget' is a component definition row, 'add' its + button; 'container'
   *  and 'leaf' are widgets inside a definition and reuse the page tree's menu. */
  kind: 'widget' | 'container' | 'leaf' | 'add' | 'folder' | 'root';
  id: string;
}

// Sentinel id for the collapse state of the top-level "Components" group row.
const COMPONENTS_ROOT_ID = '__components_root__';
// Shared empty selection for the definitions that do not own it — a stable
// reference, so a branch that never holds the selection never re-memoizes.
const NO_SELECTION: readonly string[] = [];
// Prefix for the collapse state of a folder row.
const folderCollapseId = (folder: string) => `__folder__${folder}`;

export default function CompositionTree({
  widgets: allWidgets,
  folders: allFolders,
  selectedId,
  selectedIds,
  onSelectWidget,
  onOpenWidget,
  onSelectComponent,
  onSelectRow,
  onTreeAction,
  onDeleteWidget,
  onCreateWidget,
  onCreateFolder,
  onDeleteFolder,
  onCopyWidget,
  onPasteWidget,
  onMoveWidget,
}: CompositionTreeProps) {
  const collapsedIds = useComponentEditorStore((s) => s.collapsedIds);
  const toggleCollapsed = useComponentEditorStore((s) => s.toggleCollapsed);
  const setCollapsedIds = useComponentEditorStore((s) => s.setCollapsedIds);
  const activeComponentId = useComponentEditorStore((s) => s.activeComponentId);

  const sensors = useDndSensors();

  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const closeCtx = useCallback(() => setCtxMenu(null), []);

  const isSearching = searchQuery.trim().length > 0;
  const wordSearchQuery = withDotSearchSeparators(searchQuery);
  const { widgets, folders } = useMemo(
    () => filterCompositions(allWidgets, allFolders, searchQuery),
    [allWidgets, allFolders, searchQuery],
  );

  const collapseAll = useCallback(() => {
    // A search force-expands the tree, so the collapse would otherwise be invisible.
    setSearchQuery('');
    const ids = [COMPONENTS_ROOT_ID, ...allFolders.map(folderCollapseId)];
    for (const widget of allWidgets) {
      ids.push(widget.id, ...collectContainerIds(widget.children as WidgetConfig[]));
    }
    setCollapsedIds(ids);
  }, [allFolders, allWidgets, setCollapsedIds]);

  // Search filters the tree down to what matched, so every branch it kept opens.
  const effectiveCollapsed = useMemo(
    () => (isSearching ? new Set<string>() : collapsedIds),
    [isSearching, collapsedIds],
  );
  const rootCollapsed = effectiveCollapsed.has(COMPONENTS_ROOT_ID);

  // Group components by folder path (any depth); include declared (possibly
  // empty) folders too. `childFolderMap` maps a parent path ('' = top level)
  // to its immediate child folder paths, so the tree can recurse unbounded.
  const { ungrouped, folderNames, byFolder, childFolderMap } = useMemo(() => {
    const map = new Map<string, ComponentDefinition[]>();
    for (const f of folders) map.set(f, []);
    const flat: ComponentDefinition[] = [];
    for (const w of widgets) {
      if (w.group) {
        if (!map.has(w.group)) map.set(w.group, []);
        map.get(w.group)!.push(w);
      } else {
        flat.push(w);
      }
    }
    const names = [...map.keys()].sort();
    const children = new Map<string, string[]>();
    for (const f of names) {
      const idx = f.lastIndexOf('/');
      const parent = idx === -1 ? '' : f.slice(0, idx);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(f);
    }
    return {
      ungrouped: flat,
      folderNames: names,
      byFolder: map,
      childFolderMap: children,
    };
  }, [widgets, folders]);

  /** Definition-row actions target the root of that component's widget tree. */
  function runRootAction(componentId: string, action: string) {
    onTreeAction(action, componentId, 'area');
    closeCtx();
  }

  const renderWidgetBranch = (widget: ComponentDefinition, depth: number) => (
    <WidgetBranch
      key={widget.id}
      widget={widget}
      depth={depth}
      selectedId={selectedId}
      selectedIds={widget.id === activeComponentId ? selectedIds : NO_SELECTION}
      collapsedIds={effectiveCollapsed}
      toggleCollapsed={toggleCollapsed}
      sensors={sensors}
      onSelectWidget={onSelectWidget}
      onOpenWidget={onOpenWidget}
      onSelectComponent={onSelectComponent}
      onSelectRow={onSelectRow}
      onMoveWidget={onMoveWidget}
      onOpenWidgetCtx={(x, y, id) => setCtxMenu({ x, y, kind: 'widget', id })}
      onOpenAddCtx={(x, y, id) => setCtxMenu({ x, y, kind: 'add', id })}
      onOpenItemCtx={(x, y, id, kind) => setCtxMenu({ x, y, kind, id })}
    />
  );

  // Widgets inside a definition get the page editor's own tree menu.
  const treeMenu =
    ctxMenu && (ctxMenu.kind === 'container' || ctxMenu.kind === 'leaf')
      ? { x: ctxMenu.x, y: ctxMenu.y, nodeId: ctxMenu.id, kind: ctxMenu.kind }
      : null;

  return (
    <TreeSearchQueryProvider query={wordSearchQuery}>
      <div className="cfg-tree">
        <TreeSearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          label="Search component tree"
          shortcutDisabled={ctxMenu !== null}
          onCollapseAll={collapseAll}
        />
        <div className="cfg-tree__scroll">
          {/* Components root row */}
          <TreeRow
            variant="group"
            toggle={{ open: !rootCollapsed, onClick: () => toggleCollapsed(COMPONENTS_ROOT_ID) }}
            icon={<span className="cfg-tree-item__icon">⊞</span>}
            label={<span className="cfg-tree-item__label">Components</span>}
            onSelect={() => toggleCollapsed(COMPONENTS_ROOT_ID)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu({ x: e.clientX, y: e.clientY, kind: 'root', id: '' });
            }}
          >
            {widgets.length > 0 && <span className="cfg-tree-item__count">{widgets.length}</span>}
            <TreeRowActionButton
              title="New folder"
              onClick={(e) => {
                e.stopPropagation();
                onCreateFolder(null);
              }}
            >
              🗀
            </TreeRowActionButton>
            <TreeRowActionButton
              title="Create new component"
              onClick={(e) => {
                e.stopPropagation();
                onCreateWidget(null);
              }}
            >
              +
            </TreeRowActionButton>
          </TreeRow>

          {!rootCollapsed && widgets.length === 0 && folderNames.length === 0 && (
            <div className="cfg-tree-section-empty">
              {isSearching ? 'No components match' : 'No components yet — click + to create one'}
            </div>
          )}

          {!rootCollapsed &&
            (childFolderMap.get('') ?? []).map((folder) => (
              <FolderNode
                key={folder}
                path={folder}
                depth={1}
                childFolderMap={childFolderMap}
                byFolder={byFolder}
                collapsedIds={effectiveCollapsed}
                toggleCollapsed={toggleCollapsed}
                onCreateWidget={onCreateWidget}
                onOpenFolderCtx={(x, y, id) => setCtxMenu({ x, y, kind: 'folder', id })}
                renderWidgetBranch={renderWidgetBranch}
              />
            ))}

          {!rootCollapsed && ungrouped.map((widget) => renderWidgetBranch(widget, 1))}
        </div>

        {treeMenu && (
          <TreeContextMenu
            menu={treeMenu}
            onClose={closeCtx}
            onAction={(action) => onTreeAction(action, treeMenu.nodeId, treeMenu.kind)}
          />
        )}

        {ctxMenu && !treeMenu && (
          <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={closeCtx}>
            {ctxMenu.kind === 'widget' && (
              <>
                <ContextMenuItem onClick={() => runRootAction(ctxMenu.id, 'addContainer')}>
                  Add Container
                </ContextMenuItem>
                <ContextMenuItem onClick={() => runRootAction(ctxMenu.id, 'openWidgetSelector')}>
                  Add Widget/Component…
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={() => {
                    onCopyWidget(ctxMenu.id);
                    closeCtx();
                  }}
                >
                  Copy component
                </ContextMenuItem>
                <ContextMenuItem onClick={() => runRootAction(ctxMenu.id, 'paste')}>
                  Paste
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  danger
                  onClick={() => {
                    onDeleteWidget(ctxMenu.id);
                    closeCtx();
                  }}
                >
                  Delete component
                </ContextMenuItem>
              </>
            )}
            {ctxMenu.kind === 'add' && (
              <>
                <ContextMenuItem onClick={() => runRootAction(ctxMenu.id, 'addContainer')}>
                  Add Container
                </ContextMenuItem>
                <ContextMenuItem onClick={() => runRootAction(ctxMenu.id, 'openWidgetSelector')}>
                  Add Widget/Component…
                </ContextMenuItem>
              </>
            )}
            {ctxMenu.kind === 'root' && (
              <>
                <ContextMenuItem
                  onClick={() => {
                    onCreateFolder(null);
                    closeCtx();
                  }}
                >
                  Add folder
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => {
                    onPasteWidget(null);
                    closeCtx();
                  }}
                >
                  Paste component
                </ContextMenuItem>
              </>
            )}
            {ctxMenu.kind === 'folder' && (
              <>
                <ContextMenuItem
                  onClick={() => {
                    onCreateFolder(ctxMenu.id);
                    closeCtx();
                  }}
                >
                  Add folder
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => {
                    onCreateWidget(ctxMenu.id);
                    closeCtx();
                  }}
                >
                  Create component
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => {
                    onPasteWidget(ctxMenu.id);
                    closeCtx();
                  }}
                >
                  Paste component
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  danger
                  onClick={() => {
                    onDeleteFolder(ctxMenu.id);
                    closeCtx();
                  }}
                >
                  Delete folder
                </ContextMenuItem>
              </>
            )}
          </ContextMenu>
        )}
      </div>
    </TreeSearchQueryProvider>
  );
}

/** Pointer-first, so the band under the cursor decides the drop. */
const compositionCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCenter(args);
};

// ── Folder row (recurses into child folders to any depth) ────────────────────

interface FolderNodeProps {
  /** Full folder path, e.g. "A/B". */
  path: string;
  depth: number;
  childFolderMap: Map<string, string[]>;
  byFolder: Map<string, ComponentDefinition[]>;
  collapsedIds: Set<string>;
  toggleCollapsed: (id: string) => void;
  onCreateWidget: (group: string | null) => void;
  onOpenFolderCtx: (x: number, y: number, path: string) => void;
  renderWidgetBranch: (widget: ComponentDefinition, depth: number) => React.ReactNode;
}

function FolderNode({
  path,
  depth,
  childFolderMap,
  byFolder,
  collapsedIds,
  toggleCollapsed,
  onCreateWidget,
  onOpenFolderCtx,
  renderWidgetBranch,
}: FolderNodeProps) {
  const collapsed = collapsedIds.has(folderCollapseId(path));
  const childFolders = childFolderMap.get(path) ?? [];
  const contents = byFolder.get(path) ?? [];
  const name = path.slice(path.lastIndexOf('/') + 1);

  return (
    <div>
      <TreeRow
        variant="group"
        depth={depth}
        toggle={{ open: !collapsed, onClick: () => toggleCollapsed(folderCollapseId(path)) }}
        icon={<span className="cfg-tree-item__icon">🗀</span>}
        label={
          <span className="cfg-tree-item__label">
            <TreeSearchHighlight text={name} />
          </span>
        }
        onSelect={() => toggleCollapsed(folderCollapseId(path))}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenFolderCtx(e.clientX, e.clientY, path);
        }}
      >
        {contents.length > 0 && <span className="cfg-tree-item__count">{contents.length}</span>}
        <TreeRowActionButton
          title="Create component in folder"
          onClick={(e) => {
            e.stopPropagation();
            onCreateWidget(path);
          }}
        >
          +
        </TreeRowActionButton>
      </TreeRow>
      {!collapsed && childFolders.length === 0 && contents.length === 0 && (
        <div
          className="cfg-tree-section-empty"
          style={{ '--tree-depth': depth + 1 } as React.CSSProperties}
        >
          Empty folder
        </div>
      )}
      {!collapsed &&
        childFolders.map((child) => (
          <FolderNode
            key={child}
            path={child}
            depth={depth + 1}
            childFolderMap={childFolderMap}
            byFolder={byFolder}
            collapsedIds={collapsedIds}
            toggleCollapsed={toggleCollapsed}
            onCreateWidget={onCreateWidget}
            onOpenFolderCtx={onOpenFolderCtx}
            renderWidgetBranch={renderWidgetBranch}
          />
        ))}
      {!collapsed && contents.map((widget) => renderWidgetBranch(widget, depth + 1))}
    </div>
  );
}

// ── Per-widget branch (root row + selection-scoped component subtree) ────────

interface BranchProps {
  widget: ComponentDefinition;
  depth: number;
  selectedId: string | null;
  selectedIds: readonly string[];
  collapsedIds: Set<string>;
  toggleCollapsed: (id: string) => void;
  sensors: ReturnType<typeof useDndSensors>;
  onSelectWidget: (id: string) => void;
  onOpenWidget: (id: string) => void;
  onSelectComponent: (widgetId: string, compId: string) => void;
  onSelectRow: (componentId: string, widgetId: string, mods: SelectionModifiers) => void;
  /** Applies a drag: the widget keeps its id and lands at `index` in `parentId`
   *  (null = the definition root). */
  onMoveWidget: (
    componentId: string,
    nodeId: string,
    parentId: string | null,
    index: number,
  ) => void;
  onOpenWidgetCtx: (x: number, y: number, id: string) => void;
  onOpenAddCtx: (x: number, y: number, id: string) => void;
  onOpenItemCtx: (x: number, y: number, id: string, kind: 'container' | 'leaf') => void;
}

function WidgetBranch({
  widget,
  depth,
  selectedId,
  selectedIds,
  collapsedIds,
  toggleCollapsed,
  sensors,
  onSelectWidget,
  onOpenWidget,
  onSelectComponent,
  onSelectRow,
  onMoveWidget,
  onOpenWidgetCtx,
  onOpenAddCtx,
  onOpenItemCtx,
}: BranchProps) {
  const isCollapsed = collapsedIds.has(widget.id);
  const isCut = useIsCut(widget.id);
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);

  const planFor = useCallback(
    (event: DragOverEvent | DragEndEvent) => {
      const { active, over, delta, activatorEvent } = event;
      if (!over) return null;
      const band = bandOf(over.rect, pointerYOf(activatorEvent, delta.y));
      const activeId = String(active.id);
      // Dragging a row that is part of the selection drags the whole set, so the
      // indicator has to be resolved against every widget the drop will move.
      const drop = resolveCompositionDrop(
        widget,
        activeId,
        String(over.id),
        band,
        widgetSelectionTargets(widget, selectedIds, activeId),
      );
      return { overId: String(over.id), band, drop };
    },
    [selectedIds, widget],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const resolved = planFor(event);
      if (!resolved?.drop) {
        setIndicator(null);
        return;
      }
      const into = resolved.band === 'middle' && resolved.drop.parentId === resolved.overId;
      setIndicator({
        overId: resolved.overId,
        into,
        edge: into ? undefined : resolved.band === 'top' ? 'top' : 'bottom',
      });
    },
    [planFor],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const resolved = planFor(event);
      setIndicator(null);
      if (!resolved?.drop) return;
      const { nodeId, parentId, index } = resolved.drop;
      onMoveWidget(widget.id, nodeId, parentId, index);
    },
    [onMoveWidget, planFor, widget.id],
  );

  const treeSelection = useMemo(
    () => ({
      selectedIds: new Set(selectedIds),
      selectRow: (id: string, mods: SelectionModifiers) => onSelectRow(widget.id, id, mods),
    }),
    [selectedIds, onSelectRow, widget.id],
  );

  const handleItemCtx = useCallback(
    (e: React.MouseEvent, id: string, kind: NodeKind) => {
      e.preventDefault();
      e.stopPropagation();
      // Right-clicking a row outside the selection starts over — the same thing a
      // left-click would do — so a menu verb never acts on rows the tree no longer
      // shows as selected. One that is already in it keeps the whole set, which is
      // what makes "select three, then right-click one and delete" work.
      if (!selectedIds.includes(id)) onSelectComponent(widget.id, id);
      // A definition cannot hold component instances, so the slot kinds TreeNode
      // can emit never reach here; everything non-container is a leaf.
      onOpenItemCtx(e.clientX, e.clientY, id, kind === 'container' ? 'container' : 'leaf');
    },
    [onOpenItemCtx, onSelectComponent, selectedIds, widget.id],
  );

  return (
    <div>
      <TreeRow
        variant="group"
        depth={depth}
        selected={selectedId === widget.id}
        cut={isCut}
        toggle={{ open: !isCollapsed, onClick: () => toggleCollapsed(widget.id) }}
        icon={
          <span className="cfg-tree-item__icon cfg-tree-item__icon--svg">
            <WidgetIcon icon={widget.icon} />
          </span>
        }
        label={
          <span className="cfg-tree-item__label">
            <TreeSearchHighlight text={widget.name} />
          </span>
        }
        onSelect={() => onSelectWidget(widget.id)}
        onDoubleClick={() => onOpenWidget(widget.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSelectWidget(widget.id);
          onOpenWidgetCtx(e.clientX, e.clientY, widget.id);
        }}
      >
        <TreeRowActionButton
          title="Add component"
          onClick={(e) => {
            e.stopPropagation();
            onSelectWidget(widget.id);
            onOpenAddCtx(e.clientX, e.clientY, widget.id);
          }}
        >
          +
        </TreeRowActionButton>
      </TreeRow>

      {!isCollapsed && (
        <TreeSelectionContext.Provider value={treeSelection}>
          {/* One drag context per definition — a widget belongs to the component
              it was authored in, so drags never cross definitions. */}
          <DndContext
            sensors={sensors}
            collisionDetection={compositionCollision}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setIndicator(null)}
          >
            <DropIndicatorProvider indicator={indicator}>
              <AreaWidgetList
                dropId={widget.id}
                components={widget.children as WidgetConfig[]}
                collapsed={collapsedIds}
                onToggle={toggleCollapsed}
                onCtxMenu={handleItemCtx}
                depth={depth + 1}
              />
            </DropIndicatorProvider>
          </DndContext>
        </TreeSelectionContext.Provider>
      )}
    </div>
  );
}
