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
  containerLayoutProps,
  collectComponentPriorityKeys,
  selfLayoutStyle,
  selfFlexChildStyle,
  layoutHasPropertySource,
  CONTAINER_CSS_VARS,
  FLOW_CSS_VARS,
  SELF_LAYOUT_KEYS,
  useResolvedLayout,
  useRecordListProp,
  usePropVar,
} from './layoutUtils';
import type { LayoutConfig, WidgetConfig } from '@shared/types/config';
import selfLayoutKeys from '@shared/types/__fixtures__/selfLayoutKeys.json';
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

  it('emits direct CSS properties for flex-self sizing fields', () => {
    const style = selfLayoutStyle({
      grow: 1,
      minWidth: '100px',
      maxWidth: '400px',
      minHeight: '80px',
    });

    expect(style).toEqual({
      flexGrow: 1,
      minWidth: '100px',
      maxWidth: '400px',
      minHeight: '80px',
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

  it('emits nothing for the keys the migration retires', () => {
    // `margin` and the raw flex three are off `LayoutConfig` and out of
    // `SELF_DIRECT_PROPS`, so one left in a file the migration never saw
    // renders as nothing rather than out-ranking what the panel can edit.
    const style = selfLayoutStyle({
      margin: '0.5rem',
      marginTop: '4px',
      basis: '200px',
      shrink: 0,
      alignSelf: 'stretch',
    } as LayoutConfig);

    expect(style).toBeUndefined();
  });
});

describe('selfFlexChildStyle', () => {
  // WidgetRenderer's binding/lock wrapper takes over the flex-child role from
  // `.hmi-component`, but the widget inside it still renders and still
  // applies its own `width`/`height` from the same `layout` — so the wrapper
  // must never also carry `width`/`height`, or the two apply it independently
  // and a percentage size resolves against two different boxes.
  it('omits width/height that selfLayoutStyle includes, for the same layout', () => {
    const layout: LayoutConfig = {
      width: '50%',
      height: '80px',
      grow: 1,
      minWidth: '120px',
    };

    expect(selfLayoutStyle(layout)).toMatchObject({ width: '50%', height: '80px' });

    const flexChildStyle = selfFlexChildStyle(layout);
    expect(flexChildStyle).not.toHaveProperty('width');
    expect(flexChildStyle).not.toHaveProperty('height');
    expect(flexChildStyle).toMatchObject({ flexGrow: 1, minWidth: '120px' });
  });

  it('returns undefined when no layout is provided', () => {
    expect(selfFlexChildStyle(undefined)).toBeUndefined();
  });

  it('returns undefined when the layout has only width/height set', () => {
    expect(selfFlexChildStyle({ width: '50%', height: '80px' })).toBeUndefined();
  });

  // Unlike width/height, min/max *constrain* rather than set the box, so the
  // wrapper needs them too — a `Max width` on the widget must also stop the
  // binding/lock overlay it wraps, or the overlay marks a box wider than the
  // widget it is supposed to outline.
  it('keeps min/max on the wrapper, unlike width/height', () => {
    const layout: LayoutConfig = {
      width: '50%',
      height: '80px',
      minWidth: '100px',
      maxWidth: '400px',
      minHeight: '40px',
      maxHeight: '300px',
    };
    const flexChildStyle = selfFlexChildStyle(layout);
    expect(flexChildStyle).not.toHaveProperty('width');
    expect(flexChildStyle).not.toHaveProperty('height');
    expect(flexChildStyle).toMatchObject({
      minWidth: '100px',
      maxWidth: '400px',
      minHeight: '40px',
      maxHeight: '300px',
    });
  });
});

describe('SELF_LAYOUT_KEYS', () => {
  // Same fixture is read by backend/tests/test_migration_size_modes_geometry.py,
  // whose fold harness has to apply exactly the keys `withInstanceSizing` folds.
  // Hand-copied, the two drifted silently and the harness compared the wrong
  // geometry; as a fixture, a new self key fails this instead.
  it('matches the shared fixture the geometry harness folds with', () => {
    expect([...SELF_LAYOUT_KEYS]).toEqual(selfLayoutKeys);
  });
});

describe('selfLayoutStyle — size-mode flow intent', () => {
  // A node using the size-mode system emits axis-neutral `--w-*`/`--h-*`
  // custom properties instead of computing which screen axis is main itself —
  // that is `hmi.css`'s flow-translation block's job, off the parent's own
  // `data-flow-direction`/`data-flow-align`, at render.

  it('emits the main-role triple for a literal Fill, defaulting the weight to 1', () => {
    expect(selfLayoutStyle({ widthMode: 'fill' })).toMatchObject({
      '--w-grow': '1',
      '--w-basis': '0',
      '--w-alignself-notstretch': 'stretch',
    });
    expect(selfLayoutStyle({ widthMode: 'fill' })).not.toHaveProperty('--w-shrink');
    expect(selfLayoutStyle({ widthMode: 'fill' })).not.toHaveProperty('--w-alignself-stretch');
  });

  it('reads the stored grow weight for a literal Fill', () => {
    expect(selfLayoutStyle({ widthMode: 'fill', grow: 2.5 })).toMatchObject({
      '--w-grow': '2.5',
    });
  });

  // `flex-basis: 0` opts a Fill axis out of its own content size, so a Fill
  // child of a Hug ancestor with no free space to grow into collapses to zero
  // instead of hugging content — hmi.css's barrier defaults the min to 0. An
  // `auto` floor here is what stops the collapse without capping how far a
  // real free space still lets it grow.
  it('floors a literal Fill at its content size, on either axis, unless the panel set a Min', () => {
    expect(selfLayoutStyle({ widthMode: 'fill' })).toMatchObject({ minWidth: 'auto' });
    expect(selfLayoutStyle({ heightMode: 'fill' })).toMatchObject({ minHeight: 'auto' });
    expect(selfLayoutStyle({ widthMode: 'fill', minWidth: '0' })).toMatchObject({
      minWidth: '0',
    });
    expect(selfLayoutStyle({ heightMode: 'hug' })).not.toHaveProperty('minHeight');
    expect(selfLayoutStyle({ widthMode: 'fixed', width: '30rem' })).not.toHaveProperty('minWidth');
  });

  it('emits only the shrink-off and cross-role Hug pair for a literal Hug', () => {
    const style = selfLayoutStyle({ heightMode: 'hug' });
    expect(style).toMatchObject({ '--h-shrink': '0', '--h-alignself-stretch': 'flex-start' });
    expect(style).not.toHaveProperty('--h-grow');
    expect(style).not.toHaveProperty('--h-basis');
    expect(style).not.toHaveProperty('--h-alignself-notstretch');
  });

  it('emits only shrink-off for a literal Fixed — its own width/height drives the box', () => {
    const style = selfLayoutStyle({ widthMode: 'fixed', width: '30rem' });
    expect(style).toMatchObject({ '--w-shrink': '0', width: '30rem' });
    expect(style).not.toHaveProperty('--w-grow');
    expect(style).not.toHaveProperty('--w-basis');
    expect(style).not.toHaveProperty('--w-alignself-stretch');
    expect(style).not.toHaveProperty('--w-alignself-notstretch');
  });

  it('translates both axes independently in one call, under their own prefix', () => {
    expect(
      selfLayoutStyle({ widthMode: 'fixed', width: '200px', heightMode: 'fill', grow: 2 }),
    ).toMatchObject({
      width: '200px',
      '--w-shrink': '0',
      '--h-grow': '2',
      '--h-basis': '0',
      '--h-alignself-notstretch': 'stretch',
    });
  });

  it('emits nothing flow-related for an unset, unrecognised, or property-sourced mode', () => {
    expect(selfLayoutStyle({ width: '200px' })).toEqual({ width: '200px' });
    const bound = { widthMode: { $var: { path: 'MyPLC:Mode' } }, width: '80px' } as never;
    expect(selfLayoutStyle(bound)).toEqual({ width: '80px' });
  });

  // A stale `width`/`height` left over from a Fixed pick must not survive a
  // live-bound mode resolving to Hug or Fill — a `$var`-bound mode has no
  // panel click to run `sizeModePatch`'s own clearing through, so this is the
  // only place left to stop an explicit length from overriding the axis's
  // `align-self: stretch` (cross role) or `flex-grow` (main role) outright.
  it('suppresses a stale width/height under a literal Hug or Fill, on either axis', () => {
    expect(selfLayoutStyle({ widthMode: 'fill', width: '200px', grow: 2 })).not.toHaveProperty(
      'width',
    );
    expect(selfLayoutStyle({ widthMode: 'hug', width: '200px' })).not.toHaveProperty('width');
    expect(selfLayoutStyle({ heightMode: 'fill', height: '80px' })).not.toHaveProperty('height');
    expect(selfLayoutStyle({ heightMode: 'hug', height: '80px' })).not.toHaveProperty('height');
  });

  it('keeps width/height under a literal Fixed, or a mode that cannot be read', () => {
    expect(selfLayoutStyle({ widthMode: 'fixed', width: '200px' })).toMatchObject({
      width: '200px',
    });
    const bound = { widthMode: { $var: { path: 'MyPLC:Mode' } }, width: '80px' } as never;
    expect(selfLayoutStyle(bound)).toMatchObject({ width: '80px' });
  });

  it('shares one weight across both axes when both are Fill', () => {
    const style = selfLayoutStyle({ widthMode: 'fill', heightMode: 'fill', grow: 3 });
    expect(style).toMatchObject({ '--w-grow': '3', '--h-grow': '3' });
  });

  it('routes grow through the shared weight, never as a literal flexGrow, once any axis uses a mode', () => {
    // Unlike the legacy pre-mode-system path below, `grow` must never also
    // land as a literal `flexGrow` here — that would hard-wire it to this
    // element's actual DOM flex-grow regardless of which screen axis
    // `hmi.css` later decides is main.
    const style = selfLayoutStyle({ widthMode: 'fill', grow: 2 });
    expect(style).not.toHaveProperty('flexGrow');
  });

  it('leaves an axis with no mode of its own silent, even when the other axis uses one', () => {
    // The old flip-leak this system used to accept (a weight meant for one
    // axis waking up on the other after a direction flip) no longer applies:
    // an unset axis simply emits nothing, on either side.
    const style = selfLayoutStyle({ heightMode: 'fill', grow: 3 });
    expect(style).not.toHaveProperty('--w-grow');
    expect(style).not.toHaveProperty('--w-basis');
    expect(style).not.toHaveProperty('--w-shrink');
  });

  it('passes a pre-size-mode grow through as plain flexGrow when neither axis has a mode', () => {
    // The one field of the raw shape the migration keeps: a node it could read
    // no axis for (an image-slot child, a bound container direction, a
    // definition root under two flows) still carries its `grow`, and the
    // panel still shows the Fill-weight row for it.
    const style = selfLayoutStyle({ grow: 2, minWidth: '0' });
    expect(style).toEqual({ flexGrow: 2, minWidth: '0' });
    expect(style).not.toHaveProperty('--w-grow');
    expect(style).not.toHaveProperty('--h-grow');
  });

  it('ignores a retired raw flex key stored alongside a mode', () => {
    const style = selfLayoutStyle({
      widthMode: 'fill',
      basis: '999px',
      shrink: 5,
      alignSelf: 'center',
    } as LayoutConfig);
    expect(style).not.toHaveProperty('flexBasis');
    expect(style).not.toHaveProperty('flexShrink');
    expect(style).not.toHaveProperty('alignSelf');
  });
});

describe('containerLayoutProps', () => {
  it('returns row/stretch data-flow-* and an empty style when no layout is provided', () => {
    expect(containerLayoutProps(undefined)).toEqual({
      style: {},
      'data-flow-direction': 'row',
      'data-flow-align': 'stretch',
    });
  });

  it('returns the same row/stretch fallback for an empty layout', () => {
    expect(containerLayoutProps({})).toEqual({
      style: {},
      'data-flow-direction': 'row',
      'data-flow-align': 'stretch',
    });
  });

  it('emits the --container-* vars for the kept fields', () => {
    const { style } = containerLayoutProps({
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
    const { style } = containerLayoutProps({ wrap: false });
    expect(style).toMatchObject({ '--container-wrap': 'nowrap' });
  });

  it('emits the four padding sides as plain CSS properties', () => {
    const { style } = containerLayoutProps({
      paddingTop: '4px',
      paddingRight: '8px',
      paddingBottom: '4px',
      paddingLeft: '8px',
    });

    expect(style).toMatchObject({
      paddingTop: '4px',
      paddingRight: '8px',
      paddingBottom: '4px',
      paddingLeft: '8px',
    });
  });

  it('emits self-sizing fields alongside container vars', () => {
    const { style } = containerLayoutProps({
      direction: 'row',
      width: '100%',
    });

    expect(style).toMatchObject({
      '--container-direction': 'row',
      width: '100%',
    });
  });

  it('reads data-flow-direction/data-flow-align off direction/align, defaulting each independently', () => {
    expect(containerLayoutProps({ direction: 'column' })).toMatchObject({
      'data-flow-direction': 'column',
      'data-flow-align': 'stretch',
    });
    expect(containerLayoutProps({ align: 'center' })).toMatchObject({
      'data-flow-direction': 'row',
      'data-flow-align': 'center',
    });
  });

  it('falls back to row/stretch for a property-sourced direction/align — resolve before calling', () => {
    const bound = { direction: { $var: { path: 'MyPLC:Dir' } } } as never;
    expect(containerLayoutProps(bound)).toMatchObject({
      'data-flow-direction': 'row',
      'data-flow-align': 'stretch',
    });
  });
});

// Custom properties inherit. `containerLayoutProps` emits `--container-*` and
// `selfLayoutStyle` emits `--w-*`/`--h-*` only for the fields an author (or a
// literal size mode) actually set, so any left unset would otherwise inherit
// an ancestor widget's value instead of falling back to the documented
// default (a container nested in a `column` parent silently rendering as a
// column; a widget silently growing because its `Container` ancestor does).
// Every one is therefore reset to `initial` by the shared barrier in
// hmi.css, and a stylesheet's own private vars by that stylesheet. This
// guard fails when a var is consumed with no reset in either place.
//
// The eight plain direct properties (`flexBasis`, `minWidth`, …) have no
// equivalent half: they are set on the same element that reads them, so
// there is nothing to inherit and nothing to reset — an unset field is simply
// absent from the style object, falling back to the plain default on
// `.hmi-component, .hmi-container` in hmi.css.
describe('inherited layout vars are reset where they are consumed', () => {
  const files = {
    'hmi.css': '../styles/hmi.css',
    // The Container is a built-in widget — same guard applies to its source.
    'builtin Container/style.css': '../../../widgets/Layout/Container/style.css',
  };

  function varNames(css: string, re: RegExp): Set<string> {
    return new Set([...css.matchAll(re)].map((m) => m[1]));
  }

  async function readCss(rel: string): Promise<string> {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  }

  const CONSUMED = /var\((--container-[a-z-]+)/g;
  const RESET = /(--container-[a-z-]+)\s*:\s*initial/g;

  it('builtin Container/style.css resets every --container-* var it reads', async () => {
    const css = await readCss(files['builtin Container/style.css']);
    const barrier = varNames(await readCss(files['hmi.css']), RESET);

    const consumed = varNames(css, CONSUMED);
    const reset = varNames(css, RESET);

    expect(consumed.size).toBeGreaterThan(0);
    expect([...consumed].filter((v) => !reset.has(v) && !barrier.has(v))).toEqual([]);
  });

  // One-directional: catches a var consumed without a reset, but not a key
  // added to `CONTAINER_VAR_KEYS` — and so emitted by `containerLayoutProps`
  // — that no barrier resets, which renders as the panel writing a value that
  // leaks into every nested flex host.
  it('hmi.css carries the whole container table', async () => {
    const css = await readCss(files['hmi.css']);
    const reset = varNames(css, RESET);

    // Not `consumed`: how a flex host arranges its children is its own CSS's
    // business, so the barrier resets these without ever reading one.
    expect(CONTAINER_CSS_VARS.filter((v) => !reset.has(v))).toEqual([]);
  });

  // `--w-*`/`--h-*` are both consumed and reset inside hmi.css itself — unlike
  // `--container-*`, there is no separate stylesheet on the other side of the
  // indirection, since every flex parent reads them off its own children
  // through the one shared flow-translation block.
  const FLOW_CONSUMED = /var\((--[wh]-[a-z-]+)/g;
  const FLOW_RESET = /(--[wh]-[a-z-]+)\s*:\s*initial/g;

  it('hmi.css resets every --w-*/--h-* var its own flow-translation block reads', async () => {
    const css = await readCss(files['hmi.css']);
    const consumed = varNames(css, FLOW_CONSUMED);
    const reset = varNames(css, FLOW_RESET);

    expect(consumed.size).toBeGreaterThan(0);
    expect([...consumed].filter((v) => !reset.has(v))).toEqual([]);
  });

  it('hmi.css carries the whole flow-intent table', async () => {
    const css = await readCss(files['hmi.css']);
    const reset = varNames(css, FLOW_RESET);

    expect(FLOW_CSS_VARS.filter((v) => !reset.has(v))).toEqual([]);
  });

  // Var-name coverage above catches a var added to FLOW_CSS_VARS with no
  // reset anywhere, but not a *class* the flow-translation block treats as a
  // flex item that the reset selector doesn't carry — the actual shape of the
  // binding/lock-wrapper leak this guard exists for: every `--w-*`/`--h-*` var
  // was reset, just not on the class that needed it. Extract both sides
  // structurally and diff the class sets instead of trusting a var-name match
  // to imply the selector was right too.
  it('the --w-*/--h-* reset selector covers every class the flow-translation block treats as a flex item', async () => {
    const css = await readCss(files['hmi.css']);

    // Every class the translation block's own selectors put right after a
    // `>` combinator — the plain, preview-node-nested, wrapper, and
    // wrapper-inside-preview-node paths all land here, however many there are.
    const translationStart = css.indexOf('Flow translation');
    const translationEnd = css.indexOf('Pin direct children');
    expect(translationStart).toBeGreaterThan(-1);
    expect(translationEnd).toBeGreaterThan(translationStart);
    const translationBlock = css.slice(translationStart, translationEnd);
    const flexItemClasses = new Set(
      [...translationBlock.matchAll(/>\s*:is\(([^)]+)\)/g)].flatMap((m) =>
        m[1].split(',').map((s) => s.trim().replace(/^\./, '')),
      ),
    );
    expect(flexItemClasses.size).toBeGreaterThan(0);

    // The selector list of the rule that resets --w-grow (the reset barrier
    // in the "Layout barrier" section).
    const barrierMatch = css.match(/([^{}]+)\{[^}]*--w-grow:\s*initial/);
    expect(barrierMatch).not.toBeNull();
    const barrierSelector = barrierMatch![1].replace(/\/\*[\s\S]*?\*\//g, '');
    const barrierClasses = new Set(
      [...barrierSelector.matchAll(/\.([a-zA-Z0-9-]+)/g)].map((m) => m[1]),
    );

    expect([...flexItemClasses].filter((c) => !barrierClasses.has(c))).toEqual([]);
  });

  // Positive confirmation that the `--self-*` half is actually gone, not just
  // untested — regresses loudly if a future edit reintroduces the indirection.
  const checkedForSelfVars = { ...files, 'WidgetRenderer.css': './WidgetRenderer.css' };
  for (const [label, rel] of Object.entries(checkedForSelfVars)) {
    it(`${label} references no --self-* custom property`, async () => {
      const css = await readCss(rel);
      expect(css).not.toMatch(/--self-[a-z-]+/);
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

describe('useResolvedLayout — responsive direction', () => {
  // The case fase 3 fixes: a Container's `direction` bound to a `$switch` on
  // `$viewport` used to be unresolvable ahead of render (`ownFlow` read the
  // raw property-source wrapper, not a value), so its children fell back to
  // an ambient flow and a `widthMode: 'fill'` on one of them could size
  // against the wrong axis. Now `useResolvedLayout` resolves it like any
  // other sourced field, `Container` passes the plain result straight into
  // `containerLayoutProps`, and `data-flow-direction` on `.hmi-container__content`
  // carries the resolved axis regardless of how it got there.
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, null, children);

  // jsdom reports 1024px, which `classifyViewport` calls `tablet`.
  const RESPONSIVE_DIRECTION = {
    $switch: {
      value: { $viewport: { field: 'size' } },
      cases: [
        { when: 'phone', then: 'column' },
        { when: 'tablet', then: 'row' },
      ],
      default: 'row',
    },
  };

  beforeEach(() => {
    useVariableStore.setState({ values: {} });
  });

  it('resolves a $switch-on-$viewport direction to the axis it actually renders as', () => {
    const layout = { direction: RESPONSIVE_DIRECTION as never };
    const { result } = renderHook(() => useResolvedLayout(layout), { wrapper });
    expect(result.current?.direction).toBe('row');
  });

  it('reflects live variable updates on a $var-bound direction', () => {
    useVariableStore.setState({ values: { 'MyPLC:Ui/Direction': 'row' } });
    const layout = { direction: { $var: { path: 'MyPLC:Ui/Direction' } } as never };
    const { result } = renderHook(() => useResolvedLayout(layout), { wrapper });
    expect(result.current?.direction).toBe('row');

    act(() => {
      useVariableStore.getState().setScalar('MyPLC:Ui/Direction', 'column');
    });
    expect(result.current?.direction).toBe('column');
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
