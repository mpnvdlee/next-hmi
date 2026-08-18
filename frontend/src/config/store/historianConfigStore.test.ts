import { useProjectStore } from '@shared/store/projectStore';
import { useHistorianConfigStore } from './historianConfigStore';

const EMPTY_CONFIG = { variables: {} };

const CONFIG_WITH_VAR = {
  variables: {
    'plc:temp': { enabled: true, minInterval: 1, retention: 2592000 },
  },
};

const STATUS = {
  dbSizeBytes: 1024,
  variableCount: 1,
  totalSamples: 10,
  oldestSample: '2024-01-01T00:00:00Z',
  newestSample: '2024-01-02T00:00:00Z',
};

/** Route-table fetch stub: maps `METHOD /path` to a JSON body or a failure status. */
function stubFetch(routes: Record<string, unknown | { status: number; detail?: string }>) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const route = routes[`${method} ${url}`];
    if (route && typeof route === 'object' && 'status' in route) {
      const failure = route as { status: number; detail?: string };
      return { ok: false, status: failure.status, json: async () => ({ detail: failure.detail }) };
    }
    return { ok: true, status: 200, json: async () => route ?? {} };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  useHistorianConfigStore.setState({ config: null, status: null, availableVars: [] });
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

describe('load', () => {
  it('populates config, available variables and status from the backend', async () => {
    stubFetch({
      'GET /api/historian/config': CONFIG_WITH_VAR,
      'GET /api/historian/available-variables': ['plc:temp', 'plc:pressure'],
      'GET /api/historian/status': STATUS,
    });

    await useHistorianConfigStore.getState().load();

    const state = useHistorianConfigStore.getState();
    expect(state.config).toEqual(CONFIG_WITH_VAR);
    expect(state.availableVars).toEqual(['plc:temp', 'plc:pressure']);
    expect(state.status).toEqual(STATUS);
  });

  it('skips re-fetching config when already loaded with unsaved local changes, but refreshes status', async () => {
    useHistorianConfigStore.setState({ config: CONFIG_WITH_VAR, availableVars: ['plc:temp'] });
    useProjectStore.setState({ dirty: true });
    const calls = stubFetch({ 'GET /api/historian/status': STATUS });

    await useHistorianConfigStore.getState().load();

    expect(calls).toEqual([{ url: '/api/historian/status', method: 'GET' }]);
    expect(useHistorianConfigStore.getState().status).toEqual(STATUS);
  });

  it('still refreshes status after a config load failure', async () => {
    stubFetch({
      'GET /api/historian/config': { status: 500, detail: 'db down' },
      'GET /api/historian/status': STATUS,
    });

    await useHistorianConfigStore.getState().load();

    expect(useHistorianConfigStore.getState().config).toBeNull();
    expect(useHistorianConfigStore.getState().status).toEqual(STATUS);
  });

  it('leaves status null when the status refresh also fails', async () => {
    stubFetch({
      'GET /api/historian/config': CONFIG_WITH_VAR,
      'GET /api/historian/available-variables': ['plc:temp'],
      'GET /api/historian/status': { status: 500 },
    });

    await useHistorianConfigStore.getState().load();

    expect(useHistorianConfigStore.getState().status).toBeNull();
    expect(useHistorianConfigStore.getState().config).toEqual(CONFIG_WITH_VAR);
  });
});

describe('save', () => {
  it('PUTs the current config, replaces it with the server response, and refreshes status', async () => {
    useHistorianConfigStore.setState({ config: CONFIG_WITH_VAR });
    const savedConfig = { variables: { ...CONFIG_WITH_VAR.variables } };
    const calls = stubFetch({
      'PUT /api/historian/config': savedConfig,
      'GET /api/historian/status': STATUS,
    });

    await useHistorianConfigStore.getState().save();

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PUT /api/historian/config',
      'GET /api/historian/status',
    ]);
    expect(useHistorianConfigStore.getState().config).toEqual(savedConfig);
    expect(useHistorianConfigStore.getState().status).toEqual(STATUS);
  });

  it('is a no-op when there is no config to save', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await useHistorianConfigStore.getState().save();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('draft edits', () => {
  beforeEach(() => {
    useHistorianConfigStore.setState({ config: EMPTY_CONFIG });
  });

  it('addVariable inserts the default config and marks the project dirty', () => {
    useHistorianConfigStore.getState().addVariable('plc:temp');

    expect(useHistorianConfigStore.getState().config?.variables['plc:temp']).toEqual({
      enabled: true,
      minInterval: 1,
      retention: 2592000,
    });
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('addVariable does nothing for an empty key', () => {
    useHistorianConfigStore.getState().addVariable('');

    expect(useHistorianConfigStore.getState().config?.variables).toEqual({});
    expect(useProjectStore.getState().dirty).toBe(false);
  });

  it('removeVariable drops the entry and marks the project dirty', () => {
    useHistorianConfigStore.setState({ config: CONFIG_WITH_VAR });

    useHistorianConfigStore.getState().removeVariable('plc:temp');

    expect(useHistorianConfigStore.getState().config?.variables).toEqual({});
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('toggleVariable flips enabled and marks the project dirty', () => {
    useHistorianConfigStore.setState({ config: CONFIG_WITH_VAR });

    useHistorianConfigStore.getState().toggleVariable('plc:temp');

    expect(useHistorianConfigStore.getState().config?.variables['plc:temp'].enabled).toBe(false);
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('toggleVariable is a no-op for a key that is not configured', () => {
    useHistorianConfigStore.getState().toggleVariable('plc:missing');

    expect(useHistorianConfigStore.getState().config?.variables).toEqual({});
    expect(useProjectStore.getState().dirty).toBe(false);
  });
});

describe('registerSave callback', () => {
  it('is registered as "historian" in projectStore', () => {
    expect(useProjectStore.getState()._saveCallbacks.get('historian')).toBeTruthy();
  });

  it('calls save() when invoked', async () => {
    useHistorianConfigStore.setState({ config: CONFIG_WITH_VAR });
    const calls = stubFetch({
      'PUT /api/historian/config': CONFIG_WITH_VAR,
      'GET /api/historian/status': STATUS,
    });

    await useProjectStore.getState()._saveCallbacks.get('historian')!();

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PUT /api/historian/config',
      'GET /api/historian/status',
    ]);
  });
});
