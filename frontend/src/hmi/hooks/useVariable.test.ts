import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '../store/variableStore';
import { useVariable, useBindingValue } from './useVariable';
import { usePropBoolean, usePropNumber, usePropString } from '../components/layoutUtils';

// A zustand hook subscribes through its vanilla store's own `subscribe`, which
// a spy on the hook's copy never sees. Counting is wrapped in before the hook
// is built, so it sees every listener — the hook's and a direct subscriber's.
vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>();
  const create = (initializer: import('zustand').StateCreator<object>) => {
    const api = zustand.createStore(initializer);
    const listeners = new Set<unknown>();
    const subscribe = api.subscribe;
    api.subscribe = (listener) => {
      listeners.add(listener);
      const unsubscribe = subscribe(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    };
    const useBoundStore = (selector?: (state: unknown) => unknown) =>
      zustand.useStore(api, selector as never);
    return Object.assign(useBoundStore, api, { listeners });
  };
  return { ...zustand, create };
});
vi.mock('./useUsersData', () => ({ useUsersData: () => [] }));

const storeListeners = (useVariableStore as unknown as { listeners: Set<unknown> }).listeners;

describe('useVariable', () => {
  beforeEach(() => {
    useVariableStore.setState({ values: {}, varMeta: {} });
  });

  it('returns undefined when the key is not in the store', () => {
    const { result } = renderHook(() => useVariable('MyPLC:Motor/Speed'));
    expect(result.current).toBeUndefined();
  });

  it('returns the current scalar value after setState', () => {
    useVariableStore.setState({ values: { 'MyPLC:Motor/Speed': 1452.3 } });
    const { result } = renderHook(() => useVariable('MyPLC:Motor/Speed'));
    expect(result.current).toBe(1452.3);
  });

  it('reflects store updates reactively', () => {
    const { result } = renderHook(() => useVariable('MyPLC:Motor/Speed'));
    expect(result.current).toBeUndefined();

    act(() => {
      useVariableStore.getState().setScalar('MyPLC:Motor/Speed', 99);
    });
    expect(result.current).toBe(99);
  });
});

describe('useBindingValue (struct[] index resolution)', () => {
  beforeEach(() => {
    useVariableStore.setState({ values: {}, varMeta: {} });
  });

  it('slices a scalar array client-side (no per-element backend key)', () => {
    useVariableStore.setState({
      values: { 'MyPLC:MyArray': [10, 20, 30] },
      varMeta: { 'MyPLC:MyArray': { type: { kind: 'scalar', base: 'Integer', array: true } } },
    });
    const { result } = renderHook(() => useBindingValue({ path: 'MyPLC:MyArray', index: 1 }));
    expect(result.current).toBe(20);
  });

  it("resolves a struct[] index to the element's own composite key", () => {
    useVariableStore.setState({
      values: {
        'MyPLC:Motors': [{ speed: 1 }, { speed: 2 }],
        'MyPLC:Motors/[1]': { speed: 2 },
      },
      varMeta: {
        'MyPLC:Motors': { type: { kind: 'struct', name: 'Motor', array: true, fields: ['speed'] } },
      },
    });
    const { result } = renderHook(() => useBindingValue({ path: 'MyPLC:Motors', index: 1 }));
    expect(result.current).toEqual({ speed: 2 });
  });

  it('does not index a non-array variable even when the cached value is array-shaped', () => {
    useVariableStore.setState({
      values: { 'MyPLC:NotAnArray': [10, 20] },
      varMeta: {
        'MyPLC:NotAnArray': {
          type: { kind: 'scalar', base: 'Integer', array: false },
        },
      },
    });
    const { result } = renderHook(() => useBindingValue({ path: 'MyPLC:NotAnArray', index: 1 }));
    expect(result.current).toBeNull();
  });

  it('rejects negative and fractional array indexes', () => {
    useVariableStore.setState({
      values: { 'MyPLC:MyArray': [10, 20] },
      varMeta: {
        'MyPLC:MyArray': {
          type: { kind: 'scalar', base: 'Integer', array: true },
        },
      },
    });
    const { result } = renderHook(() => ({
      negative: useBindingValue({ path: 'MyPLC:MyArray', index: -1 }),
      fractional: useBindingValue({ path: 'MyPLC:MyArray', index: 0.5 }),
    }));
    expect(result.current).toEqual({ negative: null, fractional: null });
  });

  it("only re-renders on the resolved element's own key changing, not the whole array", () => {
    useVariableStore.setState({
      values: {
        'MyPLC:Motors': [{ speed: 1 }, { speed: 2 }],
        'MyPLC:Motors/[0]': { speed: 1 },
        'MyPLC:Motors/[1]': { speed: 2 },
      },
      varMeta: {
        'MyPLC:Motors': { type: { kind: 'struct', name: 'Motor', array: true, fields: ['speed'] } },
      },
    });
    const { result } = renderHook(() => useBindingValue({ path: 'MyPLC:Motors', index: 0 }));
    expect(result.current).toEqual({ speed: 1 });

    act(() => {
      useVariableStore.setState((state) => ({
        values: {
          ...state.values,
          'MyPLC:Motors': [{ speed: 1 }, { speed: 99 }],
          'MyPLC:Motors/[1]': { speed: 99 },
        },
      }));
    });
    // Element [0]'s own key never changed, so the resolved value is stable.
    expect(result.current).toEqual({ speed: 1 });
  });
});

describe('useBindingValue (store listeners)', () => {
  // Every store listener runs on every flush, so the live ones are what a
  // widget's properties cost on each variable tick.
  beforeEach(() => {
    useVariableStore.setState({ values: {}, varMeta: {} });
  });

  it('registers no store listener when there is no binding', () => {
    const { result } = renderHook(() => useBindingValue(undefined));

    expect(storeListeners.size).toBe(0);
    act(() => useVariableStore.getState().setScalar('PLC:Any', 1));
    expect(result.current).toBeUndefined();
  });

  it('registers one store listener for a binding, and drops it on unmount', () => {
    const { unmount } = renderHook(() => useBindingValue({ path: 'PLC:Pump/Running' }));

    expect(storeListeners.size).toBe(1);
    unmount();
    expect(storeListeners.size).toBe(0);
  });

  it('subscribes once a binding appears and lets go when it is cleared', () => {
    useVariableStore.setState({ values: { 'PLC:Pump/Running': true } });
    const { result, rerender } = renderHook(
      ({ path }) => useBindingValue(path ? { path } : undefined),
      { initialProps: { path: '' } },
    );
    expect(storeListeners.size).toBe(0);

    rerender({ path: 'PLC:Pump/Running' });
    expect(storeListeners.size).toBe(1);
    expect(result.current).toBe(true);

    rerender({ path: '' });
    expect(storeListeners.size).toBe(0);
    expect(result.current).toBeUndefined();
  });

  it('costs usePropString / usePropBoolean / usePropNumber no listener for an unbound property', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(MemoryRouter, null, children);
    const props: Record<string, unknown> = {
      s: 'Pump',
      b: { $if: { condition: true, true: 1, false: 0 } },
      n: 3,
    };
    const { result, rerender } = renderHook(
      ({ p }) => [usePropString(p, 's'), usePropBoolean(p, 'b'), usePropNumber(p, 'n')],
      { wrapper, initialProps: { p: props } },
    );
    expect(result.current).toEqual(['Pump', true, 3]);
    expect(storeListeners.size).toBe(0);

    rerender({ p: { ...props, b: { $var: { path: 'PLC:Pump/Running' } } } });
    expect(storeListeners.size).toBe(1);
  });

  it('follows a bound value live', () => {
    const { result } = renderHook(() => useBindingValue({ path: 'PLC:Pump/Running' }));
    expect(result.current).toBeUndefined();

    act(() => useVariableStore.getState().setScalar('PLC:Pump/Running', true));
    expect(result.current).toBe(true);
    act(() => useVariableStore.getState().setScalar('PLC:Pump/Running', false));
    expect(result.current).toBe(false);
  });

  it('reads an array element once its metadata arrives, then follows it', () => {
    useVariableStore.setState({ values: { 'PLC:Temps': [20, 21] } });
    const { result } = renderHook(() => useBindingValue({ path: 'PLC:Temps', index: 1 }));
    expect(result.current).toBeNull();

    act(() =>
      useVariableStore.setState({
        varMeta: { 'PLC:Temps': { type: { kind: 'scalar', base: 'Float', array: true } } },
      }),
    );
    expect(result.current).toBe(21);
    act(() => useVariableStore.getState().setScalar('PLC:Temps', [20, 22.5]));
    expect(result.current).toBe(22.5);
  });
});
