import { create } from 'zustand';
import type { IconValue, ImageValue, VariableBinding } from '@shared/types/config';
import type { ComponentOption } from '@config/components/editor/WidgetOptionsContext';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';
import type { RequiredFieldEntry, SchemaField } from '@shared/types/widgetSchema';
import type { EditorRegion } from '@shared/constants/editorSentinels';
import { combinedTabs, computeCloseTabs } from '@config/hooks/useTabStrip';
import { selectionFields } from '../selectionFields';

export interface BindingPickMetadata {
  dataType?: string;
  /** True when the picked variable is itself an array (fixed or dynamic length). */
  isArray?: boolean;
  arrayLength?: number;
  index?: number;
}

/** Options for component-prop mode: supply an in-memory property map instead of fetching datasources. */
interface ComponentPropSource {
  /** All declared component properties available for selection */
  properties: Record<string, ComponentPropertySchema>;
  /** The component schema field's merged type (simple datatype(s) / struct / editor kind). */
  fieldType?: string | string[];
  /** Required sub-fields for struct-type targets (from SchemaField.requiredFields) */
  requiredFields?: RequiredFieldEntry[];
  /** Label shown in the picker header (e.g. the component schema field label) */
  label?: string;
  /** Called with the selected property key, or empty string for clear */
  onPick: (key: string) => void;
  /** Property key the field is bound to today — preselected when the picker opens. */
  currentKey?: string;
}

interface BindingPickerOptions {
  /** Called when a variable binding is picked (var mode only) */
  onPick?: (binding: VariableBinding, metadata?: BindingPickMetadata) => void;
  /** Merged-type/requiredFields filter for the variable tree (var mode only) */
  filter?: {
    label?: string;
    type?: string | string[];
    requiredFields?: RequiredFieldEntry[];
    write?: boolean;
    includeDisabled?: boolean;
  };
  /** When set, switches the picker to component-prop mode (widget or dialog scope) */
  componentPropSource?: ComponentPropSource;
  /** The binding this field already holds, for callers whose value does not live
   *  on a component property (`componentId: ''`) and so cannot be read back from
   *  the page tree — alarm/recipe fields, action fields, write targets. Drives
   *  preselect, auto-expand and scroll-to-selection. */
  currentBinding?: VariableBinding;
}

interface BindingPickerTarget {
  componentId: string;
  propertyKey: string;
  filter?: BindingPickerOptions['filter'];
  onPick?: (binding: VariableBinding, metadata?: BindingPickMetadata) => void;
  componentPropSource?: ComponentPropSource;
  currentBinding?: VariableBinding;
}

/** Optional target-type context so the widget-prop picker can validate and preview. */
interface WidgetPropPickerOptions {
  /** The bound property's merged type (drives filtering + the Required panel). */
  fieldType?: string | string[];
  /** Required sub-fields for struct-type targets. */
  requiredFields?: RequiredFieldEntry[];
  /** Label shown in the picker header (the bound property's label). */
  label?: string;
  /** Clears the binding (mirrors the field's own clear action). */
  onClear?: () => void;
  /** Row key the field is bound to today (see `widgetPropRowKey`) — preselected
   *  when the picker opens. */
  currentKey?: string;
}

interface WidgetPropPickerTarget extends WidgetPropPickerOptions {
  componentOptions: ComponentOption[];
  onPick: (componentId: string, property: string, path?: string) => void;
}

type AssetPickerTarget =
  | { type: 'icon'; onPick: (value: IconValue) => void; label?: string }
  | { type: 'image'; onPick: (value: ImageValue) => void; label?: string };

/** `label` names the property being set — the picker shows it before its own action. */
interface OpenAssetPicker {
  (type: 'icon', onPick: (value: IconValue) => void, label?: string): void;
  (type: 'image', onPick: (value: ImageValue) => void, label?: string): void;
}

interface EditorDomainStore {
  /** Lead of the selection — always the last entry of `selectedIds`, or null when
   *  empty. Consumers that act on one node (tab activation, panel header, preview
   *  scroll target) read this and need no knowledge of multi-selection. */
  selectedId: string | null;
  /** Every selected node, in the order it was added. Only widget rows ever join a
   *  set of more than one — see `selectionScope.ts` for the narrowing. */
  selectedIds: string[];
  /** Row a Shift-range extends from. Follows every click, so the range always
   *  starts at the last plain or toggled selection. */
  selectionAnchorId: string | null;
  /** The region the current selection lives in, when the caller knew it up front (see `EditorRegion`). */
  selectedRegion: EditorRegion | null;
  setSelected: (id: string | null, region?: EditorRegion | null) => void;
  /** Ctrl/Cmd-click: add or remove one id, keeping the rest. */
  toggleSelected: (id: string, region?: EditorRegion | null) => void;
  /** Replace the whole selection — Shift-range, and verbs that select their result. */
  setSelectedMany: (ids: string[], region?: EditorRegion | null, anchorId?: string) => void;
  hoveredId: string | null;
  setHovered: (id: string | null) => void;

  /**
   * Selected parameter within the selectedId component, identified by a path
   * through the property value tree (first segment is the top-level prop key).
   * The schema is the SchemaField that applies to that exact node, used for
   * paste validation.
   */
  selectedParam: { path: string[]; schema: SchemaField } | null;
  setSelectedParam: (sel: { path: string[]; schema: SchemaField } | null) => void;

  bindingPickerOpen: boolean;
  bindingPickerTarget: BindingPickerTarget | null;
  openBindingPicker: (
    componentId: string,
    propertyKey: string,
    options?: BindingPickerOptions,
  ) => void;
  closeBindingPicker: () => void;

  widgetPropPickerOpen: boolean;
  widgetPropPickerTarget: WidgetPropPickerTarget | null;
  openWidgetPropPicker: (
    componentOptions: ComponentOption[],
    onPick: (componentId: string, property: string, path?: string) => void,
    options?: WidgetPropPickerOptions,
  ) => void;
  closeWidgetPropPicker: () => void;

  assetPickerOpen: boolean;
  assetPickerTarget: AssetPickerTarget | null;
  openAssetPicker: OpenAssetPicker;
  closeAssetPicker: () => void;

  openTabIds: string[];
  previewTabId: string | null;
  activeTabId: string | null;
  previewPage(pageId: string): void;
  openTab(pageId: string): void;
  closeTab(pageId: string): void;
  closeTabs(pageIds: string[]): void;
  setActiveTab(pageId: string): void;

  previewAreaId: string;
  treeCollapsedIds: string[];
  treeOpenSectionIds: string[];
  setTreeCollapsedIds(ids: string[]): void;
  setTreeOpenSectionIds(ids: string[]): void;
}

/** The shared selection invariant plus the two fields only the page editor carries:
 *  a region always follows the lead, and no parameter row survives a reselect. */
function selectionPatch(ids: string[], anchorId: string | null, region: EditorRegion | null) {
  return {
    ...selectionFields(ids, anchorId),
    selectedRegion: region,
    selectedParam: null,
  };
}

export const useEditorDomainStore = create<EditorDomainStore>((set, get) => ({
  selectedId: null,
  selectedIds: [],
  selectionAnchorId: null,
  selectedRegion: null,
  // The `selectedIds.length <= 1` guard is load-bearing: without it, clicking a row
  // that is already the lead of a multi-selection would leave the rest selected.
  setSelected: (id, region = null) =>
    set((s) =>
      s.selectedId === id && s.selectedIds.length <= 1
        ? s
        : selectionPatch(id ? [id] : [], id, region),
    ),
  toggleSelected: (id, region = null) =>
    set((s) => {
      const present = s.selectedIds.includes(id);
      const ids = present ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id];
      // Dropping the lead promotes whatever was clicked before it, whose region the
      // caller cannot know — null lets LivePreview resolve it from the tree instead.
      return selectionPatch(
        ids,
        present ? (ids[ids.length - 1] ?? null) : id,
        present ? null : region,
      );
    }),
  setSelectedMany: (ids, region = null, anchorId) =>
    set(() => selectionPatch(ids, anchorId ?? (ids.length > 0 ? ids[0] : null), region)),
  hoveredId: null,
  setHovered: (id) => set({ hoveredId: id }),

  selectedParam: null,
  setSelectedParam: (sel) => set((s) => (s.selectedParam === sel ? s : { selectedParam: sel })),

  bindingPickerOpen: false,
  bindingPickerTarget: null,
  openBindingPicker: (componentId, propertyKey, options) =>
    set({
      bindingPickerOpen: true,
      bindingPickerTarget: {
        componentId,
        propertyKey,
        onPick: options?.onPick,
        filter: options?.filter,
        componentPropSource: options?.componentPropSource,
        currentBinding: options?.currentBinding,
      },
    }),
  closeBindingPicker: () => set({ bindingPickerOpen: false, bindingPickerTarget: null }),

  widgetPropPickerOpen: false,
  widgetPropPickerTarget: null,
  openWidgetPropPicker: (componentOptions, onPick, options) =>
    set({
      widgetPropPickerOpen: true,
      widgetPropPickerTarget: {
        componentOptions,
        onPick,
        fieldType: options?.fieldType,
        requiredFields: options?.requiredFields,
        label: options?.label,
        onClear: options?.onClear,
        currentKey: options?.currentKey,
      },
    }),
  closeWidgetPropPicker: () => set({ widgetPropPickerOpen: false, widgetPropPickerTarget: null }),

  assetPickerOpen: false,
  assetPickerTarget: null,
  openAssetPicker: ((type, onPick, label) =>
    set({
      assetPickerOpen: true,
      assetPickerTarget: { type, onPick, label } as AssetPickerTarget,
    })) as OpenAssetPicker,
  closeAssetPicker: () => set({ assetPickerOpen: false, assetPickerTarget: null }),

  openTabIds: [],
  previewTabId: null,
  activeTabId: null,
  previewPage: (pageId) =>
    set((s) => ({
      activeTabId: pageId,
      previewAreaId: pageId,
      previewTabId: s.openTabIds.includes(pageId) ? s.previewTabId : pageId,
    })),
  openTab: (pageId) =>
    set((s) => {
      if (s.openTabIds.includes(pageId))
        return s.activeTabId === pageId ? s : { activeTabId: pageId, previewAreaId: pageId };
      // At the cap, evict the oldest tab to make room rather than no-op'ing —
      // otherwise auto-navigation (page-group sync) would leave previewAreaId
      // stale against the actual preview route.
      const base = s.openTabIds.length >= 20 ? s.openTabIds.slice(1) : s.openTabIds;
      return {
        openTabIds: [...base, pageId],
        previewTabId: s.previewTabId === pageId ? null : s.previewTabId,
        activeTabId: pageId,
        previewAreaId: pageId,
      };
    }),
  closeTab: (pageId) => get().closeTabs([pageId]),
  closeTabs: (pageIds) =>
    set((s) => {
      const result = computeCloseTabs(
        { openTabIds: s.openTabIds, previewTabId: s.previewTabId, activeId: s.activeTabId },
        pageIds,
      );
      if (!result) return s;
      const nextActive = result.nextActiveId === undefined ? s.activeTabId : result.nextActiveId;
      return {
        openTabIds: result.openTabIds,
        previewTabId: result.previewTabId,
        activeTabId: nextActive,
        previewAreaId: nextActive ?? '',
      };
    }),
  setActiveTab: (pageId) =>
    set((s) =>
      s.activeTabId === pageId
        ? s
        : combinedTabs(s.openTabIds, s.previewTabId).includes(pageId)
          ? { activeTabId: pageId, previewAreaId: pageId }
          : s,
    ),

  previewAreaId: '',
  treeCollapsedIds: [],
  treeOpenSectionIds: [],
  setTreeCollapsedIds: (ids) => set({ treeCollapsedIds: ids }),
  setTreeOpenSectionIds: (ids) => set({ treeOpenSectionIds: ids }),
}));
