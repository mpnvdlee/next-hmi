import { describe, expect, it } from 'vitest';
import type { RecipeDataset, RecipeDatasetType } from '@shared/types/recipe';
import { datasetTreeLabel, filterDatasetTypes } from './recipeSearch';

function dataset(id: string, name: string): RecipeDataset {
  return { id, name, description: '', values: {}, updatedAt: '', updatedBy: '', loadedAt: '' };
}

const espresso = dataset('espresso', 'Espresso');
const ristretto = dataset('ristretto', 'Ristretto');
const rinse = dataset('rinse', 'Rinse Cycle');

const brew: RecipeDatasetType = {
  id: 'brew',
  name: 'Brew',
  parameters: [{ id: 'temp', label: 'Temp', binding: undefined, dataType: 'float' }],
  datasets: [espresso, ristretto],
};
const clean: RecipeDatasetType = {
  id: 'clean',
  name: 'Cleaning',
  parameters: [],
  datasets: [rinse],
};
const types = [brew, clean];

describe('datasetTreeLabel', () => {
  it('falls back to Untitled for an unnamed dataset', () => {
    expect(datasetTreeLabel(dataset('x', ''))).toBe('Untitled');
  });
});

describe('filterDatasetTypes', () => {
  it('returns the input untouched for an empty query', () => {
    expect(filterDatasetTypes(types, '  ')).toBe(types);
  });

  it('keeps every dataset of a type matched by name', () => {
    expect(filterDatasetTypes(types, 'brew')).toEqual([brew]);
  });

  it('keeps only the datasets that matched inside an unmatched type', () => {
    const result = filterDatasetTypes(types, 'ristretto');
    expect(result).toHaveLength(1);
    expect(result[0].datasets).toEqual([ristretto]);
  });

  it('spans the type name and the dataset name', () => {
    const result = filterDatasetTypes(types, 'cleaning rinse');
    expect(result).toHaveLength(1);
    expect(result[0].datasets).toEqual([rinse]);
  });

  it('does not match on a parameter label — the centre table filters those', () => {
    expect(filterDatasetTypes(types, 'temp')).toEqual([]);
  });

  it('drops types nothing matched in', () => {
    expect(filterDatasetTypes(types, 'grind')).toEqual([]);
  });
});
