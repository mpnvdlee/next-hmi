import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTests,
  beginTrackedWrite,
  flushAllAsDisconnected,
  registerActionRunner,
  registerPending,
  resolvePending,
} from './actionDispatcher';
import { generateId } from '@shared/utils/id';
import type { ButtonAction } from '@shared/types/config';

const closeDialog: ButtonAction = { type: 'closeDialog' };
const showToast: ButtonAction = {
  type: 'showToast',
  message: 'x',
  severity: 'info',
  discard: 'auto',
};

interface RunnerCall {
  actions: ButtonAction[];
  scope?: string;
  inputScopeProps?: Record<string, unknown>;
  resultValue?: Record<string, unknown>;
}

type CapturedRunner = (
  actions: ButtonAction[] | undefined,
  ctx: {
    scope?: string;
    evalCtx?: { inputScopeProps?: Record<string, unknown>; resultValue?: Record<string, unknown> };
  },
) => void;

function captureRunner(): { runner: CapturedRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: CapturedRunner = (actions, ctx) => {
    calls.push({
      actions: actions ?? [],
      scope: ctx?.scope,
      inputScopeProps: ctx?.evalCtx?.inputScopeProps,
      resultValue: ctx?.evalCtx?.resultValue,
    });
  };
  return { runner, calls };
}

describe('actionDispatcher', () => {
  beforeEach(() => {
    __resetForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetForTests();
  });

  it('routes resolvePending(ok=true) to onSuccess + onSettled in order', () => {
    const { runner, calls } = captureRunner();
    registerActionRunner(runner);

    const requestId = generateId();
    registerPending({
      requestId,
      scope: 's',
      onSuccess: [closeDialog],
      onFailed: [showToast],
      onSettled: [closeDialog],
    });

    resolvePending(requestId, { username: 'op1' }, true);

    expect(calls).toHaveLength(2);
    expect(calls[0].actions).toEqual([closeDialog]);
    expect(calls[0].resultValue).toEqual({ username: 'op1' });
    expect(calls[1].actions).toEqual([closeDialog]); // onSettled
  });

  it('routes resolvePending(ok=false) to onFailed + onSettled', () => {
    const { runner, calls } = captureRunner();
    registerActionRunner(runner);

    const requestId = generateId();
    registerPending({
      requestId,
      scope: 's',
      onSuccess: [closeDialog],
      onFailed: [showToast],
      onSettled: [closeDialog],
    });

    resolvePending(requestId, { reason: 'invalid_credentials' }, false);

    expect(calls).toHaveLength(2);
    expect(calls[0].actions).toEqual([showToast]);
    expect(calls[0].resultValue).toEqual({ reason: 'invalid_credentials' });
    expect(calls[1].actions).toEqual([closeDialog]); // onSettled fires for failure too
  });

  it('correlates by requestId — resolving one entry leaves others pending', () => {
    const { runner, calls } = captureRunner();
    registerActionRunner(runner);

    const idA = generateId();
    const idB = generateId();
    registerPending({ requestId: idA, scope: 's', onSuccess: [closeDialog] });
    registerPending({ requestId: idB, scope: 's', onSuccess: [showToast] });

    resolvePending(idA, {}, true);

    expect(calls).toHaveLength(1);
    expect(calls[0].actions).toEqual([closeDialog]);

    // Resolving an unknown id is a no-op
    resolvePending('unknown', {}, true);
    expect(calls).toHaveLength(1);

    resolvePending(idB, {}, true);
    expect(calls).toHaveLength(2);
    expect(calls[1].actions).toEqual([showToast]);
  });

  it('does nothing if onSuccess/onFailed/onSettled are all empty', () => {
    const { runner, calls } = captureRunner();
    registerActionRunner(runner);

    const requestId = generateId();
    registerPending({ requestId, scope: 's' });
    resolvePending(requestId, {}, true);

    expect(calls).toHaveLength(0);
  });

  it('fires onFailed (reason: timeout) + onSettled after 10s', () => {
    const { runner, calls } = captureRunner();
    registerActionRunner(runner);

    const requestId = generateId();
    registerPending({
      requestId,
      scope: 's',
      onFailed: [showToast],
      onSettled: [closeDialog],
    });

    vi.advanceTimersByTime(9_999);
    expect(calls).toHaveLength(0);

    vi.advanceTimersByTime(2);

    expect(calls).toHaveLength(2);
    expect(calls[0].actions).toEqual([showToast]);
    expect(calls[0].resultValue).toEqual({ reason: 'timeout' });
    expect(calls[1].actions).toEqual([closeDialog]);
  });

  it('clears the timeout when resolvePending arrives in time', () => {
    const { runner, calls } = captureRunner();
    registerActionRunner(runner);

    const requestId = generateId();
    registerPending({ requestId, scope: 's', onSuccess: [closeDialog], onFailed: [showToast] });

    resolvePending(requestId, {}, true);
    expect(calls).toHaveLength(1);

    // Advance past the timeout — the entry should already be gone.
    vi.advanceTimersByTime(60_000);
    expect(calls).toHaveLength(1);
  });

  it('flushAllAsDisconnected fires onFailed(reason: disconnected) + onSettled for every entry', () => {
    const { runner, calls } = captureRunner();
    registerActionRunner(runner);

    const idA = generateId();
    const idB = generateId();
    registerPending({
      requestId: idA,
      scope: 's',
      onFailed: [showToast],
      onSettled: [closeDialog],
    });
    registerPending({ requestId: idB, scope: 's', onFailed: [showToast] });

    flushAllAsDisconnected();

    // 2 onFailed + 1 onSettled = 3 runner invocations
    expect(calls).toHaveLength(3);
    expect(calls[0].resultValue).toEqual({ reason: 'disconnected' });
    expect(calls[1].resultValue).toEqual({ reason: 'disconnected' });
    // After flushing, subsequent resolves are no-ops
    resolvePending(idA, {}, true);
    expect(calls).toHaveLength(3);
  });

  it('passes inputScopeProps through to the runner', () => {
    const { runner, calls } = captureRunner();
    registerActionRunner(runner);

    const requestId = generateId();
    registerPending({
      requestId,
      scope: 'runtime:tab1:inst1',
      onSuccess: [closeDialog],
      inputScopeProps: { dialogProp: 42 },
    });

    resolvePending(requestId, {}, true);

    expect(calls[0].inputScopeProps).toEqual({ dialogProp: 42 });
    expect(calls[0].scope).toBe('runtime:tab1:inst1');
  });

  it('still fires onSettled when onSuccess handler throws', () => {
    const calls: RunnerCall[] = [];
    let firstCall = true;
    const runner: CapturedRunner = (actions, ctx) => {
      calls.push({
        actions: actions ?? [],
        scope: ctx?.scope,
        resultValue: ctx?.evalCtx?.resultValue,
      });
      if (firstCall) {
        firstCall = false;
        throw new Error('boom');
      }
    };
    registerActionRunner(runner);
    // Silence the expected dev-mode error log
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const requestId = generateId();
    registerPending({
      requestId,
      scope: 's',
      onSuccess: [closeDialog],
      onSettled: [showToast],
    });

    resolvePending(requestId, {}, true);

    expect(calls).toHaveLength(2);
    expect(calls[1].actions).toEqual([showToast]);

    errorSpy.mockRestore();
  });

  it('beginTrackedWrite always mints an id and routes the outcome to onResult', () => {
    const seen: { ok: boolean; payload: Record<string, unknown> }[] = [];
    const requestId = beginTrackedWrite('s', (ok, payload) => seen.push({ ok, payload }));

    expect(requestId).toBeTruthy();

    resolvePending(requestId, { reason: 'permission_denied' }, false);

    expect(seen).toEqual([{ ok: false, payload: { reason: 'permission_denied' } }]);

    // Resolved entries are gone — the 10s timer must not fire a second time.
    vi.advanceTimersByTime(60_000);
    expect(seen).toHaveLength(1);
  });

  it('fires onResult with reason timeout, and again for every entry on disconnect', () => {
    const timedOut: Record<string, unknown>[] = [];
    beginTrackedWrite('s', (_ok, payload) => timedOut.push(payload));
    vi.advanceTimersByTime(10_001);
    expect(timedOut).toEqual([{ reason: 'timeout' }]);

    const dropped: Record<string, unknown>[] = [];
    beginTrackedWrite('s', (_ok, payload) => dropped.push(payload));
    beginTrackedWrite('s', (_ok, payload) => dropped.push(payload));
    flushAllAsDisconnected();
    expect(dropped).toEqual([{ reason: 'disconnected' }, { reason: 'disconnected' }]);
  });

  it('still runs handler lists when an onResult callback throws', () => {
    const { runner, calls } = captureRunner();
    registerActionRunner(runner);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const requestId = generateId();
    registerPending({
      requestId,
      scope: 's',
      onResult: () => {
        throw new Error('boom');
      },
      onSuccess: [closeDialog],
    });

    resolvePending(requestId, {}, true);

    expect(calls).toHaveLength(1);
    expect(calls[0].actions).toEqual([closeDialog]);
    errorSpy.mockRestore();
  });

  it('warns in dev when no runner has been registered', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // No registerActionRunner call

    const requestId = generateId();
    registerPending({ requestId, scope: 's', onSuccess: [closeDialog] });
    resolvePending(requestId, {}, true);

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
