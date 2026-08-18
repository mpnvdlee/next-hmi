import { describe, expect, it, beforeEach, vi } from 'vitest';

// `$user` on a record-list field reads the project's account list, which
// `useEvalContext` pulls from the session-cached `/api/users` document. Stub it
// so the hook under test doesn't depend on a fetch.
vi.mock('../hooks/useUsersData', () => ({
  useUsersData: () => [
    { id: 1, username: 'admin' },
    { id: 2, username: 'operator1' },
  ],
}));
import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  containerLayoutStyle,
  collectComponentPriorityKeys,
  selfLayoutStyle,
  layoutHasPropertySource,
  useResolvedLayout,
  useRecordListProp,
  usePropVar,
} from './layoutUtils';
import type { WidgetConfig } from '@shared/types/config';
import { useVariableStore } from '../store/variableStore';
import { useRecipeStore } from '../store/recipeStore';
import { useComponentPropStore } from '../store/widgetPropStore';
import type { RecipeConfig } from '@shared/types/recipe';

describe('selfLayoutStyle', () => {
  it('returns undefined when no layout is provided', () => {
    expect(selfLayoutStyle(undefined)).toBeUndefined();
  });

  it('returns undefined when layout is empty', () => {
    expect(selfLayoutStyle({})).toBeUndefined();
  });

  it('emits CSS custom properties for flex-self sizing fields', () => {
    const style = selfLayoutStyle({
      basis: '200px',
      grow: 1,
      shrink: 0,
      alignSelf: 'stretch',
      minWidth: '100px',
      maxWidth: '400px',
      minHeight: '80px',
    });

    expect(style).toEqual({
      '--self-basis': '200px',
      '--self-grow': 1,
      '--self-shrink': 0,
      '--self-align': 'stretch',
      '--self-min-width': '100px',
      '--self-max-width': '400px',
      '--self-min-height': '80px',
    });
  });

  it('emits width and height as plain CSS properties', () => {
    const style = selfLayoutStyle({
      width: '320px',
      height: '180px',
    });

    expect(style).toMatchObject({
      width: '320px',
      height: '180px',
    });
  });

  it('emits margin shorthand and per-side margin as plain CSS properties', () => {
    const style = selfLayoutStyle({
      margin: '0.5rem',
      marginTop: '4px',
      marginRight: '8px',
      marginBottom: '4px',
      marginLeft: '8px',
    });

    expect(style).toMatchObject({
      margin: '0.5rem',
      marginTop: '4px',
      marginRight: '8px',
      marginBottom: '4px',
      marginLeft: '8px',
    });
  });
});

describe('containerLayoutStyle', () => {
  it('returns undefined when no layout is provided', () => {
    expect(containerLayoutStyle(undefined)).toBeUndefined();
  });

  it('returns undefined when layout is empty', () => {
    expect(containerLayoutStyle({})).toBeUndefined();
  });

  it('emits the --container-* vars for the kept fields', () => {
    const style = containerLayoutStyle({
      direction: 'column',
      gap: '0.5rem',
      wrap: true,
      align: 'center',
      justify: 'space-between',
    });

    expect(style).toMatchObject({
      '--container-direction': 'column',
      '--container-gap': '0.5rem',
      '--container-wrap': 'wrap',
      '--container-align': 'center',
      '--container-justify': 'space-between',
    });
  });

  it('encodes wrap=false as nowrap', () => {
    const style = containerLayoutStyle({ wrap: false });
    expect(style).toMatchObject({ '--container-wrap': 'nowrap' });
  });

  it('emits padding shorthand and per-side padding as plain CSS properties', () => {
    const style = containerLayoutStyle({
      padding: '0.5rem',
      paddingTop: '4px',
      paddingRight: '8px',
      paddingBottom: '4px',
      paddingLeft: '8px',
    });

    expect(style).toMatchObject({
      padding: '0.5rem',
      paddingTop: '4px',
      paddingRight: '8px',
      paddingBottom: '4px',
      paddingLeft: '8px',
    });
  });

  it('emits self-sizing fields alongside container vars', () => {
    const style = containerLayoutStyle({
      direction: 'row',
      width: '100%',
      margin: '0',
    });

    expect(style).toMatchObject({
      '--container-direction': 'row',
      width: '100%',
      margin: '0',
    });
  });
});

// Custom properties inherit. `selfLayoutStyle` / `containerLayoutStyle` emit
// only the fields an author actually set, so any `--self-*` / `--container-*`
// left unset would otherwise inherit an ancestor widget's value instead of
// falling back to the default the layout panel advertises (a container nested
// in a `column` parent silently rendering as a column). Each stylesheet that
// reads one of these vars therefore resets it to `initial` on the same element.
// This guard fails when a new var is consumed but not added to that reset.
describe('inherited layout vars are reset where they are consumed', () => {
  const files = {
    'hmi.css': '../styles/hmi.css',
    'WidgetRenderer.css': './WidgetRenderer.css',
    // The Container is a stdlib widget now — same guard, source moved.
    'stdlib Container/style.css': '../../../widgets/Layout/Container/style.css',
  };

  function varNames(css: string, re: RegExp): Set<string> {
    return new Set([...css.matchAll(re)].map((m) => m[1]));
  }

  for (const [label, rel] of Object.entries(files)) {
    it(`${label} resets every --self-* / --container-* var it reads`, async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const css = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

      const consumed = varNames(css, /var\((--(?:self|container)-[a-z-]+)/g);
      const reset = varNames(css, /(--(?:self|container)-[a-z-]+)\s*:\s*initial/g);

      expect(consumed.size).toBeGreaterThan(0);
      expect([...consumed].filter((v) => !reset.has(v))).toEqual([]);
    });
  }
});

describe('layoutHasPropertySource', () => {
  it('is false for undefined, empty, or all-plain layouts', () => {
    expect(layoutHasPropertySource(undefined)).toBe(false);
    expect(layoutHasPropertySource({})).toBe(false);
    expect(layoutHasPropertySource({ width: '200px', grow: 1, wrap: true })).toBe(false);
  });

  it('is true when any field holds a property source', () => {
    expect(layoutHasPropertySource({ width: { $var: { path: 'MyPLC:W' } } as never })).toBe(true);
    expect(layoutHasPropertySource({ height: '80px', gap: { $static: '1rem' } as never })).toBe(
      true,
    );
  });
});

describe('collectComponentPriorityKeys', () => {
  it('finds nested expression variables in properties, layout, and child components', () => {
    const components: WidgetConfig[] = [
      {
        id: 'parent',
        type: 'Container',
        name: 'Parent',
        properties: {
          label: {
            $stringExpr: {
              template: '{1}',
              wildcards: { 1: { $var: { path: 'PLC:Label' } } },
            },
          },
          state: {
            $switch: {
              value: { $var: { path: 'PLC:Mode' } },
              cases: [
                {
                  when: { $var: { path: 'PLC:ExpectedMode' } },
                  then: 'active',
                },
              ],
              default: 'idle',
            },
          },
        },
        layout: { width: { $var: { path: 'PLC:Width' } } as never },
        children: [
          {
            id: 'child',
            type: 'Label',
            name: 'Child',
            properties: { value: { $var: { path: 'PLC:ChildValue' } } },
          },
        ],
      },
    ];

    expect(new Set(collectComponentPriorityKeys(components))).toEqual(
      new Set(['PLC:Label', 'PLC:Mode', 'PLC:ExpectedMode', 'PLC:Width', 'PLC:ChildValue']),
    );
  });
});

describe('useResolvedLayout', () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, null, children);

  beforeEach(() => {
    useVariableStore.setState({ values: {} });
  });

  it('passes plain values through unchanged', () => {
    const layout = { width: '200px', grow: 1 };
    const { result } = renderHook(() => useResolvedLayout(layout), { wrapper });
    expect(result.current).toMatchObject({ width: '200px', grow: 1 });
  });

  it('resolves a $var-bound field to the live scalar value', () => {
    useVariableStore.setState({ values: { 'MyPLC:Motor/Width': '320px' } });
    const layout = { width: { $var: { path: 'MyPLC:Motor/Width' } } as never };
    const { result } = renderHook(() => useResolvedLayout(layout), { wrapper });
    expect(result.current?.width).toBe('320px');
  });

  it('reflects live variable updates', () => {
    const layout = { width: { $var: { path: 'MyPLC:Motor/Width' } } as never };
    const { result } = renderHook(() => useResolvedLayout(layout), { wrapper });

    act(() => {
      useVariableStore.getState().setScalar('MyPLC:Motor/Width', '480px');
    });
    expect(result.current?.width).toBe('480px');
  });
});

describe('usePropVar', () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, null, children);

  beforeEach(() => {
    useVariableStore.setState({ values: {} });
  });

  it('resolves a bound $var to its live value', () => {
    useVariableStore.setState({ values: { 'PLC:Motor/Speed': 42 } });
    const { result } = renderHook(
      () => usePropVar({ value: { $var: { path: 'PLC:Motor/Speed' } } }, 'value'),
      { wrapper },
    );
    expect(result.current).toBe(42);
  });

  it('reads an incomplete binding as absent rather than leaking the wrapper', () => {
    // "Clear binding" leaves `{ $var: { path: '' } }` in place to keep the
    // property on the $var source; a widget must see nothing, not an object it
    // would stringify to "[object Object]".
    const { result } = renderHook(() => usePropVar({ value: { $var: { path: '' } } }, 'value'), {
      wrapper,
    });
    expect(result.current == null).toBe(true);
  });

  it('still passes a plain static value through', () => {
    const { result } = renderHook(() => usePropVar({ value: 7 }, 'value'), { wrapper });
    expect(result.current).toBe(7);
  });
});

// No built-in widget currently declares a `record-list` schema field, so there
// is no real consumer component to drive these through — see
// useRecordListProp's own call sites (none in src/hmi/components). Exercised
// directly against the hook instead, matching this file's useResolvedLayout
// convention above.
describe('useRecordListProp', () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, null, children);

  const EMPTY_RECIPE_CONFIG: RecipeConfig = { version: 1, datasetTypes: [] };

  beforeEach(() => {
    useVariableStore.setState({ values: {} });
    useRecipeStore.setState({ config: EMPTY_RECIPE_CONFIG, loaded: {}, lastResult: null });
    useComponentPropStore.setState({ props: {} });
  });

  it('passes a plain static array through unchanged', () => {
    const { result } = renderHook(
      () => useRecordListProp({ rows: [{ id: 1 }, { id: 2 }] }, 'rows'),
      { wrapper },
    );
    expect(result.current).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('resolves a $static-wrapped array', () => {
    const { result } = renderHook(
      () => useRecordListProp({ rows: { $static: [{ name: 'a' }] } }, 'rows'),
      { wrapper },
    );
    expect(result.current).toEqual([{ name: 'a' }]);
  });

  it('resolves a $user userList source as { label, value } pairs', () => {
    const { result } = renderHook(
      () => useRecordListProp({ rows: { $user: { field: 'userList' } } }, 'rows'),
      { wrapper },
    );
    expect(result.current).toEqual([
      { label: 'admin', value: 'admin' },
      { label: 'operator1', value: 'operator1' },
    ]);
  });

  it('ignores a $user source whose field is not the array-valued one', () => {
    const { result } = renderHook(
      () => useRecordListProp({ rows: { $user: { field: 'username' } } }, 'rows'),
      { wrapper },
    );
    expect(result.current).toEqual([]);
  });

  it('resolves a $recipeList source from the recipe store', () => {
    useRecipeStore.setState({
      config: {
        version: 1,
        datasetTypes: [
          {
            id: 'batch',
            name: 'Batch',
            parameters: [],
            datasets: [
              {
                id: 'ds-1',
                name: 'Recipe A',
                description: '',
                values: {},
                updatedAt: '',
                updatedBy: '',
                loadedAt: '',
              },
            ],
          },
        ],
      },
      loaded: {},
      lastResult: null,
    });

    const { result } = renderHook(
      () => useRecordListProp({ rows: { $recipeList: { type: 'batch' } } }, 'rows'),
      { wrapper },
    );
    expect(result.current).toEqual([
      { id: 'ds-1', name: 'Recipe A', description: '', lastLoaded: '' },
    ]);
  });

  it('resolves a $widgetProp source from the component-prop store', () => {
    useComponentPropStore.setState({
      props: { 'source-widget': { items: [{ x: 1 }, { x: 2 }] } },
    });

    const { result } = renderHook(
      () =>
        useRecordListProp(
          { rows: { $widgetProp: { componentId: 'source-widget', property: 'items' } } },
          'rows',
        ),
      { wrapper },
    );
    expect(result.current).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it('resolves a $var binding to a live struct-array variable', () => {
    useVariableStore.setState({ values: { 'MyPLC:Rows': [{ id: 'r1' }] } });
    const { result } = renderHook(
      () => useRecordListProp({ rows: { $var: { path: 'MyPLC:Rows' } } }, 'rows'),
      { wrapper },
    );
    expect(result.current).toEqual([{ id: 'r1' }]);
  });

  it('returns an empty array for a $var binding that has not received a snapshot yet', () => {
    const { result } = renderHook(
      () => useRecordListProp({ rows: { $var: { path: 'MyPLC:Missing' } } }, 'rows'),
      { wrapper },
    );
    expect(result.current).toEqual([]);
  });

  it('returns an empty array for an unrecognised wrapper shape', () => {
    const { result } = renderHook(
      () => useRecordListProp({ rows: { $unknownSource: { foo: 'bar' } } as never }, 'rows'),
      { wrapper },
    );
    expect(result.current).toEqual([]);
  });

  it('returns an empty array when $static holds a non-array value', () => {
    const { result } = renderHook(
      () => useRecordListProp({ rows: { $static: 'not-an-array' } as never }, 'rows'),
      { wrapper },
    );
    expect(result.current).toEqual([]);
  });

  it('returns an empty array when the property is absent', () => {
    const { result } = renderHook(() => useRecordListProp({}, 'rows'), { wrapper });
    expect(result.current).toEqual([]);
  });
});
