import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVariableStore } from '../store/variableStore';
import { useHmiStore } from '../store/hmiStore';
import { __resetForTests, resolvePending } from '../utils/actionDispatcher';
import { sendWsMessage } from './useWebSocket';
import { useWriteVariable, type WriteVariableOptions } from './useWriteVariable';

vi.mock('./useWebSocket', () => ({ sendWsMessage: vi.fn() }));

function frames(): Record<string, unknown>[] {
  return vi.mocked(sendWsMessage).mock.calls.map((c) => c[0] as Record<string, unknown>);
}

function writer(properties: Record<string, unknown>, options?: WriteVariableOptions) {
  return renderHook(() => useWriteVariable(properties, 'variable', options)).result.current;
}

const bound = { variable: { $var: { path: 'PLC:Motor/Speed' } } };

describe('useWriteVariable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
    useVariableStore.setState({ values: {}, varMeta: {} });
    useHmiStore.setState({ pendingToasts: [] });
  });

  afterEach(() => {
    __resetForTests();
  });

  it('is a no-op when the property carries no binding', () => {
    writer({ variable: 42 })(1);
    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  it('sends a correlated write_field frame on the current scope', () => {
    writer(bound)(12);

    expect(frames()).toEqual([
      {
        type: 'write_field',
        requestId: expect.any(String),
        scope: 'runtime:preview',
        datasource: 'PLC',
        path: 'Motor/Speed',
        value: 12,
      },
    ]);
  });

  it('coerces a scalar against its metadata before sending', () => {
    useVariableStore.setState({
      varMeta: { 'PLC:Motor/Speed': { type: { kind: 'scalar', base: 'Integer', array: false } } },
    });

    writer(bound)('7');

    expect(frames()[0].value).toBe(7);
  });

  // `base` is a simple type, so `Float` covers Double as well. Keying the
  // coercion matrix with it directly narrows to float32 and rejects any value
  // `Math.fround` cannot round-trip — every fractional setpoint write.
  it('sends a fractional value against a Float variable', () => {
    useVariableStore.setState({
      varMeta: { 'PLC:Motor/Speed': { type: { kind: 'scalar', base: 'Float', array: false } } },
    });

    writer(bound)(19.9);

    expect(frames()[0].value).toBe(19.9);
  });

  // Same reasoning on the integer side: bare `integer` carries int32 bounds, so
  // a legitimate Int64 write would be rejected before the backend sees it.
  it('sends an integer beyond the int32 ceiling', () => {
    useVariableStore.setState({
      varMeta: { 'PLC:Motor/Speed': { type: { kind: 'scalar', base: 'Integer', array: false } } },
    });

    writer(bound)(3000000000);

    expect(frames()[0].value).toBe(3000000000);
  });

  it('rejects an out-of-range scalar locally and toasts once', () => {
    useVariableStore.setState({
      varMeta: {
        'PLC:Motor/Speed': {
          type: { kind: 'scalar', base: 'Integer', array: false },
          min: 0,
          max: 10,
        },
      },
    });

    const write = writer(bound);
    write(50);
    write(60);

    expect(sendWsMessage).not.toHaveBeenCalled();
    const toasts = useHmiStore.getState().pendingToasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe('error');
  });

  it('range-checks a struct field but never type-coerces it', () => {
    useVariableStore.setState({
      varMeta: {
        'PLC:Motor/Speed': {
          type: { kind: 'struct', name: 'Setpoint', array: false, fields: ['fValue'] },
          fieldRanges: { fValue: { min: 0, max: 100 } },
        },
      },
    });

    const write = writer(bound);
    write(150, { field: 'fValue' });
    expect(sendWsMessage).not.toHaveBeenCalled();

    // Struct fields have no dataType in VarMeta — an in-range value must pass
    // through rather than fail the coercion matrix as `unknown_type`.
    write(42, { field: 'fValue' });
    expect(frames()).toEqual([
      expect.objectContaining({ field: 'fValue', value: 42, requestId: expect.any(String) }),
    ]);
  });

  it('appends the [N] suffix for an indexed binding', () => {
    useVariableStore.setState({
      varMeta: {
        'PLC:Motor/Speed': { type: { kind: 'scalar', base: 'Integer', array: true, length: 4 } },
      },
    });

    writer({ variable: { $var: { path: 'PLC:Motor/Speed', index: 2 } } })(9);

    expect(frames()[0]).toMatchObject({ path: 'Motor/Speed[2]', value: 9 });
  });

  it('toasts the backend rejection correlated by requestId', () => {
    writer(bound)(1);

    resolvePending(String(frames()[0].requestId), { reason: 'permission_denied' }, false);

    expect(useHmiStore.getState().pendingToasts[0].message).toMatch(/not allowed/i);
  });

  it('reports canWrite only for a $var binding', () => {
    expect(writer(bound).canWrite).toBe(true);
    expect(writer({ variable: { $static: true } }).canWrite).toBe(false);
    expect(writer({}).canWrite).toBe(false);
  });

  // Every tracked write costs a pending-map entry, a 10 s timer and a response
  // frame — what a continuous writer (slider drag) opts out of.
  it('registers no pending timer and omits the requestId when tracked is false', () => {
    vi.useFakeTimers();
    try {
      const untracked = writer(bound, { tracked: false });
      const baseline = vi.getTimerCount();

      untracked(3);
      expect(frames()[0]).not.toHaveProperty('requestId');
      expect(vi.getTimerCount()).toBe(baseline);

      writer(bound)(4);
      expect(frames()[1].requestId).toEqual(expect.any(String));
      expect(vi.getTimerCount()).toBe(baseline + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours onError: silent and the callback form', () => {
    useVariableStore.setState({
      varMeta: {
        'PLC:Motor/Speed': {
          type: { kind: 'scalar', base: 'Integer', array: false },
          min: 0,
          max: 10,
        },
      },
    });

    writer(bound, { onError: 'silent' })(99);
    expect(useHmiStore.getState().pendingToasts).toHaveLength(0);

    const reasons: string[] = [];
    writer(bound, { onError: (reason) => reasons.push(reason) })(99);
    expect(reasons).toEqual(['value_out_of_range']);
    expect(useHmiStore.getState().pendingToasts).toHaveLength(0);
  });
});
