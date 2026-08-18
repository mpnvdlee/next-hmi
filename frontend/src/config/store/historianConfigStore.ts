import { create } from 'zustand';
import { useProjectStore } from '@shared/store/projectStore';
import { projectIsDirty } from '@shared/store/projectActions';
import { apiJson } from '@shared/utils/api';

export interface VariableConfig {
  enabled: boolean;
  minInterval: number;
  retention: number;
}

interface HistorianConfig {
  variables: Record<string, VariableConfig>;
}

interface HistorianStatus {
  dbSizeBytes: number;
  variableCount: number;
  totalSamples: number;
  oldestSample: string | null;
  newestSample: string | null;
}

const DEFAULT_VARIABLE_CONFIG: VariableConfig = {
  enabled: true,
  minInterval: 1,
  retention: 2592000,
};

interface HistorianConfigState {
  config: HistorianConfig | null;
  status: HistorianStatus | null;
  availableVars: string[];

  load(): Promise<void>;
  save(): Promise<void>;
  refreshStatus(): Promise<void>;
  addVariable(key: string): void;
  removeVariable(key: string): void;
  toggleVariable(key: string): void;
  updateVariable(key: string, patch: Partial<VariableConfig>): void;
}

export const useHistorianConfigStore = create<HistorianConfigState>((set, get) => ({
  config: null,
  status: null,
  availableVars: [],

  load: async () => {
    // Skip re-fetch when already loaded and there are unsaved local changes.
    if (get().config && projectIsDirty()) {
      await get().refreshStatus();
      return;
    }
    try {
      const [config, availableVars] = await Promise.all([
        apiJson<HistorianConfig>('/api/historian/config'),
        apiJson<string[]>('/api/historian/available-variables'),
      ]);
      set({ config, availableVars });
    } catch (err) {
      console.error('[historianConfigStore] load failed:', err);
    }
    await get().refreshStatus();
  },

  save: async () => {
    const { config } = get();
    if (!config) return;
    const saved = await apiJson<HistorianConfig>('/api/historian/config', {
      method: 'PUT',
      body: config,
    });
    set({ config: saved });
    await get().refreshStatus();
  },

  refreshStatus: async () => {
    try {
      const status = await apiJson<HistorianStatus>('/api/historian/status');
      set({ status });
    } catch (err) {
      console.error('[historianConfigStore] status refresh failed:', err);
    }
  },

  addVariable: (key) => {
    const { config } = get();
    if (!key || !config) return;
    // Re-picking a variable that is already tracked must not reset the interval
    // and retention the user set on it.
    if (config.variables[key]) return;
    set({
      config: {
        ...config,
        variables: { ...config.variables, [key]: { ...DEFAULT_VARIABLE_CONFIG } },
      },
    });
    useProjectStore.getState().markDirty();
  },

  removeVariable: (key) => {
    const { config } = get();
    if (!config) return;
    const variables = { ...config.variables };
    delete variables[key];
    set({ config: { ...config, variables } });
    useProjectStore.getState().markDirty();
  },

  toggleVariable: (key) => {
    const { config } = get();
    if (!config) return;
    const existing = config.variables[key];
    if (!existing) return;
    set({
      config: {
        ...config,
        variables: { ...config.variables, [key]: { ...existing, enabled: !existing.enabled } },
      },
    });
    useProjectStore.getState().markDirty();
  },

  updateVariable: (key, patch) => {
    const { config } = get();
    if (!config) return;
    const existing = config.variables[key];
    if (!existing) return;
    set({
      config: {
        ...config,
        variables: { ...config.variables, [key]: { ...existing, ...patch } },
      },
    });
    useProjectStore.getState().markDirty();
  },
}));

// Register persistent save callback — runs at module load so Ctrl+S / Save button
// persists historian config regardless of which config page is currently active.
useProjectStore.getState().registerSave('historian', async () => {
  await useHistorianConfigStore.getState().save();
});
