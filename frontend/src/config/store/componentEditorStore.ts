import { create } from 'zustand';
import { combinedTabs, computeCloseTabs } from '@config/hooks/useTabStrip';
import { selectionFields } from './selectionFields';

interface ComponentEditorStore {
  activeComponentId: string | null;

  /** Lead of the selection — always the last entry of `selectedIds`, or null when
   *  empty. `selectedId === activeComponentId` still means "the definition root". */
  selectedId: string | null;
  /** Every selected widget, in the order it was added. The definition root never
   *  joins a set of more than one — it is not a widget. */
  selectedIds: string[];
  /** Row a Shift-range extends from. */
  selectionAnchorId: string | null;
  setSelectedId: (id: string | null) => void;
  /** Ctrl/Cmd-click: add or remove one widget, keeping the rest. */
  toggleSelectedId: (id: string) => void;
  /** Replace the whole selection — Shift-range, and verbs that select their result. */
  setSelectedIds: (ids: string[], anchorId?: string) => void;

  /** Pinned tabs, in open order. */
  openTabIds: string[];
  /** At most one ephemeral tab, replaced by the next preview unless pinned. */
  previewTabId: string | null;

  /** Single click on a component row: preview it (ephemeral unless already pinned). */
  previewComponent: (componentId: string) => void;
  /** Double click, or an explicit "open" action: pin the component as a permanent tab. */
  openTab: (componentId: string) => void;
  /** Close a tab, pinned or preview. */
  closeTab: (componentId: string) => void;
  /** Close multiple pinned and/or preview tabs in one update. */
  closeTabs: (componentIds: string[]) => void;
  /** Activate an already-open tab. */
  setActiveTab: (componentId: string) => void;
  /** Select a widget inside a component's tree, opening that component as the preview if needed. */
  selectComponent: (componentId: string, widgetId: string) => void;
  /** Drop tabs whose component no longer exists (after delete). */
  pruneTabs: (validIds: Set<string>) => void;

  collapsedIds: Set<string>;
  toggleCollapsed: (id: string) => void;
  /** Replace the whole collapse set — what the tree's collapse-all button does. */
  setCollapsedIds: (ids: Iterable<string>) => void;
}

const single = (id: string | null) => selectionFields(id === null ? [] : [id], id);

export const useComponentEditorStore = create<ComponentEditorStore>((set, get) => ({
  activeComponentId: null,

  ...single(null),
  setSelectedId: (id: string | null) => set(single(id)),
  toggleSelectedId: (id: string) =>
    set((s) => {
      // The root stands for the component itself rather than a widget inside it, so
      // it can neither join a set nor survive one forming around it.
      const rootSelected =
        s.activeComponentId !== null && s.selectedIds.includes(s.activeComponentId);
      if (id === s.activeComponentId || rootSelected) return single(id);
      const present = s.selectedIds.includes(id);
      const ids = present ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id];
      return selectionFields(ids, present ? (ids[ids.length - 1] ?? null) : id);
    }),
  setSelectedIds: (ids, anchorId) =>
    set(selectionFields(ids, anchorId ?? (ids.length > 0 ? ids[0] : null))),

  openTabIds: [],
  previewTabId: null,

  previewComponent: (componentId) =>
    set((s) => ({
      activeComponentId: componentId,
      ...single(componentId),
      previewTabId: s.openTabIds.includes(componentId) ? s.previewTabId : componentId,
    })),

  openTab: (componentId) =>
    set((s) => ({
      activeComponentId: componentId,
      ...single(componentId),
      openTabIds: s.openTabIds.includes(componentId)
        ? s.openTabIds
        : [...s.openTabIds, componentId],
      previewTabId: s.previewTabId === componentId ? null : s.previewTabId,
    })),

  closeTab: (componentId) => get().closeTabs([componentId]),
  closeTabs: (componentIds) =>
    set((s) => {
      const result = computeCloseTabs(
        { openTabIds: s.openTabIds, previewTabId: s.previewTabId, activeId: s.activeComponentId },
        componentIds,
      );
      if (!result) return s;
      if (result.nextActiveId === undefined) {
        return { openTabIds: result.openTabIds, previewTabId: result.previewTabId };
      }
      return {
        openTabIds: result.openTabIds,
        previewTabId: result.previewTabId,
        activeComponentId: result.nextActiveId,
        ...single(result.nextActiveId),
      };
    }),

  setActiveTab: (componentId) =>
    set((s) =>
      s.activeComponentId === componentId
        ? s
        : { activeComponentId: componentId, ...single(componentId) },
    ),

  selectComponent: (componentId, widgetId) =>
    set((s) => ({
      activeComponentId: componentId,
      ...single(widgetId),
      previewTabId: s.openTabIds.includes(componentId) ? s.previewTabId : componentId,
    })),

  pruneTabs: (validIds) =>
    set((s) => {
      const openTabIds = s.openTabIds.filter((id) => validIds.has(id));
      const previewTabId = s.previewTabId && validIds.has(s.previewTabId) ? s.previewTabId : null;
      const activeValid = s.activeComponentId ? validIds.has(s.activeComponentId) : true;
      if (
        openTabIds.length === s.openTabIds.length &&
        previewTabId === s.previewTabId &&
        activeValid
      )
        return s;
      if (activeValid) return { openTabIds, previewTabId };

      const remaining = combinedTabs(openTabIds, previewTabId);
      const nextActive = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      return { openTabIds, previewTabId, activeComponentId: nextActive, ...single(nextActive) };
    }),

  collapsedIds: new Set(),
  toggleCollapsed: (id: string) =>
    set((s: ComponentEditorStore) => {
      const next = new Set(s.collapsedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { collapsedIds: next };
    }),
  setCollapsedIds: (ids: Iterable<string>) => set({ collapsedIds: new Set(ids) }),
}));
