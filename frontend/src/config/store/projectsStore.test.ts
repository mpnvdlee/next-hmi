import { useProjectsStore, describeError, type ProjectEntry } from './projectsStore';

interface Call {
  url: string;
  method: string;
}

function stubFetch(routes: Record<string, unknown | { status: number; detail?: string }>) {
  const calls: Call[] = [];
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

function project(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: 'p1',
    name: 'Line 1',
    path: '/projects/p1',
    addedAt: '2024-01-01T00:00:00Z',
    lastOpenedAt: null,
    status: 'present',
    inProjectsRoot: true,
    isDefault: false,
    mcpEnabled: false,
    credentialsStatus: 'ok',
    credentialsError: null,
    formatVersion: null,
    minAppVersion: null,
    needsUpgrade: false,
    unsupportedFormat: false,
    lastMigration: null,
    thumbnailUpdatedAt: null,
    ...overrides,
  };
}

const INITIAL = useProjectsStore.getState();

beforeEach(() => {
  useProjectsStore.setState({
    projects: [],
    defaultProjectId: null,
    defaultProjectsRoot: null,
    runtimeHome: null,
    loading: false,
    error: null,
    busyProjectId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useProjectsStore.setState(INITIAL);
});

describe('load', () => {
  it('populates the project list and default id', async () => {
    stubFetch({
      'GET /api/projects': {
        defaultProjectId: 'p1',
        defaultProjectsRoot: '/projects',
        projects: [project(), project({ id: 'p2', name: 'Line 2', status: 'missing' })],
      },
    });

    await useProjectsStore.getState().load();

    const state = useProjectsStore.getState();
    expect(state.projects).toHaveLength(2);
    expect(state.defaultProjectId).toBe('p1');
    expect(state.defaultProjectsRoot).toBe('/projects');
    expect(state.loading).toBe(false);
  });

  it('flags loading true while in flight and false once resolved', async () => {
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

    const loadPromise = useProjectsStore.getState().load();
    expect(useProjectsStore.getState().loading).toBe(true);

    resolveFetch({
      ok: true,
      json: async () => ({ defaultProjectId: null, defaultProjectsRoot: null, projects: [] }),
    });
    await loadPromise;

    expect(useProjectsStore.getState().loading).toBe(false);
  });

  it('records the error and stops loading on failure', async () => {
    stubFetch({ 'GET /api/projects': { status: 500, detail: 'manifest corrupt' } });

    await useProjectsStore.getState().load();

    const state = useProjectsStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBe('manifest corrupt');
  });

  it('distinguishes present vs missing project status', async () => {
    stubFetch({
      'GET /api/projects': {
        defaultProjectId: null,
        defaultProjectsRoot: null,
        projects: [
          project({ id: 'p1', status: 'present' }),
          project({ id: 'p2', status: 'missing' }),
        ],
      },
    });

    await useProjectsStore.getState().load();

    const byId = Object.fromEntries(
      useProjectsStore.getState().projects.map((p) => [p.id, p.status]),
    );
    expect(byId).toEqual({ p1: 'present', p2: 'missing' });
  });
});

describe('default project selection', () => {
  it('setDefault posts to the API and reloads the project list', async () => {
    const calls = stubFetch({
      'GET /api/projects': {
        defaultProjectId: 'p1',
        defaultProjectsRoot: null,
        projects: [project({ id: 'p1', isDefault: true })],
      },
    });

    await useProjectsStore.getState().setDefault('p1');

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/projects/p1/default',
      'GET /api/projects',
    ]);
    expect(useProjectsStore.getState().defaultProjectId).toBe('p1');
    expect(useProjectsStore.getState().busyProjectId).toBeNull();
  });

  it('clears busyProjectId even when the request fails', async () => {
    stubFetch({ 'POST /api/projects/p1/default': { status: 500, detail: 'nope' } });

    await expect(useProjectsStore.getState().setDefault('p1')).rejects.toThrow('nope');

    expect(useProjectsStore.getState().busyProjectId).toBeNull();
  });
});

describe('peer discovery', () => {
  it('loadPeers returns the discovered and manual peer lists', async () => {
    stubFetch({
      'GET /api/manager/peers/discovered': {
        discovered: [{ name: 'line-2', host: '10.0.0.2', port: 8000, source: 'mdns' }],
        manual: [{ name: 'line-3', host: '10.0.0.3', port: 8000, source: 'manual' }],
        ownRuntimeId: 'r1',
      },
    });

    const result = await useProjectsStore.getState().loadPeers();

    expect(result?.discovered).toHaveLength(1);
    expect(result?.manual).toHaveLength(1);
    expect(result?.ownRuntimeId).toBe('r1');
  });

  it('loadPeers returns null and swallows the error when the request fails', async () => {
    stubFetch({ 'GET /api/manager/peers/discovered': { status: 500 } });

    const result = await useProjectsStore.getState().loadPeers();

    expect(result).toBeNull();
  });

  function stubFetchWithBodies() {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );
    return calls;
  }

  it('addManualPeer posts host, port and name', async () => {
    const calls = stubFetchWithBodies();

    await useProjectsStore.getState().addManualPeer('10.0.0.4', 8000, 'line-4');

    expect(calls).toEqual([
      {
        url: '/api/manager/peers/manual',
        method: 'POST',
        body: { host: '10.0.0.4', port: 8000, name: 'line-4', scheme: 'http' },
      },
    ]);
  });

  it('addManualPeer stores the peer protocol when it serves HTTPS', async () => {
    const calls = stubFetchWithBodies();

    await useProjectsStore.getState().addManualPeer('10.0.0.4', 8443, 'line-4', 'https');

    expect(calls[0].body).toEqual({
      host: '10.0.0.4',
      port: 8443,
      name: 'line-4',
      scheme: 'https',
    });
  });

  it('forgetPeerCertificate drops the pin by host and port', async () => {
    const calls = stubFetch({});

    await useProjectsStore.getState().forgetPeerCertificate('10.0.0.4', 8443);

    expect(calls).toEqual([
      {
        url: '/api/manager/peers/trust?host=10.0.0.4&port=8443',
        method: 'DELETE',
      },
    ]);
  });

  it('removeManualPeer deletes by host and port query params', async () => {
    const calls = stubFetch({});

    await useProjectsStore.getState().removeManualPeer('10.0.0.4', 8000);

    expect(calls).toEqual([
      { url: '/api/manager/peers/manual?host=10.0.0.4&port=8000', method: 'DELETE' },
    ]);
  });
});

describe('clearError', () => {
  it('resets the error field', () => {
    useProjectsStore.setState({ error: 'boom' });

    useProjectsStore.getState().clearError();

    expect(useProjectsStore.getState().error).toBeNull();
  });
});

describe('describeError', () => {
  it('unwraps ApiError-shaped messages', async () => {
    stubFetch({ 'GET /api/projects': { status: 404, detail: 'not found' } });
    await useProjectsStore.getState().load();
    expect(useProjectsStore.getState().error).toBe('not found');
  });

  it('falls back to a generic Error message', () => {
    expect(describeError(new Error('plain failure'))).toBe('plain failure');
  });

  it('stringifies non-Error values', () => {
    expect(describeError('raw string')).toBe('raw string');
  });

  it('maps a failed fetch to something readable, via the shared helper', () => {
    // A rejected `fetch` (offline, DNS failure, CORS) throws a bare
    // `TypeError` whose own message — "Failed to fetch" — meant nothing to an
    // operator until this reused `errorMessage`'s mapping instead of
    // duplicating it.
    expect(describeError(new TypeError('Failed to fetch'))).toBe('Server unreachable');
  });
});

// The editor is served under /editor/<slug>/, where the manager proxies every
// base-prefixed path to the child project instance — which serves no manager
// API. Peer calls must therefore stay at the origin, where the manager is.
describe('manager calls from a proxied project instance', () => {
  afterEach(() => {
    delete window.__NEXTHMI_BASE__;
  });

  it('keeps peer pairing, discovery and transfers at the origin under an /editor/<slug>/ base', async () => {
    window.__NEXTHMI_BASE__ = '/editor/p1/';
    const calls = stubFetch({
      'GET /api/manager/peers/discovered': { discovered: [], manual: [] },
      'POST /api/manager/peer-pair': { token: 'tok' },
      // No `status` key — stubFetch reads that as an HTTP failure.
      'POST /api/manager/transfers': { transferId: 'tx-1', phase: 'packing' },
    });

    await useProjectsStore.getState().loadPeers();
    await useProjectsStore.getState().pairPeer('10.0.0.4', 8000, 'pw', 'http');
    await useProjectsStore.getState().beginPeerTransfer({
      sourceProjectId: 'p1',
      destinationProjectId: 'p1',
      destinationFolder: 'Line 1',
      peerHost: '10.0.0.4',
      peerPort: 8000,
      peerScheme: 'http',
      token: 'tok',
      collisionPolicy: 'reject',
      confirmReplace: false,
      start: false,
      transferId: 'tx-1',
    });

    expect(calls.map((c) => c.url)).toEqual([
      '/api/manager/peers/discovered',
      '/api/manager/peer-pair',
      '/api/manager/transfers',
    ]);
  });
});
