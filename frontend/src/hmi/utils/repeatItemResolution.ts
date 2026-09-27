import type { RepeatScopeValue } from '../context/RepeatScopeContext';
import { isRecord } from '@shared/types/propertyValueGuards';

const ELEMENT_NAME = /\[(\d+)\]$/;

/**
 * A struct-array element is a sub-folder whose name only *ends* in `[N]` — a
 * static server may call it `Line[2]` — so the leaf path of one of its members
 * cannot be built from the index alone. Read the real folder name off the
 * variable metadata, which lists every leaf.
 */
const elementPathCache = new WeakMap<object, Map<string, Map<number, string>>>();

function elementPaths(varMeta: Record<string, unknown>, arrayKey: string): Map<number, string> {
  let byArray = elementPathCache.get(varMeta);
  if (!byArray) {
    byArray = new Map();
    elementPathCache.set(varMeta, byArray);
  }
  let byIndex = byArray.get(arrayKey);
  if (!byIndex) {
    byIndex = new Map();
    const prefix = `${arrayKey}/`;
    for (const key of Object.keys(varMeta)) {
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length).split('/', 1)[0];
      const m = name.match(ELEMENT_NAME);
      if (m) byIndex.set(Number(m[1]), `${prefix}${name}`);
    }
    byArray.set(arrayKey, byIndex);
  }
  return byIndex;
}

export function structElementPath(
  varMeta: Record<string, unknown>,
  arrayKey: string,
  index: number,
): string | undefined {
  return elementPaths(varMeta, arrayKey).get(index);
}

/** The element a struct array's shape is read off: the one at `index` when
 *  given and present, otherwise the lowest-index element there is — arrays
 *  may count from 1. Mirrored by `_element_path` in the backend validator. */
export function structShapeElementPath(
  varMeta: Record<string, unknown>,
  arrayKey: string,
  index?: number,
): string | undefined {
  const paths = elementPaths(varMeta, arrayKey);
  const bound = index === undefined ? undefined : paths.get(index);
  if (bound !== undefined || paths.size === 0) return bound;
  return paths.get(Math.min(...paths.keys()));
}

/** Read a slash-path out of a record element; numeric segments index arrays. */
function pickMember(item: unknown, member: string | undefined): unknown {
  if (!member) return item;
  let cur: unknown = item;
  for (const seg of member.split('/')) {
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (isRecord(cur)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

/** The `$var` a scope's element (or one member of it) lives at, when it has one. */
export function repeatItemBinding(
  scope: RepeatScopeValue,
  member: string | undefined,
  varMeta: Record<string, unknown>,
): { path: string; index?: number } | undefined {
  if (!scope.arrayKey) return undefined;
  const element = scope.structArray
    ? structElementPath(varMeta, scope.arrayKey, scope.index)
    : undefined;
  if (!member) {
    // A struct element is cached under its own folder key; readers that take
    // the key as-is (usePropStruct) ignore `index` and would get the whole array.
    return element ? { path: element } : { path: scope.arrayKey, index: scope.index };
  }
  // A member of anything but a known struct array has no leaf of its own —
  // binding the whole element instead would write the member's value over it.
  return element ? { path: `${element}/${member}` } : undefined;
}

/**
 * What a `$repeatItem` stands for in one copy: the concrete `$var` when the
 * element lives in a variable (so it stays live and writable), otherwise the
 * element's value itself. Records surface as JSON text, like `$result`.
 */
export function resolveRepeatItem(
  payload: unknown,
  scope: RepeatScopeValue,
  varMeta: Record<string, unknown>,
): unknown {
  const p = isRecord(payload) ? payload : {};
  if (p.field === 'index') return scope.index;
  const member = typeof p.member === 'string' && p.member.trim() ? p.member.trim() : undefined;
  const binding = repeatItemBinding(scope, member, varMeta);
  if (binding) return { $var: binding };
  const value = pickMember(scope.item, member);
  if (value === undefined || value === null) return null;
  return typeof value === 'object' ? JSON.stringify(value) : value;
}

const containsCache = new WeakMap<object, boolean>();

/** A widget node kept inside a property (a slot's content, a `widgets` field)
 *  renders through its own WidgetRenderer, which resolves its own references —
 *  possibly against a Repeater of its own. */
function isWidgetNode(value: object): boolean {
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === 'string' &&
    typeof rec.type === 'string' &&
    ('properties' in rec || 'children' in rec)
  );
}

/** Whether a property value mentions the repeat scope anywhere, so the cost of
 *  a rewrite is paid only by the widgets that need one. */
export function containsRepeatRef(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const cached = containsCache.get(value);
  if (cached !== undefined) return cached;
  let found: boolean;
  if (isWidgetNode(value)) {
    found = false;
  } else if (Array.isArray(value)) {
    found = value.some(containsRepeatRef);
  } else {
    const rec = value as Record<string, unknown>;
    found =
      '$repeatItem' in rec ||
      (isRecord(rec.$var) && rec.$var.repeatIndex === true) ||
      Object.values(rec).some(containsRepeatRef);
  }
  containsCache.set(value, found);
  return found;
}

/**
 * Rewrite every repeat reference in a property value into what it means in this
 * copy: `$repeatItem` into its concrete source — a write action's target
 * included — and `$var` with `repeatIndex` into a plain indexed `$var`.
 *
 * Done once, up front, for the same reason `$componentProp` is substituted in
 * `useResolvedProperties`: everything downstream — the live subscription, the
 * binding overlay, the widget's own writer — then sees an ordinary `$var` and
 * needs no knowledge of repeaters. Unchanged subtrees keep their identity.
 */
export function substituteRepeatRefs(
  value: unknown,
  scope: RepeatScopeValue,
  varMeta: Record<string, unknown>,
): unknown {
  if (!containsRepeatRef(value)) return value;
  if (Array.isArray(value)) return value.map((v) => substituteRepeatRefs(v, scope, varMeta));
  const rec = value as Record<string, unknown>;
  if ('$repeatItem' in rec) return resolveRepeatItem(rec.$repeatItem, scope, varMeta);
  if (isRecord(rec.$var) && rec.$var.repeatIndex === true) {
    const { repeatIndex: _drop, ...binding } = rec.$var;
    return { ...rec, $var: { ...binding, index: scope.index } };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = substituteRepeatRefs(v, scope, varMeta);
  return out;
}
