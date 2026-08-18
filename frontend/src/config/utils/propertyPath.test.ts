import { describe, expect, it } from 'vitest';
import { pathsEqual, getAtPath, setAtPath } from './propertyPath';

describe('pathsEqual', () => {
  it('returns true for two undefined paths', () => {
    expect(pathsEqual(undefined, undefined)).toBe(true);
  });

  it('returns true for two null paths', () => {
    expect(pathsEqual(null, null)).toBe(true);
  });

  it('returns false when one is null/undefined and the other is not', () => {
    expect(pathsEqual(['a'], undefined)).toBe(false);
    expect(pathsEqual(null, ['a'])).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(pathsEqual(['a'], ['a', 'b'])).toBe(false);
  });

  it('returns false for different segments', () => {
    expect(pathsEqual(['a', 'b'], ['a', 'c'])).toBe(false);
  });

  it('returns true for identical paths', () => {
    expect(pathsEqual(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true);
  });

  it('returns true for empty arrays', () => {
    expect(pathsEqual([], [])).toBe(true);
  });
});

describe('getAtPath', () => {
  it('returns root when path is empty', () => {
    expect(getAtPath({ a: 1 }, [])).toEqual({ a: 1 });
  });

  it('walks a nested object', () => {
    expect(getAtPath({ a: { b: { c: 42 } } }, ['a', 'b', 'c'])).toBe(42);
  });

  it('returns undefined for missing segments', () => {
    expect(getAtPath({ a: 1 }, ['b'])).toBeUndefined();
  });

  it('returns undefined when traversing through a primitive', () => {
    expect(getAtPath({ a: 'hello' }, ['a', 'b'])).toBeUndefined();
  });

  it('returns undefined when root is null', () => {
    expect(getAtPath(null, ['a'])).toBeUndefined();
  });

  it('walks arrays by string index', () => {
    expect(getAtPath({ items: [10, 20, 30] }, ['items', '1'])).toBe(20);
  });
});

describe('setAtPath', () => {
  it('returns the value when path is empty', () => {
    expect(setAtPath({ old: 1 }, [], 'new')).toBe('new');
  });

  it('sets a shallow key', () => {
    expect(setAtPath({ a: 1, b: 2 }, ['a'], 99)).toEqual({ a: 99, b: 2 });
  });

  it('sets a deep key immutably', () => {
    const root = { a: { b: { c: 1 } } };
    const result = setAtPath(root, ['a', 'b', 'c'], 42);
    expect(result).toEqual({ a: { b: { c: 42 } } });
    expect(root.a.b.c).toBe(1);
  });

  it('creates intermediate objects for missing path segments', () => {
    expect(setAtPath({}, ['a', 'b'], 1)).toEqual({ a: { b: 1 } });
  });

  it('handles arrays immutably', () => {
    const root = { items: ['a', 'b', 'c'] };
    const result = setAtPath(root, ['items', '1'], 'B') as typeof root;
    expect(result.items).toEqual(['a', 'B', 'c']);
    expect(root.items[1]).toBe('b');
  });

  it('preserves sibling keys', () => {
    const root = { a: 1, b: { x: 10, y: 20 } };
    const result = setAtPath(root, ['b', 'x'], 99);
    expect(result).toEqual({ a: 1, b: { x: 99, y: 20 } });
  });
});
