import type { RepeatScopeValue } from '../context/RepeatScopeContext';
import { isRecord } from '@shared/types/propertyValueGuards';

/**
 * A struct-array element is a sub-folder whose name only *ends* in `[N]` — a
 * static server may call it `Line[2]` — so the leaf path of one of its members
 * cannot be built from the index alone. Read the real folder name off the
 * variable metadata.
 *
 * Keyed by position, not by the `N` in the name: the array value counts from 0
 * whatever the PLC does, as the backend's `_element_paths` do, so the copy at
 * position 0 of a PLC array `A[1..500]` is `A[1]`. The backend names each
 * element's `position`, since a page's metadata holds only the elements it
 * binds and their rank among those is not their place in the array.
 */
interface ElementIndex {
  /** Position → element path, per array whose elements name their position. */
  positioned: Map<string, Map<number, string>>;
  /** Each array asked about so far, its elements in position order. */
  ordered: Map<string, ReadonlyMap<number, string>>;
  /** Built on first use (`elementMembers`). */
  members?: Map<string, ElementMember[]>;
}
/** A key below an element: the key, and its path inside the element's value. */
type ElementMember = readonly [key: string, path: readonly string[]];
const NO_MEMBERS: readonly ElementMember[] = [];
const elementIndexCache = new WeakMap<object, ElementIndex>();

/** The position the metadata names for an element folder's key. */
function positionOf(varMeta: Record<string, unknown>, key: string): number | undefined {
  const meta = varMeta[key];
  const position = isRecord(meta) ? meta.position : undefined;
  return typeof position === 'number' ? position : undefined;
}

function elementIndex(varMeta: Record<string, unknown>): ElementIndex {
  let index = elementIndexCache.get(varMeta);
  if (index) return index;
  const positioned = new Map<string, Map<number, string>>();
  for (const key in varMeta) {
    const position = positionOf(varMeta, key);
    if (position === undefined) continue;
    const arrayKey = key.slice(0, key.lastIndexOf('/'));
    let elements = positioned.get(arrayKey);
    if (!elements) positioned.set(arrayKey, (elements = new Map()));
    elements.set(position, key);
  }
  index = { positioned, ordered: new Map() };
  elementIndexCache.set(varMeta, index);
  return index;
}

/**
 * Each element's members the metadata lists — every key below it, a struct
 * member and its leaves alike — with the path to each inside the element's
 * value. A nested array is a list there, so a nested element's segment is its
 * position: `Axes/Axes[1]/Pos` is `Axes/1/Pos`. A member is listed under every
 * element it sits in, so an inner element shipped on its own feeds it too.
 */
function elementMembers(varMeta: Record<string, unknown>, index: ElementIndex) {
  if (index.members) return index.members;
  const members = new Map<string, ElementMember[]>();
  // Per key: every element it sits in, innermost first, with its path there.
  const within = new Map<string, readonly ElementMember[]>();
  const elementsOf = (key: string): readonly ElementMember[] => {
    let found = within.get(key);
    if (found) return found;
    found = NO_MEMBERS;
    const cut = key.lastIndexOf('/');
    if (cut > 0) {
      const parent = key.slice(0, cut);
      const outer = elementsOf(parent);
      const inElement = positionOf(varMeta, parent) !== undefined;
      if (outer.length || inElement) {
        const position = positionOf(varMeta, key);
        const segment = position === undefined ? key.slice(cut + 1) : String(position);
        const deeper = outer.map(([element, path]) => [element, [...path, segment]] as const);
        found = inElement ? [[parent, [segment]], ...deeper] : deeper;
      }
    }
    within.set(key, found);
    return found;
  };
  if (index.positioned.size > 0) {
    for (const key in varMeta) {
      for (const [element, path] of elementsOf(key)) {
        let listed = members.get(element);
        if (!listed) members.set(element, (listed = []));
        listed.push([key, path]);
      }
    }
  }
  index.members = members;
  return members;
}

/**
 * What each struct-array element in `values` holds for the members below it
 * that the metadata lists, under each member's own key; `undefined` when
 * nothing. The server ships an element whole, never these members, so applied
 * with the element they keep each member in step with it: a widget bound to
 * one reads, writes and subscribes to it as to any variable. A member the
 * server ships itself, for a page binding it, arrives under its key too, and
 * whichever arrived last is current.
 */
export function elementMemberValues(
  values: Record<string, unknown>,
  varMeta: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const index = elementIndex(varMeta);
  if (index.positioned.size === 0) return undefined;
  const members = elementMembers(varMeta, index);
  let out: Record<string, unknown> | undefined;
  for (const key in values) {
    const listed = members.get(key);
    if (!listed) continue;
    for (const [member, path] of listed) {
      const value = pickPath(values[key], path);
      if (value !== undefined) (out ??= {})[member] = value;
    }
  }
  return out;
}

function elementPaths(
  varMeta: Record<string, unknown>,
  arrayKey: string,
): ReadonlyMap<number, string> {
  const { positioned, ordered } = elementIndex(varMeta);
  let paths = ordered.get(arrayKey);
  if (!paths) {
    paths = new Map([...(positioned.get(arrayKey) ?? [])].sort((a, b) => a[0] - b[0]));
    ordered.set(arrayKey, paths);
  }
  return paths;
}

export function structElementPath(
  varMeta: Record<string, unknown>,
  arrayKey: string,
  index: number,
): string | undefined {
  return elementPaths(varMeta, arrayKey).get(index);
}

/** Whether an array's elements may arrive under keys of their own: a struct
 *  array's do, a scalar array's never — it arrives whole. Until the array's
 *  metadata arrives its kind is unknown, so its elements are looked for too. */
export function mayHaveElementKeys(varMeta: Record<string, unknown>, arrayKey: string): boolean {
  const meta = varMeta[arrayKey];
  return !(isRecord(meta) && isRecord(meta.type) && meta.type.kind === 'scalar');
}

/** The store key a struct array's element at position `index` lives under —
 *  the backend ships an indexed element under it, not inside the whole array:
 *  the element folder the metadata names at that position. `undefined` for a
 *  scalar array, and until the metadata names the element: no name can be
 *  built from the index, `[1]` being position 0 of an array counting from 1. */
export function structElementKey(
  varMeta: Record<string, unknown>,
  arrayKey: string,
  index: number,
): string | undefined {
  return mayHaveElementKeys(varMeta, arrayKey)
    ? structElementPath(varMeta, arrayKey, index)
    : undefined;
}

/**
 * The leaf of a member of one struct-array element, addressed as the array's
 * path plus the member path at an index: what `{ $componentProp: 'device/sName' }`
 * makes of an input passing `{ path: 'PLC:Motors', index: 1 }`. That key names
 * no variable, so it has no metadata; its nearest ancestor that has some is the
 * array. `undefined` for a key with metadata of its own, without an index, and
 * when that ancestor is not a struct array or holds no element at `index`.
 */
export function memberLeafKey(
  varMeta: Record<string, unknown>,
  key: string,
  index: number | undefined,
): string | undefined {
  if (index === undefined || varMeta[key] !== undefined) return undefined;
  for (let slash = key.lastIndexOf('/'); slash > 0; slash = key.lastIndexOf('/', slash - 1)) {
    const meta = varMeta[key.slice(0, slash)];
    if (meta === undefined) continue;
    const type = isRecord(meta) && isRecord(meta.type) ? meta.type : undefined;
    if (type?.kind !== 'struct' || type.array !== true) return undefined;
    const element = structElementPath(varMeta, key.slice(0, slash), index);
    return element === undefined ? undefined : `${element}/${key.slice(slash + 1)}`;
  }
  return undefined;
}

/** One element of an array variable as the store holds it: a struct array's
 *  element under its own key, else the whole value sliced; `undefined` when
 *  neither has arrived. A member of an element (`memberLeafKey`) is its leaf,
 *  which the store keeps in step with the element (`elementMemberValues`). */
export function readArrayElement(
  values: Record<string, unknown>,
  varMeta: Record<string, unknown>,
  arrayKey: string,
  index: number,
): unknown {
  const leaf = memberLeafKey(varMeta, arrayKey, index);
  if (leaf !== undefined) return values[leaf];
  const key = structElementKey(varMeta, arrayKey, index);
  const element = key === undefined ? undefined : values[key];
  if (element !== undefined) return element;
  const whole = values[arrayKey];
  return Array.isArray(whole) ? whole[index] : undefined;
}

/** The element a struct array's shape is read off: the one at position `index`
 *  when given and present, otherwise the lowest-positioned one the metadata
 *  holds. The backend validator's `_element_path` sees every element, so its
 *  fallback is always position 0. */
export function structShapeElementPath(
  varMeta: Record<string, unknown>,
  arrayKey: string,
  index?: number,
): string | undefined {
  const paths = elementPaths(varMeta, arrayKey);
  return (index === undefined ? undefined : paths.get(index)) ?? paths.values().next().value;
}

/** Read a slash-path out of a record element; numeric segments index arrays. */
function pickMember(item: unknown, member: string | undefined): unknown {
  return member ? pickPath(item, member.split('/')) : item;
}

function pickPath(item: unknown, path: readonly string[]): unknown {
  let cur: unknown = item;
  for (const seg of path) {
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
export function isWidgetNode(value: object): boolean {
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
 * `useScopedProperties`: everything downstream — the live subscription, the
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
