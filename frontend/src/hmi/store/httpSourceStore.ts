import { create } from 'zustand';
import { apiJson, errorMessage } from '@shared/utils/api';

/**
 * Response cache behind the `$http` property source.
 *
 * `$http` is an asynchronous source read from a synchronous evaluator, so the
 * evaluator never fetches: it calls {@link readHttpSource} with the fully
 * templated request, gets whatever is cached right now (`undefined` on the very
 * first read), and the store fetches in the background. Widgets holding an
 * `$http` source subscribe via `useHttpTick`, so the value lands on the next
 * render.
 *
 * Requests are keyed by their resolved url/method/headers/body, so two widgets
 * hitting the same endpoint share one request — and a `{1}` placeholder that
 * changes (a selected device id, say) is simply a different key with its own
 * entry. The JSON extraction path is deliberately *not* part of the key: two
 * widgets reading different fields of one response still share the fetch.
 *
 * The browser cannot call a plant REST service directly (CORS), so every
 * request goes through the backend proxy at `/api/http-request`.
 */

export interface HttpRequestSpec {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  /** 0 = fetch once and keep serving the cached response. */
  refreshMs: number;
}

export interface HttpEntry {
  status: 'loading' | 'ok' | 'error';
  /** Decoded response body — JSON when the endpoint returned JSON, else text. */
  data?: unknown;
  error?: string;
  fetchedAt: number;
}

interface HttpSourceStore {
  entries: Record<string, HttpEntry>;
}

export const useHttpSourceStore = create<HttpSourceStore>(() => ({ entries: {} }));

/** Live specs, one per key. A key is dropped once nothing reads it any more. */
const specs = new Map<string, HttpRequestSpec>();
const lastReadAt = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * How long after the last read a polled entry keeps refreshing. Generous
 * relative to the interval so a slow render or a hidden tab doesn't drop the
 * poll, but bounded so navigating away eventually stops the traffic.
 */
const IDLE_GRACE_MS = 60_000;

export function httpRequestKey(spec: HttpRequestSpec): string {
  return JSON.stringify([spec.method, spec.url, spec.headers, spec.body ?? null, spec.refreshMs]);
}

/**
 * Read the cached response for `spec`, priming the request on first read.
 * Safe to call during render: the fetch is deferred to a microtask so the store
 * is never written while React is rendering.
 */
export function readHttpSource(spec: HttpRequestSpec): HttpEntry | undefined {
  const key = httpRequestKey(spec);
  lastReadAt.set(key, Date.now());
  if (!specs.has(key)) {
    specs.set(key, spec);
    queueMicrotask(() => runFetch(key));
  }
  return useHttpSourceStore.getState().entries[key];
}

function setEntry(key: string, entry: HttpEntry): void {
  useHttpSourceStore.setState((s) => ({ entries: { ...s.entries, [key]: entry } }));
}

async function runFetch(key: string): Promise<void> {
  const spec = specs.get(key);
  if (!spec) return;

  const previous = useHttpSourceStore.getState().entries[key];
  if (!previous) setEntry(key, { status: 'loading', fetchedAt: 0 });

  try {
    const res = await apiJson<{ status: number; ok: boolean; body: unknown; error?: string }>(
      '/api/http-request',
      {
        method: 'POST',
        body: {
          url: spec.url,
          method: spec.method,
          headers: spec.headers,
          body: spec.body,
        },
      },
    );
    if (res.ok) {
      setEntry(key, { status: 'ok', data: res.body, fetchedAt: Date.now() });
    } else {
      setEntry(key, {
        status: 'error',
        // Keep the last good value visible through a transient failure rather
        // than blanking the field — the status still reads 'error'.
        data: previous?.data,
        error: res.error ?? `HTTP ${res.status}`,
        fetchedAt: Date.now(),
      });
    }
  } catch (err) {
    setEntry(key, {
      status: 'error',
      data: previous?.data,
      error: errorMessage(err),
      fetchedAt: Date.now(),
    });
  } finally {
    scheduleNext(key, spec);
  }
}

function scheduleNext(key: string, spec: HttpRequestSpec): void {
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.delete(key);

  if (spec.refreshMs <= 0) return;

  const idleFor = Date.now() - (lastReadAt.get(key) ?? 0);
  if (idleFor > spec.refreshMs + IDLE_GRACE_MS) {
    // Nothing is reading this any more — stop polling and forget the spec so a
    // later read re-primes it from scratch.
    specs.delete(key);
    lastReadAt.delete(key);
    return;
  }

  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void runFetch(key);
    }, spec.refreshMs),
  );
}

