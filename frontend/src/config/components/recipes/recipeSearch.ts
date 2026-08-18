import type { RecipeDataset, RecipeDatasetType } from '@shared/types/recipe';
import { matchesSearchWords, withDotSearchSeparators } from '@shared/utils/search';

/** The row label the tree shows for a dataset type. */
export function datasetTypeTreeLabel(type: RecipeDatasetType): string {
  return type.name || 'Untitled Type';
}

/** The row label the tree shows for a saved dataset. */
export function datasetTreeLabel(dataset: RecipeDataset): string {
  return dataset.name || 'Untitled';
}

/**
 * Filter the recipe tree against a search.
 *
 * Mirrors `filterAlarmGroups`: a type matched by name keeps all of its
 * datasets, otherwise only matching datasets survive and an empty type is
 * dropped. Query words may span the type name and the dataset name.
 * Parameters are not searched here — the centre table has its own filter.
 */
export function filterDatasetTypes(types: RecipeDatasetType[], query: string): RecipeDatasetType[] {
  if (!query.trim()) return types;
  const wordQuery = withDotSearchSeparators(query);

  const kept: RecipeDatasetType[] = [];
  for (const type of types) {
    const typeLabel = datasetTypeTreeLabel(type);
    if (matchesSearchWords(wordQuery, typeLabel)) {
      kept.push(type);
      continue;
    }
    const datasets = type.datasets.filter((dataset) =>
      matchesSearchWords(wordQuery, [typeLabel, datasetTreeLabel(dataset)]),
    );
    if (datasets.length > 0) kept.push({ ...type, datasets });
  }
  return kept;
}
