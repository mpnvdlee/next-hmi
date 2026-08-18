import { useVariablesDomainStore } from './variablesDomainStore';

function resetStore() {
  useVariablesDomainStore.setState({
    datasources: [],
    selectedName: null,
    selectedConfig: null,
    datasourceTreeExpanded: true,
    listError: null,
    configError: null,
    actionError: null,
  });
}

describe('variablesDomainStore', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sets listError when datasource list load fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 })),
    );

    await useVariablesDomainStore.getState().loadList();

    const state = useVariablesDomainStore.getState();
    expect(state.datasources).toEqual([]);
    expect(state.listError).toBe('Could not load datasource list.');
  });

  it('aborts previous list request and keeps latest list result', async () => {
    let firstRequestAborted = false;

    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            firstRequestAborted = true;
            reject(new Error('aborted'));
          });
        });
      })
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => [
          { name: 'Second', type: 'static', connected: true, variable_count: 0, enabled_count: 0 },
        ],
      }));

    vi.stubGlobal('fetch', fetchMock);

    const p1 = useVariablesDomainStore.getState().loadList();
    const p2 = useVariablesDomainStore.getState().loadList();

    await p2;
    await p1;

    expect(firstRequestAborted).toBe(true);
    expect(useVariablesDomainStore.getState().datasources.map((ds) => ds.name)).toEqual(['Second']);
    expect(useVariablesDomainStore.getState().listError).toBeNull();
  });

  it('sets configError when selected datasource config load fails', async () => {
    useVariablesDomainStore.getState().setSelectedName('PLC-A');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503 })),
    );

    await useVariablesDomainStore.getState().loadConfig('PLC-A');

    expect(useVariablesDomainStore.getState().configError).toBe(
      'Could not load datasource "PLC-A".',
    );
  });
});
