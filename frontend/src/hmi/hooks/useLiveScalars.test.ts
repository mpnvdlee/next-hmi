import { renderHook, act } from '@testing-library/react';
import { useVariableStore } from '../store/variableStore';
import { useLiveScalars } from './useLiveScalars';

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
