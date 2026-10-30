import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorFrom,
  apiJson,
  apiNdjson,
  createNdjsonDecoder,
  isApiError,
  MANAGER_SESSION_REQUIRED,
  setProjectUnavailableHandler,
  setSessionExpiredHandler,
} from './api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  setSessionExpiredHandler(null);
  setProjectUnavailableHandler(null);
  vi.unstubAllGlobals();
});

/**
 * The two halves of what the custom-widget SDK declares for `apiJson`
 * (`custom-widgets-sdk.d.ts`): a `204` resolves `undefined` — which is why the
 * declared return type is `T | undefined` — and a non-2xx throws a value
 * `isApiError` recognises, the guard a widget author has to discriminate with.
 */
describe('apiJson', () => {
  it('resolves undefined for a 204', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiJson('/api/thing', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('throws an ApiError carrying status and code on a non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(403, { detail: 'Nope', code: 'denied' })),
    );

    const err = await apiJson('/api/thing').catch((e: unknown) => e);

    expect(isApiError(err)).toBe(true);
    if (!isApiError(err)) return;
    expect(err.status).toBe(403);
    expect(err.code).toBe('denied');
  });

  it('does not claim a failed fetch as an ApiError', () => {
    expect(isApiError(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('apiErrorFrom', () => {
  it('carries the backend detail and code', async () => {
    const err = await apiErrorFrom(jsonResponse(409, { detail: 'Nope', code: 'busy' }));
    expect(err.message).toBe('Nope');
    expect(err.status).toBe(409);
    expect(err.code).toBe('busy');
  });

  it('falls back to the HTTP code when the body is not JSON', async () => {
    const err = await apiErrorFrom(new Response('boom', { status: 500 }));
    expect(err.message).toBe('HTTP 500');
  });

  it('signals a lost manager session on the gate 401', async () => {
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    await apiErrorFrom(jsonResponse(401, { detail: 'x', code: MANAGER_SESSION_REQUIRED }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('leaves a project-user 401 alone', async () => {
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    await apiErrorFrom(jsonResponse(401, { detail: 'invalid_credentials' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves the gate 401 alone on a public live view', async () => {
    // A /runtime/<slug>/ document never held a manager session, so that 401 is
    // a call reaching past the public runtime surface — any custom widget can
    // make one through the SDK's `apiJson` — not a signed-out operator. The
    // overlay would blank a panel that is working.
    vi.stubGlobal('__NEXTHMI_BASE__', '/runtime/plant-a/');
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    await apiErrorFrom(jsonResponse(401, { detail: 'x', code: MANAGER_SESSION_REQUIRED }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('still signals a lost session on the gate 401 in the editor', async () => {
    vi.stubGlobal('__NEXTHMI_BASE__', '/editor/plant-a/');
    const handler = vi.fn();
    setSessionExpiredHandler(handler);
    await apiErrorFrom(jsonResponse(401, { detail: 'x', code: MANAGER_SESSION_REQUIRED }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('still signals an absent project backend on a 503 in a live view', async () => {
    // Only the session overlay is suppressed there — a live view whose child
    // is down must still explain itself.
    vi.stubGlobal('__NEXTHMI_BASE__', '/runtime/plant-a/');
    const handler = vi.fn();
    setProjectUnavailableHandler(handler);
    await apiErrorFrom(jsonResponse(503, { detail: 'Project is not running' }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('signals an absent project backend on a 503', async () => {
    const handler = vi.fn();
    setProjectUnavailableHandler(handler);
    await apiErrorFrom(jsonResponse(503, { detail: 'Project is not running' }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('leaves every other failure to its caller', async () => {
    const handler = vi.fn();
    setProjectUnavailableHandler(handler);
    await apiErrorFrom(jsonResponse(500, { detail: 'boom' }));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('createNdjsonDecoder', () => {
  const enc = new TextEncoder();

  it('holds a line the transport cut in half until its newline arrives', () => {
    const decoder = createNdjsonDecoder();
    expect(decoder.push(enc.encode('{"a":1}\n{"b":'))).toEqual([{ a: 1 }]);
    expect(decoder.push(enc.encode('2}\n'))).toEqual([{ b: 2 }]);
  });

  it('reassembles a multi-byte character split across chunks', () => {
    const bytes = enc.encode('{"name":"Füllstand"}\n');
    const cut = bytes.indexOf(0xc3) + 1; // inside the two-byte "ü"
    const decoder = createNdjsonDecoder();
    expect(decoder.push(bytes.slice(0, cut))).toEqual([]);
    expect(decoder.push(bytes.slice(cut))).toEqual([{ name: 'Füllstand' }]);
  });

  it('hands over a last line sent without a newline on flush', () => {
    const decoder = createNdjsonDecoder();
    expect(decoder.push(enc.encode('{"a":1}\n{"done":true}'))).toEqual([{ a: 1 }]);
    expect(decoder.flush()).toEqual([{ done: true }]);
  });

  it('skips blank lines', () => {
    const decoder = createNdjsonDecoder();
    expect(decoder.push(enc.encode('\n{"a":1}\n\n'))).toEqual([{ a: 1 }]);
    expect(decoder.flush()).toEqual([]);
  });
});

describe('apiNdjson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls back once per line, in order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"n":1}\n{"n":2}\n{"n":3}\n', { status: 200 })),
    );
    const seen: unknown[] = [];

    await apiNdjson('/api/stream', (line) => seen.push(line));

    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('raises an HTTP failure before the stream like apiJson does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(503, { detail: "Datasource 'PLC' is not connected" })),
    );

    const error = await apiNdjson('/api/stream', () => {}).catch((e: unknown) => e);

    expect(isApiError(error)).toBe(true);
    expect((error as Error).message).toBe("Datasource 'PLC' is not connected");
  });
});
