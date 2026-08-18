// ── Recipe types (mirrors backend models/recipe.py, camelCase wire format) ────

export type RecipeDataType =
  | 'boolean'
  | 'integer'
  | 'float'
  | 'string'
  | 'datetime'
  | 'boolean[]'
  | 'integer[]'
  | 'float[]'
  | 'string[]'
  | 'datetime[]';

type DownloadResultKind = 'success' | 'partial' | 'failed';

/** Dynamic property fields exposed by the $recipe wrapper, scoped to a type. */
export type RecipeField = 'activeName' | 'loaded' | 'parametersChanged';

/**
 * One row of the $recipeList property source — a saved dataset flattened for a
 * data grid. `lastLoaded` reflects when that specific dataset was last
 * downloaded to variables (empty if never loaded).
 */
export interface RecipeRow {
  id: string;
  name: string;
  description: string;
  lastLoaded: string;
}

export interface RecipeParameter {
  id: string;
  label: string;
  /** Binding to a writable variable, e.g. { $var: { path: 'datasource:location' } } */
  binding: unknown;
  /** Inferred from the bound variable when the parameter is added. */
  dataType: RecipeDataType;
}

export interface RecipeDataset {
  id: string;
  name: string;
  description: string;
  /** parameterId -> value */
  values: Record<string, unknown>;
  updatedAt: string;
  updatedBy: string;
  /** Set whenever this dataset is downloaded to variables. */
  loadedAt: string;
}

export interface RecipeDatasetType {
  id: string;
  name: string;
  parameters: RecipeParameter[];
  datasets: RecipeDataset[];
}

export interface RecipeConfig {
  version: number;
  datasetTypes: RecipeDatasetType[];
}

// ── Runtime state ────────────────────────────────────────────────────────────

export interface LoadedDataset {
  datasetId: string;
  loadedAt: string;
}

export interface RecipeState {
  /** datasetTypeId -> loaded dataset pointer */
  loaded: Record<string, LoadedDataset>;
}

interface DownloadFailure {
  parameterId: string;
  reason: string;
}

export interface DownloadResult {
  result: DownloadResultKind;
  datasetId: string;
  written: number;
  total: number;
  verified: boolean;
  failures: DownloadFailure[];
}

/** Whether a data type is an array (free-length element list). */
export function isArrayDataType(dt: RecipeDataType): boolean {
  return dt.endsWith('[]');
}

/** The scalar element type of a (possibly array) data type. */
export function elementDataType(dt: RecipeDataType): RecipeDataType {
  return dt.endsWith('[]') ? (dt.slice(0, -2) as RecipeDataType) : dt;
}
