import { readHttpSource, useHttpSourceStore, type HttpRequestSpec } from './httpSourceStore';
import { useHmiStore } from './hmiStore';

const TOO_LARGE =
  'Request not sent. The data for this request is larger than 1 MB, so the device refused to send it.';

/** Every `/api/http-request` call answers with `status` (and the device's detail). */
function stubDevice(status: number) {
  const fetchMock = vi.fn(async () =>
    status === 200
      ? { ok: true, status, json: async () => ({ status: 200, ok: true, body: { v: 1 } }) }
      : {
          ok: false,
          status,
          json: async () => ({ detail: `device answered ${status}` }),
        },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let nextId = 0;

/** A spec no earlier test has primed: the store keeps one entry per spec. */
function spec(overrides: Partial<HttpRequestSpec> = {}): HttpRequestSpec {
  nextId += 1;
  return {
    url: `http://plc.local/api/${nextId}`,
    method: 'POST',
    headers: {},
    body: 'x',
    refreshMs: 0,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  // The fetch is deferred to a microtask, then awaits fetch and its json().
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

const toasts = () => useHmiStore.getState().pendingToasts;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useHmiStore.setState({ pendingToasts: [] });
  useHttpSourceStore.setState({ entries: {} });
});

describe('$http request the device refuses as too large', () => {
  it('tells the operator why nothing was sent', async () => {
    stubDevice(413);

    readHttpSource(spec());
    await settle();

    expect(toasts()).toEqual([
      expect.objectContaining({ message: TOO_LARGE, severity: 'error', discard: 'auto' }),
    ]);
  });

  it('shares one toast between sources failing together', async () => {
    stubDevice(413);

    readHttpSource(spec());
    readHttpSource(spec());
    await settle();

    expect(toasts()).toHaveLength(1);
  });

  it('does not repeat the toast on every poll of the same failing request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchMock = stubDevice(413);

    readHttpSource(spec({ refreshMs: 1000 }));
    await settle();
    useHmiStore.setState({ pendingToasts: [] });
    await vi.advanceTimersByTimeAsync(1000);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toasts()).toEqual([]);
  });

  it('leaves other failures to the source, without a toast', async () => {
    stubDevice(500);
    const request = spec();

    readHttpSource(request);
    await settle();

    expect(toasts()).toEqual([]);
    expect(readHttpSource(request)).toMatchObject({
      status: 'error',
      error: 'device answered 500',
    });
  });
});
