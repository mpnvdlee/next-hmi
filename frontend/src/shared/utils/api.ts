/**
 * Thin wrapper around `fetch` for our JSON HTTP API.
 *
 * - Adds `Content-Type: application/json` and serialises `body` when present.
 * - On non-2xx, throws `ApiError` with `status` + optional `code` (from the
 *   response body's ``code`` field). Use ``isApiError`` to discriminate.
 * - Returns parsed JSON for non-empty responses, `undefined` for 204.
 * - Root-relative URLs are prefixed with the runtime base so a project served
 *   under a manager project prefix (`/runtime/<slug>/` or `/editor/<slug>/`)
 *   hits the right backend.
 */

import { withBase } from './runtimeBase';

class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Error code the manager's auth gate puts on its 401 body (backend/manager.py). */
export const MANAGER_SESSION_REQUIRED = 'manager_session_required';

let sessionExpiredHandler: (() => void) | null = null;

/**
 * Register the one place that reacts to a lost manager session.
 *
 * Every gated call 401s at once when the device-admin session is missing or
 * expired, and individual callers only log the failure — so without a central
 * signal the app renders an empty project with no explanation. Handled here
 * rather than in `apiJson` so raw-`fetch` callers that build their error via
 * `apiErrorFrom` (uploads) are covered too.
 */
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

export async function apiErrorFrom(res: Response): Promise<ApiError> {
  let detail: string | undefined;
  let code: string | null = null;
  try {
    const payload = (await res.json()) as { detail?: unknown; code?: unknown };
    if (typeof payload?.detail === 'string' && payload.detail) detail = payload.detail;
    if (typeof payload?.code === 'string' && payload.code) code = payload.code;
  } catch {
    // body wasn't JSON — fall through to HTTP code
  }
  if (res.status === 401 && code === MANAGER_SESSION_REQUIRED) sessionExpiredHandler?.();
  return new ApiError(detail ?? `HTTP ${res.status}`, res.status, code);
}

/**
 * Human-readable one-liner for a caught error, for surfacing in the UI.
 * `ApiError` already carries the backend's `detail`; a failed `fetch` rejects
 * with a bare TypeError whose message ("Failed to fetch") means nothing to an
 * operator, so it gets spelled out.
 */
export function errorMessage(err: unknown): string {
  if (isApiError(err)) return err.message;
  if (err instanceof TypeError) return 'Server unreachable';
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export async function apiJson<T = unknown>(
  url: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const { method = 'GET', body, signal } = options ?? {};
  const init: RequestInit = { method, signal };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(withBase(url), init);
  if (!res.ok) throw await apiErrorFrom(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
