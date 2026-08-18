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
import { useEvalContext } from '../hooks/useEvalContext';
import { useLiveScalars } from '../hooks/useLiveScalars';
import { useBindingValue } from '../hooks/useVariable';
import { useStructVariable } from '../hooks/useStructVariable';
import { useThemeRuntimeStore } from '../store/themeRuntimeStore';

/** Self-fields emitted as CSS custom properties, consumed by `.hmi-component`
 *  and Container CSS with sensible defaults. */
const SELF_VAR_KEYS = {
  basis: '--self-basis',
  grow: '--self-grow',
  shrink: '--self-shrink',
  alignSelf: '--self-align',
  minWidth: '--self-min-width',
  maxWidth: '--self-max-width',
  minHeight: '--self-min-height',
} as const satisfies Partial<Record<keyof LayoutConfig, string>>;

/** Self-fields emitted as plain CSS properties. These override the component's
 *  own CSS so the Layout panel wins when the user sets a value. */
const SELF_DIRECT_KEYS = [
  'width',
  'height',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
] as const satisfies readonly (keyof LayoutConfig)[];

/** Layout keys describing how a node sits in its parent, as opposed to how it
 *  arranges its own children — the union of the two tables above, which
 *  `buildSelfSizingProps` emits. ComponentRenderer folds exactly these from a
 *  component instance onto the definition's roots. */
export const SELF_LAYOUT_KEYS: readonly (keyof LayoutConfig)[] = [
  ...(Object.keys(SELF_VAR_KEYS) as (keyof LayoutConfig)[]),
  ...SELF_DIRECT_KEYS,
];

/**
 * Shared helper: build the self-sizing half of a style object from a layout
 * config. Used by both selfLayoutStyle() and containerLayoutStyle().
 */
function buildSelfSizingProps(layout: LayoutConfig): CSSWithVars {
  const s: Record<string, unknown> = {};
  for (const [key, cssVar] of Object.entries(SELF_VAR_KEYS)) {
    const value = layout[key as keyof LayoutConfig];
    if (value !== undefined) s[cssVar] = value;
  }
  for (const key of SELF_DIRECT_KEYS) {
    const value = layout[key];
    if (value !== undefined) s[key] = value;
  }
  return s as CSSWithVars;
}

/**
 * Build a style object of CSS custom properties from a layout config.
 * Used by leaf components to expose their self-sizing hints to hmi.css rules.
 */
export function selfLayoutStyle(layout?: LayoutConfig): CSSWithVars | undefined {
  if (!layout) return undefined;
  const s = buildSelfSizingProps(layout);
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

/**
 * Build a style object for a Container: includes both self-sizing hints and
 * child-layout hints (direction, gap, wrap, align, justify).
 */
export function containerLayoutStyle(layout?: LayoutConfig): CSSWithVars | undefined {
  if (!layout) return undefined;
  const s = buildSelfSizingProps(layout);
  if (layout.direction !== undefined) s['--container-direction'] = layout.direction;
  if (layout.gap !== undefined) s['--container-gap'] = layout.gap;
  if (layout.wrap !== undefined) s['--container-wrap'] = layout.wrap ? 'wrap' : 'nowrap';
  if (layout.align !== undefined) s['--container-align'] = layout.align;
  if (layout.justify !== undefined) s['--container-justify'] = layout.justify;
  if (layout.radius !== undefined) s['--container-radius'] = layout.radius;
  if (layout.padding !== undefined) s.padding = layout.padding;
  if (layout.paddingTop !== undefined) s.paddingTop = layout.paddingTop;
  if (layout.paddingRight !== undefined) s.paddingRight = layout.paddingRight;
  if (layout.paddingBottom !== undefined) s.paddingBottom = layout.paddingBottom;
  if (layout.paddingLeft !== undefined) s.paddingLeft = layout.paddingLeft;
  return Object.keys(s).length ? s : undefined;
}

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
  // `evalCtx` is stable across variable ticks, so subscribe to the layout's own
  // `$var` keys and fold the signature into the memo deps — otherwise a `$var`
  // in layout would never re-resolve.
  const sig = useLiveScalars(extractVarKeys(layout));
  return useMemo(() => {
    if (!layout) return layout;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(layout)) {
      out[k] = hasPropertySourceKey(v) ? (evaluatePropertyValue(v, evalCtx) ?? undefined) : v;
    }
    return out as LayoutConfig;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, evalCtx, sig]);
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
 */
export function collectComponentPriorityKeys(components: WidgetConfig[]): string[] {
  const keySet = new Set<string>();
  function walk(nodes: WidgetConfig[]): void {
    for (const comp of nodes) {
      for (const key of extractVarKeys(comp.properties)) keySet.add(key);
      for (const key of extractVarKeys(comp.layout)) keySet.add(key);
      if (comp.children?.length) {
        walk(comp.children);
      }
    }
  }
  walk(components);
  return [...keySet];
}
