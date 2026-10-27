import { create } from 'zustand';
import { useVariableStore } from './variableStore';
import { bindingIndex, bindingKey } from '@shared/types/config';
import { getVarBinding } from '@shared/types/propertyValueGuards';
import type {
  RecipeConfig,
  RecipeDatasetType,
  RecipeField,
  RecipeRow,
  DownloadResult,
  LoadedDataset,
} from '@shared/types/recipe';

interface RecipeStore {
  config: RecipeConfig;
  loaded: Record<string, LoadedDataset>;
  lastResult: DownloadResult | null;

  setSnapshot(
    config: RecipeConfig,
    loaded: Record<string, LoadedDataset>,
    lastResult: DownloadResult | null,
  ): void;

  /** Resolve a $recipe dynamic property scoped to a dataset type; the
   *  `parameter…` fields read one parameter of the loaded dataset. */
  getField(typeId: string, field: RecipeField, parameter?: string): unknown;

  /**
   * The $recipeList property source: saved datasets flattened to rows. When
   * `typeId` is empty, every type's datasets are returned; otherwise only that
   * type's. `lastLoaded` reflects each dataset's own last-downloaded time.
   */
  getList(typeId: string): RecipeRow[];
}

const EMPTY_CONFIG: RecipeConfig = { version: 1, datasetTypes: [] };

/** Compare a stored value to a live one (arrays element-wise). Numbers use a
 * relative tolerance so a PLC float round-trip's low-bit drift doesn't read as
 * an unsaved change. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return a === b;
}

function liveValue(binding: unknown, values: Record<string, unknown>): unknown {
  const v = getVarBinding(binding);
  if (!v) return undefined;
  const live = values[bindingKey(v)];
  const index = bindingIndex(v);
  if (index !== undefined && Array.isArray(live)) {
    return live[index];
  }
  return live;
}

function findType(config: RecipeConfig, typeId: string): RecipeDatasetType | undefined {
  return config.datasetTypes.find((t) => t.id === typeId);
}

// Per-typeId memo so getList returns a stable array reference while the config
// is unchanged — a fresh array every call would defeat consumers' memoization.
const listCache = new Map<string, { config: RecipeConfig; rows: RecipeRow[] }>();

export const useRecipeStore = create<RecipeStore>((set, get) => ({
  config: EMPTY_CONFIG,
  loaded: {},
  lastResult: null,

  setSnapshot: (config, loaded, lastResult) => set({ config, loaded, lastResult }),

  getField: (typeId, field, parameter) => {
    const { config, loaded } = get();
    const entry = loaded[typeId];

    if (field === 'loaded') return entry !== undefined;

    const type = findType(config, typeId);
    const dataset = entry && type ? type.datasets.find((d) => d.id === entry.datasetId) : undefined;

    if (field === 'activeName') return dataset?.name ?? '';

    if (field === 'parameterValue') return (parameter && dataset?.values[parameter]) ?? null;
    if (field === 'savedAt') return dataset?.updatedAt ?? '';

    // parametersChanged / parameterChanged: compare the loaded dataset's stored values to live values.
    if (!type || !dataset) return false;
    const values = useVariableStore.getState().values;
    const changed = (param: (typeof type.parameters)[number]) => {
      if (!(param.id in dataset.values)) return false;
      const live = liveValue(param.binding, values);
      if (live === undefined) return false; // live value not known yet — not "changed"
      return !valuesEqual(dataset.values[param.id], live);
    };
    if (field === 'parameterChanged') {
      const param = type.parameters.find((p) => p.id === parameter);
      return param ? changed(param) : false;
    }
    if (field === 'changedCount') return type.parameters.filter(changed).length;
    return type.parameters.some(changed);
  },

  getList: (typeId) => {
    const { config } = get();
    const cached = listCache.get(typeId);
    if (cached && cached.config === config) return cached.rows;
    const types = typeId ? config.datasetTypes.filter((t) => t.id === typeId) : config.datasetTypes;
    const rows: RecipeRow[] = [];
    for (const type of types) {
      for (const dataset of type.datasets) {
        rows.push({
          id: dataset.id,
          name: dataset.name,
          description: dataset.description,
          lastLoaded: dataset.loadedAt,
          values: dataset.values,
        });
      }
    }
    listCache.set(typeId, { config, rows });
    return rows;
  },
}));
