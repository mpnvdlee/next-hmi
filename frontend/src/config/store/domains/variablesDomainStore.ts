import { create } from 'zustand';
import { apiJson } from '@shared/utils/api';
import { makeAbortableLoader } from '@shared/utils/abortableLoader';
import type {
  DatasourceConfig,
  DatasourceListItem,
  DatasourceSettings,
  DatasourceType,
  TreeNode,
} from '@shared/types/datasource';
import { defaultDatasource } from '@shared/types/datasource';
import {
  diffSelectionKey,
  type BrowseDiff,
} from '@config/components/variables/DatasourceVariableTable/datasourceBrowseDiff';

interface VariablesViewState {
  datasources: DatasourceListItem[];
  selectedName: string | null;
  selectedConfig: DatasourceConfig | null;
  datasourceTreeExpanded: boolean;
  listError: string | null;
  configError: string | null;
  actionError: string | null;

  setSelectedName(name: string | null): void;
  setSelectedConfig(config: DatasourceConfig | null): void;
  setDatasourceTreeExpanded(expanded: boolean): void;
  clearErrors(): void;

  loadList(): Promise<void>;
  loadConfig(name: string): Promise<void>;
  addDatasource(
    type: DatasourceType,
    name: string,
    settings?: Partial<DatasourceSettings>,
  ): Promise<void>;
  deleteDatasource(name: string): Promise<void>;
  saveSettings(config: DatasourceConfig): Promise<void>;
  refreshSelected(): Promise<void>;
}

interface DatasourceDraftState {
  propsDrafts: Record<string, Record<string, unknown>>;
  varsDrafts: Record<string, TreeNode[]>;
  collapsedDrafts: Record<string, string[]>;

  setPropsDraft(name: string, settings: Record<string, unknown>): void;
  clearPropsDraft(name: string): void;

  setVarsDraft(name: string, tree: TreeNode[]): void;
  clearVarsDraft(name: string): void;

  setCollapsedDraft(name: string, collapsed: string[]): void;
  clearCollapsedDraft(name: string): void;

  clearAllDrafts(): void;
}

interface PendingBrowseEntry {
  diff: BrowseDiff;
  selected: ReadonlySet<string>;
}

interface PendingBrowseState {
  pendingBrowse: Record<string, PendingBrowseEntry>;
  /** One-shot hand-off from the connection wizard: browse this datasource's
   *  server as soon as it reports connected. Cleared once the browse fires. */
  browseRequestName: string | null;

  setPendingBrowse(name: string, payload: { diff: BrowseDiff }): void;
  togglePendingSelection(name: string, key: string): void;
  setCategorySelection(
    name: string,
    category: 'added' | 'removed' | 'modified',
    selected: boolean,
  ): void;
  clearPendingBrowse(name: string): void;
  requestBrowse(name: string): void;
  clearBrowseRequest(): void;
}

type VariablesDomainStore = VariablesViewState & DatasourceDraftState & PendingBrowseState;

export const useVariablesDomainStore = create<VariablesDomainStore>((set, get) => {
  const listLoader = makeAbortableLoader();
  const configLoader = makeAbortableLoader();
  let configRequestSeq = 0;

  return {
    datasources: [],
    selectedName: null,
    selectedConfig: null,
    datasourceTreeExpanded: true,
    listError: null,
    configError: null,
    actionError: null,

    propsDrafts: {},
    varsDrafts: {},
    collapsedDrafts: {},
    pendingBrowse: {},
    browseRequestName: null,

    setSelectedName: (name) => set({ selectedName: name, configError: null, actionError: null }),
    setSelectedConfig: (config) => set({ selectedConfig: config }),
    setDatasourceTreeExpanded: (expanded) => set({ datasourceTreeExpanded: expanded }),
    clearErrors: () => set({ listError: null, configError: null, actionError: null }),

    loadList: async () => {
      const controller = listLoader.begin();
      try {
        const data = await apiJson<DatasourceListItem[]>('/api/datasources', {
          signal: controller.signal,
        });
        if (!listLoader.isCurrent(controller)) return;
        set({ datasources: data, listError: null });
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('[variablesDomainStore] Failed to load datasource list:', err);
        set({ listError: 'Could not load datasource list.', datasources: [] });
      } finally {
        listLoader.finalize(controller);
      }
    },

    loadConfig: async (name) => {
      const controller = configLoader.begin();
      configRequestSeq += 1;
      const requestId = configRequestSeq;

      try {
        const partialConfig = await apiJson<DatasourceConfig>(
          `/api/datasources/${encodeURIComponent(name)}?include_variables=false`,
          { signal: controller.signal },
        );
        if (!configLoader.isCurrent(controller) || requestId !== configRequestSeq) return;
        set((state) =>
          state.selectedName === name
            ? { selectedConfig: { ...partialConfig, variables: [] }, configError: null }
            : state,
        );

        const { variables } = await apiJson<{ variables: TreeNode[] }>(
          `/api/datasources/${encodeURIComponent(name)}/variables?simple=false`,
          { signal: controller.signal },
        );
        if (!configLoader.isCurrent(controller) || requestId !== configRequestSeq) return;

        set((state) =>
          state.selectedConfig?.name === name
            ? { selectedConfig: { ...state.selectedConfig, variables }, configError: null }
            : state,
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('[variablesDomainStore] Failed to load datasource config:', err);
        if (get().selectedName === name) {
          set({ configError: `Could not load datasource "${name}".` });
        }
      } finally {
        configLoader.finalize(controller);
      }
    },

    addDatasource: async (type, name, settings) => {
      const config = defaultDatasource(type, name);
      if (settings) {
        config.settings = { ...config.settings, ...settings } as DatasourceSettings;
      }
      try {
        await apiJson(`/api/datasources/${encodeURIComponent(name)}`, {
          method: 'PUT',
          body: config,
        });
        await get().loadList();
        set({ selectedName: name, actionError: null });
      } catch (err) {
        console.error('[variablesDomainStore] Failed to add datasource:', err);
        set({ actionError: `Could not create datasource "${name}".` });
      }
    },

    deleteDatasource: async (name) => {
      try {
        await apiJson(`/api/datasources/${encodeURIComponent(name)}`, { method: 'DELETE' });
        set((state) => {
          const nextPending = { ...state.pendingBrowse };
          delete nextPending[name];
          const base = { pendingBrowse: nextPending, actionError: null };
          return state.selectedName === name
            ? { ...base, selectedName: null, selectedConfig: null }
            : base;
        });
        await get().loadList();
      } catch (err) {
        console.error('[variablesDomainStore] Failed to delete datasource:', err);
        set({ actionError: `Could not delete datasource "${name}".` });
      }
    },

    saveSettings: async (config) => {
      try {
        // The variable-table save (useDatasourceSaveRegistration) is the sole
        // writer of the variable tree via PUT /variables. Omit `variables`
        // here entirely and rely on the backend preserving the existing tree
        // (§1.5) — this is a settings-only save, so it can no longer race the
        // table's own concurrent save with a stale snapshot (§8.2).
        const { variables: _variables, ...settingsOnly } = config;
        await apiJson(`/api/datasources/${encodeURIComponent(config.name)}`, {
          method: 'PUT',
          body: settingsOnly,
        });
        set((state) => ({
          selectedConfig: { ...config, variables: state.selectedConfig?.variables ?? [] },
          actionError: null,
        }));
        await get().loadList();
      } catch (err) {
        console.error('[variablesDomainStore] Failed to save datasource settings:', err);
        set({ actionError: `Could not save datasource "${config.name}".` });
      }
    },

    refreshSelected: async () => {
      await get().loadList();
      const selectedName = get().selectedName;
      if (selectedName) await get().loadConfig(selectedName);
    },

    setPropsDraft: (name, settings) =>
      set((state) => ({
        propsDrafts: { ...state.propsDrafts, [name]: settings },
      })),

    clearPropsDraft: (name) =>
      set((state) => {
        const next = { ...state.propsDrafts };
        delete next[name];
        return { propsDrafts: next };
      }),

    setVarsDraft: (name, tree) =>
      set((state) => ({
        varsDrafts: { ...state.varsDrafts, [name]: tree },
      })),

    clearVarsDraft: (name) =>
      set((state) => {
        const next = { ...state.varsDrafts };
        delete next[name];
        return { varsDrafts: next };
      }),

    setCollapsedDraft: (name, collapsed) =>
      set((state) => ({
        collapsedDrafts: { ...state.collapsedDrafts, [name]: collapsed },
      })),

    clearCollapsedDraft: (name) =>
      set((state) => {
        const next = { ...state.collapsedDrafts };
        delete next[name];
        return { collapsedDrafts: next };
      }),

    clearAllDrafts: () =>
      set({ propsDrafts: {}, varsDrafts: {}, collapsedDrafts: {}, pendingBrowse: {} }),

    setPendingBrowse: (name, payload) =>
      set((state) => ({
        pendingBrowse: {
          ...state.pendingBrowse,
          [name]: { diff: payload.diff, selected: new Set<string>() },
        },
      })),

    togglePendingSelection: (name, key) =>
      set((state) => {
        const entry = state.pendingBrowse[name];
        if (!entry) return state;
        const next = new Set(entry.selected);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return {
          pendingBrowse: { ...state.pendingBrowse, [name]: { ...entry, selected: next } },
        };
      }),

    setCategorySelection: (name, category, selected) =>
      set((state) => {
        const entry = state.pendingBrowse[name];
        if (!entry) return state;
        const rows = entry.diff[category];
        const next = new Set(entry.selected);
        for (const row of rows) {
          const key = diffSelectionKey(category, row.node_id);
          if (selected) next.add(key);
          else next.delete(key);
        }
        return {
          pendingBrowse: { ...state.pendingBrowse, [name]: { ...entry, selected: next } },
        };
      }),

    clearPendingBrowse: (name) =>
      set((state) => {
        const next = { ...state.pendingBrowse };
        delete next[name];
        return { pendingBrowse: next };
      }),

    requestBrowse: (name) => set({ browseRequestName: name }),
    clearBrowseRequest: () => set({ browseRequestName: null }),
  };
});
