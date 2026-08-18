import { useDeviceInfoStore } from './deviceInfoStore';

const INITIAL = useDeviceInfoStore.getState();

beforeEach(() => {
  useDeviceInfoStore.setState(INITIAL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetch', () => {
  it('populates info from the response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ip: '10.0.0.5', hostname: 'plc-01', mac: 'aa:bb:cc' }),
      })),
    );

    await useDeviceInfoStore.getState().fetch();

    const state = useDeviceInfoStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.info).toEqual({
      hostname: 'plc-01',
      ipAddress: '10.0.0.5',
      macAddress: 'aa:bb:cc',
    });
  });

  it('fetches only once even when called twice in sequence', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ip: '10.0.0.5', hostname: 'plc-01', mac: 'aa:bb:cc' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await useDeviceInfoStore.getState().fetch();
    await useDeviceInfoStore.getState().fetch();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch while a request is already in flight', async () => {
    let resolveFetch!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = useDeviceInfoStore.getState().fetch();
    const second = useDeviceInfoStore.getState().fetch();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch({
      ok: true,
      json: async () => ({ ip: '10.0.0.5', hostname: 'plc-01', mac: 'aa:bb:cc' }),
    });
    await first;
    await second;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useDeviceInfoStore.getState().loaded).toBe(true);
  });

  it('falls back to null fields and marks loaded when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );

    await useDeviceInfoStore.getState().fetch();

    expect(useDeviceInfoStore.getState()).toMatchObject({
      loaded: true,
      info: { hostname: null, ipAddress: null, macAddress: null },
    });
  });

  it('falls back to null fields and marks loaded when the fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await useDeviceInfoStore.getState().fetch();

    expect(useDeviceInfoStore.getState()).toMatchObject({
      loaded: true,
      info: { hostname: null, ipAddress: null, macAddress: null },
    });
  });
});
