import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useVariableStore } from '../store/variableStore';
import { InputScopeContext } from '../context/InputScopeContext';
import { useResolvedProperties } from '../hooks/useResolvedProperties';
import { collectBoundIndexes, substituteBoundIndexes } from './boundIndexResolution';
import { evaluatePropertyValue } from './propertySourceEval';
import { extractVarKeys } from './extractVarKeys';

const OPEN = 'CF:Safety/Open';

describe('bound $var index', () => {
  beforeEach(() => {
    useVariableStore.setState({
      values: { [OPEN]: [false, true, false, true], 'CF:Selected': 1 },
      varMeta: {},
    });
  });

  it('reads the element its source names', () => {
    const value = { $var: { path: OPEN, index: { $componentProp: 'device' } } };
    const ctx = {
      resolveVariable: (ds: string, p: string) =>
        useVariableStore.getState().values[`${ds}:${p}`] as never,
      inputScopeProps: { device: 3 },
    };
    expect(evaluatePropertyValue(value, ctx)).toBe(true);
    // No index from the dialog: no element, never the whole array.
    expect(evaluatePropertyValue(value, { ...ctx, inputScopeProps: {} })).toBeNull();
  });

  it('subscribes to a variable used as the index', () => {
    const value = { $var: { path: OPEN, index: { $var: { path: 'CF:Selected' } } } };
    expect(extractVarKeys(value)).toEqual([OPEN, 'CF:Selected']);
  });

  it('rewrites bound indexes and leaves widget nodes in a property alone', () => {
    const child = {
      id: 'c',
      type: 'Label',
      properties: { text: { $var: { path: OPEN, index: { $repeatItem: { field: 'index' } } } } },
    };
    const props = {
      value: { $var: { path: OPEN, index: { $componentProp: 'device' } } },
      fixed: { $var: { path: OPEN, index: 2 } },
      widgets: [child],
    };
    expect(collectBoundIndexes(props)).toEqual([{ $componentProp: 'device' }]);
    const out = substituteBoundIndexes(props, () => 3) as typeof props;
    expect(out.value).toEqual({ $var: { path: OPEN, index: 3 } });
    expect(out.fixed).toBe(props.fixed);
    expect(out.widgets[0]).toBe(child);
  });

  it('follows the index as the variable it reads changes', () => {
    const props = { value: { $var: { path: OPEN, index: { $var: { path: 'CF:Selected' } } } } };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter>{children}</MemoryRouter>
    );
    const { result } = renderHook(() => useResolvedProperties(props), { wrapper });
    expect(result.current?.value).toEqual({ $var: { path: OPEN, index: 1 } });

    act(() => {
      useVariableStore.setState({
        values: { ...useVariableStore.getState().values, 'CF:Selected': 2 },
      });
    });
    expect(result.current?.value).toEqual({ $var: { path: OPEN, index: 2 } });
  });

  it("resolves a dialog's input parameter as the index", () => {
    const props = { value: { $var: { path: OPEN, index: { $componentProp: 'device' } } } };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <InputScopeContext.Provider value={{ properties: { device: 3 } } as never}>
          {children}
        </InputScopeContext.Provider>
      </MemoryRouter>
    );
    const { result } = renderHook(() => useResolvedProperties(props), { wrapper });
    expect(result.current?.value).toEqual({ $var: { path: OPEN, index: 3 } });
  });
});
