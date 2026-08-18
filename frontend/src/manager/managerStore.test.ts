import { useManagerStore, type InstanceSnapshot } from './managerStore';
import { useProjectsStore } from '@config/store/projectsStore';
import { enterpriseSessionResets } from '@enterprise';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Route-table fetch stub: maps `METHOD /path` to a JSON body or a status. */
function stubFetch(routes: Record<string, unknown | { status: number; detail?: string }>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const route = routes[`${method} ${url}`];
    if (route && typeof route === 'object' && 'status' in route) {
      const failure = route as { status: number; detail?: string };
      return {
        ok: false,
        status: failure.status,
        json: async () => ({ detail: failure.detail }),
      };
    }
    return { ok: true, status: 200, json: async () => route ?? {} };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function instance(overrides: Partial<InstanceSnapshot> = {}): InstanceSnapshot {
  return {
    id: 'p1',
    name: 'Line 1',
    path: '/projects/p1',
    basePath: '/runtime/p1/',
    port: 9101,
    pid: 4242,
    status: 'running',
    startedAt: 1,
    restarts: 0,
    lastError: null,
    ...overrides,
  };
}

const INITIAL = useManagerStore.getState();

beforeEach(() => {
  useManagerStore.setState({
    auth: 'loading',
    authError: null,
    instances: {},
    systemInfo: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useManagerStore.setState(INITIAL);
  enterpriseSessionResets.length = 0;
});

describe('auth lifecycle', () => {
  it('maps the status endpoint onto the three gate states', async () => {
    const cases: Array<[{ passwordSet: boolean; authenticated: boolean }, string]> = [
      [{ passwordSet: true, authenticated: true }, 'authed'],
      [{ passwordSet: true, authenticated: false }, 'needs-login'],
      [{ passwordSet: false, authenticated: false }, 'needs-setup'],
    ];
    for (const [status, expected] of cases) {
      stubFetch({ 'GET /api/manager/auth/status': status });
      await useManagerStore.getState().refreshAuth();
      expect(useManagerStore.getState().auth).toBe(expected);
      expect(useManagerStore.getState().authError).toBeNull();
    }
  });

  it('falls back to the login gate and records the error when status fails', async () => {
    stubFetch({ 'GET /api/manager/auth/status': { status: 503, detail: 'supervisor down' } });

    await useManagerStore.getState().refreshAuth();

    expect(useManagerStore.getState().auth).toBe('needs-login');
    expect(useManagerStore.getState().authError).toBe('supervisor down');
  });

  it('setup posts the password and opens the dashboard', async () => {
    const calls = stubFetch({});
    useManagerStore.setState({ auth: 'needs-setup', authError: 'stale' });

    await useManagerStore.getState().setup('hunter2');

    expect(calls).toEqual([
      { url: '/api/manager/auth/setup', method: 'POST', body: { password: 'hunter2' } },
    ]);
    expect(useManagerStore.getState().auth).toBe('authed');
    expect(useManagerStore.getState().authError).toBeNull();
  });

  it('login clears a previous error on success', async () => {
    stubFetch({});
    useManagerStore.setState({ auth: 'needs-login', authError: 'Invalid password' });

    await useManagerStore.getState().login('hunter2');

    expect(useManagerStore.getState().auth).toBe('authed');
    expect(useManagerStore.getState().authError).toBeNull();
  });

  it('login records the error and rethrows so the form can react', async () => {
    stubFetch({ 'POST /api/manager/auth/login': { status: 401, detail: 'Invalid password' } });

    await expect(useManagerStore.getState().login('nope')).rejects.toThrow('Invalid password');

    expect(useManagerStore.getState().auth).toBe('loading');
    expect(useManagerStore.getState().authError).toBe('Invalid password');
  });

  it('logout drops every piece of authenticated device state', async () => {
    stubFetch({});
    useManagerStore.setState({ auth: 'authed', instances: { p1: instance() } });

    await useManagerStore.getState().logout();

    const state = useManagerStore.getState();
    expect(state.auth).toBe('needs-login');
    expect(state.instances).toEqual({});
  });

  it('logout also clears the state contributed through the edition seam', async () => {
    // Device state added by a build-time module is a module-level singleton
    // like this store, so it outlives sign-out unless logout reaches it. Core
    // cannot name what that state is — it only runs the seam's callbacks.
    stubFetch({});
    const reset = vi.fn();
    enterpriseSessionResets.push(reset);
    useManagerStore.setState({ auth: 'authed' });

    await useManagerStore.getState().logout();

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('a failed logout leaves the seam state alone', async () => {
    stubFetch({ 'POST /api/manager/auth/logout': { status: 502, detail: 'gone' } });
    const reset = vi.fn();
    enterpriseSessionResets.push(reset);
    useManagerStore.setState({ auth: 'authed', instances: { p1: instance() } });

    await expect(useManagerStore.getState().logout()).rejects.toThrow('gone');

    expect(reset).not.toHaveBeenCalled();
    expect(useManagerStore.getState().auth).toBe('authed');
  });

  it('changePassword posts both passwords without touching the gate state', async () => {
    const calls = stubFetch({});
    useManagerStore.setState({ auth: 'authed' });

    await useManagerStore.getState().changePassword('old', 'new');

    expect(calls[0].body).toEqual({ currentPassword: 'old', newPassword: 'new' });
    expect(useManagerStore.getState().auth).toBe('authed');
  });

  it('changePassword rejects when the current password is wrong', async () => {
    stubFetch({
      'POST /api/manager/auth/change-password': { status: 403, detail: 'Wrong password' },
    });

    await expect(useManagerStore.getState().changePassword('bad', 'new')).rejects.toThrow(
      'Wrong password',
    );
  });
});

describe('process supervision', () => {
  it('refreshRunning indexes the instance list by project id', async () => {
    stubFetch({
      'GET /api/manager/running': {
        instances: [instance(), instance({ id: 'p2', status: 'crashed' })],
      },
    });

    await useManagerStore.getState().refreshRunning();

    const { instances } = useManagerStore.getState();
    expect(Object.keys(instances)).toEqual(['p1', 'p2']);
    expect(instances.p2.status).toBe('crashed');
  });

  it('refreshRunning replaces the previous set so stopped instances disappear', async () => {
    useManagerStore.setState({ instances: { p1: instance(), p2: instance({ id: 'p2' }) } });
    stubFetch({ 'GET /api/manager/running': { instances: [instance()] } });

    await useManagerStore.getState().refreshRunning();

    expect(Object.keys(useManagerStore.getState().instances)).toEqual(['p1']);
  });

  it('start posts to the supervisor and then re-reads the running set', async () => {
    const calls = stubFetch({
      'GET /api/manager/running': { instances: [instance({ status: 'starting' })] },
    });

    await useManagerStore.getState().start('p1');

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/manager/projects/p1/start',
      'GET /api/manager/running',
    ]);
    expect(useManagerStore.getState().instances.p1.status).toBe('starting');
  });

  it('stop posts to the supervisor and then re-reads the running set', async () => {
    const calls = stubFetch({ 'GET /api/manager/running': { instances: [] } });
    useManagerStore.setState({ instances: { p1: instance() } });

    await useManagerStore.getState().stop('p1');

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/manager/projects/p1/stop',
      'GET /api/manager/running',
    ]);
    expect(useManagerStore.getState().instances).toEqual({});
  });

  it('percent-encodes the project id in supervisor URLs', async () => {
    const calls = stubFetch({ 'GET /api/manager/running': { instances: [] } });

    await useManagerStore.getState().start('line a/b');

    expect(calls[0].url).toBe('/api/manager/projects/line%20a%2Fb/start');
  });

  it('a failed start leaves the running set untouched and propagates', async () => {
    stubFetch({
      'POST /api/manager/projects/p1/start': { status: 500, detail: 'port in use' },
    });
    useManagerStore.setState({ instances: {} });

    await expect(useManagerStore.getState().start('p1')).rejects.toThrow('port in use');
    expect(useManagerStore.getState().instances).toEqual({});
  });

  it('setProjectMcp posts the flag and reloads the manifest-backed project list', async () => {
    const loadSpy = vi.spyOn(useProjectsStore.getState(), 'load').mockResolvedValue();
    const calls = stubFetch({});

    await useManagerStore.getState().setProjectMcp('p1', true);

    expect(calls[0]).toEqual({
      url: '/api/projects/p1/mcp',
      method: 'POST',
      body: { enabled: true },
    });
    expect(loadSpy).toHaveBeenCalled();
  });
});

describe('system info polling', () => {
  it('stores the snapshot on success', async () => {
    stubFetch({ 'GET /api/system/info': { uptime_seconds: 90, python: '3.13.1', pid: 42 } });

    await useManagerStore.getState().loadSystemInfo();

    expect(useManagerStore.getState().systemInfo).toEqual({
      uptime_seconds: 90,
      python: '3.13.1',
      pid: 42,
    });
  });

  it('swallows a transient supervisor outage and keeps the last snapshot', async () => {
    useManagerStore.setState({ systemInfo: { uptime_seconds: 5, python: '3.13.1', pid: 42 } });
    stubFetch({ 'GET /api/system/info': { status: 502 } });

    await expect(useManagerStore.getState().loadSystemInfo()).resolves.toBeUndefined();
    expect(useManagerStore.getState().systemInfo?.uptime_seconds).toBe(5);
  });
});
