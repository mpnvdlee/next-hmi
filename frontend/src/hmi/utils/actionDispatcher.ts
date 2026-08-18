/**
 * Action result dispatcher.
 *
 * Async actions (loginUser, logoutUser, writeDataVariable) carry an optional
 * `onSuccess` / `onFailed` / `onSettled` list of follow-up actions. When such
 * an action is fired, `executeWidgetActions` calls `registerPending` here with
 * a freshly-generated requestId; the backend echoes the requestId on its
 * response, the WebSocket handler calls `resolvePending`, and we invoke the
 * appropriate handler list — always followed by `onSettled`.
 *
 * Pending entries are cleared on response, on timeout (10s), or on WebSocket
 * reconnect (via `flushAllAsDisconnected`). The `reason` exposed to handlers
 * via the `$result` expression follows a documented vocabulary — see
 * docs/dev/architecture/websocket.md.
 *
 * A second kind of caller has no authored handler lists at all: a widget
 * writing a variable (`useWriteVariable`) registers via `beginTrackedWrite`
 * and receives the outcome through the `onResult` callback instead.
 *
 * Cycle avoidance: this module depends on `widgetActions.executeWidgetActions`
 * to run handler arrays, and `widgetActions` depends on this module to
 * register pending requests. To avoid a TS/ESM cycle we inject the runner via
 * `registerActionRunner` at app startup.
 */

import type { ButtonAction } from '@shared/types/config';
import { generateId } from '@shared/utils/id';

type ActionRunner = (
  actions: ButtonAction[] | undefined,
  context: {
    scope?: string;
    evalCtx?: { inputScopeProps?: Record<string, unknown>; resultValue?: Record<string, unknown> };
  },
) => void;

/**
 * Direct result callback for callers that have no authored action lists —
 * widget writes via `useWriteVariable`. Fires on every termination path
 * (response, timeout, disconnect), alongside any handler lists.
 */
export type PendingResultCallback = (ok: boolean, payload: Record<string, unknown>) => void;

interface PendingEntry {
  scope: string;
  onSuccess?: ButtonAction[];
  onFailed?: ButtonAction[];
  onSettled?: ButtonAction[];
  onResult?: PendingResultCallback;
  inputScopeProps?: Record<string, unknown>;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export interface RegisterPendingArgs {
  requestId: string;
  scope: string;
  onSuccess?: ButtonAction[];
  onFailed?: ButtonAction[];
  onSettled?: ButtonAction[];
  onResult?: PendingResultCallback;
  inputScopeProps?: Record<string, unknown>;
}

const TIMEOUT_MS = 10_000;

const pending = new Map<string, PendingEntry>();
let actionRunner: ActionRunner | null = null;

export function registerActionRunner(runner: ActionRunner): void {
  actionRunner = runner;
}

export function registerPending(args: RegisterPendingArgs): void {
  const timeoutHandle = setTimeout(() => {
    resolvePending(args.requestId, { reason: 'timeout' }, false);
  }, TIMEOUT_MS);

  pending.set(args.requestId, {
    scope: args.scope,
    onSuccess: args.onSuccess,
    onFailed: args.onFailed,
    onSettled: args.onSettled,
    onResult: args.onResult,
    inputScopeProps: args.inputScopeProps,
    timeoutHandle,
  });
}

/**
 * Generate a requestId and register pending handlers when at least one of
 * onSuccess/onFailed/onSettled has actions. Returns `undefined` for
 * fire-and-forget calls — the caller omits `requestId` from the outgoing
 * message so the backend skips the response, keeping continuous-write
 * widgets (e.g. slider drag) off the timer/WS hot path.
 */
export function beginAsyncAction(
  action: {
    onSuccess?: ButtonAction[];
    onFailed?: ButtonAction[];
    onSettled?: ButtonAction[];
  },
  scope: string,
  inputScopeProps?: Record<string, unknown>,
): string | undefined {
  const hasHandlers =
    (action.onSuccess?.length ?? 0) > 0 ||
    (action.onFailed?.length ?? 0) > 0 ||
    (action.onSettled?.length ?? 0) > 0;
  if (!hasHandlers) return undefined;
  const requestId = generateId();
  registerPending({
    requestId,
    scope,
    onSuccess: action.onSuccess,
    onFailed: action.onFailed,
    onSettled: action.onSettled,
    inputScopeProps,
  });
  return requestId;
}

/**
 * Mint a requestId for a widget write and register it, with no handler lists.
 *
 * Unlike `beginAsyncAction` this never returns `undefined`: a widget has no
 * authored onSuccess/onFailed to gate on, and the correlated response is the
 * only way it can learn the write was rejected (out of range, or denied by
 * `interactableByGroups` — which the frontend cannot see up front).
 */
export function beginTrackedWrite(scope: string, onResult: PendingResultCallback): string {
  const requestId = generateId();
  registerPending({ requestId, scope, onResult });
  return requestId;
}

export function resolvePending(
  requestId: string,
  payload: Record<string, unknown>,
  ok: boolean,
): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timeoutHandle);

  runResult(entry, payload, ok);
  const branch = ok ? entry.onSuccess : entry.onFailed;
  runHandlers(branch, entry, payload);
  // onSettled always fires, even if the primary branch's actions threw.
  runHandlers(entry.onSettled, entry, payload);
}

/**
 * Fire onFailed (+ onSettled) for every pending entry. Called on WebSocket
 * close so handlers don't hang forever when the connection drops.
 */
export function flushAllAsDisconnected(): void {
  if (pending.size === 0) return;
  // Snapshot then clear before invoking handlers — handlers may fire actions
  // that register new pending entries, which must not be flushed alongside.
  const entries = Array.from(pending.values());
  pending.clear();
  for (const entry of entries) {
    clearTimeout(entry.timeoutHandle);
    runResult(entry, { reason: 'disconnected' }, false);
    runHandlers(entry.onFailed, entry, { reason: 'disconnected' });
    runHandlers(entry.onSettled, entry, { reason: 'disconnected' });
  }
}

function runResult(entry: PendingEntry, payload: Record<string, unknown>, ok: boolean): void {
  if (!entry.onResult) return;
  try {
    entry.onResult(ok, payload);
  } catch (err) {
    if (import.meta.env.DEV) {
      console.error('[actionDispatcher] Result callback threw:', err);
    }
  }
}

function runHandlers(
  actions: ButtonAction[] | undefined,
  entry: PendingEntry,
  payload: Record<string, unknown>,
): void {
  if (!actions || actions.length === 0) return;
  if (!actionRunner) {
    if (import.meta.env.DEV) {
      console.warn('[actionDispatcher] No action runner registered; handler actions dropped.');
    }
    return;
  }
  try {
    actionRunner(actions, {
      scope: entry.scope,
      evalCtx: {
        inputScopeProps: entry.inputScopeProps,
        resultValue: payload,
      },
    });
  } catch (err) {
    if (import.meta.env.DEV) {
      console.error('[actionDispatcher] Handler invocation threw:', err);
    }
  }
}

/** Test-only: reset internal state between tests. */
export function __resetForTests(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timeoutHandle);
  }
  pending.clear();
  actionRunner = null;
}
