import { describe, expect, it } from 'vitest';
import { customWidgetKey, useAdminViewStore, type CustomWidgetStatus } from './adminViewStore';

describe('customWidgetKey', () => {
  it('uses the canonical API identity for duplicate leaf names', () => {
    expect(customWidgetKey({ key: 'Inputs/Display' })).toBe('Inputs/Display');
    expect(customWidgetKey({ key: 'Other/Display' })).toBe('Other/Display');
  });
});

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

function widget(overrides: Partial<CustomWidgetStatus> = {}): CustomWidgetStatus {
  return {
    key: 'Inputs/Display',
    name: 'Display',
    group: 'Inputs',
    hasStyle: false,
    buildOk: true,
    buildError: null,
    buildTs: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

const INITIAL = useAdminViewStore.getState();

beforeEach(() => {
  useAdminViewStore.setState({
    customWidgets: [],
    subscriptions: {},
    alarmTriggers: {},
    historianPaths: {},
    runtimes: [],
    runtimesLoading: false,
    runtimesError: null,
    recompiling: [],
    recompileError: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAdminViewStore.setState(INITIAL);
});

describe('loadCustomWidgets', () => {
  it('populates customWidgets from the API', async () => {
    stubFetch({ 'GET /api/widgets': [widget()] });

    await useAdminViewStore.getState().loadCustomWidgets();

    expect(useAdminViewStore.getState().customWidgets).toEqual([widget()]);
  });

  it('leaves customWidgets untouched when the request fails', async () => {
    useAdminViewStore.setState({ customWidgets: [widget()] });
    stubFetch({ 'GET /api/widgets': { status: 500 } });

    await useAdminViewStore.getState().loadCustomWidgets();

    expect(useAdminViewStore.getState().customWidgets).toEqual([widget()]);
  });
});

describe('loadSubscriptions', () => {
  it('populates subscriptions, alarm triggers, and historian paths together', async () => {
    stubFetch({
      'GET /api/system/subscriptions': {
        plc: {
          priority_paths: ['Temp'],
          priority_leaf_paths: [],
          connected: true,
          bg_enabled: false,
        },
      },
      'GET /api/system/alarm-triggers': { plc: ['Temp'] },
      'GET /api/system/historian-paths': { plc: ['Flow'] },
    });

    await useAdminViewStore.getState().loadSubscriptions();

    const state = useAdminViewStore.getState();
    expect(state.subscriptions.plc.priority_paths).toEqual(['Temp']);
    expect(state.alarmTriggers).toEqual({ plc: ['Temp'] });
    expect(state.historianPaths).toEqual({ plc: ['Flow'] });
  });

  it('leaves state untouched when any of the three requests fails', async () => {
    stubFetch({
      'GET /api/system/subscriptions': { status: 500 },
      'GET /api/system/alarm-triggers': { plc: ['Temp'] },
      'GET /api/system/historian-paths': { plc: ['Flow'] },
    });

    await useAdminViewStore.getState().loadSubscriptions();

    expect(useAdminViewStore.getState().subscriptions).toEqual({});
    expect(useAdminViewStore.getState().alarmTriggers).toEqual({});
  });
});

describe('loadRuntimes', () => {
  it('sets runtimesLoading during the request and populates runtimes on success', async () => {
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const promise = useAdminViewStore.getState().loadRuntimes();
    expect(useAdminViewStore.getState().runtimesLoading).toBe(true);

    resolveFetch({
      ok: true,
      json: async () => ({
        runtimes: [
          {
            clientId: 'c1',
            scope: 'operator',
            username: 'op',
            groups: [],
            connectedAt: '2024-01-01T00:00:00Z',
          },
        ],
      }),
    });
    await promise;

    const state = useAdminViewStore.getState();
    expect(state.runtimesLoading).toBe(false);
    expect(state.runtimes).toHaveLength(1);
    expect(state.runtimesError).toBeNull();
  });

  it('records the error and clears loading on failure', async () => {
    stubFetch({ 'GET /api/system/runtimes': { status: 503, detail: 'unreachable' } });

    await useAdminViewStore.getState().loadRuntimes();

    const state = useAdminViewStore.getState();
    expect(state.runtimesLoading).toBe(false);
    expect(state.runtimesError).toContain('unreachable');
  });

  it('clears a previous runtimesError once a subsequent load succeeds', async () => {
    useAdminViewStore.setState({ runtimesError: 'stale error' });
    stubFetch({ 'GET /api/system/runtimes': { runtimes: [] } });

    await useAdminViewStore.getState().loadRuntimes();

    expect(useAdminViewStore.getState().runtimesError).toBeNull();
  });
});

describe('recompileAllWidgets', () => {
  it('tracks "*" as recompiling and clears it once the response lands', async () => {
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const promise = useAdminViewStore.getState().recompileAllWidgets();
    expect(useAdminViewStore.getState().recompiling).toEqual(['*']);

    resolveFetch({ ok: true, json: async () => [widget()] });
    await promise;

    expect(useAdminViewStore.getState().recompiling).toEqual([]);
    expect(useAdminViewStore.getState().customWidgets).toEqual([widget()]);
  });

  it('records recompileError and still clears the recompiling marker on failure', async () => {
    stubFetch({ 'POST /api/widgets/recompile': { status: 500, detail: 'compiler crashed' } });

    await useAdminViewStore.getState().recompileAllWidgets();

    expect(useAdminViewStore.getState().recompiling).toEqual([]);
    expect(useAdminViewStore.getState().recompileError).toContain('compiler crashed');
  });
});

describe('recompileWidget', () => {
  it('tracks the specific key as recompiling and encodes slashes in the URL', async () => {
    const calls = stubFetch({ 'POST /api/widgets/recompile/Inputs/Display': [widget()] });

    await useAdminViewStore.getState().recompileWidget('Inputs/Display');

    expect(calls).toEqual([{ url: '/api/widgets/recompile/Inputs/Display', method: 'POST' }]);
    expect(useAdminViewStore.getState().recompiling).toEqual([]);
  });

  it('does not affect the recompiling state of a different widget key', async () => {
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const promise = useAdminViewStore.getState().recompileWidget('Inputs/Display');
    expect(useAdminViewStore.getState().recompiling).toEqual(['Inputs/Display']);

    resolveFetch({ ok: true, json: async () => [widget()] });
    await promise;

    expect(useAdminViewStore.getState().recompiling).toEqual([]);
  });
});
