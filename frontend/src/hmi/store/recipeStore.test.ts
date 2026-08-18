import { useRecipeStore } from './recipeStore';
import { useVariableStore } from './variableStore';
import type { RecipeConfig } from '@shared/types/recipe';

const CONFIG: RecipeConfig = {
  version: 1,
  datasetTypes: [
    {
      id: 'coffee',
      name: 'Coffee',
      parameters: [
        { id: 'temp', label: 'Temp', binding: { $var: { path: 'DS:Temp' } }, dataType: 'float' },
        {
          id: 'steps',
          label: 'Steps',
          binding: { $var: { path: 'DS:Steps' } },
          dataType: 'integer[]',
        },
      ],
      datasets: [
        {
          id: 'espresso',
          name: 'Espresso',
          description: '',
          values: { temp: 92, steps: [1, 2, 3] },
          updatedAt: '',
          updatedBy: '',
          loadedAt: '',
        },
      ],
    },
  ],
};

beforeEach(() => {
  useRecipeStore.setState({
    config: { version: 1, datasetTypes: [] },
    loaded: {},
    lastResult: null,
  });
  useVariableStore.setState({ values: {} } as never);
});

function setLive(values: Record<string, unknown>) {
  useVariableStore.setState({ values } as never);
}

describe('getField', () => {
  it('loaded reflects whether the type has a loaded dataset', () => {
    useRecipeStore.getState().setSnapshot(CONFIG, {}, null);
    expect(useRecipeStore.getState().getField('coffee', 'loaded')).toBe(false);

    useRecipeStore
      .getState()
      .setSnapshot(CONFIG, { coffee: { datasetId: 'espresso', loadedAt: 'now' } }, null);
    expect(useRecipeStore.getState().getField('coffee', 'loaded')).toBe(true);
  });

  it('activeName returns the loaded dataset name', () => {
    useRecipeStore
      .getState()
      .setSnapshot(CONFIG, { coffee: { datasetId: 'espresso', loadedAt: 'now' } }, null);
    expect(useRecipeStore.getState().getField('coffee', 'activeName')).toBe('Espresso');
  });

  it('parametersChanged is false when live matches stored (arrays element-wise)', () => {
    setLive({ 'DS:Temp': 92, 'DS:Steps': [1, 2, 3] });
    useRecipeStore
      .getState()
      .setSnapshot(CONFIG, { coffee: { datasetId: 'espresso', loadedAt: 'now' } }, null);
    expect(useRecipeStore.getState().getField('coffee', 'parametersChanged')).toBe(false);
  });

  it('parametersChanged is true when a scalar differs', () => {
    setLive({ 'DS:Temp': 90, 'DS:Steps': [1, 2, 3] });
    useRecipeStore
      .getState()
      .setSnapshot(CONFIG, { coffee: { datasetId: 'espresso', loadedAt: 'now' } }, null);
    expect(useRecipeStore.getState().getField('coffee', 'parametersChanged')).toBe(true);
  });

  it('parametersChanged is true when an array element differs', () => {
    setLive({ 'DS:Temp': 92, 'DS:Steps': [1, 9, 3] });
    useRecipeStore
      .getState()
      .setSnapshot(CONFIG, { coffee: { datasetId: 'espresso', loadedAt: 'now' } }, null);
    expect(useRecipeStore.getState().getField('coffee', 'parametersChanged')).toBe(true);
  });

  it('parametersChanged is false when nothing is loaded', () => {
    useRecipeStore.getState().setSnapshot(CONFIG, {}, null);
    expect(useRecipeStore.getState().getField('coffee', 'parametersChanged')).toBe(false);
  });
});

const MULTI: RecipeConfig = {
  version: 1,
  datasetTypes: [
    {
      id: 'coffee',
      name: 'Coffee',
      parameters: [],
      datasets: [
        {
          id: 'espresso',
          name: 'Espresso',
          description: 'Strong',
          values: {},
          updatedAt: '',
          updatedBy: '',
          loadedAt: '2026-07-01T00:00:00Z',
        },
        {
          id: 'lungo',
          name: 'Lungo',
          description: '',
          values: {},
          updatedAt: '',
          updatedBy: '',
          loadedAt: '',
        },
      ],
    },
    {
      id: 'tea',
      name: 'Tea',
      parameters: [],
      datasets: [
        {
          id: 'green',
          name: 'Green',
          description: '',
          values: {},
          updatedAt: '',
          updatedBy: '',
          loadedAt: '',
        },
      ],
    },
  ],
};

describe('getList', () => {
  it("maps a type's datasets to grid rows", () => {
    useRecipeStore.getState().setSnapshot(MULTI, {}, null);
    expect(useRecipeStore.getState().getList('coffee')).toEqual([
      {
        id: 'espresso',
        name: 'Espresso',
        description: 'Strong',
        lastLoaded: '2026-07-01T00:00:00Z',
      },
      { id: 'lungo', name: 'Lungo', description: '', lastLoaded: '' },
    ]);
  });

  it("reflects each dataset's own lastLoaded, independent of the type's current load pointer", () => {
    useRecipeStore
      .getState()
      .setSnapshot(
        MULTI,
        { coffee: { datasetId: 'lungo', loadedAt: '2026-07-03T00:00:00Z' } },
        null,
      );
    const rows = useRecipeStore.getState().getList('coffee');
    // lungo isn't stamped in this fixture's config, so it stays '' even though it's the active load.
    expect(rows.find((r) => r.id === 'lungo')?.lastLoaded).toBe('');
    // espresso keeps its own recorded lastLoaded even though it's no longer the active load.
    expect(rows.find((r) => r.id === 'espresso')?.lastLoaded).toBe('2026-07-01T00:00:00Z');
  });

  it('flattens every type when typeId is empty', () => {
    useRecipeStore.getState().setSnapshot(MULTI, {}, null);
    expect(
      useRecipeStore
        .getState()
        .getList('')
        .map((r) => r.id),
    ).toEqual(['espresso', 'lungo', 'green']);
  });

  it('returns [] for an unknown type', () => {
    useRecipeStore.getState().setSnapshot(MULTI, {}, null);
    expect(useRecipeStore.getState().getList('nope')).toEqual([]);
  });
});
