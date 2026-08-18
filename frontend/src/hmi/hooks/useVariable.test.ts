import { renderHook, act } from '@testing-library/react';
import { useVariableStore } from '../store/variableStore';
import { useVariable, useBindingValue } from './useVariable';

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

describe('useBindingValue (§10.5 struct[] index resolution)', () => {
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
