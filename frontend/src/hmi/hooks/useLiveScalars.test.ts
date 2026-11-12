import { renderHook, act } from '@testing-library/react';
import { useVariableStore, type VarMeta } from '../store/variableStore';
import { useLiveKeys, useLiveScalars } from './useLiveScalars';

describe('useLiveScalars', () => {
  beforeEach(() => {
    useVariableStore.setState({ values: {} });
  });

  it('does not re-render when an unsubscribed variable changes', () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      useLiveScalars(['PLC:a']);
    });
    expect(renders).toBe(1);

    act(() => {
      useVariableStore.getState().setScalar('PLC:b', 123);
    });
    expect(renders).toBe(1);
  });

  it('re-renders when a subscribed variable changes', () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      useLiveScalars(['PLC:a']);
    });
    expect(renders).toBe(1);

    act(() => {
      useVariableStore.getState().setScalar('PLC:a', 1);
    });
    expect(renders).toBe(2);
  });

  it('does not re-render when a subscribed variable is set to the same value', () => {
    useVariableStore.setState({ values: { 'PLC:a': 5 } });
    let renders = 0;
    renderHook(() => {
      renders++;
      useLiveScalars(['PLC:a']);
    });
    expect(renders).toBe(1);

    act(() => {
      useVariableStore.getState().setScalar('PLC:a', 5);
    });
    expect(renders).toBe(1);
  });

  it('returns a signature that changes only when a subscribed value changes', () => {
    const { result } = renderHook(() => useLiveScalars(['PLC:a']));
    const first = result.current;

    act(() => {
      useVariableStore.getState().setScalar('PLC:b', 9);
    });
    expect(result.current).toBe(first);

    act(() => {
      useVariableStore.getState().setScalar('PLC:a', 7);
    });
    expect(result.current).not.toBe(first);
  });

  it('never re-renders for an empty key list', () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      useLiveScalars([]);
    });
    act(() => {
      useVariableStore.getState().setScalar('PLC:a', 1);
    });
    expect(renders).toBe(1);
  });
});

describe('useLiveKeys', () => {
  const setMeta = (meta: Record<string, unknown>) =>
    useVariableStore.setState({ varMeta: meta as Record<string, VarMeta> });
  const motor = { kind: 'struct', name: 'Motor', array: true, fields: ['Speed'] };

  it('does not re-render on new metadata when every index falls in a scalar array', () => {
    const zones = { type: { kind: 'scalar', base: 'Integer', array: true } };
    setMeta({ 'PLC:Zones': zones });
    const value = { a: { $var: { path: 'PLC:Zones', index: 3 } } };
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useLiveKeys(value);
    });
    act(() => setMeta({ 'PLC:Zones': zones }));
    expect(renders).toBe(1);
    expect(result.current).toEqual(['PLC:Zones']);
  });

  it('adds a struct element once the metadata naming it arrives', () => {
    setMeta({});
    const value = { a: { $var: { path: 'PLC:Motors', index: 1 } } };
    const { result } = renderHook(() => useLiveKeys(value));
    expect(result.current).toEqual(['PLC:Motors']);
    act(() =>
      setMeta({
        'PLC:Motors': { type: motor },
        'PLC:Motors/[2]': { type: { ...motor, array: false }, position: 1 },
      }),
    );
    expect(result.current).toEqual(['PLC:Motors', 'PLC:Motors/[2]']);
  });

  it('does not re-render on new metadata naming the same struct element', () => {
    const page = {
      'PLC:Motors': { type: motor },
      'PLC:Motors/[2]': { type: { ...motor, array: false }, position: 1 },
    };
    setMeta({ ...page });
    const value = { a: { $var: { path: 'PLC:Motors', index: 1 } } };
    let renders = 0;
    renderHook(() => {
      renders++;
      return useLiveKeys(value);
    });
    act(() => setMeta({ ...page }));
    expect(renders).toBe(1);
  });
});
