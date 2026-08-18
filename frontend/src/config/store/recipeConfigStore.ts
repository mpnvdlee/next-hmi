import { create } from 'zustand';
import { useProjectStore } from '@shared/store/projectStore';
import { projectIsDirty } from '@shared/store/projectActions';
import { apiJson } from '@shared/utils/api';
import { slugId } from '@shared/utils/id';
import type {
  RecipeConfig,
  RecipeDatasetType,
  RecipeParameter,
  RecipeDataType,
  RecipeDataset,
} from '@shared/types/recipe';

/** Fields supplied when adding a parameter from a picked variable. */
type NewParameterInit = Pick<RecipeParameter, 'label' | 'binding' | 'dataType'>;

export type RecipeSelection =
  { type: 'type'; id: string } | { type: 'dataset'; typeId: string; id: string } | null;

interface RecipeConfigState {
  config: RecipeConfig | null;
  loaded: boolean;
  selection: RecipeSelection;
  loadError: string | null;

  setSelection(sel: RecipeSelection): void;
  load(): Promise<void>;
  save(): Promise<void>;

  addType(name: string): void;
  patchType(id: string, patch: Partial<Pick<RecipeDatasetType, 'name'>>): void;
  deleteType(id: string): void;

  addParameter(typeId: string, init?: NewParameterInit): void;
  patchParameter(typeId: string, paramId: string, patch: Partial<RecipeParameter>): void;
  deleteParameter(typeId: string, paramId: string): void;
  moveParameter(typeId: string, paramId: string, dir: -1 | 1): void;

  addDataset(typeId: string): void;
  patchDataset(typeId: string, datasetId: string, patch: Partial<RecipeDataset>): void;
  deleteDataset(typeId: string, datasetId: string): void;
  setDatasetValue(typeId: string, datasetId: string, paramId: string, value: unknown): void;
  /** Persist a dataset's content straight to the backend without dirtying the project. */
  saveDataset(
    typeId: string,
    datasetId: string,
    patch: Pick<RecipeDataset, 'name' | 'description' | 'values'>,
  ): Promise<void>;
}

function createParameter(taken: Iterable<string>, init?: NewParameterInit): RecipeParameter {
  return {
    id: slugId('parameter', taken),
    label: init?.label || 'New Parameter',
    binding: init?.binding,
    dataType: init?.dataType ?? ('float' as RecipeDataType),
  };
}

function createDataset(taken: Iterable<string>): RecipeDataset {
  return {
    id: slugId('dataset', taken),
    name: 'New Dataset',
    description: '',
    values: {},
    updatedAt: '',
    updatedBy: '',
    loadedAt: '',
  };
}

function markDirty() {
  useProjectStore.getState().markDirty();
}

export const useRecipeConfigStore = create<RecipeConfigState>((set, get) => {
  /** Map every dataset type in the current config, marking dirty. */
  function mutateTypes(map: (t: RecipeDatasetType) => RecipeDatasetType) {
    const { config } = get();
    if (!config) return;
    set({ config: { ...config, datasetTypes: config.datasetTypes.map(map) } });
    markDirty();
  }

  /** Map only the matching type. */
  function mutateType(typeId: string, map: (t: RecipeDatasetType) => RecipeDatasetType) {
    mutateTypes((t) => (t.id === typeId ? map(t) : t));
  }

  return {
    config: null,
    loaded: false,
    selection: null,
    loadError: null,

    setSelection: (sel) => set({ selection: sel }),

    load: async () => {
      if (get().loaded && projectIsDirty()) return;
      try {
        const config = await apiJson<RecipeConfig>('/api/recipes/config');
        set({ config, loaded: true, loadError: null });
      } catch (err) {
        console.error('[recipeConfigStore] load failed:', err);
        set({ loadError: 'Could not load recipe configuration.' });
      }
    },

    save: async () => {
      const { config } = get();
      if (!config) return;
      const saved = await apiJson<RecipeConfig>('/api/recipes/config', {
        method: 'PUT',
        body: config,
      });
      set({ config: saved });
    },

    addType: (name) => {
      const { config } = get();
      if (!config) return;
      const type: RecipeDatasetType = {
        id: slugId(
          name || 'type',
          config.datasetTypes.map((t) => t.id),
        ),
        name,
        parameters: [],
        datasets: [],
      };
      set({
        config: { ...config, datasetTypes: [...config.datasetTypes, type] },
        selection: { type: 'type', id: type.id },
      });
      markDirty();
    },

    patchType: (id, patch) => mutateType(id, (t) => ({ ...t, ...patch })),

    deleteType: (id) => {
      const { config, selection } = get();
      if (!config) return;
      const stillSelected =
        (selection?.type === 'type' && selection.id === id) ||
        (selection?.type === 'dataset' && selection.typeId === id);
      set({
        config: { ...config, datasetTypes: config.datasetTypes.filter((t) => t.id !== id) },
        selection: stillSelected ? null : selection,
      });
      markDirty();
    },

    addParameter: (typeId, init) =>
      mutateType(typeId, (t) => ({
        ...t,
        parameters: [
          ...t.parameters,
          createParameter(
            t.parameters.map((p) => p.id),
            init,
          ),
        ],
      })),

    patchParameter: (typeId, paramId, patch) =>
      mutateType(typeId, (t) => ({
        ...t,
        parameters: t.parameters.map((p) => (p.id === paramId ? { ...p, ...patch } : p)),
      })),

    deleteParameter: (typeId, paramId) =>
      mutateType(typeId, (t) => ({
        ...t,
        parameters: t.parameters.filter((p) => p.id !== paramId),
        // Drop the parameter's value from every dataset of this type.
        datasets: t.datasets.map((d) => {
          if (!(paramId in d.values)) return d;
          const { [paramId]: _drop, ...rest } = d.values;
          return { ...d, values: rest };
        }),
      })),

    moveParameter: (typeId, paramId, dir) =>
      mutateType(typeId, (t) => {
        const idx = t.parameters.findIndex((p) => p.id === paramId);
        const next = idx + dir;
        if (idx < 0 || next < 0 || next >= t.parameters.length) return t;
        const params = [...t.parameters];
        [params[idx], params[next]] = [params[next], params[idx]];
        return { ...t, parameters: params };
      }),

    addDataset: (typeId) => {
      let newId = '';
      mutateType(typeId, (t) => {
        const dataset = createDataset(t.datasets.map((d) => d.id));
        newId = dataset.id;
        return { ...t, datasets: [...t.datasets, dataset] };
      });
      if (newId) set({ selection: { type: 'dataset', typeId, id: newId } });
    },

    patchDataset: (typeId, datasetId, patch) =>
      mutateType(typeId, (t) => ({
        ...t,
        datasets: t.datasets.map((d) => (d.id === datasetId ? { ...d, ...patch } : d)),
      })),

    deleteDataset: (typeId, datasetId) => {
      const { selection } = get();
      mutateType(typeId, (t) => ({
        ...t,
        datasets: t.datasets.filter((d) => d.id !== datasetId),
      }));
      if (selection?.type === 'dataset' && selection.id === datasetId) {
        set({ selection: { type: 'type', id: typeId } });
      }
    },

    setDatasetValue: (typeId, datasetId, paramId, value) =>
      mutateType(typeId, (t) => ({
        ...t,
        datasets: t.datasets.map((d) =>
          d.id === datasetId ? { ...d, values: { ...d.values, [paramId]: value } } : d,
        ),
      })),

    saveDataset: async (typeId, datasetId, patch) => {
      const { config } = get();
      if (!config) return;
      // Commit the dataset locally without markDirty, then persist directly —
      // dataset content is operator data, kept out of the project dirty/save flow.
      const next: RecipeConfig = {
        ...config,
        datasetTypes: config.datasetTypes.map((t) =>
          t.id === typeId
            ? {
                ...t,
                datasets: t.datasets.map((d) => (d.id === datasetId ? { ...d, ...patch } : d)),
              }
            : t,
        ),
      };
      set({ config: next });
      const saved = await apiJson<RecipeConfig>('/api/recipes/config', {
        method: 'PUT',
        body: next,
      });
      set({ config: saved });
    },
  };
});

// Register persistent save callback so Ctrl+S / Save persists recipe config
// regardless of which config page is active.
useProjectStore.getState().registerSave('recipes', async () => {
  await useRecipeConfigStore.getState().save();
});
