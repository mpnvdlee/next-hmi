import { useState, useEffect, useMemo, type CSSProperties } from 'react';
import {
  type WidgetConfig,
  type LayoutConfig,
  type VariableBinding,
  bindingKey,
} from '@shared/types/config';
import type { CSSWithVars } from '@shared/types/style';
import { getVarBinding, hasPropertySourceKey, isRecord } from '@shared/types/propertyValueGuards';
import { evaluatePropertyValue, type EvaluationContext } from '../utils/propertySourceEval';
import { extractVarKeys } from '../utils/extractVarKeys';
import { resolveComponentPropValue, withDeclaredDefaults } from '../utils/componentPropResolution';
import { componentDefinition } from '@shared/store/componentStore';
import { useEvalContext } from '../hooks/useEvalContext';
import { useLiveScalars } from '../hooks/useLiveScalars';
import { getViewportSnapshot } from '../hooks/useViewport';
import { useBindingValue } from '../hooks/useVariable';
import { useStructVariable } from '../hooks/useStructVariable';
import { useThemeRuntimeStore } from '../store/themeRuntimeStore';

/** Self-fields carried straight through as literal CSS properties: min/max
 *  (always, regardless of mode — a bound never competes with the mode system
 *  the way a length or a flex key does) and `width`/`height` (gated per axis in
 *  {@link buildSelfProps} — suppressed under that axis's own literal Hug/Fill,
 *  same as the runtime always has, since an explicit `width`/`height` left
 *  over from Fixed would otherwise override a cross-axis Fill's `align-self:
 *  stretch` outright). The raw flex keys the pre-size-mode panel wrote —
 *  `basis`, `shrink`, `alignSelf` — are not here and not on `LayoutConfig`:
 *  the 4 → 5 migration drops all three from every node, including the ones it
 *  can read no axis for (`_drop_retired_keys`), and no project is served
 *  before `run_baseline_migration` has brought it to the current format. A
 *  stray one left in a hand-edited file emits nothing, same as `margin`. */
const SELF_DIRECT_PROPS = {
  minWidth: 'minWidth',
  maxWidth: 'maxWidth',
  minHeight: 'minHeight',
  maxHeight: 'maxHeight',
  width: 'width',
  height: 'height',
} as const satisfies Partial<Record<keyof LayoutConfig, keyof CSSProperties>>;

const SELF_DIRECT_ENTRIES = Object.entries(SELF_DIRECT_PROPS) as [keyof LayoutConfig, string][];

/** Layout keys describing how a node sits in its parent, as opposed to how it
 *  arranges its own children — every field {@link selfLayoutStyle} reads.
 *  ComponentRenderer folds exactly these from a component instance onto the
 *  definition's roots. Order matches the shared fixture
 *  `__fixtures__/selfLayoutKeys.json`, which the backend geometry harness
 *  folds in the same order (`test_migration_size_modes_geometry.py`). */
export const SELF_LAYOUT_KEYS: readonly (keyof LayoutConfig)[] = [
  'grow',
  ...(Object.keys(SELF_DIRECT_PROPS) as (keyof LayoutConfig)[]),
  'widthMode',
  'heightMode',
];

const SIZE_MODES = new Set(['hug', 'fill', 'fixed']);

/** Every custom property {@link axisFlowProps} can emit, both axes. Unlike the
 *  plain CSS properties in {@link SELF_DIRECT_PROPS}, a custom property
 *  inherits — set on a `Container`, it would otherwise leak into every widget
 *  nested inside it that doesn't set its own. Exported for the stylesheet
 *  guard in `layoutUtils.test.ts`, same as {@link CONTAINER_CSS_VARS}: the
 *  shared layout barrier in hmi.css has to reset every one of these, or a key
 *  added to {@link axisFlowProps} inherits where it shouldn't. */
export const FLOW_CSS_VARS: readonly string[] = (['w', 'h'] as const).flatMap((prefix) => [
  `--${prefix}-grow`,
  `--${prefix}-basis`,
  `--${prefix}-shrink`,
  `--${prefix}-alignself-stretch`,
  `--${prefix}-alignself-notstretch`,
]);

/**
 * One axis's flow-intent custom properties — the axis-neutral vocabulary
 * `hmi.css`'s translation block reads, under a `w-`/`h-` prefix the caller
 * supplies. Written only when this axis's own mode is one of the three literal
 * values; an unset, still-bound, or otherwise unrecognised mode leaves the
 * axis silent, so CSS falls through to the plain `.hmi-component,
 * .hmi-container` default same as it always did.
 *
 * Every value here is the same one `axisModePatch` used to write directly onto
 * `flexGrow`/`flexBasis`/`flexShrink`/`alignSelf` before this axis's *role*
 * (main or cross) was known — the difference fase 3 makes is that the role is
 * no longer this function's business. Both a main-role triple
 * (`grow`/`basis`/`shrink`) and a cross-role pair (`alignself` under a
 * `stretch`-aligned parent, and under a non-`stretch` one) are written
 * unconditionally; `hmi.css` picks whichever half actually applies once it
 * knows which axis is main, from the parent's own `data-flow-direction` /
 * `data-flow-align` — never from this widget.
 */
function axisFlowProps(
  prefix: 'w' | 'h',
  mode: unknown,
  fillWeight: number,
): Record<string, string> {
  if (typeof mode !== 'string' || !SIZE_MODES.has(mode)) return {};
  const p: Record<string, string> = {};
  if (mode === 'fill') {
    p[`--${prefix}-grow`] = String(fillWeight);
    p[`--${prefix}-basis`] = '0';
    p[`--${prefix}-alignself-notstretch`] = 'stretch';
  } else if (mode === 'hug') {
    p[`--${prefix}-shrink`] = '0';
    p[`--${prefix}-alignself-stretch`] = 'flex-start';
  } else {
    // fixed — the axis's own width/height (SELF_DIRECT_PROPS) drives the box;
    // this only needs to stop it shrinking away under pressure.
    p[`--${prefix}-shrink`] = '0';
  }
  return p;
}

/**
 * `grow` is the one field both the pre-size-mode raw shape and the size-mode
 * system author — a node the 4 → 5 migration could read no mode for keeps it
 * raw, and the panel writes it as the Fill weight once any mode is literal.
 * The two can't be told apart from `layout.grow` alone, only from whether
 * *either* axis's mode is one this system recognises: a node with neither key
 * set is the pre-mode shape, and `grow` passes straight through as `flexGrow`.
 * A node using the size-mode system instead routes it through
 * {@link axisFlowProps} as the shared weight both `--w-grow` and `--h-grow`
 * read from — never as a literal `flexGrow`, which would hard-wire it to one
 * screen axis regardless of which one a flip later makes main.
 */
function usesSizeModes(layout: LayoutConfig): boolean {
  const w = layout.widthMode;
  const h = layout.heightMode;
  return (
    (typeof w === 'string' && SIZE_MODES.has(w)) || (typeof h === 'string' && SIZE_MODES.has(h))
  );
}

/**
 * A node the 4 → 5 size-mode migration never rewrote: no literal mode on either
 * axis, but a raw `grow`/`width`/`height` still sizing it. That migration
 * leaves this shape behind wherever it could not read which axis those keys
 * drove — a component-definition root whose instances sit under different
 * flows, a container whose `direction` is itself bound, an ImageContainer's
 * absolutely-placed child.
 *
 * The unset-means-Hug default below stops at this door. Hug suppresses an
 * axis's stored length, so defaulting one of these would drop the very
 * `width`/`height` still holding the node open and collapse it to its content.
 * They keep rendering off their raw keys until `migration_size_modes.py`
 * stamps a real mode on them.
 *
 * A bare `grow` is deliberately *not* one of them. It is what the panel writes
 * for the Fill weight, whose row shows while an axis is merely unset — and the
 * migration never leaves one behind alone, since pass 3 drops a `grow` whose
 * axis reads as anything but Fill. Counting it here rendered it as a literal
 * `flexGrow`, so a widget both rows mark "Hug (default)" grew anyway, against
 * what the panel and `docs/user/layout.md` both promise.
 */
function isPreModeShape(layout: LayoutConfig): boolean {
  return !usesSizeModes(layout) && (layout.width !== undefined || layout.height !== undefined);
}

/** What an axis with no stored mode renders as. The Layout panel already
 *  advertises it — `schemaFor` in LayoutFields gives both mode rows
 *  `defaultValue: 'hug'` — so emitting anything else here makes the button
 *  already marked "default" move the widget when it is finally pressed. */
const DEFAULT_SIZE_MODE = 'hug';

/** A literal Hug or Fill owns this axis's length role instead of its own
 *  stored `width`/`height`. Anything else (Fixed, unset, still bound/mixed)
 *  leaves the stored length to pass straight through.
 *
 *  Exported because the Layout panel decides whether to *show* a length row
 *  from the same rule (`reachableSizeKeys`): the panel must not offer a row
 *  the renderer has stopped reading, so the two read one definition rather
 *  than two that agree by comment. */
export function lengthSuppressed(mode: unknown): boolean {
  return mode === 'hug' || mode === 'fill';
}

/** The mode an axis renders as, including the Hug an unset axis falls to once
 *  the node has left the pre-mode shape. The Layout panel reads a node's
 *  stored config through the same function (`LayoutFields`'s `sizeValueRow`),
 *  so the two can't quietly disagree on what "unset" means the way they used
 *  to — the panel offering a length row the runtime has already stopped
 *  reading for. */
export function effectiveSizeMode(
  layout: LayoutConfig,
  axis: 'width' | 'height',
): string | undefined {
  const stored = axis === 'width' ? layout.widthMode : layout.heightMode;
  return isPreModeShape(layout) ? stored : (stored ?? DEFAULT_SIZE_MODE);
}

function buildSelfProps(layout: LayoutConfig): CSSWithVars {
  const s: Record<string, unknown> = {};
  const preMode = isPreModeShape(layout);
  // Resolved once and read by both halves below: the length suppression and the
  // flow properties have to see the *same* mode, or an axis defaulted to Hug
  // keeps a length a pressed Hug drops.
  const widthMode = effectiveSizeMode(layout, 'width');
  const heightMode = effectiveSizeMode(layout, 'height');
  for (const [key, cssProp] of SELF_DIRECT_ENTRIES) {
    if (key === 'width' && lengthSuppressed(widthMode)) continue;
    if (key === 'height' && lengthSuppressed(heightMode)) continue;
    const value = layout[key];
    if (value !== undefined) s[cssProp] = value;
  }
  if (!preMode) {
    const fillWeight = typeof layout.grow === 'number' ? layout.grow : 1;
    Object.assign(s, axisFlowProps('w', widthMode, fillWeight));
    Object.assign(s, axisFlowProps('h', heightMode, fillWeight));
    // Fill's `flex-basis: 0` opts this axis out of its own content size; with
    // nothing to grow into (a Hug ancestor with no free space) it collapses to
    // zero instead of hugging content, since hmi.css's barrier defaults the min
    // to 0. `auto` restores the browser's content-based floor — the same one
    // `_write_content_floor` in migration_size_modes.py pins on a node it reads
    // as Fill over a content-sized `grow` — without capping how far real free
    // space still lets it grow. An explicit Min from the panel always wins.
    if (widthMode === 'fill' && layout.minWidth === undefined) s.minWidth = 'auto';
    if (heightMode === 'fill' && layout.minHeight === undefined) s.minHeight = 'auto';
  } else if (layout.grow !== undefined) {
    s.flexGrow = layout.grow;
  }
  return s as CSSWithVars;
}

/**
 * Build a style object sizing a widget as a flex child — plain CSS properties
 * for `width`/`height`/min/max, a pre-size-mode `grow` as `flexGrow`, and (for
 * a node using Hug/Fill/Fixed) the axis-neutral custom properties `hmi.css`'s
 * translation block reads. An unset field is simply absent, and the shared
 * `.hmi-component, .hmi-container` default in hmi.css takes over, same as it
 * always did.
 *
 * A *missing* layout is not a special case: `makeComponentOfType` creates every
 * widget without one, so treating it as anything other than an empty layout
 * would exempt exactly the nodes the Hug default exists for.
 */
export function selfLayoutStyle(layout?: LayoutConfig): CSSWithVars | undefined {
  const s = buildSelfProps(layout ?? {});
  return Object.keys(s).length ? s : undefined;
}

/**
 * {@link selfLayoutStyle} minus `width`/`height` — the flex-child role plus
 * min/max, with none of the *own-box* sizing that would double up if applied
 * both to a wrapper and to the real widget inside it. Used by
 * `WidgetRenderer`'s binding/lock wrapper, which takes over the flex-child
 * role from `.hmi-component` but renders the real widget (which applies its
 * own `width`/`height`) inside it — a percentage width doubly applied would
 * overflow the wrapper. Min/max stay, unlike width/height: they *constrain*
 * rather than set the box, so the wrapper needs them too, or an author's
 * `Max width` stops the widget inside without stopping the binding-overlay
 * that is supposed to mark exactly its bounds.
 */
export function selfFlexChildStyle(layout?: LayoutConfig): CSSWithVars | undefined {
  const s = buildSelfProps(layout ?? {});
  delete s.width;
  delete s.height;
  return Object.keys(s).length ? s : undefined;
}

/**
 * Returns a style object applying a per-instance background color.
 * When `color` is undefined the element falls through to its CSS rule
 * (e.g. `background: var(--hmi-accent)`), so no JS fallback is needed.
 * Import and spread this on any HMI element that exposes a 'color' schema field.
 */
export function widgetColorStyle(color: string | undefined): CSSProperties {
  return color ? { backgroundColor: color } : {};
}

/** Child-layout fields emitted as CSS custom properties, consumed by the
 *  stylesheet of whichever widget declared `flowsChildren`. The twin of
 *  {@link SELF_DIRECT_PROPS}: that table says how a widget sits in its parent,
 *  this one how it arranges its children — and unlike that table, this one
 *  still needs custom properties: the style is set on the container root but
 *  read by its content wrapper, a different element, so there is real
 *  indirection to cross. Padding is not here — it emits as plain CSS
 *  properties, which do not inherit and so need no barrier. */
const CONTAINER_VAR_KEYS = {
  direction: '--container-direction',
  gap: '--container-gap',
  wrap: '--container-wrap',
  align: '--container-align',
  justify: '--container-justify',
  radius: '--container-radius',
} as const satisfies Partial<Record<keyof LayoutConfig, string>>;

const CONTAINER_VAR_ENTRIES = Object.entries(CONTAINER_VAR_KEYS) as [
  keyof typeof CONTAINER_VAR_KEYS,
  string,
][];

/** The custom properties {@link containerLayoutProps} can emit. Exported for the
 *  stylesheet guard in `layoutUtils.test.ts`: the shared layout barrier in
 *  hmi.css has to reset every one of them, or a key added to the table above
 *  inherits into every nested flex host. */
export const CONTAINER_CSS_VARS: readonly string[] = Object.values(CONTAINER_VAR_KEYS);

/** `wrap` is the one field whose stored value is not its CSS value. */
function containerVarValue(key: keyof typeof CONTAINER_VAR_KEYS, value: unknown): string {
  return key === 'wrap' ? (value ? 'wrap' : 'nowrap') : String(value);
}

function containerStyle(layout?: LayoutConfig): CSSWithVars {
  // `layout ?? {}` rather than an early return: a flex host is a flex *child*
  // too, so it owes the same unset-means-Hug default as every other widget —
  // see {@link selfLayoutStyle}. Bailing here gave a Container with no layout
  // key a different size role from one holding an empty layout.
  const resolved = layout ?? {};
  const s: Record<string, unknown> = buildSelfProps(resolved);
  for (const [key, cssVar] of CONTAINER_VAR_ENTRIES) {
    const value = resolved[key];
    if (value !== undefined) s[cssVar] = containerVarValue(key, value);
  }
  if (resolved.paddingTop !== undefined) s.paddingTop = resolved.paddingTop;
  if (resolved.paddingRight !== undefined) s.paddingRight = resolved.paddingRight;
  if (resolved.paddingBottom !== undefined) s.paddingBottom = resolved.paddingBottom;
  if (resolved.paddingLeft !== undefined) s.paddingLeft = resolved.paddingLeft;
  return s as CSSWithVars;
}

/**
 * A flex host's layout as the props object it takes to actually behave like
 * one: `style` — self-sizing plus the child-layout `--container-*` vars — and
 * `data-flow-direction` /
 * `data-flow-align`, the attributes `hmi.css`'s translation block reads off a
 * flex parent to decide which of a child's two axes is main. Spread the whole
 * object onto whichever element is actually `display: flex`; a host split
 * across two elements (the built-in `Container`'s title row sits between
 * `.hmi-container` and `.hmi-container__content`, the one that flexes) can
 * destructure `style` onto the outer element and the two `data-flow-*` fields
 * onto the inner one instead.
 *
 * `layout` must already be resolved — `direction`/`align` are read as plain
 * values, so a `$var`/`$switch` still holding its property-source wrapper here
 * (rather than the value it resolved to) falls back to the CSS default
 * (`row`/`stretch`), same as leaving them unset does.
 */
export function containerLayoutProps(layout?: LayoutConfig): {
  style: CSSWithVars;
  'data-flow-direction': 'row' | 'column';
  'data-flow-align': string;
} {
  const direction = layout?.direction;
  const align = layout?.align;
  return {
    style: containerStyle(layout),
    'data-flow-direction': direction === 'column' ? 'column' : 'row',
    'data-flow-align': typeof align === 'string' && align !== '' ? align : 'stretch',
  };
}

/** The two attributes `hmi.css`'s flow-translation block reads, for a fixed
 *  column of stretched children — page and page-group chrome, and the modal
 *  content area. The whole contract is these two names and their values, so
 *  the app-side literals spell it once here rather than at each band. */
export const COLUMN_FLOW = {
  'data-flow-direction': 'column',
  'data-flow-align': 'stretch',
} as const;

// ── Layout expression resolution ──────────────────────────────────────────────

/**
 * True when any layout field holds a property source ($static, $var, $if, …)
 * rather than a plain value. Used to decide whether a node needs live resolution.
 */
export function layoutHasPropertySource(layout?: LayoutConfig): boolean {
  if (!layout) return false;
  return Object.values(layout).some(hasPropertySourceKey);
}

/**
 * Resolve any sourced layout values to plain values, subscribing to
 * the eval context so `$var`-bound layout fields update live. Plain values pass
 * through untouched. Call only when `layoutHasPropertySource(layout)` is true so
 * static-layout nodes don't subscribe to variable updates.
 */
export function useResolvedLayout(layout?: LayoutConfig): LayoutConfig | undefined {
  const evalCtx = useEvalContext();
  // `evalCtx` is stable across both variable and viewport ticks by design, so
  // neither reaches the memo on its own. `$var` folds in through the signature
  // of the layout's own keys; `$viewport` — what a responsive `direction` or
  // `width` actually reads — through the snapshot identity, which changes only
  // when a viewport field really did. `useEvalContext` already subscribes to
  // the viewport store, so reading the snapshot here costs no second listener.
  const sig = useLiveScalars(extractVarKeys(layout));
  const viewport = getViewportSnapshot();
  return useMemo(() => {
    if (!layout) return layout;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(layout)) {
      out[k] = hasPropertySourceKey(v) ? (evaluatePropertyValue(v, evalCtx) ?? undefined) : v;
    }
    return out as LayoutConfig;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, evalCtx, sig, viewport]);
}

// ── Property reading helpers ──────────────────────────────────────────────────
// These replace verbose cast patterns in HMI components and are also exposed
// via window.__nextHMI__ so custom components can use them too.

/** Safely read a string property. Returns fallback (default '') when absent or wrong type. */
export function getPropString(
  properties: Record<string, unknown> | undefined,
  key: string,
  fallback = '',
  evalContext?: EvaluationContext,
): string {
  const v = properties?.[key];
  if (v == null) return fallback;
  // If evaluation context provided, evaluate the value first
  if (evalContext) {
    const evaluated = evaluatePropertyValue(v, evalContext);
    if (evaluated == null) return fallback;
    if (typeof evaluated === 'object') return fallback;
    return String(evaluated);
  }
  // Translation references are { $loc: 'key' } objects — treat as absent here;
  // components that render translated text should use the translation hook instead.
  if (typeof v === 'object') return fallback;
  return String(v);
}

/** Safely read a number property. Returns fallback (default 0) when absent or wrong type. */
export function getPropNumber(
  properties: Record<string, unknown> | undefined,
  key: string,
  fallback = 0,
  evalContext?: EvaluationContext,
): number {
  const v = properties?.[key];
  if (evalContext) {
    const evaluated = evaluatePropertyValue(v, evalContext);
    if (typeof evaluated === 'number' && !isNaN(evaluated)) return evaluated;
    return fallback;
  }
  if (typeof v === 'number' && !isNaN(v)) return v;
  return fallback;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '') return true;
    if (
      normalized === 'true' ||
      normalized === '1' ||
      normalized === 'yes' ||
      normalized === 'on'
    ) {
      return true;
    }
    if (
      normalized === 'false' ||
      normalized === '0' ||
      normalized === 'no' ||
      normalized === 'off'
    ) {
      return false;
    }
  }
  return Boolean(value);
}

/** Safely read a boolean property. Returns fallback (default false) when absent or wrong type. */
export function getPropBoolean(
  properties: Record<string, unknown> | undefined,
  key: string,
  fallback = false,
  evalContext?: EvaluationContext,
): boolean {
  const v = properties?.[key];
  if (evalContext) {
    const evaluated = evaluatePropertyValue(v, evalContext);
    return coerceBoolean(evaluated, fallback);
  }
  return coerceBoolean(v, fallback);
}

/** Safely read a VariableBinding property from the canonical `{ $var: binding }` form. */
export function getPropBinding(
  properties: Record<string, unknown> | undefined,
  key: string,
): VariableBinding | undefined {
  return getVarBinding(properties?.[key]);
}

/**
 * Normalise a scalar-or-$var property value into either a VariableBinding or a static value.
 * This is intended for custom components where schema fields allow ['$static', '$var'].
 */
export function getPropBindingOrStatic(value: unknown): {
  binding: VariableBinding | undefined;
  staticValue: unknown;
} {
  const binding = getVarBinding(value);
  if (binding) {
    return { binding, staticValue: undefined };
  }
  return { binding: undefined, staticValue: value };
}

/**
 * Hook: subscribe to a live variable ($var binding) or resolve a static/sourced value.
 * Use this for `$static` / `$var` value-source properties.
 * Returns `unknown` — cast to the expected type at the call site.
 * @example
 *   const value = usePropVar(properties, 'variable');
 *   const num   = typeof value === 'number' ? value : 0;
 */
export function usePropVar(properties: Record<string, unknown> | undefined, key: string): unknown {
  const { binding, staticValue } = getPropBindingOrStatic(properties?.[key]);
  const liveValue = useBindingValue(binding);
  const evalCtx = useEvalContext();
  if (binding) return liveValue;
  // Evaluate property sources ($time, $user, $loc, etc.) for the static path
  const resolved = evaluatePropertyValue(staticValue, evalCtx);
  // A `$`-sourced value that resolves to nothing is absent, not its own
  // wrapper — an incomplete binding (`{ $var: { path: '' } }`) must read as
  // null, never leak the object and render as "[object Object]".
  if (hasPropertySourceKey(staticValue)) return resolved;
  return resolved ?? staticValue;
}

/** Hook: read a string property, evaluating any property source. */
export function usePropString(
  properties: Record<string, unknown> | undefined,
  key: string,
  fallback = '',
): string {
  const evalCtx = useEvalContext();
  return getPropString(properties, key, fallback, evalCtx);
}

/** Hook: read a number property, evaluating any property source. */
export function usePropNumber(
  properties: Record<string, unknown> | undefined,
  key: string,
  fallback = 0,
): number {
  const evalCtx = useEvalContext();
  return getPropNumber(properties, key, fallback, evalCtx);
}

/** Hook: read a boolean property, evaluating any property source. */
export function usePropBoolean(
  properties: Record<string, unknown> | undefined,
  key: string,
  fallback = false,
): boolean {
  const evalCtx = useEvalContext();
  return getPropBoolean(properties, key, fallback, evalCtx);
}

/**
 * Hook: subscribe to a struct variable bound via a `$var`-wrapped property.
 * Combines getPropBinding + bindingKey + useStructVariable into one call.
 * @example
 *   const fields = usePropStruct(properties, 'variable');
 *   const bVisible = fields?.bVisible !== false;
 */
export function usePropStruct(
  properties: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | unknown[] {
  const varKey = bindingKey(getPropBinding(properties, key));
  return useStructVariable(varKey);
}

/** Resolve a non-`$var` record-list wrapper to an array (source-agnostic). */
function resolveRecordListSource(raw: unknown, evalCtx: EvaluationContext): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  if (Array.isArray(raw.$static)) return raw.$static;
  if (isRecord(raw.$recipeList)) {
    const type = typeof raw.$recipeList.type === 'string' ? raw.$recipeList.type : '';
    return evalCtx.resolveRecipeList?.(type) ?? [];
  }
  if (isRecord(raw.$widgetProp)) {
    const { componentId, property } = raw.$widgetProp as {
      componentId?: string;
      property?: string;
    };
    const value = evalCtx.resolveComponentProp?.(String(componentId ?? ''), String(property ?? ''));
    return Array.isArray(value) ? value : [];
  }
  // `option-list` fields accept `$user` (see propertySourceRules), whose only
  // array-valued field is `userList`. Emitted as `{ label, value }` pairs to
  // match `ItemEntry`, the shape every option-list consumer expects.
  if (isRecord(raw.$user)) {
    if ((raw.$user as { field?: string }).field !== 'userList') return [];
    return (evalCtx.resolveUserList?.() ?? []).map((username) => ({
      label: username,
      value: username,
    }));
  }
  return [];
}

/**
 * Hook: read a `record-list` property (array of records) regardless of its
 * source. Handles a `$var` binding to a struct-array variable, the
 * `$recipeList` source, a `$widgetProp` export, and a plain static array.
 * Returns `unknown[]` — cast rows/cells at the call site.
 * @example
 *   const rows = useRecordListProp(properties, 'rows');
 */
export function useRecordListProp(
  properties: Record<string, unknown> | undefined,
  key: string,
): unknown[] {
  const binding = getPropBinding(properties, key);
  const structVal = useStructVariable(bindingKey(binding));
  const evalCtx = useEvalContext();
  if (binding) return Array.isArray(structVal) ? structVal : [];
  return resolveRecordListSource(properties?.[key], evalCtx);
}

/**
 * Hook: read a CSS custom property from the document root, re-reading whenever the
 * active theme changes so canvas/SVG components (which can't rely on CSS cascade)
 * re-skin live. Use for HMI theme tokens (e.g. '--hmi-accent').
 * @example
 *   const accentColor = useCssVar('--hmi-accent', '#e94560');
 */
export function useCssVar(varName: string, fallback: string): string {
  const activeThemeId = useThemeRuntimeStore((s) => s.activeThemeId);
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    setValue(v || fallback);
    // `activeThemeId` in deps: switching themes re-applies the `:root` tokens, so
    // re-read the resolved value even though `varName` is unchanged.
  }, [varName, fallback, activeThemeId]);
  return value;
}

/**
 * Recursively walk a component tree and collect all composite variable keys
 * from properties and layout, including variables nested in expressions.
 *
 * Used to build the `priorityKeys` list when sending `set_context` from
 * HmiView so the backend subscribes and pushes variables even when the page
 * config has not been saved to disk yet.
 *
 * Descends into the definitions of `$component:` instances with the
 * instance's properties as the `$componentProp` scope. A definition that
 * binds a sub-path of a struct input (`sensor/stSignalFiltered`) reads a
 * composite no instance names; the backend only builds and pushes a nested
 * struct composite when some client asks for it, so it has to be listed here.
 */
export function collectComponentPriorityKeys(components: WidgetConfig[]): string[] {
  const keySet = new Set<string>();
  function walk(
    nodes: WidgetConfig[],
    scope: Record<string, unknown> | undefined,
    seenComponents: ReadonlySet<string>,
  ): void {
    for (const comp of nodes) {
      const properties = resolveScopedProperties(comp.properties, scope);
      for (const key of extractVarKeys(properties)) keySet.add(key);
      for (const key of extractVarKeys(comp.layout)) keySet.add(key);
      if (comp.children?.length) {
        walk(comp.children, scope, seenComponents);
      }
      if (typeof comp.type === 'string' && comp.type.startsWith(COMPONENT_TYPE_PREFIX)) {
        const name = comp.type.slice(COMPONENT_TYPE_PREFIX.length);
        if (seenComponents.has(name)) continue;
        const definition = componentDefinition(name);
        if (!definition?.children?.length) continue;
        walk(
          definition.children as WidgetConfig[],
          withDeclaredDefaults(properties, definition.componentProperties),
          new Set([...seenComponents, name]),
        );
      }
    }
  }
  walk(components, undefined, new Set());
  return [...keySet];
}

const COMPONENT_TYPE_PREFIX = '$component:';

function resolveScopedProperties(
  properties: Record<string, unknown> | undefined,
  scope: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!properties || !scope) return properties;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] = resolveComponentPropValue(value, scope);
  }
  return out;
}
