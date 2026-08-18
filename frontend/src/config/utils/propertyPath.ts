/**
 * Path utilities for the property value tree. A path is a sequence of string
 * keys; numeric segments are coerced when walking through arrays.
 */

import { isRecord } from '@shared/types/propertyValueGuards';

/** Sentinel top-level path segment for layout-panel fields. */
export const LAYOUT_PATH_KEY = '__layout__';

export function pathsEqual(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function getAtPath(root: unknown, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function setAtPath(root: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const next = root.slice();
    const idx = Number(head);
    next[idx] = setAtPath(root[idx], rest, value);
    return next;
  }
  const obj = (isRecord(root) ? root : {}) as Record<string, unknown>;
  return { ...obj, [head]: setAtPath(obj[head], rest, value) };
}
