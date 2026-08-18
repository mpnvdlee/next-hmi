import { useProjectStore } from '@shared/store/projectStore';
import { useRecipeConfigStore } from './recipeConfigStore';
import type { RecipeConfig } from '@shared/types/recipe';

const EMPTY_CONFIG: RecipeConfig = { version: 1, datasetTypes: [] };

const CONFIG_WITH_TYPE: RecipeConfig = {
  version: 1,
  datasetTypes: [
    {
      id: 't1',
      name: 'Coffee',
      parameters: [{ id: 'p1', label: 'Temp', binding: undefined, dataType: 'float' }],
      datasets: [
        {
          id: 'd1',
          name: 'Espresso',
          description: '',
          values: { p1: 92 },
          updatedAt: '',
          updatedBy: '',
          loadedAt: '',
        },
      ],
    },
  ],
};

beforeEach(() => {
  useRecipeConfigStore.setState({
    config: null,
    loaded: false,
    selection: null,
    loadError: null,
  });
  useProjectStore.setState({
    dirty: false,
    saving: false,
    saveError: null,
    past: [],
    future: [],
    _saveCallbacks: useProjectStore.getState()._saveCallbacks,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mutations', () => {
  it('addType appends a type, selects it, and marks dirty', () => {
    useRecipeConfigStore.setState({ config: EMPTY_CONFIG, loaded: true });
    useRecipeConfigStore.getState().addType('Tea');
    const { config, selection } = useRecipeConfigStore.getState();
    expect(config!.datasetTypes).toHaveLength(1);
    expect(config!.datasetTypes[0].name).toBe('Tea');
    expect(selection?.type).toBe('type');
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('addParameter appends a parameter from a picked variable', () => {
    useRecipeConfigStore.setState({ config: CONFIG_WITH_TYPE, loaded: true });
    useRecipeConfigStore.getState().addParameter('t1', {
      label: 'Speed',
      binding: { $var: { path: 'plc:speed' } },
      dataType: 'integer',
    });
    const params = useRecipeConfigStore.getState().config!.datasetTypes[0].parameters;
    expect(params).toHaveLength(2);
    expect(params[1]).toMatchObject({ label: 'Speed', dataType: 'integer' });
  });

  it('deleteParameter drops the parameter and its dataset values', () => {
    useRecipeConfigStore.setState({ config: CONFIG_WITH_TYPE, loaded: true });
    useRecipeConfigStore.getState().deleteParameter('t1', 'p1');
    const type = useRecipeConfigStore.getState().config!.datasetTypes[0];
    expect(type.parameters).toHaveLength(0);
    expect(type.datasets[0].values).toEqual({});
  });

  it('moveParameter reorders parameters', () => {
    const cfg: RecipeConfig = {
      version: 1,
      datasetTypes: [
        {
          id: 't1',
          name: 'T',
          parameters: [
            { id: 'a', label: 'A', binding: undefined, dataType: 'float' },
            { id: 'b', label: 'B', binding: undefined, dataType: 'float' },
          ],
          datasets: [],
        },
      ],
    };
    useRecipeConfigStore.setState({ config: cfg, loaded: true });
    useRecipeConfigStore.getState().moveParameter('t1', 'b', -1);
    expect(
      useRecipeConfigStore.getState().config!.datasetTypes[0].parameters.map((p) => p.id),
    ).toEqual(['b', 'a']);
  });

  it('addDataset appends a dataset and selects it', () => {
    useRecipeConfigStore.setState({ config: CONFIG_WITH_TYPE, loaded: true });
    useRecipeConfigStore.getState().addDataset('t1');
    const { config, selection } = useRecipeConfigStore.getState();
    expect(config!.datasetTypes[0].datasets).toHaveLength(2);
    expect(selection?.type).toBe('dataset');
  });

  it('setDatasetValue updates a single value', () => {
    useRecipeConfigStore.setState({ config: CONFIG_WITH_TYPE, loaded: true });
    useRecipeConfigStore.getState().setDatasetValue('t1', 'd1', 'p1', 80);
    expect(useRecipeConfigStore.getState().config!.datasetTypes[0].datasets[0].values.p1).toBe(80);
  });

  it('saveDataset persists directly to the backend without marking the project dirty', async () => {
    const fetchMock = vi.fn(async (_url: string, opts?: RequestInit) => ({
      ok: true,
      json: async () => JSON.parse(String(opts?.body)),
    }));
    vi.stubGlobal('fetch', fetchMock);
    useRecipeConfigStore.setState({ config: CONFIG_WITH_TYPE, loaded: true });

    await useRecipeConfigStore.getState().saveDataset('t1', 'd1', {
      name: 'Ristretto',
      description: 'short',
      values: { p1: 88 },
    });

    const ds = useRecipeConfigStore.getState().config!.datasetTypes[0].datasets[0];
    expect(ds).toMatchObject({ name: 'Ristretto', description: 'short', values: { p1: 88 } });
    expect(useProjectStore.getState().dirty).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/recipes/config',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('deleteType clears selection scoped to it', () => {
    useRecipeConfigStore.setState({
      config: CONFIG_WITH_TYPE,
      loaded: true,
      selection: { type: 'dataset', typeId: 't1', id: 'd1' },
    });
    useRecipeConfigStore.getState().deleteType('t1');
    expect(useRecipeConfigStore.getState().config!.datasetTypes).toHaveLength(0);
    expect(useRecipeConfigStore.getState().selection).toBeNull();
  });
});

describe('registerSave callback', () => {
  it('is registered as "recipes" in projectStore', () => {
    expect(useProjectStore.getState()._saveCallbacks.get('recipes')).toBeTruthy();
  });

  it('calls PUT /api/recipes/config with current config', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/recipes/config' && opts?.method === 'PUT') {
        return { ok: true, json: async () => CONFIG_WITH_TYPE };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    useRecipeConfigStore.setState({ config: CONFIG_WITH_TYPE, loaded: true });

    await useProjectStore.getState()._saveCallbacks.get('recipes')!();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/recipes/config',
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});
