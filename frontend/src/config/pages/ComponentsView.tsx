/**
 * ComponentsView — /config/components
 *
 * Three-panel layout (same as EditorView):
 *   Left:   Component list — all components as expandable tree branches showing their widget tree.
 *           Clicking the component root selects it (shows component schema editor on the right).
 *           Clicking a widget inside selects it (shows widget properties on the right).
 *   Center: Live preview of the active component's widget tree.
 *   Right:  — Component selected: Component property schema editor (add/remove/edit inputs)
 *           — Widget selected: Widget properties panel with $componentProp source type
 */

import '@hmi/styles/hmi.css';
import '../components/compositions/composition.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useComponentStore, type DraftChange } from '@shared/store/componentStore';
import { useComponentEditorStore } from '../store/componentEditorStore';
import { useProjectStore } from '@shared/store/projectStore';
import { useTranslations } from '@shared/hooks/useTranslations';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { WidgetConfig, LayoutConfig } from '@shared/types/config';
import { collectWidgetIds, deepCloneComponent } from '@shared/store/configStoreHelpers';
import { detectCopyPasteKey, type SelectionModifiers } from '@shared/utils/domEvent';
import { isContainerHostType } from '@hmi/registry/widgetRegistry';
import {
  makeComponentOfType,
  makeDefaultContainer,
  mapAllComponents,
} from '../components/editor/WidgetTree/treeUtils';
import type { NodeKind } from '../components/editor/WidgetTree/types';
import { copyTreeNode, pasteToast } from '../components/editor/WidgetTree/clipboardOps';
import { clearCut, matchesPendingCut, setCut } from '../components/editor/WidgetTree/cutState';
import {
  componentChildren,
  duplicateWidgets,
  flattenVisibleWidgets,
  insertWidgetsAt,
  moveWidgetsToIndex,
  moveWidgetsWithin,
  moveWidgetToIndex,
  readCompositionClipboard,
  removeWidgets,
  takenWidgetIds,
  topLevelWidgetIds,
  widgetSelectionTargets,
} from '../components/compositions/compositionTreeOps';
import { widgetLabel } from '../components/compositions/compositionInsertTarget';
import WidgetSelector from '../components/ui/WidgetSelector';
import { findComponentById } from '@shared/utils/widgetTree';
import { usePanelDiagnostics, type DiagnosticsArtifact } from '@config/hooks/usePanelDiagnostics';
import ConfigLayout from '../components/ui/ConfigLayout';
import CompositionWidgetPanel from '../components/compositions/CompositionWidgetPanel';
import CompositionMultiWidgetPanel from '../components/compositions/CompositionMultiWidgetPanel';
import CompositionSchemaEditor from '../components/compositions/CompositionSchemaEditor';
import PanelDiagnosticsBanner from '../components/editor/PropertiesPanel/PanelDiagnosticsBanner';
import CompositionPreview from '../components/compositions/CompositionPreview';
import CompositionTree from '../components/compositions/CompositionTree';
import NameInputModal from '../components/ui/NameInputModal';
import PreviewEmptyState from '../components/editor/PreviewEmptyState';

// ── Widget-tree mutation helper (module scope — no closure deps) ────────

function mapChildren(
  component: ComponentDefinition,
  fn: (children: WidgetConfig[]) => WidgetConfig[],
): ComponentDefinition {
  return { ...component, children: fn(component.children as WidgetConfig[]) };
}

/** A definition cannot hold instances of another reusable component. */
const NO_COMPONENT_INSTANCES = (type: string) => !type.startsWith('$component:');

/** Where an add or a paste lands, from the node kind the menu reported. */
function insertKindFor(kind: NodeKind): 'container' | 'leaf' | 'root' {
  if (kind === 'container') return 'container';
  if (kind === 'leaf') return 'leaf';
  return 'root';
}

export default function ComponentsView() {
  useTranslations();

  const components = useComponentStore((s) => s.components);
  const folders = useComponentStore((s) => s.folders);
  const loaded = useComponentStore((s) => s.loaded);
  const load = useComponentStore((s) => s.load);
  const createComponent = useComponentStore((s) => s.createComponent);
  const createComponentFromDefinition = useComponentStore((s) => s.createComponentFromDefinition);
  const createFolder = useComponentStore((s) => s.createFolder);
  const deleteFolder = useComponentStore((s) => s.deleteFolder);
  const deleteComponent = useComponentStore((s) => s.deleteComponent);
  const draftComponents = useComponentStore((s) => s.draftComponents);
  const draftStructureRev = useComponentStore((s) => s.draftStructureRev);
  const setComponentDraft = useComponentStore((s) => s.setComponentDraft);
  const clearComponentDraft = useComponentStore((s) => s.clearComponentDraft);

  const markDirty = useProjectStore((s) => s.markDirty);

  const activeComponentId = useComponentEditorStore((s) => s.activeComponentId);
  const selectedId = useComponentEditorStore((s) => s.selectedId);
  const selectedIds = useComponentEditorStore((s) => s.selectedIds);
  const setSelectedId = useComponentEditorStore((s) => s.setSelectedId);
  const setSelectedIds = useComponentEditorStore((s) => s.setSelectedIds);
  const selectComponent = useComponentEditorStore((s) => s.selectComponent);
  const previewComponent = useComponentEditorStore((s) => s.previewComponent);
  const openComponentTab = useComponentEditorStore((s) => s.openTab);

  // When set, a component-create modal is open; `group` is the target folder.
  const [creatingIn, setCreatingIn] = useState<{ group: string | null } | null>(null);
  // When set, a folder-create modal is open; `parent` is the containing folder path.
  const [creatingFolder, setCreatingFolder] = useState<{ parent: string | null } | null>(null);
  // When set, the widget selector drawer is open for this insertion target.
  const [selectorTarget, setSelectorTarget] = useState<{
    nodeId: string;
    kind: NodeKind;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  // Drop tabs for components deleted elsewhere (component delete, folder delete).
  useEffect(() => {
    useComponentEditorStore.getState().pruneTabs(new Set(components.map((c) => c.id)));
  }, [components]);

  // Effective widget list: draft overrides the saved version for the config editor.
  const effectiveComponents = components.map((c) => draftComponents[c.id] ?? c);

  const activeComponent =
    (activeComponentId
      ? (draftComponents[activeComponentId] ?? components.find((c) => c.id === activeComponentId))
      : null) ?? null;

  const componentDiagnosticsArtifact = useMemo<DiagnosticsArtifact | null>(
    () =>
      activeComponent
        ? { kind: 'component', id: activeComponent.id, draft: activeComponent }
        : null,
    [activeComponent],
  );
  usePanelDiagnostics(componentDiagnosticsArtifact);

  const handleCopyComponent = useCallback(
    async (id: string) => {
      const component = effectiveComponents.find((item) => item.id === id);
      if (!component) return;
      try {
        await navigator.clipboard.writeText(JSON.stringify(component, null, 2));
        pasteToast('info', `Copied ${component.name}`);
      } catch {
        pasteToast('error', 'Clipboard write blocked');
      }
    },
    [effectiveComponents],
  );

  /** Create a new component from a definition on the clipboard. */
  const pasteDefinition = useCallback(
    async (parsed: ComponentDefinition, group: string | null) => {
      const taken = new Set<string>();
      for (const component of effectiveComponents) {
        collectWidgetIds(component.children as WidgetConfig[], taken);
      }
      const baseName = `${parsed.name.trim()} copy`;
      const names = new Set(effectiveComponents.map((component) => component.name));
      let name = baseName;
      let suffix = 2;
      while (names.has(name)) name = `${baseName} ${suffix++}`;

      const duplicate: ComponentDefinition = {
        ...parsed,
        id: '',
        name,
        group,
        componentProperties: structuredClone(parsed.componentProperties),
        children: (parsed.children as WidgetConfig[]).map((child) =>
          deepCloneComponent(child, taken),
        ),
      };
      try {
        const created = await createComponentFromDefinition(duplicate);
        openComponentTab(created.id);
        pasteToast('info', `Pasted ${created.name}`);
      } catch (error) {
        console.error('[ComponentsView] component paste failed:', error);
        pasteToast('error', 'Could not paste component');
      }
    },
    [createComponentFromDefinition, effectiveComponents, openComponentTab],
  );

  /** Folder and root rows have nowhere to put a bare widget. */
  const handlePasteComponent = useCallback(
    async (group: string | null) => {
      const entry = await readCompositionClipboard();
      if (!entry) return;
      if (entry.kind !== 'definition') {
        pasteToast('error', 'Clipboard holds a widget, not a component');
        return;
      }
      await pasteDefinition(entry.node, group);
    },
    [pasteDefinition],
  );

  /** Every write to the open definition goes through here. `change` defaults to
   *  the structural answer, so only a caller that knows it moved nothing opts out
   *  of the tree-order walk keyed on it. */
  const saveComponent = useCallback(
    (component: ComponentDefinition, change: DraftChange = 'structure') => {
      setComponentDraft(component, change);
      markDirty();
    },
    [markDirty, setComponentDraft],
  );

  /** Copy, or cut — a cut also records the sources so the next paste moves the
   *  widgets with their ids instead of cloning them. */
  const copyWidgets = useCallback(
    (ids: string[], mode: 'copy' | 'cut' = 'copy') => {
      if (!activeComponent) return;
      const widgets = ids
        .map((id) => findComponentById(componentChildren(activeComponent), id))
        .filter((w): w is WidgetConfig => w !== null);
      if (widgets.length === 0) {
        pasteToast('error', `Nothing to ${mode}`);
        return;
      }
      const nodes = widgets.map((node) => ({ kind: 'widget' as const, node }));
      void copyTreeNode(nodes.length === 1 ? nodes[0] : { kind: 'multi', nodes }, mode);
      if (mode === 'cut')
        setCut(
          widgets.map((w) => w.id),
          'widget',
        );
      else clearCut();
    },
    [activeComponent],
  );

  /** One Paste for both clipboard shapes: a widget lands in the tree, a whole
   *  definition becomes a new component. */
  const pasteAt = useCallback(
    async (nodeId: string, kind: NodeKind) => {
      const entry = await readCompositionClipboard();
      if (!entry) return;
      if (entry.kind === 'definition') {
        const owner = effectiveComponents.find((c) => c.id === nodeId) ?? activeComponent;
        await pasteDefinition(entry.node, owner?.group ?? null);
        return;
      }
      if (!activeComponent) return;

      const payload = entry.kind === 'widgets' ? entry.nodes : [entry.node];
      const insertKind = insertKindFor(kind);

      // A cut of widgets still in this definition moves them, ids intact; the
      // target must not sit inside any of them.
      const isCutMove = matchesPendingCut(
        payload.map((node) => ({ kind: 'widget' as const, node })),
      );
      const sources = isCutMove
        ? payload
            .map((node) => findComponentById(componentChildren(activeComponent), node.id))
            .filter((w): w is WidgetConfig => w !== null)
        : [];
      if (sources.length === payload.length && sources.length > 0) {
        const ids = sources.map((w) => w.id);
        const moved = moveWidgetsWithin(activeComponent, ids, nodeId, insertKind);
        if (!moved) {
          pasteToast('error', 'Cannot move it in there');
          return;
        }
        saveComponent(moved);
        if (ids.length === 1) setSelectedId(ids[0]);
        else setSelectedIds(ids);
        clearCut();
        pasteToast(
          'info',
          ids.length === 1 ? `Moved ${sources[0].name}` : `Moved ${ids.length} components`,
        );
        return;
      }

      // One shared id pool, so two clones of a batch can never collide.
      const taken = takenWidgetIds(activeComponent);
      const clones = payload.map((node) => deepCloneComponent(node, taken));
      const updated = insertWidgetsAt(activeComponent, nodeId, insertKind, clones);
      if (!updated) {
        pasteToast('error', 'Nothing to paste into');
        return;
      }
      saveComponent(updated);
      const cloneIds = clones.map((c) => c.id);
      if (cloneIds.length === 1) setSelectedId(cloneIds[0]);
      else setSelectedIds(cloneIds);
      pasteToast(
        'info',
        clones.length === 1 ? `Pasted ${clones[0].name}` : `Pasted ${clones.length} components`,
      );
    },
    [
      activeComponent,
      effectiveComponents,
      pasteDefinition,
      saveComponent,
      setSelectedId,
      setSelectedIds,
    ],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const key = detectCopyPasteKey(event);
      if (!key || !activeComponent) return;
      event.preventDefault();
      const widget =
        selectedId && selectedId !== activeComponent.id
          ? findComponentById(componentChildren(activeComponent), selectedId)
          : null;
      if (!widget) {
        // Nothing inside the definition is selected: the shortcuts act on the
        // whole component, which has no cut.
        if (key === 'x') return;
        if (key === 'c') void handleCopyComponent(activeComponent.id);
        else void handlePasteComponent(activeComponent.group ?? null);
        return;
      }
      if (key === 'c' || key === 'x') {
        const ids =
          selectedIds.length > 1 ? topLevelWidgetIds(activeComponent, selectedIds) : [widget.id];
        copyWidgets(ids, key === 'x' ? 'cut' : 'copy');
      } else void pasteAt(widget.id, isContainerHostType(widget.type) ? 'container' : 'leaf');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    activeComponent,
    copyWidgets,
    handleCopyComponent,
    handlePasteComponent,
    pasteAt,
    selectedId,
    selectedIds,
  ]);

  /** Run an async action for create/delete operations that still hit the API immediately. */
  async function withSaveError(fn: () => Promise<void>, onError?: () => void) {
    try {
      await fn();
    } catch (e) {
      console.error('[ComponentsView] operation failed:', e);
      onError?.();
    }
  }

  function patchActiveComponent(patch: Partial<ComponentDefinition>) {
    if (!activeComponent) return;
    const updated = { ...activeComponent, ...patch };
    saveComponent(updated);
  }

  /** One pass over the draft for any number of widgets — the properties panel's
   *  multi write. Definition edits are outside undo either way (see saveComponent),
   *  so no batching is needed beyond keeping this to a single save. */
  function handleUpdateWidgets(
    ids: string[],
    patch: { name?: string; properties?: Record<string, unknown>; layout?: Partial<LayoutConfig> },
  ) {
    if (!activeComponent || ids.length === 0) return;
    const idSet = new Set(ids);
    const updated = mapChildren(activeComponent, (children) =>
      mapAllComponents(children, (c) => {
        if (!idSet.has(c.id)) return c;
        return {
          ...c,
          name: patch.name !== undefined ? patch.name : c.name,
          properties: patch.properties
            ? { ...(c.properties ?? {}), ...patch.properties }
            : c.properties,
          layout: patch.layout ? { ...(c.layout ?? {}), ...patch.layout } : c.layout,
        };
      }),
    );
    // Names, properties and layout only — every widget object is replaced, but
    // none of them moves, so the tree order the panel resolved still holds.
    saveComponent(updated, 'properties');
  }

  function handleUpdateWidget(
    id: string,
    patch: { name?: string; properties?: Record<string, unknown>; layout?: Partial<LayoutConfig> },
  ) {
    handleUpdateWidgets([id], patch);
  }

  function insertNewWidget(nodeId: string, kind: NodeKind, type: string) {
    if (!activeComponent) return;
    // A definition cannot hold instances of another component.
    if (type.startsWith('$component:')) return;
    const taken = takenWidgetIds(activeComponent);
    const widget =
      type === 'Container' ? makeDefaultContainer(taken) : makeComponentOfType(type, taken);
    const updated = insertWidgetsAt(activeComponent, nodeId, insertKindFor(kind), [widget]);
    if (!updated) return;
    saveComponent(updated);
    setSelectedId(widget.id);
  }

  /** A widget row click from the tree or the canvas: plain replaces, ctrl/cmd
   *  toggles, shift extends from the anchor over the rows the tree currently shows. */
  function handleSelectRow(componentId: string, widgetId: string, mods: SelectionModifiers) {
    const store = useComponentEditorStore.getState();
    const definition = effectiveComponents.find((c) => c.id === componentId);
    // A range only means anything inside the definition the panels are showing —
    // in another one it degrades to a plain select, exactly as a toggle does.
    if (mods.range && definition && componentId === store.activeComponentId) {
      const anchorId = store.selectionAnchorId ?? store.selectedId;
      const rows = flattenVisibleWidgets(definition, store.collapsedIds);
      // Only a selectable row can anchor a range. A row that is not part of the
      // result — a slot header of a nested component — would hand back every widget
      // between two places the user never pointed at, so the click degrades to a
      // plain select.
      const anchorRow = anchorId ? rows.find((row) => row.id === anchorId) : undefined;
      const from = anchorRow?.selectable ? rows.indexOf(anchorRow) : -1;
      const to = rows.findIndex((row) => row.id === widgetId);
      if (from !== -1 && to !== -1) {
        const span = (from <= to ? rows.slice(from, to + 1) : rows.slice(to, from + 1))
          .filter((row) => row.selectable)
          .map((row) => row.id);
        if (span.length > 0) {
          store.setSelectedIds(span, anchorId ?? undefined);
          return;
        }
      }
    }
    if (mods.toggle && componentId === store.activeComponentId) {
      store.toggleSelectedId(widgetId);
      return;
    }
    selectComponent(componentId, widgetId);
  }

  /** The page editor's verb rule against this definition's tree: descendants of
   *  another selected widget are dropped — deleting a container already takes its
   *  children. */
  function verbWidgetTargets(nodeId: string): string[] {
    if (!activeComponent) return [nodeId];
    return widgetSelectionTargets(activeComponent, selectedIds, nodeId);
  }

  /** Context-menu verbs from the tree and the preview — same vocabulary the page
   *  editor's WidgetTree dispatches. */
  function handleTreeAction(action: string, nodeId: string, kind: NodeKind) {
    if (!activeComponent) return;
    const sep = action.indexOf(':');
    const verb = sep === -1 ? action : action.slice(0, sep);
    switch (verb) {
      case 'addContainer':
        insertNewWidget(nodeId, kind, 'Container');
        break;
      case 'openWidgetSelector': {
        const widget = findComponentById(componentChildren(activeComponent), nodeId);
        setSelectorTarget({
          nodeId,
          kind,
          name: widget ? widgetLabel(widget) : activeComponent.name,
        });
        break;
      }
      case 'duplicate': {
        const result = duplicateWidgets(activeComponent, verbWidgetTargets(nodeId));
        if (!result) return;
        saveComponent(result.component);
        if (result.newIds.length === 1) setSelectedId(result.newIds[0]);
        else setSelectedIds(result.newIds);
        break;
      }
      case 'copy':
      case 'cut':
        copyWidgets(verbWidgetTargets(nodeId), verb === 'cut' ? 'cut' : 'copy');
        break;
      case 'paste':
        void pasteAt(nodeId, kind);
        break;
      case 'delete':
        handleDeleteWidgets(verbWidgetTargets(nodeId));
        break;
    }
  }

  /** Drag inside a definition: the widget keeps its id, only its parent and
   *  position change. Works across containers, not just within one list. */
  function handleMoveWidget(
    componentId: string,
    nodeId: string,
    parentId: string | null,
    index: number,
  ) {
    const target = effectiveComponents.find((c) => c.id === componentId);
    if (!target) return;
    // Dragging a row that is part of the selection drags the whole set — the same
    // set the tree resolved its drop indicator against.
    const ids =
      componentId === activeComponentId
        ? widgetSelectionTargets(target, selectedIds, nodeId)
        : [nodeId];
    const updated =
      ids.length === 1
        ? moveWidgetToIndex(target, ids[0], parentId, index)
        : moveWidgetsToIndex(target, ids, parentId, index);
    if (updated) saveComponent(updated);
  }

  function handleDeleteWidgets(ids: string[]) {
    if (!activeComponent || ids.length === 0) return;
    saveComponent(removeWidgets(activeComponent, ids));
    setSelectedId(activeComponent.id);
  }

  async function handleCreateComponent(name: string) {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const group = creatingIn?.group ?? null;
    setCreatingIn(null);
    await withSaveError(
      async () => {
        const c = await createComponent(trimmedName, group);
        openComponentTab(c.id);
      },
      () => setCreatingIn({ group }),
    );
  }

  async function handleCreateFolder(name: string) {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const parent = creatingFolder?.parent ?? null;
    const path = parent ? `${parent}/${trimmedName}` : trimmedName;
    setCreatingFolder(null);
    await withSaveError(
      () => createFolder(path),
      () => setCreatingFolder({ parent }),
    );
  }

  async function handleDeleteFolder(path: string) {
    if (!confirm(`Delete folder "${path}" and everything inside it? This cannot be undone.`))
      return;
    await withSaveError(async () => {
      await deleteFolder(path);
    });
  }

  async function handleDeleteComponent(id: string) {
    if (!confirm('Delete this component? This cannot be undone.')) return;
    await withSaveError(async () => {
      clearComponentDraft(id);
      await deleteComponent(id);
    });
  }

  const isComponentRoot = selectedId === activeComponentId;
  const selectedWidget: WidgetConfig | null =
    activeComponent && !isComponentRoot && selectedId
      ? findComponentById(activeComponent.children as WidgetConfig[], selectedId)
      : null;

  /**
   * The selection in tree order, when more than one widget is selected.
   *
   * Only the *shape* of the definition decides that order, so the walk repeats on
   * `draftStructureRev` (a structural draft write) and on `components` (a load,
   * create, delete or save) rather than on every draft write — a property write
   * replaces every widget object without moving one, and re-walking the definition
   * per keystroke is what this avoids. The definition itself is read through a ref
   * so the walk always sees the current one.
   */
  const activeComponentRef = useRef(activeComponent);
  activeComponentRef.current = activeComponent;
  const selectedIdsInOrder = useMemo<string[]>(() => {
    const component = activeComponentRef.current;
    if (!component || selectedIds.length <= 1) return [];
    const wanted = new Set(selectedIds);
    return flattenVisibleWidgets(component, new Set())
      .filter((row) => row.selectable && wanted.has(row.id))
      .map((row) => row.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the revision and the component list stand for the definition the ref reads
  }, [selectedIds, activeComponentId, components, draftStructureRev]);

  /** Re-resolved on every draft write, so the panel's rows show the value just
   *  typed; an id the walk still lists but the tree no longer holds drops out here. */
  const selectedWidgets = useMemo<WidgetConfig[]>(() => {
    if (!activeComponent || selectedIdsInOrder.length === 0) return [];
    const children = componentChildren(activeComponent);
    return selectedIdsInOrder
      .map((id) => findComponentById(children, id))
      .filter((w): w is WidgetConfig => w !== null);
  }, [activeComponent, selectedIdsInOrder]);

  const rightPanelBody = (() => {
    if (!activeComponent) {
      return (
        <div className="cfg-panel-empty">
          Select a component or create a new one to get started.
        </div>
      );
    }
    if (selectedWidgets.length > 1) {
      return (
        <CompositionMultiWidgetPanel
          comps={selectedWidgets}
          componentProperties={activeComponent.componentProperties}
          onUpdate={handleUpdateWidgets}
        />
      );
    }
    if (!selectedId || isComponentRoot) {
      return (
        <CompositionSchemaEditor component={activeComponent} onUpdate={patchActiveComponent} />
      );
    }
    if (selectedWidget) {
      return (
        <CompositionWidgetPanel
          comp={selectedWidget}
          componentProperties={activeComponent.componentProperties}
          onUpdate={handleUpdateWidget}
        />
      );
    }
    return <div className="cfg-panel-empty">Widget not found.</div>;
  })();

  // Findings that belong to the component as a whole (an unparseable file, a
  // malformed children array) can't be badged on any field — see the page
  // editor's counterpart in PropertiesPanel.
  const rightPanel = (
    <>
      <PanelDiagnosticsBanner />
      {rightPanelBody}
    </>
  );

  return (
    <>
      <ConfigLayout
        storageKey="components"
        left={
          <CompositionTree
            widgets={effectiveComponents}
            folders={folders}
            selectedId={selectedId}
            selectedIds={selectedIds}
            onSelectWidget={previewComponent}
            onOpenWidget={openComponentTab}
            onSelectComponent={selectComponent}
            onSelectRow={handleSelectRow}
            onTreeAction={handleTreeAction}
            onMoveWidget={handleMoveWidget}
            onDeleteWidget={handleDeleteComponent}
            onCreateWidget={(group) => setCreatingIn({ group })}
            onCreateFolder={(parent) => setCreatingFolder({ parent })}
            onDeleteFolder={handleDeleteFolder}
            onCopyWidget={handleCopyComponent}
            onPasteWidget={handlePasteComponent}
          />
        }
        center={
          <div className="editor-preview">
            {activeComponent ? (
              <CompositionPreview
                component={activeComponent}
                selectedIds={selectedIds}
                onUpdate={patchActiveComponent}
                onAction={handleTreeAction}
                onSelect={(id, mods) => {
                  if (!activeComponent) return;
                  if (!id) {
                    setSelectedId(activeComponent.id);
                    return;
                  }
                  handleSelectRow(activeComponent.id, id, mods);
                }}
              />
            ) : (
              <PreviewEmptyState message="No component selected." />
            )}
          </div>
        }
        right={rightPanel}
      />
      {creatingIn && (
        <NameInputModal
          title={creatingIn.group ? `New Component in "${creatingIn.group}"` : 'New Component'}
          placeholder="Component name..."
          onConfirm={handleCreateComponent}
          onCancel={() => setCreatingIn(null)}
        />
      )}
      {creatingFolder && (
        <NameInputModal
          title={creatingFolder.parent ? `New Folder in "${creatingFolder.parent}"` : 'New Folder'}
          placeholder="Folder name..."
          onConfirm={handleCreateFolder}
          onCancel={() => setCreatingFolder(null)}
        />
      )}
      {selectorTarget && (
        <WidgetSelector
          contextName={selectorTarget.name}
          filter={NO_COMPONENT_INSTANCES}
          onClose={() => setSelectorTarget(null)}
          onInsert={(type) => {
            insertNewWidget(selectorTarget.nodeId, selectorTarget.kind, type);
            setSelectorTarget(null);
          }}
        />
      )}
    </>
  );
}
