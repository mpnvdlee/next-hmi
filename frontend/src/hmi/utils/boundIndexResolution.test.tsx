import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useVariableStore } from '../store/variableStore';
import { useComponentPropStore } from '../store/widgetPropStore';
import { InputScopeContext } from '../context/InputScopeContext';
import { useBoundIndexes, useScopedProperties } from '../hooks/useResolvedProperties';
import { storesReadBy, useEvalContext } from '../hooks/useEvalContext';
import {
  collectBoundIndexes,
  substituteBoundIndexes,
  substituteMemberLeaves,
} from './boundIndexResolution';
import { evaluatePropertyValue } from './propertySourceEval';
import { extractVarKeys } from './extractVarKeys';

const OPEN = 'CF:Safety/Open';

/** The properties as WidgetRenderer hands them to its widget. */
function useResolvedProperties(properties: Record<string, unknown>) {
  const scoped = useScopedProperties(properties);
  return useBoundIndexes(scoped, useEvalContext(storesReadBy(scoped)));
}

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

  it('follows an index another widget publishes', () => {
    const props = {
      value: {
        $var: { path: OPEN, index: { $widgetProp: { componentId: 'grid', property: 'row' } } },
      },
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter>{children}</MemoryRouter>
    );
    const { result } = renderHook(() => useResolvedProperties(props), { wrapper });
    act(() => useComponentPropStore.getState().setComponentProp('grid', 'row', 2));
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

describe('a member of a struct-array element an input passes', () => {
  const S = { kind: 'struct', name: 'Motor', array: true, fields: ['sName'] };
  const STRING = { type: { kind: 'scalar', base: 'String', array: false } };
  // A TwinCAT array counting from 1: position 1 is `Motors[2]`.
  const META = {
    'PLC:Motors': { type: S },
    'PLC:Motors/Motors[1]': { type: { ...S, array: false }, position: 0 },
    'PLC:Motors/Motors[1]/sName': STRING,
    'PLC:Motors/Motors[2]': { type: { ...S, array: false }, position: 1 },
    'PLC:Motors/Motors[2]/sName': STRING,
  };
  const sName = (path: string) => ({ $var: { path } });
  function render(device: unknown) {
    const props = { text: { $componentProp: 'device/sName' } };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <InputScopeContext.Provider value={{ properties: { device } } as never}>
          {children}
        </InputScopeContext.Provider>
      </MemoryRouter>
    );
    return renderHook(() => useResolvedProperties(props), { wrapper });
  }

  it("binds the member's own leaf once the metadata names the element", () => {
    useVariableStore.setState({ values: {}, varMeta: {} });
    const { result } = render({ $var: { path: 'PLC:Motors', index: 1 } });
    expect(result.current?.text).toEqual({ $var: { path: 'PLC:Motors/sName', index: 1 } });

    act(() => useVariableStore.setState({ varMeta: META as never }));
    expect(result.current?.text).toEqual(sName('PLC:Motors/Motors[2]/sName'));
  });

  it('follows the element a bound index selects', () => {
    useVariableStore.setState({ values: { 'CF:Selected': 1 }, varMeta: META as never });
    const { result } = render({
      $var: { path: 'PLC:Motors', index: { $var: { path: 'CF:Selected' } } },
    });
    expect(result.current?.text).toEqual(sName('PLC:Motors/Motors[2]/sName'));

    act(() => useVariableStore.setState({ values: { 'CF:Selected': 0 } }));
    expect(result.current?.text).toEqual(sName('PLC:Motors/Motors[1]/sName'));
  });

  it('leaves every other $var, and a widget node in a property, alone', () => {
    const child = {
      id: 'c',
      type: 'Label',
      properties: { text: { $var: { path: 'PLC:Motors/sName', index: 0 } } },
    };
    const props = {
      member: { $var: { path: 'PLC:Motors/sName', index: 0, bit: 2 } },
      element: { $var: { path: 'PLC:Motors', index: 0 } },
      past: { $var: { path: 'PLC:Motors/sName', index: 5 } },
      widgets: [child],
    };
    const out = substituteMemberLeaves(props, META) as typeof props;
    expect(out.member).toEqual({ $var: { path: 'PLC:Motors/Motors[1]/sName', bit: 2 } });
    expect(out.element).toBe(props.element);
    expect(out.past).toBe(props.past);
    expect(out.widgets).toBe(props.widgets);
  });
});
