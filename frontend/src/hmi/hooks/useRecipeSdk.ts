/**
 * Recipe SDK handles exposed to custom components via window.__nextHMI__.
 *
 * Thin wrappers over the runtime recipeStore (fed by recipe_snapshot /
 * recipe_update WS broadcasts) and the REST download/upload endpoints.
 */

import { useMemo } from 'react';
import { useRecipeStore } from '../store/recipeStore';
import { apiJson } from '@shared/utils/api';
import type { RecipeConfig, RecipeState, DownloadResult } from '@shared/types/recipe';

/** Reactive recipe config (dataset types with parameters + saved datasets). */
export function useRecipeConfig(): RecipeConfig {
  return useRecipeStore((s) => s.config);
}

/** Reactive loaded-dataset-per-type map. */
export function useRecipeState(): RecipeState {
  const loaded = useRecipeStore((s) => s.loaded);
  return useMemo(() => ({ loaded }), [loaded]);
}

/** Download (write) a saved dataset's values to their variables. */
export function recipeDownload(
  datasetId: string,
  opts?: { verify?: boolean },
): Promise<DownloadResult> {
  return apiJson<DownloadResult>(
    `/api/recipes/datasets/${encodeURIComponent(datasetId)}/download`,
    {
      method: 'POST',
      body: { verify: opts?.verify ?? false },
    },
  );
}

/** Upload (overwrite in place) a dataset from current live values. */
export function recipeUpload(datasetId: string): Promise<RecipeConfig> {
  return apiJson<RecipeConfig>(`/api/recipes/datasets/${encodeURIComponent(datasetId)}/upload`, {
    method: 'POST',
  });
}
