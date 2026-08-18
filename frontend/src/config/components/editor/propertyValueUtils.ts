import {
  hasPropertySourceKey,
  isLocSource,
  isRecord,
  getVarBinding,
} from '@shared/types/propertyValueGuards';
import { bindingParts } from '@shared/types/config';
import { assetName } from './assetPickerUtils';
import type { PropertySource } from '@hmi/utils/propertySourceRegistry';

/**
 * Shared property-value utilities — extracted here to break the circular
 * dependency between PropertySourceEditor ↔ PropertySourceSelector.
 */

export type { PropertySource } from '@hmi/utils/propertySourceRegistry';

/**
 * Determine the property source of a value (plain or sourced).
 */
export function getPropertySource(value: unknown): PropertySource | null {
  if (value === null || value === undefined) {
    return 'static';
  }
  if (hasPropertySourceKey(value)) {
    const sourceKey = Object.keys(value)[0];
    if (sourceKey === '$static') return 'static';
    if (sourceKey?.startsWith('$')) return sourceKey as PropertySource;
  }
  return 'static';
}

/** Recursive preview depth cap — nested branches beyond this render as a `kind(…)` stub. */
export const MAX_PREVIEW_DEPTH = 2;

type BranchNode =
  | { kind: 'if'; condition: unknown; trueVal: unknown; falseVal: unknown }
  | { kind: 'switch'; value: unknown; cases: { when: unknown; then: unknown }[]; fallback: unknown }
  | { kind: 'compare'; left: unknown; operator: string; right: unknown };

/**
 * Unwrap a `$if`/`$switch`/`$compare` value into its typed parts — the one
 * place that knows each source's field names, shared by `propertyValuePreview`
 * (string preview) and `shared.tsx`'s `previewNodes` (colored JSX preview) so
 * the two don't re-derive the same branch shapes independently.
 *
 * Returns `null` when `value` isn't one of these three source keys at all
 * (callers fall through to their other key checks). When the key matches but
 * the payload itself is falsy/malformed, returns the bare kind name instead
 * of a `BranchNode` — callers render a `kind(…)` stub without recursing.
 */
export function unwrapBranch(value: unknown): BranchNode | 'if' | 'switch' | 'compare' | null {
  if (!isRecord(value)) return null;
  const key = Object.keys(value)[0];
  if (key === '$if') {
    const w = value.$if as { condition?: unknown; true?: unknown; false?: unknown } | undefined;
    return w ? { kind: 'if', condition: w.condition, trueVal: w.true, falseVal: w.false } : 'if';
  }
  if (key === '$switch') {
    const w = value.$switch as
      | { value?: unknown; cases?: { when: unknown; then: unknown }[]; default?: unknown }
      | undefined;
    return w
      ? { kind: 'switch', value: w.value, cases: w.cases ?? [], fallback: w.default }
      : 'switch';
  }
  if (key === '$compare') {
    const w = value.$compare as { left?: unknown; operator?: string; right?: unknown } | undefined;
    return w
      ? { kind: 'compare', left: w.left, operator: w.operator ?? '>', right: w.right }
      : 'compare';
  }
  return null;
}

/** Longest binding path a `$stringExpr` summary shows in full. */
const PREVIEW_PATH_MAX = 28;

/**
 * Drop leading path segments from an over-long binding path, marking the cut
 * with a leading `…`. The tail is the part that identifies the variable, so it
 * is the part that survives — `Machine: Plant/Line3/Measurement/RunNumber`
 * becomes `…Measurement/RunNumber`. Text with no separators is returned
 * untouched rather than cut mid-word.
 */
export function shortenBindingPath(text: string, max = PREVIEW_PATH_MAX): string {
  if (text.length <= max) return text;
  const segments = text.split(/(?<=\/)|(?<=:\s)/);
  let kept = '';
  for (let i = segments.length - 1; i >= 0; i--) {
    const next = segments[i] + kept;
    if (kept && next.length + 1 > max) break;
    kept = next;
  }
  return kept === text ? text : `…${kept}`;
}

/**
 * Replace a `$stringExpr` template's wildcard numbers with a rendering of the
 * value each one is bound to, so a summary says what it interpolates instead of
 * `{1} · {2}`. Placeholder numbers only mean anything inside a `{…}` group —
 * elsewhere in the template a digit is literal text ("Plane 1").
 *
 * Generic over the rendered wildcard so the tinted node renderer in
 * `editors/shared.tsx` can share the parse and emit React nodes.
 */
export function substituteWildcards<T>(
  template: string,
  wildcards: Record<string, unknown>,
  renderValue: (value: unknown) => T,
  renderLiteral: (text: string) => T = (text) => text as T,
  join: (parts: T[]) => T = (parts) => parts.join('') as T,
): T {
  const parts: T[] = [];
  for (const segment of template.split(/(\{[^{}]*\})/)) {
    if (!segment) continue;
    if (!segment.startsWith('{')) {
      parts.push(renderLiteral(segment));
      continue;
    }
    for (const token of segment.split(/(\d+)/)) {
      if (!token) continue;
      if (/^\d+$/.test(token) && token in wildcards) parts.push(renderValue(wildcards[token]));
      else parts.push(renderLiteral(token));
    }
  }
  return join(parts);
}

/**
 * Return a compact human-readable preview string for any property value.
 * Used in collapsed previews and case list displays.
 *
 * @param fieldType Optional schema field type — improves static value display
 *   (e.g. shows "true/false" for boolean, uses raw value for color hex).
 * @param depth Recursion depth for nested branching sources (`$if`/`$switch`/
 *   `$compare`) — internal, callers should not pass this.
 */
export function propertyValuePreview(value: unknown, fieldType?: string, depth = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    if (fieldType === 'option-list') return `${value.length} item${value.length === 1 ? '' : 's'}`;
    if (fieldType === 'image-indicators')
      return `${value.length} indicator${value.length === 1 ? '' : 's'}`;
    if (fieldType === 'child-positions')
      return `${value.length} placement${value.length === 1 ? '' : 's'}`;
    return '—';
  }
  if (!isRecord(value)) {
    if (fieldType?.toLowerCase() === 'boolean') return value ? 'true' : 'false';
    return String(value);
  }
  const obj = value;
  const key = Object.keys(obj)[0];
  if (!key) return '—';
  if (key === '$static') {
    const payload = obj.$static as unknown;
    if (isRecord(payload)) {
      if (payload.type === 'builtin') return (payload.name as string) || 'icon';
      if (payload.type === 'custom')
        return payload.path ? assetName(payload.path as string) : 'custom icon';
      if (typeof payload.path === 'string') return assetName(payload.path);
      return '—';
    }
    return payload != null && payload !== '' ? String(payload) : '—';
  }
  if (key === '$var') {
    const v = getVarBinding(obj);
    if (!v?.path) return '(var)';
    const { datasource, location } = bindingParts(v);
    const base = datasource ? `${datasource}: ${location}` : location;
    return v.index !== undefined ? `${base}[${v.index}]` : base;
  }
  if (isLocSource(obj)) return `"${obj.$loc}"`;
  const branch = unwrapBranch(obj);
  if (branch) {
    if (typeof branch === 'string') return `${branch}(…)`;
    if (depth >= MAX_PREVIEW_DEPTH) return `${branch.kind}(…)`;
    if (branch.kind === 'if') {
      const cond = propertyValuePreview(branch.condition, undefined, depth + 1);
      const t = propertyValuePreview(branch.trueVal, fieldType, depth + 1);
      const f = propertyValuePreview(branch.falseVal, fieldType, depth + 1);
      return `if(${cond} then ${t} else ${f})`;
    }
    if (branch.kind === 'switch') {
      const val = propertyValuePreview(branch.value, undefined, depth + 1);
      const parts = branch.cases.map(
        (c) => `"${String(c.when)}" → ${propertyValuePreview(c.then, fieldType, depth + 1)}`,
      );
      const fallback = propertyValuePreview(branch.fallback, fieldType, depth + 1);
      return `switch(${val}: ${parts.join(', ')}, else ${fallback})`;
    }
    const left = propertyValuePreview(branch.left, undefined, depth + 1);
    const right = propertyValuePreview(branch.right, undefined, depth + 1);
    return `compare(${left} ${branch.operator} ${right})`;
  }
  if (key === '$random') {
    const r = obj.$random as { min?: number; max?: number } | undefined;
    return r !== undefined ? `${r.min ?? 0}–${r.max ?? 100}` : 'random(…)';
  }
  if (key === '$urlParam') {
    const p = obj.$urlParam as { name?: string } | undefined;
    return p?.name ? `?${p.name}` : '(param)';
  }
  if (key === '$pageIsActive') {
    const p = obj.$pageIsActive as { page?: string } | undefined;
    return p?.page ? p.page : '(current page)';
  }
  if (key === '$user') {
    const u = obj.$user as { field?: string } | undefined;
    if (u?.field === 'userList') return 'User list';
    return u?.field ? `user.${u.field}` : 'user(…)';
  }
  if (key === '$userGroups') {
    const groups = (obj.$userGroups as { groups?: string[] } | undefined)?.groups ?? [];
    return groups.length > 0 ? groups.join(', ') : 'everyone';
  }
  if (key === '$device') {
    const d = obj.$device as { field?: string } | undefined;
    return d?.field ? `device.${d.field}` : 'device(…)';
  }
  if (key === '$page') {
    const p = obj.$page as { field?: string; pageId?: string } | undefined;
    if (!p?.field) return 'page(…)';
    return p.pageId ? `page(${p.pageId}).${p.field}` : `page.${p.field}`;
  }
  if (key === '$viewport') {
    const v = obj.$viewport as { field?: string } | undefined;
    return v?.field ? `viewport.${v.field}` : 'viewport(…)';
  }
  if (key === '$recipe') {
    const r = obj.$recipe as { type?: string; field?: string } | undefined;
    if (!r?.type) return 'recipe(…)';
    return `recipe(${r.type}).${r.field ?? 'parametersChanged'}`;
  }
  if (key === '$time') {
    const t = obj.$time as { format?: string; timezone?: string } | undefined;
    const format = t?.format || 'HH:mm:ss';
    const timezone = t?.timezone || 'local';
    return `time(${format}, ${timezone})`;
  }
  if (key === '$widgetProp') {
    const c = obj.$widgetProp as
      { componentId?: string; property?: string; path?: string } | undefined;
    if (!c?.property) return '(component)';
    return c.path ? `${c.property}/${c.path}` : c.property;
  }
  if (key === '$languages') return 'Language list';
  if (key === '$stringExpr') {
    const se = obj.$stringExpr as
      { template?: string; wildcards?: Record<string, unknown> } | undefined;
    if (!se?.template) return 'expr(…)';
    if (depth >= MAX_PREVIEW_DEPTH) return se.template;
    return substituteWildcards(se.template, se.wildcards ?? {}, (v) =>
      shortenBindingPath(propertyValuePreview(v, undefined, depth + 1)),
    );
  }
  if (key === '$alarmCount') {
    const ac = obj.$alarmCount as { filter?: string } | undefined;
    return ac?.filter ? `alarms(${ac.filter})` : 'alarms(…)';
  }
  if (key === '$componentProp') {
    const propKey = obj.$componentProp;
    return typeof propKey === 'string' && propKey ? propKey : '(component prop)';
  }
  if (key === '$result') {
    const field = obj.$result;
    return typeof field === 'string' && field ? `result.${field}` : '(result)';
  }
  if (key === '$recipeList') {
    const r = obj.$recipeList as { type?: string } | undefined;
    return r?.type ? `recipes(${r.type})` : 'Recipe list';
  }
  return `${key}(…)`;
}

/**
 * Extract a value from a plain primitive or `{ $static: T }` source, stringified.
 * Returns `fallback` (default `''`) when the value is null/undefined — suitable for
 * controlled `<input>` values regardless of the underlying type.
 */
export function getStaticString(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'object' && '$static' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).$static ?? fallback);
  }
  return String(value);
}
